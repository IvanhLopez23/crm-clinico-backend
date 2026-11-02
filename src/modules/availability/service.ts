import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Database, Transaction } from "../../db/client.js";
import { appointments } from "../../db/schema/appointments.js";
import { availabilityRules } from "../../db/schema/availability-rules.js";
import { clinicClosures } from "../../db/schema/clinic-closures.js";
import { clinics } from "../../db/schema/clinics.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { scheduleBlocks } from "../../db/schema/schedule-blocks.js";
import { services } from "../../db/schema/services.js";
import { findPractitionerServiceTx } from "../services/practitioner-service.js";
import { resolveServiceTiming } from "../services/timing.js";
import { resolveBlockRange } from "./blocks.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { pgErrorCode } from "../../lib/pg-error.js";
import { generateSlots, type Slot } from "./slots.js";

const ACTIVE_STATUSES = [
  "requested",
  "confirmed",
  "arrived",
  "in_consultation",
  "completed",
] as const;

const MAX_RANGE_DAYS = 31;

export type AvailabilityRuleRow = typeof availabilityRules.$inferSelect;
export type ScheduleBlockRow = typeof scheduleBlocks.$inferSelect;

export type ComputeSlotsParams = {
  clinicId: string;
  practitionerId: string;
  timezone: string;
  from: string;
  to: string;
  /** Si falta, cada regla usa su `slotMinutes` como duracion. */
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  slotMinutes?: number;
  occupancyStep?: boolean;
  anchorStart?: Date;
};

/**
 * Calcula slots libres dentro de una transaccion ya abierta (tenant fijado).
 * Lo usan tanto la consulta publica de disponibilidad como la validacion
 * al reservar, para que ambas respuestas no puedan divergir.
 */
export async function computeSlots(
  tx: Transaction,
  params: ComputeSlotsParams,
): Promise<Slot[]> {
  // El rango se expresa en dias locales del consultorio; la DB guarda UTC.
  const fromUtc = DateTime.fromISO(params.from, { zone: params.timezone })
    .startOf("day")
    .toUTC()
    .toJSDate();
  const toUtc = DateTime.fromISO(params.to, { zone: params.timezone })
    .startOf("day")
    .toUTC()
    .toJSDate();

  const rules = await tx
    .select()
    .from(availabilityRules)
    .where(
      and(
        eq(availabilityRules.practitionerId, params.practitionerId),
        lte(availabilityRules.validFrom, params.to),
        or(
          isNull(availabilityRules.validTo),
          gte(availabilityRules.validTo, params.from),
        ),
      ),
    );

  const blocks = await tx
    .select({
      startsAt: scheduleBlocks.startsAt,
      endsAt: scheduleBlocks.endsAt,
    })
    .from(scheduleBlocks)
    .where(
      and(
        eq(scheduleBlocks.practitionerId, params.practitionerId),
        lt(scheduleBlocks.startsAt, toUtc),
        gt(scheduleBlocks.endsAt, fromUtc),
      ),
    );

  // El sobrecupo no consume disponibilidad: es una excepcion consciente.
  const booked = await tx
    .select({
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      bufferBefore: appointments.bufferBeforeMinutesSnapshot,
      bufferAfter: appointments.bufferAfterMinutesSnapshot,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.practitionerId, params.practitionerId),
        eq(appointments.isOverbooking, false),
        isNull(appointments.deletedAt),
        inArray(appointments.status, [...ACTIVE_STATUSES]),
        lt(appointments.startsAt, toUtc),
        gt(appointments.endsAt, fromUtc),
      ),
    );

  const closures = await tx
    .select({
      startsAt: clinicClosures.startsAt,
      endsAt: clinicClosures.endsAt,
    })
    .from(clinicClosures)
    .where(
      and(
        eq(clinicClosures.clinicId, params.clinicId),
        lt(clinicClosures.startsAt, toUtc),
        gt(clinicClosures.endsAt, fromUtc),
      ),
    );

  const busy = [
    ...blocks,
    ...closures,
    ...booked.map((appointment) => ({
      startsAt: new Date(
        appointment.startsAt.getTime() -
          (appointment.bufferBefore ?? 0) * 60_000,
      ),
      endsAt: new Date(
        appointment.endsAt.getTime() +
          (appointment.bufferAfter ?? 0) * 60_000,
      ),
    })),
  ];

  return generateSlots({
    rules: rules.map((rule) => ({
      weekday: rule.weekday,
      startTime: rule.startTime,
      endTime: rule.endTime,
      validFrom: rule.validFrom,
      validTo: rule.validTo,
      slotMinutes: rule.slotMinutes,
    })),
    from: params.from,
    to: params.to,
    timezone: params.timezone,
    durationMinutes: params.durationMinutes,
    bufferBeforeMinutes: params.bufferBeforeMinutes,
    bufferAfterMinutes: params.bufferAfterMinutes,
    slotMinutes: params.slotMinutes,
    occupancyStep: params.occupancyStep,
    anchorStart: params.anchorStart,
    busy,
  });
}

