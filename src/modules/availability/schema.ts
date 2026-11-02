import { z } from "zod";

const isoDateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const isoDate = z.iso.date();

const timeHm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato HH:MM");

export const availabilityQuery = z.object({
  practitionerId: z.uuid(),
  serviceId: z.uuid().optional(),
  from: isoDate,
  to: isoDate,
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  slotMinutes: z.coerce.number().int().min(5).max(120).optional(),
});

export const practitionerQuery = z.object({
  practitionerId: z.uuid(),
});

export const createRuleBody = z.object({
  practitionerId: z.uuid(),
  weekday: z.coerce.number().int().min(1).max(7),
  startTime: timeHm,
  endTime: timeHm,
  validFrom: isoDate,
  validTo: isoDate.optional(),
  slotMinutes: z.coerce.number().int().min(5).max(120).default(15),
  label: z.string().max(120).optional(),
});

export const ruleParams = z.object({
  id: z.uuid(),
});

export const updateRuleBody = z.object({
  weekday: z.coerce.number().int().min(1).max(7).optional(),
  startTime: timeHm.optional(),
  endTime: timeHm.optional(),
  validFrom: isoDate.optional(),
  validTo: isoDate.nullable().optional(),
  slotMinutes: z.coerce.number().int().min(5).max(120).optional(),
  label: z.string().max(120).nullable().optional(),
});

export const createWeeklyRulesBody = z
  .object({
    practitionerId: z.uuid(),
    weekdays: z
      .array(z.coerce.number().int().min(1).max(7))
      .min(1)
      .max(7),
    startTime: timeHm,
    endTime: timeHm,
    lunchStart: timeHm.optional(),
    lunchEnd: timeHm.optional(),
    slotMinutes: z.coerce.number().int().min(5).max(120).default(15),
    validFrom: isoDate,
    validTo: isoDate.optional(),
  })
  .refine(
    (value) =>
      (value.lunchStart === undefined) === (value.lunchEnd === undefined),
    {
      message: "lunchStart y lunchEnd deben enviarse juntos",
      path: ["lunchStart"],
    },
  )
  .refine(
    (value) =>
      !value.lunchStart ||
      (value.startTime < value.lunchStart &&
        value.lunchStart < value.lunchEnd! &&
        value.lunchEnd! < value.endTime),
    {
      message: "La comida debe estar dentro del horario laboral",
      path: ["lunchStart"],
    },
  );

export const blocksQuery = z.object({
  practitionerId: z.uuid(),
  from: isoDateTime,
  to: isoDateTime,
});

export const createBlockBody = z
  .object({
    practitionerId: z.uuid(),
    /** Modo anterior: fechas absolutas. */
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
    /** Modo dia/rango local de la clinica. */
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    startAllDay: z.boolean().default(false),
    endAllDay: z.boolean().default(false),
    startTime: timeHm.optional(),
    endTime: timeHm.optional(),
    type: z
      .enum([
        "vacation",
        "meeting",
        "surgery",
        "personal",
        "holiday",
        "maintenance",
        "break",
        "other",
      ])
      .default("other"),
    reason: z.string().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    const hasAbsoluteRange =
      value.startsAt !== undefined || value.endsAt !== undefined;
    const hasLocalDays =
      value.startDate !== undefined || value.endDate !== undefined;

    if (hasAbsoluteRange && hasLocalDays) {
      ctx.addIssue({
        code: "custom",
        message: "Usa startsAt/endsAt o startDate/endDate, no ambos",
        path: ["startDate"],
      });
      return;
    }

    if (hasAbsoluteRange) {
      if (!value.startsAt || !value.endsAt) {
        ctx.addIssue({
          code: "custom",
          message: "Indica inicio y fin del bloqueo",
          path: ["endsAt"],
        });
      }
      return;
    }

    if (!value.startDate || !value.endDate) {
      ctx.addIssue({
        code: "custom",
        message: "Indica el dia y la fecha de fin del bloqueo",
        path: ["startDate"],
      });
      return;
    }

    if (!value.startAllDay && !value.startTime) {
      ctx.addIssue({
        code: "custom",
        message: "Indica la hora de inicio o marca todo el dia",
        path: ["startTime"],
      });
    }

    if (!value.endAllDay && !value.endTime) {
      ctx.addIssue({
        code: "custom",
        message: "Indica la hora de fin o marca todo el dia",
        path: ["endTime"],
      });
    }
  });

export const blockParams = z.object({
  id: z.uuid(),
});
