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
let adminToken: string;
let receptionToken: string;
let serviceId: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  app = buildApp({ db: appDb, logger: false });

  clinicId = randomUUID();

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica API Servicios",
    timezone: "America/Mexico_City",
  });

  await testDb.adminDb.insert(schema.practitioners).values({
    clinicId,
    fullName: "Dra. Servicios",
    specialty: "Medicina general",
  });

  const admin = await createStaffUser(testDb.adminDb, { clinicId, role: "admin" });
  const reception = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  adminToken = admin.token;
  receptionToken = reception.token;
}, 300_000);

afterAll(async () => {
  await app.close();
  await testDb?.close();
}, 60_000);

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("API de servicios", () => {
  it("admin crea un servicio con buffers y moneda de la clinica", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: headers(adminToken),
      payload: {
        code: "LIMPIEZA",
        name: "Limpieza dental",
        durationMinutes: 45,
        bufferAfterMinutes: 10,
        priceCents: 90_000,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.currency).toBe("MXN");
    expect(body.bufferAfterMinutes).toBe(10);
    serviceId = body.id;
  });

  it("recepción no puede crear servicios", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: headers(receptionToken),
      payload: {
        code: "NO_PERM",
        name: "Sin permiso",
        durationMinutes: 30,
        priceCents: 0,
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rechaza código duplicado y duración inválida", async () => {
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: headers(adminToken),
      payload: {
        code: "LIMPIEZA",
        name: "Duplicado",
        durationMinutes: 30,
        priceCents: 0,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("SERVICE_CODE_EXISTS");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: headers(adminToken),
      payload: {
        code: "CORTO",
        name: "Muy corto",
        durationMinutes: 2,
        priceCents: 0,
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("recepción lista servicios y practicantes", async () => {
    const services = await app.inject({
      method: "GET",
      url: "/api/v1/services?active=true",
      headers: headers(receptionToken),
    });
    expect(services.statusCode).toBe(200);
    expect(services.json().some((s: { id: string }) => s.id === serviceId)).toBe(true);

    const practitioners = await app.inject({
      method: "GET",
      url: "/api/v1/practitioners",
      headers: headers(receptionToken),
    });
    expect(practitioners.statusCode).toBe(200);
    expect(practitioners.json()[0]).toMatchObject({
      color: "#0F766E",
      defaultSlotMinutes: 30,
      bufferAfterMinutes: 5,
      isAcceptingNewPatients: true,
    });
  });

  it("admin actualiza duración y desactiva sin borrar", async () => {
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: headers(adminToken),
      payload: { durationMinutes: 60, isActive: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().durationMinutes).toBe(60);
    expect(updated.json().isActive).toBe(false);

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/services?active=true",
      headers: headers(receptionToken),
    });
    expect(active.json().some((s: { id: string }) => s.id === serviceId)).toBe(false);
  });

  it("admin crea especialidad y valida duplicado", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/specialties",
      headers: headers(adminToken),
      payload: { code: "CARDIO", name: "Cardiologia" },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/specialties",
      headers: headers(adminToken),
      payload: { code: "CARDIO", name: "Cardiologia" },
    });
    expect(duplicate.statusCode).toBe(409);
  });
});