export type GetAvailabilityInput = {
  clinicId: string;
  practitionerId: string;
  serviceId?: string;
  from: string;
  to: string;
  /** Si falta y no hay servicio, se usa el `slotMinutes` de cada regla. */
  durationMinutes?: number;
  slotMinutes?: number;
};

export async function getAvailability(
  db: Database,
  input: GetAvailabilityInput,
): Promise<{
  timezone: string;
  slots: Slot[];
  service?: {
    id: string;
    name: string;
    priceCents: number;
    currency: string;
    depositRequiredCents: number;
  };
}> {
  assertDateRange(input.from, input.to);

  return withTenant(db, input.clinicId, async (tx) => {
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
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, input.clinicId))
      .limit(1);

    if (!clinic) {
      throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
    }

    let durationMinutes = input.durationMinutes;
    let bufferBeforeMinutes = 0;
    let bufferAfterMinutes = 0;
    let serviceInfo:
      | {
          id: string;
          name: string;
          priceCents: number;
          currency: string;
          depositRequiredCents: number;
        }
      | undefined;

    if (input.serviceId) {
      const [service] = await tx
        .select()
        .from(services)
        .where(
          and(eq(services.id, input.serviceId), eq(services.isActive, true)),
        )
        .limit(1);

      if (!service) {
        throw new AppError(404, "SERVICE_NOT_FOUND", "Servicio no encontrado");
      }

      const override = await findPractitionerServiceTx(tx, {
        practitionerId: input.practitionerId,
        serviceId: service.id,
      });

      if (override && !override.isActive) {
        throw new AppError(
          409,
          "SERVICE_NOT_AVAILABLE",
          "El especialista no ofrece este servicio",
        );
      }

      const timing = resolveServiceTiming({
        service,
        override,
        practitioner,
      });
      durationMinutes = timing.durationMinutes;
      bufferBeforeMinutes = timing.bufferBeforeMinutes;
      bufferAfterMinutes = timing.bufferAfterMinutes;

      const priceCents = override?.priceCents ?? service.priceCents;
      const currency = override?.currency ?? service.currency;

      serviceInfo = {
        id: service.id,
        name: service.name,
        priceCents,
        currency,
        depositRequiredCents:
          service.depositCents ??
          (service.depositBps
            ? Math.round((priceCents * service.depositBps) / 10_000)
            : 0),
      };
    }

    const slots = await computeSlots(tx, {
      clinicId: input.clinicId,
      practitionerId: input.practitionerId,
      timezone: clinic.timezone,
      from: input.from,
      to: input.to,
      durationMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      slotMinutes: input.slotMinutes,
      occupancyStep: Boolean(input.serviceId),
    });

    return {
      timezone: clinic.timezone,
      slots,
      ...(serviceInfo ? { service: serviceInfo } : {}),
    };
  });
}

export type CreateRuleInput = {
  clinicId: string;
  practitionerId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo?: string;
  slotMinutes: number;
  label?: string;
};

export async function createAvailabilityRule(
  db: Database,
  input: CreateRuleInput,
): Promise<AvailabilityRuleRow> {
  if (input.startTime >= input.endTime) {
    throw new AppError(
      422,
      "INVALID_TIME_RANGE",
      "startTime debe ser anterior a endTime",
    );
  }

  if (input.validTo && input.validTo < input.validFrom) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "validTo debe ser igual o posterior a validFrom",
    );
  }

  return withTenant(db, input.clinicId, async (tx) => {
    await assertPractitioner(tx, input.practitionerId);

    try {
      const [rule] = await tx
        .insert(availabilityRules)
        .values({
          clinicId: input.clinicId,
          practitionerId: input.practitionerId,
          weekday: input.weekday,
          startTime: input.startTime,
          endTime: input.endTime,
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
          slotMinutes: input.slotMinutes,
          label: input.label ?? null,
        })
        .returning();

      if (!rule) {
        throw new AppError(500, "INSERT_FAILED", "No se pudo crear la regla");
      }

      return rule;
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "RULE_DUPLICATED",
          "Ya existe una regla identica para ese especialista y fecha de inicio",
        );
      }
      throw err;
    }
  });
}

export type CreateWeeklyRulesInput = {
  clinicId: string;
  practitionerId: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  lunchStart?: string;
  lunchEnd?: string;
  slotMinutes: number;
  validFrom: string;
  validTo?: string;
};

