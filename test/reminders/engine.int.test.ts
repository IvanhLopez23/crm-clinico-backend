import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import {
  bookAppointment,
  cancelAppointment,
} from "../../src/modules/appointments/service.js";
import { processDueReminders } from "../../src/modules/reminders/engine.js";
import type {
  MessageSender,
  OutboundMessage,
} from "../../src/modules/reminders/sender.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";
const PHONE = "+5215512345678";
const EMAIL = "paciente@example.com";

let testDb: TestDatabase | undefined;
let appDb: Database;
let workerDb: Database;

let clinicId: string;
let practitionerId: string;
let patientId: string;
let optOutPatientId: string;

function dateIn(days: number): string {
  return DateTime.now().setZone(TZ).plus({ days }).toISODate() as string;
}

async function bookAt(
  daysAhead: number,
  options: { patientId?: string; time?: string; durationMinutes?: number } = {},
) {
  const day = dateIn(daysAhead);
  const startsAt = new Date(`${day}T${options.time ?? "10:00"}:00-06:00`);
  const endsAt = new Date(
    startsAt.getTime() + (options.durationMinutes ?? 30) * 60_000,
  );

  return bookAppointment(appDb, {
    clinicId,
    patientId: options.patientId ?? patientId,
    practitionerId,
    startsAt,
    endsAt,
    timezone: TZ,
    bookedVia: "staff",
  });
}

async function jobsFor(appointmentId: string) {
  return workerDb
    .select()
    .from(schema.reminderJobs)
    .where(eq(schema.reminderJobs.appointmentId, appointmentId));
}

async function makeDue(jobId: string, now: Date): Promise<void> {
  await workerDb
    .update(schema.reminderJobs)
    .set({ scheduledFor: new Date(now.getTime() - 60_000) })
    .where(eq(schema.reminderJobs.id, jobId));
}

type RecordingSender = MessageSender & { messages: OutboundMessage[] };

