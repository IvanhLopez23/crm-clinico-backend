import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { bookAppointment } from "../../src/modules/appointments/service.js";
import {
  transitionAppointment,
  type TransitionActor,
} from "../../src/modules/appointments/transitions.js";
import {
  createAvailabilityRule,
  getAvailability,
} from "../../src/modules/availability/service.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;
let app: ReturnType<typeof buildApp>;

let clinicId: string;
let practitionerId: string;
let patientId: string;
let serviceId: string;
let adminActor: TransitionActor;
let receptionActor: TransitionActor;
let receptionToken: string;

function at(minutesFromNow: number, duration = 30): { startsAt: Date; endsAt: Date } {
  const starts = DateTime.now().setZone(TZ).plus({ minutes: minutesFromNow });
  return {
    startsAt: starts.toUTC().toJSDate(),
    endsAt: starts.plus({ minutes: duration }).toUTC().toJSDate(),
  };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  app = buildApp({ db: appDb, logger: false });

  clinicId = randomUUID();
  practitionerId = randomUUID();
  patientId = randomUUID();
  serviceId = randomUUID();

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Transiciones",
    timezone: TZ,
  });

  await testDb.adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Transicion",
    specialty: "Medicina general",
  });

  await testDb.adminDb.insert(schema.patients).values({
    id: patientId,
    clinicId,
    firstName: "Paciente",
    lastName: "Transicion",
  });

  await testDb.adminDb.insert(schema.services).values({
    id: serviceId,
    clinicId,
    code: "TRANS",
    name: "Consulta con buffer",
    durationMinutes: 45,
    bufferAfterMinutes: 10,
    priceCents: 50_000,
    currency: "MXN",
  });

  const admin = await createStaffUser(testDb.adminDb, { clinicId, role: "admin" });
  const reception = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  adminActor = { userId: admin.id, role: "admin", practitionerId: null };
  receptionActor = {
    userId: reception.id,
    role: "receptionist",
    practitionerId: null,
  };
  receptionToken = reception.token;
}, 300_000);

afterAll(async () => {
  await app.close();
  await testDb?.close();
}, 60_000);

async function book(minutesFromNow: number, confirm = true) {
  const { startsAt, endsAt } = at(minutesFromNow, 45);
  return bookAppointment(appDb, {
    clinicId,
    patientId,
    practitionerId,
    serviceId,
    startsAt,
    endsAt,
    timezone: TZ,
    bookedVia: "staff",
    confirm,
    bookedByUserId: adminActor.userId,
  });
}

