import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const serviceParams = z.object({
  id: z.uuid(),
});

export const serviceListQuery = z.object({
  active: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

export const createServiceBody = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(160),
    specialtyId: z.uuid().optional(),
    durationMinutes: z.coerce.number().int().min(5).max(480),
    bufferBeforeMinutes: z.coerce.number().int().min(0).max(120).default(0),
    bufferAfterMinutes: z.coerce.number().int().min(0).max(120).default(0),
    priceCents: z.coerce.number().int().min(0),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    taxRateBps: z.coerce.number().int().min(0).max(10_000).default(0),
    depositRequired: z.boolean().default(false),
    depositCents: z.coerce.number().int().min(0).optional(),
    depositBps: z.coerce.number().int().min(0).max(10_000).optional(),
    color: hexColor.optional(),
    isTelehealth: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .refine(
    (value) =>
      !value.depositRequired ||
      value.depositCents !== undefined ||
      value.depositBps !== undefined,
    {
      message: "depositRequired exige depositCents o depositBps",
      path: ["depositCents"],
    },
  )
  .refine(
    (value) =>
      value.depositCents === undefined || value.depositBps === undefined,
    {
      message: "depositCents y depositBps son mutuamente excluyentes",
      path: ["depositBps"],
    },
  );

export const updateServiceBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  specialtyId: z.uuid().nullable().optional(),
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  bufferBeforeMinutes: z.coerce.number().int().min(0).max(120).optional(),
  bufferAfterMinutes: z.coerce.number().int().min(0).max(120).optional(),
  priceCents: z.coerce.number().int().min(0).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  taxRateBps: z.coerce.number().int().min(0).max(10_000).optional(),
  depositRequired: z.boolean().optional(),
  depositCents: z.coerce.number().int().min(0).nullable().optional(),
  depositBps: z.coerce.number().int().min(0).max(10_000).nullable().optional(),
  color: hexColor.nullable().optional(),
  isTelehealth: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const createSpecialtyBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
});

export const practitionerServiceParams = z.object({
  id: z.uuid(),
});

export const practitionerParams = z.object({
  id: z.uuid(),
});

export const practitionerServiceListQuery = z.object({
  practitionerId: z.uuid().optional(),
  active: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

export const upsertPractitionerServiceBody = z
  .object({
    serviceId: z.uuid().optional(),
    serviceName: z.string().trim().min(1).max(160).optional(),
    durationMinutes: z.coerce.number().int().min(5).max(480),
    priceCents: z.coerce.number().int().min(0),
    isActive: z.boolean().default(true),
  })
  .refine((value) => Boolean(value.serviceId || value.serviceName), {
    message: "Indica serviceId o serviceName",
    path: ["serviceName"],
  });

export const updatePractitionerServiceBody = z.object({
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  priceCents: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export type CreateServiceBody = z.infer<typeof createServiceBody>;
export type UpdateServiceBody = z.infer<typeof updateServiceBody>;
export type CreateSpecialtyBody = z.infer<typeof createSpecialtyBody>;
export type UpsertPractitionerServiceBody = z.infer<
  typeof upsertPractitionerServiceBody
>;
export type UpdatePractitionerServiceBody = z.infer<
  typeof updatePractitionerServiceBody
>;