/**
 * Crea el horario de varios días en una sola transaccion. Si un dia ya tiene
 * una regla incompatible, no se crea ninguna: evita horarios a medias.
 */
export async function createWeeklyRules(
  db: Database,
  input: CreateWeeklyRulesInput,
): Promise<AvailabilityRuleRow[]> {
  if (input.startTime >= input.endTime) {
    throw new AppError(
      422,
      "INVALID_TIME_RANGE",
      "startTime debe ser anterior a endTime",
    );
  }
  if (
    input.lunchStart &&
    input.lunchEnd &&
    !(
      input.startTime < input.lunchStart &&
      input.lunchStart < input.lunchEnd &&
      input.lunchEnd < input.endTime
    )
  ) {
    throw new AppError(
      422,
      "INVALID_LUNCH_RANGE",
      "La comida debe estar dentro del horario laboral",
    );
  }
  if (input.validTo && input.validTo < input.validFrom) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "validTo debe ser igual o posterior a validFrom",
    );
  }

  const weekdays = [...new Set(input.weekdays)].sort((a, b) => a - b);
  const segments: Array<{ startTime: string; endTime: string; label: string }> =
    input.lunchStart && input.lunchEnd
      ? [
          {
            startTime: input.startTime,
            endTime: input.lunchStart,
            label: "Mañana",
          },
          {
            startTime: input.lunchEnd,
            endTime: input.endTime,
            label: "Tarde",
          },
        ]
      : [
          {
            startTime: input.startTime,
            endTime: input.endTime,
            label: "Horario continuo",
          },
        ];

  return withTenant(db, input.clinicId, async (tx) => {
    await assertPractitioner(tx, input.practitionerId);

    try {
      const created: AvailabilityRuleRow[] = [];
      for (const weekday of weekdays) {
        for (const segment of segments) {
          const [rule] = await tx
            .insert(availabilityRules)
            .values({
              clinicId: input.clinicId,
              practitionerId: input.practitionerId,
              weekday,
              startTime: segment.startTime,
              endTime: segment.endTime,
              validFrom: input.validFrom,
              validTo: input.validTo ?? null,
              slotMinutes: input.slotMinutes,
              label: segment.label,
            })
            .returning();

          if (!rule) {
            throw new AppError(
              500,
              "INSERT_FAILED",
              "No se pudo crear el horario semanal",
            );
          }
          created.push(rule);
        }
      }
      return created;
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "RULE_DUPLICATED",
          "Alguno de los días ya tiene una regla con ese horario de inicio",
        );
      }
      throw err;
    }
  });
}

export async function listAvailabilityRules(
  db: Database,
  params: { clinicId: string; practitionerId: string },
): Promise<AvailabilityRuleRow[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select()
      .from(availabilityRules)
      .where(eq(availabilityRules.practitionerId, params.practitionerId))
      .orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startTime)),
  );
}

export type UpdateRuleInput = {
  clinicId: string;
  ruleId: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
  validFrom?: string;
  validTo?: string | null;
  slotMinutes?: number;
  label?: string | null;
  requirePractitionerId?: string | null;
};

export async function updateAvailabilityRule(
  db: Database,
  input: UpdateRuleInput,
): Promise<AvailabilityRuleRow> {
  return withTenant(db, input.clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(availabilityRules)
      .where(eq(availabilityRules.id, input.ruleId))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "RULE_NOT_FOUND", "Regla no encontrada");
    }

    if (
      input.requirePractitionerId &&
      existing.practitionerId !== input.requirePractitionerId
    ) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "La regla pertenece a otro especialista",
      );
    }

    const startTime = input.startTime ?? existing.startTime;
    const endTime = input.endTime ?? existing.endTime;
    const validFrom = input.validFrom ?? existing.validFrom;
    const validTo =
      input.validTo !== undefined ? input.validTo : existing.validTo;

    if (startTime >= endTime) {
      throw new AppError(
        422,
        "INVALID_TIME_RANGE",
        "startTime debe ser anterior a endTime",
      );
    }
    if (validTo && validTo < validFrom) {
      throw new AppError(
        422,
        "INVALID_RANGE",
        "validTo debe ser igual o posterior a validFrom",
      );
    }

    try {
      const [updated] = await tx
        .update(availabilityRules)
        .set({
          weekday: input.weekday ?? existing.weekday,
          startTime,
          endTime,
          validFrom,
          validTo,
          slotMinutes: input.slotMinutes ?? existing.slotMinutes,
          label: input.label !== undefined ? input.label : existing.label,
        })
        .where(eq(availabilityRules.id, input.ruleId))
        .returning();

      if (!updated) {
        throw new AppError(500, "UPDATE_FAILED", "No se pudo actualizar la regla");
      }
      return updated;
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "RULE_DUPLICATED",
          "Ya existe una regla identica para ese especialista y fecha de inicio",
        );
      }
      throw err;
    }
  });
}