describe("booking v2 y transiciones", () => {
  it("guarda snapshots del servicio y el bloque ocupado", async () => {
    const appointment = await book(600);

    expect(appointment.serviceId).toBe(serviceId);
    expect(appointment.serviceNameSnapshot).toBe("Consulta con buffer");
    expect(appointment.durationMinutesSnapshot).toBe(45);
    expect(appointment.bufferAfterMinutesSnapshot).toBe(10);
    expect(appointment.priceCentsSnapshot).toBe(50_000);
    expect(appointment.status).toBe("confirmed");
    expect(appointment.householdId).toBeNull();
  });

  it("bloquea el buffer y permite justo después", async () => {
    const base = await book(800);

    const { startsAt } = at(845, 45);
    const endsAt = new Date(startsAt.getTime() + 45 * 60_000);

    await expect(
      bookAppointment(appDb, {
        clinicId,
        patientId,
        practitionerId,
        serviceId,
        startsAt,
        endsAt,
        timezone: TZ,
        bookedVia: "staff",
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "BUFFER_CONFLICT" });

    const afterBuffer = new Date(startsAt.getTime() + 10 * 60_000);
    const ok = await bookAppointment(appDb, {
      clinicId,
      patientId,
      practitionerId,
      serviceId,
      startsAt: afterBuffer,
      endsAt: new Date(afterBuffer.getTime() + 45 * 60_000),
      timezone: TZ,
      bookedVia: "staff",
      confirm: true,
    });
    expect(ok.id).toBeTruthy();
    expect(ok.id).not.toBe(base.id);
  });

  it("recorre requested → confirmed → arrived → in_consultation → completed", async () => {
    const appointment = await book(500, false);
    expect(appointment.status).toBe("requested");
    const visitTime = DateTime.now()
      .setZone(TZ)
      .plus({ minutes: 500 })
      .toJSDate();

    const arrived = await transitionAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      action: "check-in",
      actor: receptionActor,
      source: "reception",
      now: visitTime,
    });

    expect(arrived.status).toBe("arrived");
    expect(arrived.checkedInAt).toBeInstanceOf(Date);
    expect(arrived.confirmedAt).toBeInstanceOf(Date);

    const roomed = await transitionAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      action: "room",
      actor: receptionActor,
      now: visitTime,
    });
    expect(roomed.roomedAt).toBeInstanceOf(Date);

    const started = await transitionAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      action: "start",
      actor: receptionActor,
      now: visitTime,
    });
    expect(started.status).toBe("in_consultation");

    const completed = await transitionAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      action: "complete",
      actor: receptionActor,
      now: visitTime,
    });
    expect(completed.status).toBe("completed");
    expect(completed.consultEndedAt).toBeInstanceOf(Date);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/appointments/${appointment.id}/history`,
      headers: { authorization: `Bearer ${receptionToken}` },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().length).toBeGreaterThanOrEqual(5);
  });

  it("rechaza check-in fuera de ventana y permite override de admin", async () => {
    const appointment = await book(1000);

    await expect(
      transitionAppointment(appDb, {
        clinicId,
        appointmentId: appointment.id,
        action: "check-in",
        actor: receptionActor,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "CHECKIN_WINDOW_CLOSED" });

    const forced = await transitionAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      action: "check-in",
      actor: adminActor,
      force: true,
      now: new Date(),
    });
    expect(forced.status).toBe("arrived");
  });

  it("no permite no-show antes de la gracia y sí después", async () => {
    const appointment = await book(300);

    await expect(
      transitionAppointment(appDb, {
        clinicId,
        appointmentId: appointment.id,
        action: "no-show",
        actor: receptionActor,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "NO_SHOW_TOO_EARLY" });

    const marked = await transitionAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      action: "no-show",
      actor: receptionActor,
      reason: "no llego",
      now: DateTime.now().setZone(TZ).plus({ minutes: 325 }).toJSDate(),
    });
    expect(marked.status).toBe("no_show");
  });

  it("no permite no-show si ya está en sala sin override", async () => {
    const appointment = await book(1200, false);
    const checkInAt = DateTime.now().setZone(TZ).plus({ minutes: 1200 }).toJSDate();
    await transitionAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      action: "check-in",
      actor: receptionActor,
      now: checkInAt,
    });

    await expect(
      transitionAppointment(appDb, {
        clinicId,
        appointmentId: appointment.id,
        action: "no-show",
        actor: receptionActor,
        now: checkInAt,
      }),
    ).rejects.toMatchObject({ code: "NO_SHOW_CHECKED_IN" });
  });

  it("la disponibilidad usa duración, buffers y servicio", async () => {
    const monday = DateTime.now()
      .setZone(TZ)
      .plus({ days: 7 })
      .startOf("week")
      .toISODate() as string;
    const nextDay = DateTime.fromISO(monday, { zone: TZ })
      .plus({ days: 1 })
      .toISODate() as string;

    await createAvailabilityRule(appDb, {
      clinicId,
      practitionerId,
      weekday: 1,
      startTime: "09:00",
      endTime: "12:00",
      validFrom: monday,
      slotMinutes: 15,
    });

    const availability = await getAvailability(appDb, {
      clinicId,
      practitionerId,
      serviceId,
      from: monday,
      to: nextDay,
      durationMinutes: 30,
    });

    expect(availability.service).toMatchObject({
      id: serviceId,
      name: "Consulta con buffer",
      priceCents: 50_000,
      currency: "MXN",
    });
    expect(availability.slots.length).toBeGreaterThan(0);
    expect(availability.slots[0]?.startsAt).toBeInstanceOf(Date);
  });
});
