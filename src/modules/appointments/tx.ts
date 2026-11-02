import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Transaction } from "../../db/client.js";
import { appointmentStatusHistory } from "../../db/schema/appointment-status-history.js";
import {
  appointments,
  type BOOKED_VIA_VALUES,
} from "../../db/schema/appointments.js";
import { clinics } from "../../db/schema/clinics.js";
import { idempotencyKeys } from "../../db/schema/idempotency-keys.js";
import { patients } from "../../db/schema/patients.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { services } from "../../db/schema/services.js";
import { AppError, SlotTakenError } from "../../lib/errors.js";
import { pgConstraint, pgErrorCode } from "../../lib/pg-error.js";
import { computeSlots } from "../availability/service.js";
import { createReminderJobsTx } from "../reminders/service.js";
import { findPractitionerServiceTx } from "../services/practitioner-service.js";
import { resolveServiceTiming } from "../services/timing.js";

export type Appointment = typeof appointments.$inferSelect;
export type BookedVia = (typeof BOOKED_VIA_VALUES)[number];

export type BookAppointmentInput = {
  clinicId: string;
  patientId: string;
  practitionerId: string;
  serviceId?: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  isOverbooking?: boolean;
  overbookingReason?: string;
  overbookingApprovedByUserId?: string;
  notesInternal?: string;
  idempotencyKey?: string;
  /** Quien reserva. Solo `staff` puede saltarse la disponibilidad. */
  bookedVia?: BookedVia;
  bookedByUserId?: string;
  bookedByPatientId?: string;
  /** Staff puede crear la cita ya confirmada. */
  confirm?: boolean;
  rescheduledFromId?: string;
};

/**
 * Nucleo transaccional de creacion de citas. Vive aparte de `service.ts` para
 * que la lista de espera pueda reutilizarlo sin crear un ciclo de imports.
 */
