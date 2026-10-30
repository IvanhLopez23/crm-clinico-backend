import type { Transaction } from "../../db/client.js";
import { reminderJobs } from "../../db/schema/reminder-jobs.js";
import { computeReminderSchedules, type ScheduledReminder, type ReminderChannel } from "./schedule.js";

export type ReminderTarget = {
  appointmentId: string;
  clinicId: string;
  startsAt: Date;
  timezone: string;
  patientStatus: string;
  patientOptOut: boolean;
  patientPhone: string | null;
  patientEmail: string | null;
};

/**
 * Materializa los recordatorios de una cita. Se llama dentro de la misma
 * transaccion que crea la cita: si la reserva falla, no quedan jobs huerfanos.
 *
 * Prioriza WhatsApp si el paciente dejo telefono; si no, usa correo. No se
 * crean recordatorios SMS nuevos.
 */
export async function createReminderJobsTx(
  tx: Transaction,
  target: ReminderTarget,
  now: Date = new Date(),
): Promise<ScheduledReminder[]> {
  if (target.patientOptOut) return [];
  if (target.patientStatus === "blocked" || target.patientStatus === "deceased") {
    return [];
  }

  const channel: ReminderChannel | null = target.patientPhone
    ? "whatsapp"
    : target.patientEmail
      ? "email"
      : null;
  if (!channel) return [];

  const schedules = computeReminderSchedules({
    startsAt: target.startsAt,
    timezone: target.timezone,
    now,
  });

  if (schedules.length === 0) return [];

  const materialized = schedules.map((schedule) => ({
    ...schedule,
    channel,
  }));

  await tx
    .insert(reminderJobs)
    .values(
      materialized.map((schedule) => ({
        clinicId: target.clinicId,
        appointmentId: target.appointmentId,
        channel: schedule.channel,
        templateCode: schedule.code,
        scheduledFor: schedule.scheduledFor,
      })),
    )
    .onConflictDoNothing();

  return materialized;
}
