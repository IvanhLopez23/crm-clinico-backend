import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;
let app: ReturnType<typeof buildApp>;

let clinicId: string;
let adminToken: string;
let receptionToken: string;
let practitionerId: string;
let serviceId: string;
let patientId: string;
let monday: string;

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function plusDays(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: TZ })
    .plus({ days })
    .toISODate() as string;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  app = buildApp({ db: appDb, logger: false });

  clinicId = randomUUID();
  patientId = randomUUID();
  monday = DateTime.now()
    .setZone(TZ)
    .plus({ days: 7 })
    .startOf("week")
    .toISODate() as string;

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Servicios Propios",
    timezone: TZ,
  });
  await testDb.adminDb.insert(schema.patients).values({
    id: patientId,
    clinicId,
    firstName: "Paciente",
    lastName: "Servicios",
  });

  const admin = await createStaffUser(testDb.adminDb, { clinicId, role: "admin" });
  const reception = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  adminToken = admin.token;
  receptionToken = reception.token;

  const practitioner = await app.inject({
    method: "POST",
    url: "/api/v1/practitioners",
    headers: headers(adminToken),
    payload: { fullName: "Dra. Propios", specialty: "General" },
  });
  expect(practitioner.statusCode).toBe(201);
  practitionerId = practitioner.json().id;

  const service = await app.inject({
    method: "POST",
    url: "/api/v1/services",
    headers: headers(adminToken),
    payload: {
      code: "PROPIO",
      name: "Consulta propia",
      durationMinutes: 30,
      priceCents: 100_000,
    },
  });
  expect(service.statusCode).toBe(201);
  serviceId = service.json().id;

  const rule = await app.inject({
    method: "POST",
    url: "/api/v1/availability/rules",
    headers: headers(adminToken),
    payload: {
      practitionerId,
      weekday: 1,
      startTime: "09:00",
      endTime: "12:00",
      validFrom: monday,
      slotMinutes: 15,
    },
  });
  expect(rule.statusCode).toBe(201);
}, 300_000);

afterAll(async () => {
  await app.close();
  await testDb?.close();
}, 60_000);

describe("servicios por especialista", () => {
  it("asigna el servicio nuevo al especialista con sus valores base", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/practitioner-services?practitionerId=${practitionerId}`,
      headers: headers(receptionToken),
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{
      serviceId: string;
      durationMinutes: number;
      priceCents: number;
      isActive: boolean;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serviceId,
      durationMinutes: 30,
      priceCents: 100_000,
      isActive: true,
    });
  });

  it("recepción no puede cambiar precio ni duración", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/practitioners/${practitionerId}/services`,
      headers: headers(receptionToken),
      payload: { serviceId, durationMinutes: 45, priceCents: 150_000 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("admin ajusta duración y precio propios", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/practitioners/${practitionerId}/services`,
      headers: headers(adminToken),
      payload: { serviceId, durationMinutes: 45, priceCents: 150_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      serviceId,
      durationMinutes: 45,
      priceCents: 150_000,
      isActive: true,
    });
  });

  it("la disponibilidad usa la duración y precio del especialista", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        `/api/v1/availability?practitionerId=${practitionerId}` +
        `&serviceId=${serviceId}&from=${monday}&to=${plusDays(monday, 1)}`,
      headers: headers(receptionToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service.priceCents).toBe(150_000);
    expect(body.slots).toHaveLength(10);

    const first = body.slots[0];
    const minutes =
      (new Date(first.endsAt).getTime() - new Date(first.startsAt).getTime()) /
      60_000;
    expect(minutes).toBe(45);
  });

  it("la cita guarda snapshots del precio y duración propios", async () => {
    const startsAt = `${monday}T09:00:00-06:00`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/appointments",
      headers: headers(receptionToken),
      payload: {
        patientId,
        practitionerId,
        serviceId,
        startsAt,
        endsAt: `${monday}T09:45:00-06:00`,
        timezone: TZ,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      serviceId,
      durationMinutesSnapshot: 45,
      priceCentsSnapshot: 150_000,
      currencySnapshot: "MXN",
    });
  });

  it("admin agrega un servicio escribiendo el nombre libre", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/practitioners/${practitionerId}/services`,
      headers: headers(adminToken),
      payload: {
        serviceName: "Valoración express",
        durationMinutes: 20,
        priceCents: 50_000,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      name: "Valoración express",
      durationMinutes: 20,
      priceCents: 50_000,
      isActive: true,
    });
    expect(body.code).toMatch(/^PX-/);

    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/services?active=true",
      headers: headers(adminToken),
    });
    expect(
      catalog
        .json()
        .some((service: { name: string }) => service.name === "Valoración express"),
    ).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/practitioner-services?practitionerId=${practitionerId}`,
      headers: headers(adminToken),
    });
    expect(list.json()).toHaveLength(2);
  });

  it("admin puede quitar un servicio del especialista", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/practitioner-services?practitionerId=${practitionerId}`,
      headers: headers(adminToken),
    });

    for (const assignment of list.json() as Array<{ id: string }>) {
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/practitioner-services/${assignment.id}`,
        headers: headers(adminToken),
      });
      expect(deleted.statusCode).toBe(204);
    }

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/practitioner-services?practitionerId=${practitionerId}`,
      headers: headers(adminToken),
    });
    expect(after.json()).toHaveLength(0);
  });
});