export async function deleteAvailabilityRule(
  db: Database,
  params: {
    clinicId: string;
    ruleId: string;
    requirePractitionerId?: string | null;
  },
): Promise<void> {
  await withTenant(db, params.clinicId, async (tx) => {
    const [existing] = await tx
      .select({
        id: availabilityRules.id,
        practitionerId: availabilityRules.practitionerId,
      })
      .from(availabilityRules)
      .where(eq(availabilityRules.id, params.ruleId))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "RULE_NOT_FOUND", "Regla no encontrada");
    }
    if (
      params.requirePractitionerId &&
      existing.practitionerId !== params.requirePractitionerId
    ) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "La regla pertenece a otro especialista",
      );
    }

    await tx
      .delete(availabilityRules)
      .where(eq(availabilityRules.id, params.ruleId));
  });
}

export type CreateBlockInput = {
  clinicId: string;
  practitionerId: string;
  startsAt?: Date;
  endsAt?: Date;
  startDate?: string;
  endDate?: string;
  startAllDay?: boolean;
  endAllDay?: boolean;
  startTime?: string;
  endTime?: string;
  type: string;
  reason?: string;
};

export async function createScheduleBlock(
  db: Database,
  input: CreateBlockInput,
): Promise<ScheduleBlockRow> {
  return withTenant(db, input.clinicId, async (tx) => {
    const [clinic] = await tx
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, input.clinicId))
      .limit(1);

    if (!clinic) {
      throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
    }

    const { startsAt, endsAt } = resolveBlockRange(input, clinic.timezone);

    await assertPractitioner(tx, input.practitionerId);

    const [block] = await tx
      .insert(scheduleBlocks)
      .values({
        clinicId: input.clinicId,
        practitionerId: input.practitionerId,
        startsAt,
        endsAt,
        type: input.type,
        reason: input.reason ?? null,
      })
      .returning();

    if (!block) {
      throw new AppError(500, "INSERT_FAILED", "No se pudo crear el bloqueo");
    }

    return block;
  });
}

export async function listScheduleBlocks(
  db: Database,
  params: {
    clinicId: string;
    practitionerId: string;
    from: Date;
    to: Date;
  },
): Promise<ScheduleBlockRow[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select()
      .from(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.practitionerId, params.practitionerId),
          lt(scheduleBlocks.startsAt, params.to),
          gt(scheduleBlocks.endsAt, params.from),
        ),
      )
      .orderBy(asc(scheduleBlocks.startsAt)),
  );
}

export async function deleteScheduleBlock(
  db: Database,
  params: {
    clinicId: string;
    id: string;
    requirePractitionerId?: string | null;
  },
): Promise<void> {
  await withTenant(db, params.clinicId, async (tx) => {
    const [block] = await tx
      .select({
        id: scheduleBlocks.id,
        practitionerId: scheduleBlocks.practitionerId,
      })
      .from(scheduleBlocks)
      .where(eq(scheduleBlocks.id, params.id))
      .limit(1);

    if (!block) {
      throw new AppError(404, "BLOCK_NOT_FOUND", "Bloqueo no encontrado");
    }

    if (
      params.requirePractitionerId &&
      block.practitionerId !== params.requirePractitionerId
    ) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "El bloqueo pertenece a otro especialista",
      );
    }

    await tx.delete(scheduleBlocks).where(eq(scheduleBlocks.id, params.id));
  });
}

async function assertPractitioner(
  tx: Transaction,
  practitionerId: string,
): Promise<void> {
  const [practitioner] = await tx
    .select({ id: practitioners.id })
    .from(practitioners)
    .where(
      and(
        eq(practitioners.id, practitionerId),
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
}

function assertDateRange(from: string, to: string): void {
  const start = DateTime.fromISO(from, { zone: "utc" });
  const end = DateTime.fromISO(to, { zone: "utc" });

  if (!start.isValid || !end.isValid) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "Las fechas deben tener formato YYYY-MM-DD",
    );
  }

  if (start >= end) {
    throw new AppError(422, "INVALID_RANGE", "from debe ser anterior a to");
  }

  if (end.diff(start, "days").days > MAX_RANGE_DAYS) {
    throw new AppError(
      422,
      "RANGE_TOO_LARGE",
      `El rango maximo es de ${MAX_RANGE_DAYS} dias`,
    );
  }
}
