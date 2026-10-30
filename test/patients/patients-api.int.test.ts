import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let testDb: TestDatabase | undefined;
let appDb: Database;
let app: ReturnType<typeof buildApp>;

let clinicId: string;
let practitionerId: string;
let adminToken: string;
let receptionToken: string;
let practitionerToken: string;
let patientId: string;
let householdId: string;
let tagId: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  app = buildApp({ db: appDb, logger: false });

  clinicId = randomUUID();
  practitionerId = randomUUID();

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica API Pacientes",
    timezone: "America/Mexico_City",
  });

  await testDb.adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. API",
    specialty: "Medicina general",
  });

  const admin = await createStaffUser(testDb.adminDb, { clinicId, role: "admin" });
  const reception = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  const practitioner = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "practitioner",
    practitionerId,
  });

  adminToken = admin.token;
  receptionToken = reception.token;
  practitionerToken = practitioner.token;
}, 300_000);

afterAll(async () => {
  await app.close();
  await testDb?.close();
}, 60_000);

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("API de pacientes", () => {
  it("crea un paciente adulto con household y contactos enmascarados", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: headers(receptionToken),
      payload: {
        firstName: "Ana",
        lastName: "Gomez",
        birthDate: "1990-04-12",
        phone: "+52 155 1234 5678",
        email: "ANA@example.com",
        documentType: "ine",
        documentNumber: "ABC-123456",
        transactionalOptIn: true,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeTruthy();
    expect(body.householdId).toBeTruthy();
    expect(body.documentMasked).toBe("****3456");
    expect(body.contacts.some((c: { valueMasked: string }) => c.valueMasked === "+52******5678")).toBe(true);
    expect(body.contacts.some((c: { valueMasked: string }) => c.valueMasked === "a***@example.com")).toBe(true);

    patientId = body.id;
    householdId = body.householdId;
  });

  it("busca por telefono y no devuelve el valor completo", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/patients?q=%2B5215512345678",
      headers: headers(receptionToken),
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows.some((row: { id: string }) => row.id === patientId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("+5215512345678");

    const local = await app.inject({
      method: "GET",
      url: "/api/v1/patients?q=5512345678",
      headers: headers(receptionToken),
    });
    expect(local.statusCode).toBe(200);
    expect(local.json().some((row: { id: string }) => row.id === patientId)).toBe(
      true,
    );
  });

  it("exige tutor legal al crear un menor", async () => {
    const withoutGuardian = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: headers(receptionToken),
      payload: {
        firstName: "Menor",
        lastName: "SinTutor",
        birthDate: "2015-01-01",
      },
    });
    expect(withoutGuardian.statusCode).toBe(422);
    expect(withoutGuardian.json().error.code).toBe("GUARDIAN_REQUIRED");

    const withGuardian = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: headers(receptionToken),
      payload: {
        firstName: "Menor",
        lastName: "ConTutor",
        birthDate: "2015-01-01",
        guardian: {
          name: "Tutora Legal",
          relationship: "parent",
          isLegalGuardian: true,
        },
      },
    });
    expect(withGuardian.statusCode).toBe(201);
    expect(withGuardian.json().guardians).toHaveLength(1);
  });

  it("recepción ve alergia sin reacción; el médico ve el detalle", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${patientId}/allergies`,
      headers: headers(adminToken),
      payload: {
        allergen: "Penicilina",
        severity: "anaphylaxis",
        reaction: "Edema",
        notes: "Confirmada por médico",
      },
    });
    expect(created.statusCode).toBe(201);

    const reception = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}/allergies`,
      headers: headers(receptionToken),
    });
    expect(reception.statusCode).toBe(200);
    expect(reception.json()[0].allergen).toBe("Penicilina");
    expect(reception.json()[0].reaction).toBeUndefined();

    const admin = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}/allergies`,
      headers: headers(adminToken),
    });
    expect(admin.json()[0].reaction).toBe("Edema");
  });

  it("recepción no puede crear alergias", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${patientId}/allergies`,
      headers: headers(receptionToken),
      payload: { allergen: "Latex", severity: "mild" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("asigna etiquetas y las devuelve en la ficha", async () => {
    const tag = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: headers(adminToken),
      payload: { code: "vip", label: "VIP", category: "vip" },
    });
    expect(tag.statusCode).toBe(201);
    tagId = tag.json().id;

    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${patientId}/tags`,
      headers: headers(receptionToken),
      payload: { tagId, severity: 2 },
    });
    expect(assigned.statusCode).toBe(201);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}`,
      headers: headers(receptionToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().tags.some((t: { code: string }) => t.code === "vip")).toBe(true);
  });

  it("actualiza el teléfono y el contacto primario", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/patients/${patientId}`,
      headers: headers(receptionToken),
      payload: { phone: "+52 55 9999 0000" },
    });
    expect(response.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}`,
      headers: headers(receptionToken),
    });
    const phone = detail
      .json()
      .contacts.find((c: { kind: string }) => c.kind === "phone");
    expect(phone.valueMasked).toBe("+52******0000");
  });

  it("devuelve la familia con sus miembros", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/households/${householdId}`,
      headers: headers(receptionToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().members.some((m: { id: string }) => m.id === patientId)).toBe(true);
  });

  it("un médico solo ve pacientes con los que tiene cita", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}`,
      headers: headers(practitionerToken),
    });
    expect(before.statusCode).toBe(404);

    await testDb!.adminDb.insert(schema.appointments).values({
      clinicId,
      patientId,
      practitionerId,
      startsAt: new Date("2027-06-01T15:00:00Z"),
      endsAt: new Date("2027-06-01T15:30:00Z"),
      timezone: "America/Mexico_City",
      status: "confirmed",
    });

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientId}`,
      headers: headers(practitionerToken),
    });
    expect(after.statusCode).toBe(200);
  });
});