export async function createAppointmentTx(
  tx: Transaction,
  input: BookAppointmentInput,
): Promise<Appointment> {
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "endsAt debe ser posterior a startsAt",
    );
  }

  const bookedVia: BookedVia = input.bookedVia ?? "staff";

  if (input.isOverbooking && bookedVia === "public") {
    throw new AppError(
      403,
      "OVERBOOKING_FORBIDDEN",
      "El sobrecupo solo puede crearlo el personal",
    );
  }

  const requestHash = hashRequest(input, bookedVia);
  // Lock por medico + dia LOCAL del consultorio. Con UTC, una cita cerca de
  // medianoche o en DST podria caer en otro dia y no serializar con la del dia
  // local correcto. La garantia definitiva sigue siendo la exclusion constraint.
  const localDay = DateTime.fromJSDate(input.startsAt, {
    zone: input.timezone,
  }).toISODate();
  const lockKey = `${input.practitionerId}:${
    localDay ?? input.startsAt.toISOString().slice(0, 10)
  }`;

  if (input.isOverbooking && !input.overbookingReason) {
    throw new AppError(
      422,
      "OVERBOOK_REASON_REQUIRED",
      "El sobrecupo requiere un motivo",
    );
  }

  if (input.idempotencyKey) {
    const [reserved] = await tx
      .insert(idempotencyKeys)
      .values({
        clinicId: input.clinicId,
        key: input.idempotencyKey,
        requestHash,
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (!reserved) {
      return replayIdempotent(
        tx,
        input.clinicId,
        input.idempotencyKey,
        requestHash,
      );
    }
  }

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const [patient] = await tx
    .select({
      id: patients.id,
      firstName: patients.firstName,
      householdId: patients.householdId,
      status: patients.status,
      reminderOptOut: patients.reminderOptOut,
      phone: patients.phoneE164,
      email: patients.email,
    })
    .from(patients)
    .where(and(eq(patients.id, input.patientId), isNull(patients.deletedAt)))
    .limit(1);

  // RLS hace invisible un paciente de otra clinica: se responde 404, no 403.
  if (!patient) {
    throw new AppError(
      404,
      "PATIENT_NOT_FOUND",
      "Paciente no encontrado en esta clinica",
    );
  }

  const [practitioner] = await tx
    .select({
      id: practitioners.id,
      bufferBeforeMinutes: practitioners.bufferBeforeMinutes,
      bufferAfterMinutes: practitioners.bufferAfterMinutes,
    })
    .from(practitioners)
    .where(
      and(
        eq(practitioners.id, input.practitionerId),
        eq(practitioners.isActive, true),
      ),
    )
    .limit(1);

  if (!practitioner) {
    throw new AppError(
      404,
      "PRACTITIONER_NOT_FOUND",
      "Especialista no encontrado o inactivo",
    );
  }

  const [clinic] = await tx
    .select({
      name: clinics.name,
      timezone: clinics.timezone,
      currency: clinics.currency,
    })
    .from(clinics)
    .where(eq(clinics.id, input.clinicId))
    .limit(1);

  if (!clinic) {
    throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
  }

  let service: typeof services.$inferSelect | null = null;
  let durationMinutes = Math.max(
    1,
    Math.round((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000),
  );
  let endsAt = input.endsAt;
  let bufferBeforeMinutes = 0;
  let bufferAfterMinutes = 0;
  let priceCentsSnapshot = 0;
  let currencySnapshot = clinic.currency;

  if (input.serviceId) {
    const [selected] = await tx
      .select()
      .from(services)
      .where(
        and(eq(services.id, input.serviceId), eq(services.isActive, true)),
      )
      .limit(1);

    if (!selected) {
      throw new AppError(404, "SERVICE_NOT_FOUND", "Servicio no encontrado");
    }

    const override = await findPractitionerServiceTx(tx, {
      practitionerId: input.practitionerId,
      serviceId: selected.id,
    });

    if (override && !override.isActive) {
      throw new AppError(
        409,
        "SERVICE_NOT_AVAILABLE",
        "El especialista no ofrece este servicio",
      );
    }

    service = selected;
    const timing = resolveServiceTiming({
      service: selected,
      override,
      practitioner,
    });
    durationMinutes = timing.durationMinutes;
    bufferBeforeMinutes = timing.bufferBeforeMinutes;
    bufferAfterMinutes = timing.bufferAfterMinutes;
    priceCentsSnapshot = override?.priceCents ?? selected.priceCents;
    currencySnapshot = override?.currency ?? selected.currency;
    endsAt = new Date(input.startsAt.getTime() + durationMinutes * 60_000);
  }

  if (endsAt.getTime() <= input.startsAt.getTime()) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "La duracion del servicio debe ser mayor a cero",
    );
  }

  // La reserva publica solo puede usar slots que el motor de disponibilidad
  // ofrece. Recepcion puede forzar horarios (sobrecupo, urgencias, etc.).
  if (bookedVia !== "staff") {
    await assertSlotAvailable(tx, {
      appointment: { ...input, endsAt },
      clinicId: input.clinicId,
      timezone: clinic.timezone,
      durationMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
    });
  }

  if (input.isOverbooking) {
    await assertOverbookingAllowed(tx, input, endsAt, clinic.timezone);
  } else {
    const exact = await tx.execute(sql`
      select 1
      from appointments
      where practitioner_id = ${input.practitionerId}
        and status in ('requested', 'confirmed', 'arrived', 'in_consultation', 'completed')
        and is_overbooking = false
        and deleted_at is null
        and tstzrange(starts_at, ends_at, '[)')
            && tstzrange(${input.startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')
      limit 1
    `);

    if ((exact.rowCount ?? 0) > 0) throw new SlotTakenError();

    // Solape del bloque ocupado (servicio + buffers). La constraint de
    // exclusion cubre el solape exacto; esta consulta cubre los buffers, que
    // no forman parte del rango starts_at/ends_at.
    const conflict = await tx.execute(sql`
      select 1
      from appointments
      where practitioner_id = ${input.practitionerId}
        and status in ('requested', 'confirmed', 'arrived', 'in_consultation', 'completed')
        and is_overbooking = false
        and deleted_at is null
        and tstzrange(
          starts_at - make_interval(mins => coalesce(buffer_before_minutes_snapshot, 0)::int),
          ends_at + make_interval(mins => coalesce(buffer_after_minutes_snapshot, 0)::int),
          '[)'
        ) && tstzrange(
          ${input.startsAt}::timestamptz - make_interval(mins => ${bufferBeforeMinutes}::int),
          ${endsAt}::timestamptz + make_interval(mins => ${bufferAfterMinutes}::int),
          '[)'
        )
      limit 1
    `);

    if ((conflict.rowCount ?? 0) > 0) {
      throw new AppError(
        409,
        "BUFFER_CONFLICT",
        "El horario se solapa con el buffer de otra cita",
      );
    }
  }

  const status = input.confirm ? "confirmed" : "requested";

  const [created] = await tx
    .insert(appointments)
    .values({
      clinicId: input.clinicId,
      patientId: input.patientId,
      practitionerId: input.practitionerId,
      serviceId: service?.id ?? null,
      householdId: patient.householdId,
      startsAt: input.startsAt,
      endsAt,
      timezone: input.timezone,
      status,
      bookedVia,
      isOverbooking: input.isOverbooking ?? false,
      notesInternal: input.notesInternal ?? null,
      serviceNameSnapshot: service?.name ?? null,
      durationMinutesSnapshot: durationMinutes,
      bufferBeforeMinutesSnapshot: bufferBeforeMinutes,
      bufferAfterMinutesSnapshot: bufferAfterMinutes,
      priceCentsSnapshot,
      currencySnapshot,
      bookedByUserId: input.bookedByUserId ?? null,
      bookedByPatientId: input.bookedByPatientId ?? null,
      confirmedAt: status === "confirmed" ? new Date() : null,
      confirmationChannel: status === "confirmed" ? "staff" : null,
      overbookingReason: input.overbookingReason ?? null,
      overbookingApprovedByUserId:
        input.overbookingApprovedByUserId ?? null,
      rescheduledFromId: input.rescheduledFromId ?? null,
    })
    .returning();

  if (!created) {
    throw new AppError(500, "INSERT_FAILED", "No se pudo crear la cita");
  }

  await tx.insert(appointmentStatusHistory).values({
    clinicId: input.clinicId,
    appointmentId: created.id,
    fromStatus: null,
    toStatus: status,
    actorType:
      bookedVia === "public" ? "patient" : bookedVia === "staff" ? "user" : "api",
    changedByUserId: input.bookedByUserId ?? null,
    reasonCode: "created",
    metadata: { bookedVia, serviceId: service?.id ?? null },
  });

  if (input.idempotencyKey) {
    await tx
      .update(idempotencyKeys)
      .set({ appointmentId: created.id })
      .where(
        and(
          eq(idempotencyKeys.clinicId, input.clinicId),
          eq(idempotencyKeys.key, input.idempotencyKey),
        ),
      );
  }

  // Recordatorios materializados en la misma transaccion que la cita.
  await createReminderJobsTx(tx, {
    appointmentId: created.id,
    clinicId: input.clinicId,
    startsAt: created.startsAt,
    timezone: clinic.timezone,
    patientStatus: patient.status,
    patientOptOut: patient.reminderOptOut,
    patientPhone: patient.phone,
    patientEmail: patient.email,
  });

  return created;
}

