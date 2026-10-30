import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import { appointmentStatusHistory } from "../../db/schema/appointment-status-history.js";
import { appointments } from "../../db/schema/appointments.js";
import type { UserRole } from "../../db/schema/users.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";

export const CHECKIN_WINDOW_BEFORE_MINUTES = 90;
export const CHECKIN_WINDOW_AFTER_MINUTES = 45;
export const NO_SHOW_GRACE_MINUTES = 15;

export type AppointmentAction =
  | "confirm"
  | "check-in"
  | "room"
  | "start"
  | "complete"
  | "no-show";

export type TransitionActor = {
  userId: string;
  role: UserRole;
  practitionerId: string | null;
};

export type TransitionInput = {
  clinicId: string;
  appointmentId: string;
  action: AppointmentAction;
  actor: TransitionActor;
  reason?: string;
  source?: string;
  force?: boolean;
  now?: Date;
};

export async function transitionAppointment(
  db: Database,
  input: TransitionInput,
): Promise<typeof appointments.$inferSelect> {
  const now = input.now ?? new Date();

  return withTenant(db, input.clinicId, async (tx) => {
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
      input.actor.role === "practitioner" &&
      appointment.practitionerId !== input.actor.practitionerId
    ) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "La cita pertenece a otro especialista",
      );
    }

    if (input.force && input.actor.role !== "admin") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Solo admin puede forzar una transicion",
      );
    }

    switch (input.action) {
      case "confirm":
        return confirmTx(tx, appointment, input, now);
      case "check-in":
        return checkInTx(tx, appointment, input, now);
      case "room":
        return roomTx(tx, appointment, input, now);
      case "start":
        return startTx(tx, appointment, input, now);
      case "complete":
        return completeTx(tx, appointment, input, now);
      case "no-show":
        return noShowTx(tx, appointment, input, now);
    }
  });
}

export async function listAppointmentHistory(
  db: Database,
  params: {
    clinicId: string;
    appointmentId: string;
    actor: TransitionActor;
  },
): Promise<(typeof appointmentStatusHistory.$inferSelect)[]> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [appointment] = await tx
      .select({ practitionerId: appointments.practitionerId })
      .from(appointments)
      .where(eq(appointments.id, params.appointmentId))
      .limit(1);

    if (!appointment) {
      throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Cita no encontrada");
    }
    if (
      params.actor.role === "practitioner" &&
      appointment.practitionerId !== params.actor.practitionerId
    ) {
      throw new AppError(403, "FORBIDDEN", "La cita pertenece a otro especialista");
    }

    return tx
      .select()
      .from(appointmentStatusHistory)
      .where(eq(appointmentStatusHistory.appointmentId, params.appointmentId))
      .orderBy(desc(appointmentStatusHistory.createdAt));
  });
}

async function confirmTx(
  tx: Transaction,
  appointment: typeof appointments.$inferSelect,
  input: TransitionInput,
  now: Date,
): Promise<typeof appointments.$inferSelect> {
  if (appointment.status === "confirmed") return appointment;
  if (appointment.status !== "requested") {
    throw invalidTransition(appointment.status, "confirmed");
  }

  const [updated] = await tx
    .update(appointments)
    .set({
      status: "confirmed",
      confirmedAt: now,
      confirmationChannel: input.source ?? "staff",
      updatedAt: now,
    })
    .where(eq(appointments.id, appointment.id))
    .returning();

  if (!updated) throw new AppError(500, "UPDATE_FAILED", "No se pudo confirmar");
  await recordHistoryTx(tx, appointment, "confirmed", input, "confirmed");
  return updated;
}

async function checkInTx(
  tx: Transaction,
  appointment: typeof appointments.$inferSelect,
  input: TransitionInput,
  now: Date,
): Promise<typeof appointments.$inferSelect> {
  if (appointment.status === "arrived") return appointment;
  if (!["requested", "confirmed"].includes(appointment.status)) {
    throw invalidTransition(appointment.status, "arrived");
  }

  const windowStart = new Date(
    appointment.startsAt.getTime() - CHECKIN_WINDOW_BEFORE_MINUTES * 60_000,
  );
  const windowEnd = new Date(
    appointment.startsAt.getTime() + CHECKIN_WINDOW_AFTER_MINUTES * 60_000,
  );

  if (!input.force && (now < windowStart || now > windowEnd)) {
    throw new AppError(
      422,
      "CHECKIN_WINDOW_CLOSED",
      "El check-in esta fuera de la ventana permitida",
    );
  }

  let current = appointment;
  if (current.status === "requested") {
    const [confirmed] = await tx
      .update(appointments)
      .set({
        status: "confirmed",
        confirmedAt: now,
        confirmationChannel: input.source ?? "reception",
        updatedAt: now,
      })
      .where(eq(appointments.id, current.id))
      .returning();

    if (!confirmed) throw new AppError(500, "UPDATE_FAILED", "No se pudo confirmar");
    await recordHistoryTx(tx, current, "confirmed", input, "check_in_confirmed");
    current = confirmed;
  }

  const [updated] = await tx
    .update(appointments)
    .set({
      status: "arrived",
      checkedInAt: now,
      updatedAt: now,
    })
    .where(eq(appointments.id, current.id))
    .returning();

  if (!updated) throw new AppError(500, "UPDATE_FAILED", "No se pudo hacer check-in");
  await recordHistoryTx(tx, current, "arrived", input, "check_in");
  return updated;
}

