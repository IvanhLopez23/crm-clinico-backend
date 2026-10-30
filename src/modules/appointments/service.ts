import { and, asc, eq, getTableColumns, gte, isNull, lt } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import { appointmentStatusHistory } from "../../db/schema/appointment-status-history.js";
import {
  appointments,
  CANCELLATION_REASONS,
} from "../../db/schema/appointments.js";
import { patients } from "../../db/schema/patients.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { reminderJobs } from "../../db/schema/reminder-jobs.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { offerNextForSlotTx } from "../waitlist/service.js";
import {
  createAppointmentTx,
  mapBookingError,
  type Appointment,
  type BookAppointmentInput,
  type BookedVia,
} from "./tx.js";

export type {
  Appointment,
  BookAppointmentInput,
  BookedVia,
} from "./tx.js";

export type CancelledBy = "staff" | "patient" | "system";
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export async function bookAppointment(
  db: Database,
  input: BookAppointmentInput,
): Promise<Appointment> {
  try {
    return await withTenant(db, input.clinicId, (tx) =>
      createAppointmentTx(tx, input),
    );
  } catch (err) {
    throw mapBookingError(err);
  }
}

export type CancelAppointmentInput = {
  clinicId: string;
  appointmentId: string;
  reasonCode: CancellationReason;
  cancelledBy: CancelledBy;
  /** Si viene, la cita debe pertenecer a ese especialista (rol medico). */
  requirePractitionerId?: string | null;
};

export async function cancelAppointment(
  db: Database,
  input: CancelAppointmentInput,
): Promise<Appointment> {
  return withTenant(db, input.clinicId, (tx) =>
    cancelAppointmentTx(tx, input),
  );
}

export type RescheduleAppointmentInput = {
  clinicId: string;
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  bookedVia?: BookedVia;
  cancelledBy?: CancelledBy;
  requirePractitionerId?: string | null;
};

/**
 * Reagendar = cancelar la cita anterior y crear una nueva encadenada.
 * Todo ocurre en una transaccion: si el nuevo horario choca, la cita original
 * sigue activa (rollback).
 */
export async function rescheduleAppointment(
  db: Database,
  input: RescheduleAppointmentInput,
): Promise<Appointment> {
  try {
    return await withTenant(db, input.clinicId, async (tx) => {
      const [previous] = await tx
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            isNull(appointments.deletedAt),
          ),
        )
        .limit(1)
        .for("update");

      if (!previous) {
        throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Cita no encontrada");
      }

      if (
        input.requirePractitionerId &&
        previous.practitionerId !== input.requirePractitionerId
      ) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "La cita pertenece a otro especialista",
        );
      }

      if (previous.status === "cancelled") {
        throw new AppError(
          409,
          "ALREADY_CANCELLED",
          "No se puede reagendar una cita cancelada",
        );
      }

      if (previous.status === "completed" || previous.status === "no_show") {
        throw new AppError(
          409,
          "INVALID_TRANSITION",
          `No se puede reagendar una cita en estado ${previous.status}`,
        );
      }

      // Primero se libera el slot anterior; si el alta falla, el rollback
      // devuelve la cita a su estado original.
      await cancelAppointmentTx(tx, {
        clinicId: input.clinicId,
        appointmentId: previous.id,
        reasonCode: "rescheduled",
        cancelledBy: input.cancelledBy ?? "staff",
      });

      return await createAppointmentTx(tx, {
        clinicId: input.clinicId,
        patientId: previous.patientId,
        practitionerId: previous.practitionerId,
        ...(previous.serviceId ? { serviceId: previous.serviceId } : {}),
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        isOverbooking: previous.isOverbooking,
        ...(previous.overbookingReason
          ? { overbookingReason: previous.overbookingReason }
          : {}),
        ...(previous.overbookingApprovedByUserId
          ? {
              overbookingApprovedByUserId:
                previous.overbookingApprovedByUserId,
            }
          : {}),
        ...(previous.bookedByUserId
          ? { bookedByUserId: previous.bookedByUserId }
          : {}),
        ...(previous.bookedByPatientId
          ? { bookedByPatientId: previous.bookedByPatientId }
          : {}),
        confirm: previous.status !== "requested",
        bookedVia: input.bookedVia ?? "staff",
        rescheduledFromId: previous.id,
        ...(previous.notesInternal
          ? { notesInternal: previous.notesInternal }
          : {}),
      });
    });
  } catch (err) {
    throw mapBookingError(err);
  }
}

