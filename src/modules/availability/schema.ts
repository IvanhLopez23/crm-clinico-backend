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

export const createBlockBody = z.object({
  practitionerId: z.uuid(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
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
});

export const blockParams = z.object({
  id: z.uuid(),
});