export function mapBookingError(err: unknown): unknown {
  // Red de seguridad: si el pre-chequeo se salto por concurrencia, la
  // constraint traduce el 23P01 a un 409 de dominio.
  if (pgErrorCode(err) === "23P01" && pgConstraint(err) === "appt_no_overlap") {
    return new SlotTakenError();
  }
  return err;
}

async function assertSlotAvailable(
  tx: Transaction,
  params: {
    appointment: BookAppointmentInput;
    clinicId: string;
    timezone: string;
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
  },
): Promise<void> {
  const { appointment, timezone } = params;
  const localStart = DateTime.fromJSDate(appointment.startsAt, {
    zone: timezone,
  });
  const from = localStart.toISODate();
  const to = localStart.plus({ days: 1 }).toISODate();

  if (!from || !to) {
    throw new AppError(422, "INVALID_RANGE", "Fecha de inicio invalida");
  }

  const slots = await computeSlots(tx, {
    clinicId: params.clinicId,
    practitionerId: appointment.practitionerId,
    timezone,
    from,
    to,
    durationMinutes: params.durationMinutes,
    bufferBeforeMinutes: params.bufferBeforeMinutes,
    bufferAfterMinutes: params.bufferAfterMinutes,
    occupancyStep: Boolean(appointment.serviceId),
  });

  const available = slots.some(
    (slot) => slot.startsAt.getTime() === appointment.startsAt.getTime(),
  );

  if (!available) {
    throw new AppError(
      409,
      "SLOT_NOT_AVAILABLE",
      "El horario no esta dentro de la disponibilidad del especialista",
    );
  }
}

