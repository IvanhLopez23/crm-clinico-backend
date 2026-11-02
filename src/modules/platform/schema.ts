import { z } from "zod";

export const clinicParams = z.object({
  id: z.uuid(),
});

export const clinicUserParams = z.object({
  id: z.uuid(),
  userId: z.uuid(),
});

export const contractParams = z.object({
  id: z.uuid(),
  contractId: z.uuid(),
});

const timezone = z.string().trim().min(1).max(80);
const currency = z.string().trim().length(3).toUpperCase();
const isoDate = z.iso.date();

const coordinateFields = {
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
};

function validateCoordinates(
  value: {
    latitude?: number | null;
    longitude?: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  const hasLatitude = value.latitude !== undefined;
  const hasLongitude = value.longitude !== undefined;

  if (hasLatitude !== hasLongitude) {
    ctx.addIssue({
      code: "custom",
      message: "Indica latitud y longitud juntas",
      path: ["latitude"],
    });
    return;
  }

  if (
    (value.latitude === null) !== (value.longitude === null) &&
    hasLatitude &&
    hasLongitude
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Latitud y longitud deben ser ambas nulas o ambas numericas",
      path: ["latitude"],
    });
  }
}

export const createClinicBody = z
  .object({
    name: z.string().trim().min(1).max(160),
    timezone: timezone.default("America/Mexico_City"),
    currency: currency.default("MXN"),
    ...coordinateFields,
    admin: z.object({
      fullName: z.string().trim().min(1).max(160),
      email: z.email().max(254),
      password: z.string().min(8).max(128),
    }),
  })
  .superRefine(validateCoordinates);

export const updateClinicBody = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    timezone: timezone.optional(),
    currency: currency.optional(),
    ...coordinateFields,
    isActive: z.boolean().optional(),
  })
  .superRefine(validateCoordinates);

export const createClinicUserBody = z.object({
  fullName: z.string().trim().min(1).max(160),
  email: z.email().max(254),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "practitioner", "receptionist"]),
  practitionerId: z.uuid().nullable().optional(),
});

export const updateClinicUserBody = z.object({
  fullName: z.string().trim().min(1).max(160).optional(),
  email: z.email().max(254).optional(),
  password: z.string().min(8).max(128).optional(),
  role: z.enum(["admin", "practitioner", "receptionist"]).optional(),
  practitionerId: z.uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const createContractFields = z
  .object({
    name: z.string().trim().min(1).max(160),
    startsAt: isoDate,
    endsAt: isoDate.optional(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((value) => value || undefined),
    isActive: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  })
  .refine((value) => !value.endsAt || value.endsAt >= value.startsAt, {
    message: "La fecha de fin debe ser igual o posterior al inicio",
    path: ["endsAt"],
  });

export type CreateClinicBody = z.infer<typeof createClinicBody>;
export type UpdateClinicBody = z.infer<typeof updateClinicBody>;
export type CreateClinicUserBody = z.infer<typeof createClinicUserBody>;
export type UpdateClinicUserBody = z.infer<typeof updateClinicUserBody>;