async function roomTx(
  tx: Transaction,
  appointment: typeof appointments.$inferSelect,
  input: TransitionInput,
  now: Date,
): Promise<typeof appointments.$inferSelect> {
  if (appointment.status !== "arrived") {
    throw invalidTransition(appointment.status, "arrived");
  }
  if (appointment.roomedAt) return appointment;

  const [updated] = await tx
    .update(appointments)
    .set({ roomedAt: now, updatedAt: now })
    .where(eq(appointments.id, appointment.id))
    .returning();

  if (!updated) throw new AppError(500, "UPDATE_FAILED", "No se pudo pasar a consultorio");
  await recordHistoryTx(tx, appointment, "arrived", input, "roomed");
  return updated;
}

async function startTx(
  tx: Transaction,
  appointment: typeof appointments.$inferSelect,
  input: TransitionInput,
  now: Date,
): Promise<typeof appointments.$inferSelect> {
  if (appointment.status === "in_consultation") return appointment;
  if (appointment.status !== "arrived") {
    throw invalidTransition(appointment.status, "in_consultation");
  }

  const [updated] = await tx
    .update(appointments)
    .set({
      status: "in_consultation",
      consultStartedAt: now,
      updatedAt: now,
    })
    .where(eq(appointments.id, appointment.id))
    .returning();

  if (!updated) throw new AppError(500, "UPDATE_FAILED", "No se pudo iniciar");
  await recordHistoryTx(tx, appointment, "in_consultation", input, "consult_started");
  return updated;
}

async function completeTx(
  tx: Transaction,
  appointment: typeof appointments.$inferSelect,
  input: TransitionInput,
  now: Date,
): Promise<typeof appointments.$inferSelect> {
  if (appointment.status === "completed") return appointment;
  if (appointment.status !== "in_consultation") {
    throw invalidTransition(appointment.status, "completed");
  }

  const [updated] = await tx
    .update(appointments)
    .set({
      status: "completed",
      consultEndedAt: now,
      checkedOutAt: now,
      updatedAt: now,
    })
    .where(eq(appointments.id, appointment.id))
    .returning();

  if (!updated) throw new AppError(500, "UPDATE_FAILED", "No se pudo completar");
  await recordHistoryTx(tx, appointment, "completed", input, "consult_completed");
  return updated;
}

async function noShowTx(
  tx: Transaction,
  appointment: typeof appointments.$inferSelect,
  input: TransitionInput,
  now: Date,
): Promise<typeof appointments.$inferSelect> {
  if (appointment.status === "no_show") return appointment;
  if (["completed", "cancelled", "in_consultation"].includes(appointment.status)) {
    throw invalidTransition(appointment.status, "no_show");
  }
  if (appointment.checkedInAt && !input.force) {
    throw new AppError(
      409,
      "NO_SHOW_CHECKED_IN",
      "El paciente ya tiene check-in; se requiere override",
    );
  }

  const graceEnd = new Date(
    appointment.startsAt.getTime() + NO_SHOW_GRACE_MINUTES * 60_000,
  );
  if (!input.force && now < graceEnd) {
    throw new AppError(
      422,
      "NO_SHOW_TOO_EARLY",
      "Aun no termina la gracia de no-show",
    );
  }

  const [updated] = await tx
    .update(appointments)
    .set({
      status: "no_show",
      noShowMarkedAt: now,
      noShowReason: input.reason ?? "no_show",
      updatedAt: now,
    })
    .where(eq(appointments.id, appointment.id))
    .returning();

  if (!updated) throw new AppError(500, "UPDATE_FAILED", "No se pudo marcar no-show");
  await recordHistoryTx(tx, appointment, "no_show", input, "no_show");
  return updated;
}

async function recordHistoryTx(
  tx: Transaction,
  appointment: typeof appointments.$inferSelect,
  toStatus: string,
  input: TransitionInput,
  reasonCode: string,
): Promise<void> {
  await tx.insert(appointmentStatusHistory).values({
    clinicId: input.clinicId,
    appointmentId: appointment.id,
    fromStatus: appointment.status,
    toStatus,
    actorType: "user",
    changedByUserId: input.actor.userId,
    reasonCode,
    reasonText: input.reason ?? null,
    metadata: input.source ? { source: input.source } : null,
  });
}

function invalidTransition(
  from: string,
  to: string,
): AppError {
  return new AppError(
    409,
    "INVALID_TRANSITION",
    `No se puede pasar de ${from} a ${to}`,
  );
}