async function replayIdempotent(
  tx: Transaction,
  clinicId: string,
  key: string,
  requestHash: string,
): Promise<Appointment> {
  const [stored] = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.clinicId, clinicId), eq(idempotencyKeys.key, key)),
    )
    .limit(1);

  if (!stored) {
    throw new AppError(
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "La reserva con esta clave sigue en proceso",
    );
  }

  if (stored.requestHash !== requestHash) {
    throw new AppError(
      422,
      "IDEMPOTENCY_KEY_REUSED",
      "La clave de idempotencia se uso con otro payload",
    );
  }

  if (!stored.appointmentId) {
    throw new AppError(
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "La reserva con esta clave sigue en proceso",
    );
  }

  const [existing] = await tx
    .select()
    .from(appointments)
    .where(eq(appointments.id, stored.appointmentId))
    .limit(1);

  if (!existing) {
    throw new AppError(
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "La reserva con esta clave sigue en proceso",
    );
  }

  return existing;
}

async function assertOverbookingAllowed(
  tx: Transaction,
  input: BookAppointmentInput,
  endsAt: Date,
  timezone: string,
): Promise<void> {
  const result = await tx.execute<{ regular: string; overbooked: string }>(sql`
    select
      count(*) filter (where not is_overbooking) as regular,
      count(*) filter (where is_overbooking) as overbooked
    from appointments
    where practitioner_id = ${input.practitionerId}
      and status in ('requested', 'confirmed', 'arrived', 'in_consultation', 'completed')
      and deleted_at is null
      and tstzrange(starts_at, ends_at, '[)')
          && tstzrange(${input.startsAt}, ${endsAt}, '[)')
  `);

  const row = result.rows[0];
  const regular = Number(row?.regular ?? 0);
  const overbooked = Number(row?.overbooked ?? 0);

  if (regular < 1) {
    throw new AppError(
      409,
      "OVERBOOKING_NOT_ALLOWED",
      "No hay una cita base en ese horario",
    );
  }

  if (overbooked >= 1) {
    throw new AppError(
      409,
      "OVERBOOKING_NOT_ALLOWED",
      "Ya existe un sobrecupo en ese horario",
    );
  }

  const localDay = DateTime.fromJSDate(input.startsAt, { zone: timezone })
    .startOf("day")
    .toUTC()
    .toJSDate();
  const nextDay = DateTime.fromJSDate(input.startsAt, { zone: timezone })
    .startOf("day")
    .plus({ days: 1 })
    .toUTC()
    .toJSDate();

  const daily = await tx.execute<{ count: string }>(sql`
    select count(*)::int as count
    from appointments
    where practitioner_id = ${input.practitionerId}
      and is_overbooking = true
      and status in ('requested', 'confirmed', 'arrived', 'in_consultation', 'completed')
      and deleted_at is null
      and starts_at >= ${localDay}
      and starts_at < ${nextDay}
  `);

  if (Number(daily.rows[0]?.count ?? 0) >= 2) {
    throw new AppError(
      409,
      "OVERBOOK_LIMIT_REACHED",
      "El especialista ya tiene el maximo de sobrecupos del dia",
    );
  }
}

function hashRequest(
  input: BookAppointmentInput,
  bookedVia: BookedVia,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        patientId: input.patientId,
        practitionerId: input.practitionerId,
        serviceId: input.serviceId ?? null,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
        timezone: input.timezone,
        bookedVia,
        isOverbooking: Boolean(input.isOverbooking),
        overbookingReason: input.overbookingReason ?? null,
        confirm: Boolean(input.confirm),
        notesInternal: input.notesInternal ?? null,
      }),
    )
    .digest("hex");
}