function recordingSender(shouldFail = false): RecordingSender {
  const messages: OutboundMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
      if (shouldFail) return { ok: false, errorCode: "provider_down" };
      return { ok: true, providerMessageId: `test:${message.jobId}` };
    },
  };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  // El worker corre con un rol BYPASSRLS; en tests usamos el superusuario.
  workerDb = testDb.adminDb;

  clinicId = randomUUID();
  practitionerId = randomUUID();
  patientId = randomUUID();
  optOutPatientId = randomUUID();

  await workerDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Recordatorios",
    timezone: TZ,
  });

  await workerDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Recordatorio",
  });

  await workerDb.insert(schema.patients).values([
    {
      id: patientId,
      clinicId,
      firstName: "Paciente",
      lastName: "Recordado",
      phoneE164: PHONE,
      email: EMAIL,
    },
    {
      id: optOutPatientId,
      clinicId,
      firstName: "Paciente",
      lastName: "SinMensajes",
      phoneE164: PHONE,
      email: EMAIL,
      reminderOptOut: true,
    },
  ]);
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("motor de recordatorios", () => {
  it("la reserva materializa 48h, 24h y 2h", async () => {
    const appointment = await bookAt(10);
    const jobs = await jobsFor(appointment.id);

    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.templateCode).sort()).toEqual([
      "reminder_24h",
      "reminder_2h",
      "reminder_48h",
    ]);
    expect(jobs.map((j) => j.channel).sort()).toEqual([
      "whatsapp",
      "whatsapp",
      "whatsapp",
    ]);
    expect(jobs.every((j) => j.status === "pending")).toBe(true);
  });

  it("no crea recordatorios si el paciente pidio no recibirlos", async () => {
    const appointment = await bookAt(9, { patientId: optOutPatientId });

    expect(await jobsFor(appointment.id)).toHaveLength(0);
  });

  it("envia un recordatorio vencido y lo marca como sent", async () => {
    const appointment = await bookAt(11);
    const [job] = await jobsFor(appointment.id);
    if (!job) throw new Error("job no creado");

    const now = new Date();
    await makeDue(job.id, now);

    const sender = recordingSender();
    const summary = await processDueReminders(workerDb, { sender, now });

    expect(summary.claimed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]?.to).toBe(PHONE);
    expect(sender.messages[0]?.body).toContain("Paciente");

    const [updated] = await jobsFor(appointment.id).then((jobs) =>
      jobs.filter((j) => j.id === job.id),
    );
    expect(updated?.status).toBe("sent");
    expect(updated?.attempts).toBe(1);
    expect(updated?.sentAt).toBeInstanceOf(Date);
  });

  it("no reenvia un job ya enviado", async () => {
    const now = new Date();
    const sender = recordingSender();
    const summary = await processDueReminders(workerDb, { sender, now });

    expect(summary.claimed).toBe(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("reintenta con backoff y al tercer fallo crea fallback de canal", async () => {
    const appointment = await bookAt(12);
    const jobs = await jobsFor(appointment.id);
    const job = jobs.find((j) => j.templateCode === "reminder_48h");
    if (!job) throw new Error("job 48h no creado");

    const t0 = new Date();
    await makeDue(job.id, t0);

    const failing = recordingSender(true);

    const first = await processDueReminders(workerDb, {
      sender: failing,
      now: t0,
    });
    expect(first.retried).toBe(1);

    let current = (await jobsFor(appointment.id)).find((j) => j.id === job.id);
    expect(current?.status).toBe("pending");
    expect(current?.attempts).toBe(1);
    expect(current?.errorCode).toBe("provider_down");

    const t1 = new Date(t0.getTime() + 2 * 60_000);
    const second = await processDueReminders(workerDb, {
      sender: failing,
      now: t1,
    });
    expect(second.retried).toBe(1);

    const t2 = new Date(t0.getTime() + 10 * 60_000);
    const third = await processDueReminders(workerDb, {
      sender: failing,
      now: t2,
    });
    expect(third.failed).toBe(1);

    current = (await jobsFor(appointment.id)).find((j) => j.id === job.id);
    expect(current?.status).toBe("failed");
    expect(current?.attempts).toBe(3);

    const fallback = (await jobsFor(appointment.id)).find(
      (j) =>
        j.id !== job.id &&
        j.status === "pending" &&
        j.templateCode === "reminder_48h" &&
        j.channel === "email",
    );
    expect(fallback).toBeDefined();
    expect(fallback?.status).toBe("pending");
  });

  it("cancela el envio si el paciente se dio de baja despues de reservar", async () => {
    const appointment = await bookAt(13);
    const [job] = await jobsFor(appointment.id);
    if (!job) throw new Error("job no creado");

    const now = new Date();
    await makeDue(job.id, now);

    await workerDb
      .update(schema.patients)
      .set({ reminderOptOut: true })
      .where(eq(schema.patients.id, patientId));

    const sender = recordingSender();
    const summary = await processDueReminders(workerDb, { sender, now });

    expect(summary.cancelled).toBeGreaterThanOrEqual(1);
    expect(sender.messages).toHaveLength(0);

    const [cancelled] = (await jobsFor(appointment.id)).filter(
      (j) => j.id === job.id,
    );
    expect(cancelled?.status).toBe("cancelled");

    await workerDb
      .update(schema.patients)
      .set({ reminderOptOut: false })
      .where(eq(schema.patients.id, patientId));
  });

  it("cancelar la cita cancela sus recordatorios pendientes", async () => {
    const appointment = await bookAt(14);
    const [job] = await jobsFor(appointment.id);
    if (!job) throw new Error("job no creado");

    const now = new Date();
    await makeDue(job.id, now);

    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    const afterCancel = await jobsFor(appointment.id);
    expect(afterCancel.every((j) => j.status === "cancelled")).toBe(true);

    const sender = recordingSender();
    const summary = await processDueReminders(workerDb, { sender, now });

    expect(summary.claimed).toBe(0);
    expect(sender.messages).toHaveLength(0);
  });
});
