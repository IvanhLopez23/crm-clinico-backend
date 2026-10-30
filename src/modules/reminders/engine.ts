import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { appointments } from "../../db/schema/appointments.js";
import { clinics } from "../../db/schema/clinics.js";
import { patients } from "../../db/schema/patients.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { reminderJobs } from "../../db/schema/reminder-jobs.js";
import type { ReminderChannel } from "./schedule.js";
import type { MessageSender, SendResult } from "./sender.js";
import { renderReminder } from "./templates.js";

const MAX_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 10 * 60_000;
const RETRY_DELAYS_MS = [0, 60_000, 5 * 60_000];

const FALLBACK_CHANNEL: Record<ReminderChannel, ReminderChannel | null> = {
  whatsapp: "email",
  sms: "email",
  email: null,
};

type ClaimedJob = {
  id: string;
  appointment_id: string;
  channel: string;
  template_code: string;
  attempts: number;
};

type JobContext = {
  appointmentStatus: string;
  clinicId: string;
  startsAt: Date;
  patientStatus: string;
  optOut: boolean;
  firstName: string;
  phone: string | null;
  email: string | null;
  practitionerName: string;
  clinicName: string;
  timezone: string;
};

export type ProcessSummary = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
};

export type ProcessOptions = {
  sender: MessageSender;
  now?: Date;
  limit?: number;
};

/**
 * Procesa los recordatorios vencidos.
 *
 * El claim usa `FOR UPDATE SKIP LOCKED`, asi varios workers pueden correr en
 * paralelo sin enviar el mismo mensaje dos veces. El envio ocurre fuera de la
 * transaccion: no se retiene un lock de fila mientras se llama al proveedor.
 */
export async function processDueReminders(
  db: Database,
  opts: ProcessOptions,
): Promise<ProcessSummary> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;
  const summary: ProcessSummary = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    cancelled: 0,
  };

  // Recupera jobs que quedaron 'processing' por un crash del worker.
  await db.execute(sql`
    update reminder_jobs
    set status = 'pending', updated_at = ${now}
    where status = 'processing'
      and (last_attempt_at is null or last_attempt_at < ${new Date(
        now.getTime() - STALE_PROCESSING_MS,
      )})
  `);

  const claimed = await db.execute<ClaimedJob>(sql`
    with due as (
      select id
      from reminder_jobs
      where status = 'pending' and scheduled_for <= ${now}
      order by scheduled_for asc
      limit ${limit}
      for update skip locked
    )
    update reminder_jobs as j
    set status = 'processing',
        attempts = j.attempts + 1,
        last_attempt_at = ${now},
        updated_at = ${now}
    from due
    where j.id = due.id
    returning j.id, j.appointment_id, j.channel, j.template_code, j.attempts
  `);

  summary.claimed = claimed.rows.length;

  for (const job of claimed.rows) {
    await processJob(db, opts.sender, job, now, summary);
  }

  return summary;
}

async function processJob(
  db: Database,
  sender: MessageSender,
  job: ClaimedJob,
  now: Date,
  summary: ProcessSummary,
): Promise<void> {
  const channel = job.channel as ReminderChannel;

  const [ctx] = await db
    .select({
      appointmentStatus: appointments.status,
      clinicId: appointments.clinicId,
      startsAt: appointments.startsAt,
      patientStatus: patients.status,
      optOut: patients.reminderOptOut,
      firstName: patients.firstName,
      phone: patients.phoneE164,
      email: patients.email,
      practitionerName: practitioners.fullName,
      clinicName: clinics.name,
      timezone: clinics.timezone,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId))
    .innerJoin(clinics, eq(clinics.id, appointments.clinicId))
    .where(eq(appointments.id, job.appointment_id))
    .limit(1);

  if (!ctx) {
    await markFailed(db, job.id, now, "appointment_missing");
    summary.failed += 1;
    return;
  }

  // Si la cita ya no existe para el paciente (cancelada, atendida) o el
  // paciente pidio no recibir mensajes, no se envia nada.
  if (isInactive(ctx)) {
    await markCancelled(db, job.id, now);
    summary.cancelled += 1;
    return;
  }

  const recipient = channel === "email" ? ctx.email : ctx.phone;

  if (!recipient) {
    await failJob(db, job, channel, now, "missing_recipient", ctx);
    summary.failed += 1;
    return;
  }

  const rendered = renderReminder(job.template_code, channel, {
    firstName: ctx.firstName,
    practitionerName: ctx.practitionerName,
    clinicName: ctx.clinicName,
    startsAt: ctx.startsAt,
    timezone: ctx.timezone,
  });

  let result: SendResult;

  try {
    result = await sender.send({
      jobId: job.id,
      channel,
      to: recipient,
      ...rendered,
    });
  } catch {
    result = { ok: false, errorCode: "sender_exception" };
  }

  if (result.ok) {
    await db
      .update(reminderJobs)
      .set({ status: "sent", sentAt: now, errorCode: null, updatedAt: now })
      .where(
        and(eq(reminderJobs.id, job.id), eq(reminderJobs.status, "processing")),
      );
    summary.sent += 1;
    return;
  }

  if (job.attempts >= MAX_ATTEMPTS) {
    await failJob(db, job, channel, now, result.errorCode, ctx);
    summary.failed += 1;
    return;
  }

  const delay = RETRY_DELAYS_MS[job.attempts] ?? 5 * 60_000;

  await db
    .update(reminderJobs)
    .set({
      status: "pending",
      scheduledFor: new Date(now.getTime() + delay),
      errorCode: result.errorCode,
      updatedAt: now,
    })
    .where(
      and(eq(reminderJobs.id, job.id), eq(reminderJobs.status, "processing")),
    );
  summary.retried += 1;
}

async function failJob(
  db: Database,
  job: ClaimedJob,
  channel: ReminderChannel,
  now: Date,
  errorCode: string,
  ctx: JobContext,
): Promise<void> {
  await markFailed(db, job.id, now, errorCode);

  if (isInactive(ctx)) return;

  const next = FALLBACK_CHANNEL[channel];
  if (!next) return;

  // Si el canal de respaldo tampoco tiene destinatario, no se crea nada.
  const recipient = next === "email" ? ctx.email : ctx.phone;
  if (!recipient) return;

  await db
    .insert(reminderJobs)
    .values({
      clinicId: ctx.clinicId,
      appointmentId: job.appointment_id,
      channel: next,
      templateCode: job.template_code,
      scheduledFor: now,
      status: "pending",
    })
    .onConflictDoNothing();
}

function isInactive(ctx: JobContext): boolean {
  return (
    ctx.appointmentStatus === "cancelled" ||
    ctx.appointmentStatus === "no_show" ||
    ctx.appointmentStatus === "completed" ||
    ctx.optOut ||
    ctx.patientStatus === "blocked" ||
    ctx.patientStatus === "deceased"
  );
}

async function markFailed(
  db: Database,
  id: string,
  now: Date,
  errorCode: string,
): Promise<void> {
  await db
    .update(reminderJobs)
    .set({ status: "failed", errorCode, updatedAt: now })
    .where(and(eq(reminderJobs.id, id), eq(reminderJobs.status, "processing")));
}

async function markCancelled(
  db: Database,
  id: string,
  now: Date,
): Promise<void> {
  await db
    .update(reminderJobs)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(reminderJobs.id, id), eq(reminderJobs.status, "processing")));
}