export type AppointmentListItem = Appointment & {
  patientFirstName: string;
  patientLastName: string;
  practitionerName: string;
};

export async function listAppointments(
  db: Database,
  params: {
    clinicId: string;
    from: Date;
    to: Date;
    practitionerId?: string;
    patientId?: string;
    status?: string;
  },
): Promise<AppointmentListItem[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select({
        ...getTableColumns(appointments),
        patientFirstName: patients.firstName,
        patientLastName: patients.lastName,
        practitionerName: practitioners.fullName,
      })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .innerJoin(
        practitioners,
        eq(practitioners.id, appointments.practitionerId),
      )
      .where(
        and(
          isNull(appointments.deletedAt),
          gte(appointments.startsAt, params.from),
          lt(appointments.startsAt, params.to),
          params.practitionerId
            ? eq(appointments.practitionerId, params.practitionerId)
            : undefined,
          params.patientId
            ? eq(appointments.patientId, params.patientId)
            : undefined,
          params.status ? eq(appointments.status, params.status) : undefined,
        ),
      )
      .orderBy(asc(appointments.startsAt)),
  );
}

async function cancelAppointmentTx(
  tx: Transaction,
  input: CancelAppointmentInput,
): Promise<Appointment> {
  const [appointment] = await tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.id, input.appointmentId),
        isNull(appointments.deletedAt),
      ),
    )
    .limit(1)
    .for("update");

  if (!appointment) {
    throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Cita no encontrada");
  }

  if (
    input.requirePractitionerId &&
    appointment.practitionerId !== input.requirePractitionerId
  ) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "La cita pertenece a otro especialista",
    );
  }

  // Idempotente: cancelar dos veces devuelve el mismo estado.
  if (appointment.status === "cancelled") return appointment;

  assertCanCancel(appointment.status);

  const cancelledAt = new Date();

  const [updated] = await tx
    .update(appointments)
    .set({
      status: "cancelled",
      cancelledAt,
      cancelledBy: input.cancelledBy,
      cancellationReasonCode: input.reasonCode,
      updatedAt: cancelledAt,
    })
    .where(eq(appointments.id, input.appointmentId))
    .returning();

  if (!updated) {
    throw new AppError(500, "UPDATE_FAILED", "No se pudo cancelar la cita");
  }

  await tx.insert(appointmentStatusHistory).values({
    clinicId: input.clinicId,
    appointmentId: input.appointmentId,
    fromStatus: appointment.status,
    toStatus: "cancelled",
    actorType:
      input.cancelledBy === "staff"
        ? "user"
        : input.cancelledBy === "patient"
          ? "patient"
          : "system",
    reasonCode: input.reasonCode,
    metadata: { cancelledBy: input.cancelledBy },
  });

  // Un recordatorio de una cita cancelada es un incidente visible al paciente:
  // se cancelan en la misma transaccion.
  await tx
    .update(reminderJobs)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(reminderJobs.appointmentId, input.appointmentId),
        eq(reminderJobs.status, "pending"),
      ),
    );

  // El hueco recien liberado se ofrece a la lista de espera en la misma
  // transaccion: si algo falla, la cancelacion no queda a medias.
  await offerNextForSlotTx(tx, {
    clinicId: input.clinicId,
    practitionerId: appointment.practitionerId,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timezone: appointment.timezone,
    now: cancelledAt,
  });

  return updated;
}

function assertCanCancel(status: string): void {
  if (
    status === "completed" ||
    status === "no_show" ||
    status === "cancelled"
  ) {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `No se puede cancelar una cita en estado ${status}`,
    );
  }
}
