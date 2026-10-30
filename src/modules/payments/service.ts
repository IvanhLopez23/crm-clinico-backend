import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { appointmentPayments } from "../../db/schema/appointment-payments.js";
import { appointmentStatusHistory } from "../../db/schema/appointment-status-history.js";
import { appointments } from "../../db/schema/appointments.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { pgErrorCode } from "../../lib/pg-error.js";
import type { AuthContext } from "../../lib/permissions.js";
import type { CheckoutBody } from "./schema.js";

export type Payment = typeof appointmentPayments.$inferSelect;

export type CheckoutResult = {
  appointment: typeof appointments.$inferSelect;
  payment: Payment;
};

export async function checkoutAppointment(
  db: Database,
  params: {
    clinicId: string;
    appointmentId: string;
    actor: AuthContext;
    input: CheckoutBody;
  },
): Promise<CheckoutResult> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [appointment] = await tx
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.id, params.appointmentId),
          isNull(appointments.deletedAt),
        ),
      )
      .limit(1)
      .for("update");

    if (!appointment) {
      throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Cita no encontrada");
    }

    if (
      params.actor.role === "practitioner" &&
      appointment.practitionerId !== params.actor.practitionerId
    ) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "La cita pertenece a otro especialista",
      );
    }

    if (!["in_consultation", "completed"].includes(appointment.status)) {
      throw new AppError(
        409,
        "APPOINTMENT_NOT_CLOSABLE",
        "La cita debe estar en consulta o completada para cobrar",
      );
    }

    const [existing] = await tx
      .select({ id: appointmentPayments.id })
      .from(appointmentPayments)
      .where(eq(appointmentPayments.appointmentId, appointment.id))
      .limit(1);

    if (existing) {
      throw new AppError(409, "ALREADY_PAID", "La cita ya tiene un cobro");
    }

    const now = new Date();
    let updated = appointment;

    if (appointment.status === "in_consultation") {
      const [closed] = await tx
        .update(appointments)
        .set({
          status: "completed",
          consultEndedAt: now,
          checkedOutAt: now,
          updatedAt: now,
        })
        .where(eq(appointments.id, appointment.id))
        .returning();

      if (!closed) {
        throw new AppError(500, "UPDATE_FAILED", "No se pudo cerrar la cita");
      }
      updated = closed;

      await tx.insert(appointmentStatusHistory).values({
        clinicId: params.clinicId,
        appointmentId: appointment.id,
        fromStatus: appointment.status,
        toStatus: "completed",
        actorType: "user",
        changedByUserId: params.actor.userId,
        reasonCode: "checkout",
        metadata: { source: "payments" },
      });
    }

    const amountCents =
      params.input.amountCents ?? appointment.priceCentsSnapshot;

    try {
      const [payment] = await tx
        .insert(appointmentPayments)
        .values({
          clinicId: params.clinicId,
          appointmentId: appointment.id,
          amountCents,
          currency: appointment.currencySnapshot ?? "MXN",
          method: params.input.method,
          notes: params.input.notes ?? null,
          createdByUserId: params.actor.userId,
          paidAt: now,
        })
        .returning();

      if (!payment) {
        throw new AppError(500, "INSERT_FAILED", "No se pudo registrar el pago");
      }

      return { appointment: updated, payment };
    } catch (error) {
      if (pgErrorCode(error) === "23505") {
        throw new AppError(409, "ALREADY_PAID", "La cita ya tiene un cobro");
      }
      throw error;
    }
  });
}

export async function getAppointmentPayment(
  db: Database,
  params: {
    clinicId: string;
    appointmentId: string;
    actor: AuthContext;
  },
): Promise<Payment | null> {
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
      throw new AppError(403, "FORBIDDEN", "La cita es de otro especialista");
    }

    const [payment] = await tx
      .select()
      .from(appointmentPayments)
      .where(eq(appointmentPayments.appointmentId, params.appointmentId))
      .limit(1);

    return payment ?? null;
  });
}
