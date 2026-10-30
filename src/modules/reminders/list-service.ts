import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { appointments } from "../../db/schema/appointments.js";
import { patients } from "../../db/schema/patients.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { reminderJobs } from "../../db/schema/reminder-jobs.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";

export type ReminderJobView = {
  id: string;
  appointmentId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  practitionerName: string;
  channel: string;
  templateCode: string;
  scheduledFor: Date;
  status: string;
  attempts: number;
  lastAttemptAt: Date | null;
  sentAt: Date | null;
  errorCode: string | null;
  appointmentStartsAt: Date;
};

export async function listReminderJobs(
  db: Database,
  params: {
    clinicId: string;
    status?: string;
    from?: Date;
    to?: Date;
    limit: number;
  },
): Promise<ReminderJobView[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select({
        id: reminderJobs.id,
        appointmentId: reminderJobs.appointmentId,
        patientId: appointments.patientId,
        patientFirstName: patients.firstName,
        patientLastName: patients.lastName,
        practitionerName: practitioners.fullName,
        channel: reminderJobs.channel,
        templateCode: reminderJobs.templateCode,
        scheduledFor: reminderJobs.scheduledFor,
        status: reminderJobs.status,
        attempts: reminderJobs.attempts,
        lastAttemptAt: reminderJobs.lastAttemptAt,
        sentAt: reminderJobs.sentAt,
        errorCode: reminderJobs.errorCode,
        appointmentStartsAt: appointments.startsAt,
      })
      .from(reminderJobs)
      .innerJoin(appointments, eq(appointments.id, reminderJobs.appointmentId))
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .innerJoin(
        practitioners,
        eq(practitioners.id, appointments.practitionerId),
      )
      .where(
        and(
          params.status ? eq(reminderJobs.status, params.status) : undefined,
          params.from ? gte(reminderJobs.scheduledFor, params.from) : undefined,
          params.to ? lte(reminderJobs.scheduledFor, params.to) : undefined,
        ),
      )
      .orderBy(asc(reminderJobs.scheduledFor))
      .limit(params.limit),
  );
}

export async function reminderSummary(
  db: Database,
  clinicId: string,
): Promise<Record<string, number>> {
  return withTenant(db, clinicId, async (tx) => {
    const rows = await tx
      .select({ status: reminderJobs.status })
      .from(reminderJobs);
    const summary: Record<string, number> = {
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of rows) {
      summary[row.status] = (summary[row.status] ?? 0) + 1;
    }
    return summary;
  });
}

export async function cancelReminderJob(
  db: Database,
  params: { clinicId: string; id: string },
): Promise<void> {
  await withTenant(db, params.clinicId, async (tx) => {
    const [job] = await tx
      .select({ status: reminderJobs.status })
      .from(reminderJobs)
      .where(eq(reminderJobs.id, params.id))
      .limit(1)
      .for("update");

    if (!job) {
      throw new AppError(404, "REMINDER_NOT_FOUND", "Recordatorio no encontrado");
    }
    if (job.status !== "pending" && job.status !== "failed") {
      throw new AppError(
        409,
        "REMINDER_NOT_CANCELLABLE",
        "El recordatorio ya fue procesado",
      );
    }

    await tx
      .update(reminderJobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(reminderJobs.id, params.id));
  });
}

export async function retryReminderJob(
  db: Database,
  params: { clinicId: string; id: string },
): Promise<void> {
  await withTenant(db, params.clinicId, async (tx) => {
    const [job] = await tx
      .select({ status: reminderJobs.status })
      .from(reminderJobs)
      .where(eq(reminderJobs.id, params.id))
      .limit(1)
      .for("update");

    if (!job) {
      throw new AppError(404, "REMINDER_NOT_FOUND", "Recordatorio no encontrado");
    }
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new AppError(
        409,
        "REMINDER_NOT_RETRYABLE",
        "Solo se pueden reintentar recordatorios fallidos o cancelados",
      );
    }

    await tx
      .update(reminderJobs)
      .set({
        status: "pending",
        attempts: 0,
        scheduledFor: new Date(),
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(reminderJobs.id, params.id));
  });
}
