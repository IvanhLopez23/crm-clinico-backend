import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { SlotTakenError } from "../../src/lib/errors.js";
import { buildApp } from "../../src/app.js";
import {
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from "../../src/modules/appointments/service.js";
import { createAvailabilityRule } from "../../src/modules/availability/service.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;
let adminDb: Database;

let clinicId: string;
let practitionerId: string;
let patientId: string;
let monday: string;
let staffToken: string;

function at(isoDate: string, time: string): Date {
  return new Date(`${isoDate}T${time}:00-06:00`);
}

function plusMinutes(time: string, minutes: number): string {
  const [h = "0", m = "0"] = time.split(":");
  const total = Number(h) * 60 + Number(m) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

async function book(
  time: string,
  options: { bookedVia?: "public" | "staff"; isOverbooking?: boolean } = {},
) {
  return bookAppointment(appDb, {
    clinicId,
    patientId,
    practitionerId,
    startsAt: at(monday, time),
    endsAt: at(monday, plusMinutes(time, 30)),
    timezone: TZ,
    ...options,
  });
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  adminDb = testDb.adminDb;

  clinicId = randomUUID();
  practitionerId = randomUUID();
  patientId = randomUUID();

  monday = DateTime.now()
    .setZone(TZ)
    .plus({ days: 7 })
    .startOf("week")
    .toISODate() as string;

  await adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Ciclo de Vida",
    timezone: TZ,
  });

  await adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Ciclo",
  });

  await adminDb.insert(schema.patients).values({
    id: patientId,
    clinicId,
    firstName: "Paciente",
    lastName: "Ciclo",
    phoneE164: "+525512345678",
  });

  await createAvailabilityRule(appDb, {
    clinicId,
    practitionerId,
    weekday: 1,
    startTime: "09:00",
    endTime: "12:00",
    validFrom: monday,
    slotMinutes: 15,
  });

  const staff = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  staffToken = staff.token;
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("reserva: disponibilidad y origen", () => {
  it("acepta una reserva publica dentro de la regla", async () => {
    const appointment = await book("09:00", { bookedVia: "public" });

    expect(appointment.bookedVia).toBe("public");
    expect(appointment.status).toBe("requested");
  });

  it("rechaza una reserva publica fuera de la disponibilidad", async () => {
    await expect(book("12:30", { bookedVia: "public" })).rejects.toMatchObject({
      code: "SLOT_NOT_AVAILABLE",
    });
  });

  it("permite al staff forzar un horario fuera de la regla", async () => {
    const appointment = await book("13:00", { bookedVia: "staff" });

    expect(appointment.bookedVia).toBe("staff");
    expect(appointment.status).toBe("requested");
  });

  it("el publico no puede crear sobrecupos", async () => {
    await expect(
      book("09:30", { bookedVia: "public", isOverbooking: true }),
    ).rejects.toMatchObject({ code: "OVERBOOKING_FORBIDDEN" });
  });
});

