import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { createAvailabilityRule } from "../../src/modules/availability/service.js";
import {
  createStaffUser,
  type TestUser,
} from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;

let clinicId: string;
let patientId: string;
let practitionerA: string;
let practitionerB: string;
let monday: string;

let admin: TestUser;
let receptionist: TestUser;
let doctorA: TestUser;

function at(time: string): Date {
  return new Date(`${monday}T${time}:00-06:00`);
}

function payload(practitionerId: string, time: string) {
  const startsAt = at(time);
  return {
    patientId,
    practitionerId,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
    timezone: TZ,
  };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;

  clinicId = randomUUID();
  patientId = randomUUID();
  practitionerA = randomUUID();
  practitionerB = randomUUID();

  monday = DateTime.now()
    .setZone(TZ)
    .plus({ days: 7 })
    .startOf("week")
    .toISODate() as string;

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Auth",
    timezone: TZ,
  });

  await testDb.adminDb.insert(schema.practitioners).values([
    { id: practitionerA, clinicId, fullName: "Dra. A" },
    { id: practitionerB, clinicId, fullName: "Dr. B" },
  ]);

  await testDb.adminDb.insert(schema.patients).values({
    id: patientId,
    clinicId,
    firstName: "Paciente",
    lastName: "Auth",
    phoneE164: "+5215512345678",
    email: "auth@example.com",
  });

  for (const practitionerId of [practitionerA, practitionerB]) {
    await createAvailabilityRule(appDb, {
      clinicId,
      practitionerId,
      weekday: 1,
      startTime: "09:00",
      endTime: "12:00",
      validFrom: monday,
      slotMinutes: 15,
    });
  }

  admin = await createStaffUser(testDb.adminDb, { clinicId, role: "admin" });
  receptionist = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  doctorA = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "practitioner",
    practitionerId: practitionerA,
  });
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("autenticacion", () => {
  it("hace login y devuelve el perfil", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: admin.email, password: admin.password },
    });

    expect(login.statusCode).toBe(200);
    const body = login.json();
    expect(body.token).toBeTruthy();
    expect(body.user.role).toBe("admin");

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().userId).toBe(admin.id);
    expect(me.json().clinicId).toBe(clinicId);

    await app.close();
  });

  it("rechaza credenciales invalidas", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: admin.email, password: "password-incorrecta" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS");

    await app.close();
  });

  it("exige token en rutas de staff", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/waitlist",
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe("rbac", () => {
  it("recepcion no puede leer la auditoria; admin si", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/audit",
      headers: { authorization: `Bearer ${receptionist.token}` },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/audit",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(Array.isArray(allowed.json())).toBe(true);

    await app.close();
  });

  it("un medico no puede cancelar la cita de otro", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/appointments",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: payload(practitionerB, "10:00"),
    });
    expect(created.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/appointments/${created.json().id}/cancel`,
      headers: { authorization: `Bearer ${doctorA.token}` },
      payload: { reasonCode: "other" },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");

    await app.close();
  });
});

describe("portal publico y auditoria", () => {
  it("permite reservar sin token y lo registra como publico", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/appointments",
      headers: { "x-clinic-id": clinicId },
      payload: payload(practitionerA, "09:00"),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().bookedVia).toBe("public");

    await app.close();
  });

  it("el staff puede forzar un horario fuera de la regla", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/appointments",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: payload(practitionerA, "14:00"),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().bookedVia).toBe("staff");

    await app.close();
  });

  it("escribe eventos con cadena de hash verificable", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/audit?limit=200",
      headers: { authorization: `Bearer ${admin.token}` },
    });

    expect(response.statusCode).toBe(200);
    const events = response.json() as Array<{
      seq: number;
      prevHash: string | null;
      hash: string;
      action: string;
      actorType: string;
    }>;

    expect(events.length).toBeGreaterThan(0);

    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]?.prevHash).toBe(ordered[i - 1]?.hash);
    }

    const creations = ordered.filter((e) => e.action === "appointment.create");
    expect(creations.length).toBeGreaterThanOrEqual(2);
    expect(creations.some((e) => e.actorType === "public")).toBe(true);
    expect(creations.some((e) => e.actorType === "user")).toBe(true);

    await app.close();
  });
});
