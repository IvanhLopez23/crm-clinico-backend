import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let testDb: TestDatabase | undefined;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let receptionToken: string;
let clinicId: string;
let practitionerId: string;
let ruleId: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = buildApp({ db: testDb.appDb, logger: false });

  clinicId = randomUUID();
  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Especialistas",
    timezone: "America/Mexico_City",
  });

  const admin = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "admin",
  });
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

describe("especialistas y disponibilidad", () => {
  it("admin crea un especialista", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/practitioners",
      headers: headers(adminToken),
      payload: {
        fullName: "Dra. Nueva",
        specialty: "Dermatologia",
        color: "#2563EB",
        defaultSlotMinutes: 45,
        bufferAfterMinutes: 10,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.fullName).toBe("Dra. Nueva");
    expect(body.defaultSlotMinutes).toBe(45);
    expect(body.isActive).toBe(true);
    practitionerId = body.id;
  });

  it("recepción puede listar pero no crear", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/practitioners",
      headers: headers(receptionToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((p: { id: string }) => p.id === practitionerId)).toBe(
      true,
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/practitioners",
      headers: headers(receptionToken),
      payload: { fullName: "No permitido" },
    });
    expect(created.statusCode).toBe(403);
  });

  it("admin edita y desactiva; incluye inactivos bajo demanda", async () => {
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/practitioners/${practitionerId}`,
      headers: headers(adminToken),
      payload: { fullName: "Dra. Editada", isActive: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().fullName).toBe("Dra. Editada");
    expect(updated.json().isActive).toBe(false);

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/practitioners",
      headers: headers(receptionToken),
    });
    expect(active.json().some((p: { id: string }) => p.id === practitionerId)).toBe(
      false,
    );

    const all = await app.inject({
      method: "GET",
      url: "/api/v1/practitioners?includeInactive=true",
      headers: headers(receptionToken),
    });
    expect(all.json().some((p: { id: string }) => p.id === practitionerId)).toBe(
      true,
    );
  });

  it("crea, edita y elimina una regla semanal", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/practitioners/${practitionerId}`,
      headers: headers(adminToken),
      payload: { isActive: true },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/availability/rules",
      headers: headers(adminToken),
      payload: {
        practitionerId,
        weekday: 1,
        startTime: "09:00",
        endTime: "12:00",
        validFrom: "2026-11-01",
        slotMinutes: 30,
      },
    });
    expect(created.statusCode).toBe(201);
    ruleId = created.json().id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/availability/rules/${ruleId}`,
      headers: headers(adminToken),
      payload: { endTime: "14:00", slotMinutes: 15 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().endTime).toBe("14:00:00");
    expect(updated.json().slotMinutes).toBe(15);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/availability/rules?practitionerId=${practitionerId}`,
      headers: headers(receptionToken),
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].endTime).toBe("14:00:00");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/availability/rules/${ruleId}`,
      headers: headers(adminToken),
    });
    expect(deleted.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/availability/rules?practitionerId=${practitionerId}`,
      headers: headers(receptionToken),
    });
    expect(after.json()).toHaveLength(0);
  });

  it("crea un horario semanal con comida en varios días", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/availability/rules/bulk",
      headers: headers(adminToken),
      payload: {
        practitionerId,
        weekdays: [1, 3, 5],
        startTime: "08:00",
        endTime: "18:00",
        lunchStart: "12:00",
        lunchEnd: "14:00",
        slotMinutes: 15,
        validFrom: "2026-12-01",
      },
    });

    expect(created.statusCode).toBe(201);
    const rules = created.json().rules as Array<{
      weekday: number;
      startTime: string;
      endTime: string;
      label: string | null;
    }>;
    expect(rules).toHaveLength(6);
    expect(rules.map((rule) => rule.weekday)).toEqual([1, 1, 3, 3, 5, 5]);
    expect(rules.map((rule) => rule.startTime)).toEqual([
      "08:00:00",
      "14:00:00",
      "08:00:00",
      "14:00:00",
      "08:00:00",
      "14:00:00",
    ]);
    expect(rules.map((rule) => rule.endTime)).toEqual([
      "12:00:00",
      "18:00:00",
      "12:00:00",
      "18:00:00",
      "12:00:00",
      "18:00:00",
    ]);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/availability/rules?practitionerId=${practitionerId}`,
      headers: headers(receptionToken),
    });
    expect(
      (list.json() as Array<{ validFrom: string }>).filter(
        (rule) => rule.validFrom === "2026-12-01",
      ),
    ).toHaveLength(6);
  });

  it("crea un horario continuo cuando no hay comida", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/availability/rules/bulk",
      headers: headers(adminToken),
      payload: {
        practitionerId,
        weekdays: [2],
        startTime: "09:00",
        endTime: "13:00",
        slotMinutes: 30,
        validFrom: "2027-01-01",
      },
    });

    expect(created.statusCode).toBe(201);
    const rules = created.json().rules as Array<{
      startTime: string;
      endTime: string;
    }>;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.startTime).toBe("09:00:00");
    expect(rules[0]?.endTime).toBe("13:00:00");
  });

  it("no permite duplicar el horario semanal", async () => {
    const duplicated = await app.inject({
      method: "POST",
      url: "/api/v1/availability/rules/bulk",
      headers: headers(adminToken),
      payload: {
        practitionerId,
        weekdays: [1],
        startTime: "08:00",
        endTime: "18:00",
        lunchStart: "12:00",
        lunchEnd: "14:00",
        validFrom: "2026-12-01",
      },
    });

    expect(duplicated.statusCode).toBe(409);
    expect(duplicated.json().error.code).toBe("RULE_DUPLICATED");
  });

  it("rechaza una comida fuera del horario laboral", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/availability/rules/bulk",
      headers: headers(adminToken),
      payload: {
        practitionerId,
        weekdays: [4],
        startTime: "08:00",
        endTime: "18:00",
        lunchStart: "07:00",
        lunchEnd: "09:00",
        validFrom: "2026-12-01",
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
