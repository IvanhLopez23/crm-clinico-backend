import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { createAvailabilityRule } from "../../src/modules/availability/service.js";
import { transitionAppointment } from "../../src/modules/appointments/transitions.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;
let app: ReturnType<typeof buildApp>;
let clinicId: string;
let serviceId: string;
let practitionerId: string;
let adminToken: string;
let adminId: string;
let slug: string;
let monday: string;

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  app = buildApp({ db: appDb, logger: false });

  clinicId = randomUUID();
  serviceId = randomUUID();
  practitionerId = randomUUID();
  slug = `clinica-publica-${clinicId.slice(0, 6)}`;
  monday = DateTime.now()
    .setZone(TZ)
    .plus({ days: 7 })
    .startOf("week")
    .toISODate() as string;

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Publica",
    slug,
    timezone: TZ,
  });
  await testDb.adminDb.insert(schema.clinicSlugs).values({ slug, clinicId });
  await testDb.adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Publica",
  });
  await testDb.adminDb.insert(schema.services).values({
    id: serviceId,
    clinicId,
    code: "PUB",
    name: "Consulta publica",
    durationMinutes: 30,
    priceCents: 80_000,
    currency: "MXN",
  });
  await createAvailabilityRule(appDb, {
    clinicId,
    practitionerId,
    weekday: 1,
    startTime: "09:00",
    endTime: "12:00",
    validFrom: monday,
    slotMinutes: 30,
  });

  const admin = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "admin",
  });
  adminToken = admin.token;
  adminId = admin.id;
}, 300_000);

afterAll(async () => {
  await app.close();
  await testDb?.close();
}, 60_000);

describe("portal publico y cobro", () => {
  it("expone la clinica publica por slug", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/clinics/${slug}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().clinic.name).toBe("Clinica Publica");
    expect(response.json().services).toHaveLength(1);
  });

  it("publica disponibilidad sin autenticacion", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        `/api/v1/public/clinics/${slug}/availability` +
        `?serviceId=${serviceId}&practitionerId=${practitionerId}&date=${monday}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().slots.length).toBeGreaterThan(0);
  });

  it("crea paciente y cita desde el portal publico", async () => {
    const slots = await app.inject({
      method: "GET",
      url:
        `/api/v1/public/clinics/${slug}/availability` +
        `?serviceId=${serviceId}&practitionerId=${practitionerId}&date=${monday}`,
    });
    const slot = slots.json().slots[0];

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/public/clinics/${slug}/appointments`,
      payload: {
        serviceId,
        practitionerId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        patient: {
          firstName: "Paciente",
          lastName: "Publico",
          phone: "+525512345678",
          email: "publico@test.local",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("requested");
    expect(response.json().serviceName).toBe("Consulta publica");
  });

  it("lista recordatorios generados por la cita", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reminders",
      headers: headers(adminToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().length).toBeGreaterThan(0);
    expect(response.json()[0]).toMatchObject({
      patientFirstName: "Paciente",
      patientLastName: "Publico",
    });
  });

  it("cobra y cierra una cita en consulta", async () => {
    const [appointment] = await testDb!.adminDb
      .select()
      .from(schema.appointments)
      .limit(1);

    const actor = {
      userId: adminId,
      role: "admin" as const,
      practitionerId: null,
    };
    for (const action of ["confirm", "check-in", "start"] as const) {
      await transitionAppointment(appDb, {
        clinicId,
        appointmentId: appointment!.id,
        action,
        actor,
        force: true,
      });
    }

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/appointments/${appointment!.id}/checkout`,
      headers: headers(adminToken),
      payload: { amountCents: 80_000, method: "card" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().appointment.status).toBe("completed");
    expect(response.json().payment.amountCents).toBe(80_000);
    expect(response.json().payment.method).toBe("card");
  });
});