describe("cancelacion", () => {
  it("cancela la cita y sus recordatorios pendientes", async () => {
    const appointment = await book("10:00");

    const cancelled = await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(cancelled.cancelledBy).toBe("staff");
    expect(cancelled.cancellationReasonCode).toBe("patient_request");

    const jobs = await adminDb
      .select()
      .from(schema.reminderJobs)
      .where(eq(schema.reminderJobs.appointmentId, appointment.id));

    // Booking materializa 48h/24h/2h; la cancelacion los apaga todos.
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.status === "cancelled")).toBe(true);
  });

  it("cancelar dos veces es idempotente", async () => {
    const appointment = await book("09:30");

    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    const again = await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    expect(again.id).toBe(appointment.id);
    expect(again.status).toBe("cancelled");
  });

  it("no permite cancelar una cita completada", async () => {
    const appointment = await book("11:00");
    const now = new Date();

    // La cita debe recorrer la maquina de estados; el trigger impide saltar
    // de requested a completed.
    await adminDb
      .update(schema.appointments)
      .set({ status: "confirmed", confirmedAt: now })
      .where(eq(schema.appointments.id, appointment.id));
    await adminDb
      .update(schema.appointments)
      .set({ status: "arrived", checkedInAt: now })
      .where(eq(schema.appointments.id, appointment.id));
    await adminDb
      .update(schema.appointments)
      .set({ status: "in_consultation", consultStartedAt: now })
      .where(eq(schema.appointments.id, appointment.id));
    await adminDb
      .update(schema.appointments)
      .set({ status: "completed", consultEndedAt: now })
      .where(eq(schema.appointments.id, appointment.id));

    await expect(
      cancelAppointment(appDb, {
        clinicId,
        appointmentId: appointment.id,
        reasonCode: "other",
        cancelledBy: "staff",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("devuelve 404 si la cita no existe en la clinica", async () => {
    await expect(
      cancelAppointment(appDb, {
        clinicId,
        appointmentId: randomUUID(),
        reasonCode: "other",
        cancelledBy: "staff",
      }),
    ).rejects.toMatchObject({ code: "APPOINTMENT_NOT_FOUND" });
  });

  it("expone la cancelacion por HTTP y registra al actor", async () => {
    const app = buildApp({ db: appDb, logger: false });
    const appointment = await book("15:00", { bookedVia: "staff" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/appointments/${appointment.id}/cancel`,
      headers: {
        authorization: `Bearer ${staffToken}`,
      },
      payload: { reasonCode: "patient_request" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelled");
    expect(response.json().cancelledBy).toBe("staff");

    await app.close();
  });
});

describe("reagendado", () => {
  it("crea una cita nueva encadenada y cancela la anterior", async () => {
    const original = await book("12:00", { bookedVia: "staff" });

    const rescheduled = await rescheduleAppointment(appDb, {
      clinicId,
      appointmentId: original.id,
      startsAt: at(monday, "12:30"),
      endsAt: at(monday, "13:00"),
      timezone: TZ,
      bookedVia: "staff",
      cancelledBy: "staff",
    });

    expect(rescheduled.id).not.toBe(original.id);
    expect(rescheduled.rescheduledFromId).toBe(original.id);
    expect(rescheduled.status).toBe("requested");

    const [previous] = await adminDb
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, original.id));

    expect(previous?.status).toBe("cancelled");
    expect(previous?.cancellationReasonCode).toBe("rescheduled");

    const jobs = await adminDb
      .select()
      .from(schema.reminderJobs)
      .where(eq(schema.reminderJobs.appointmentId, original.id));
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.status === "cancelled")).toBe(true);
  });

  it("si el nuevo horario esta ocupado, la cita original no se toca", async () => {
    // Fuera de la regla: el staff puede forzar, asi el test no depende del
    // estado que dejaron los casos anteriores.
    const moved = await book("14:00", { bookedVia: "staff" });
    await book("14:30", { bookedVia: "staff" });

    await expect(
      rescheduleAppointment(appDb, {
        clinicId,
        appointmentId: moved.id,
        startsAt: at(monday, "14:30"),
        endsAt: at(monday, "15:00"),
        timezone: TZ,
        bookedVia: "staff",
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);

    const [stillActive] = await adminDb
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, moved.id));

    expect(stillActive?.status).toBe("requested");
    expect(stillActive?.cancelledAt).toBeNull();
  });

  it("no permite reagendar una cita cancelada", async () => {
    const appointment = await book("10:15");

    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    await expect(
      rescheduleAppointment(appDb, {
        clinicId,
        appointmentId: appointment.id,
        startsAt: at(monday, "10:45"),
        endsAt: at(monday, "11:15"),
        timezone: TZ,
      }),
    ).rejects.toMatchObject({ code: "ALREADY_CANCELLED" });
  });
});
