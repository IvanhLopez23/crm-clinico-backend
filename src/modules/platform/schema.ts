import { z } from "zod";

export const clinicParams = z.object({
  id: z.uuid(),
});

export const clinicUserParams = z.object({
  id: z.uuid(),
  userId: z.uuid(),
});

const timezone = z.string().trim().min(1).max(80);
const currency = z.string().trim().length(3).toUpperCase();

export const createClinicBody = z.object({
  name: z.string().trim().min(1).max(160),
  timezone: timezone.default("America/Mexico_City"),
  currency: currency.default("MXN"),
  admin: z.object({
    fullName: z.string().trim().min(1).max(160),
    email: z.email().max(254),
    password: z.string().min(8).max(128),
  }),
});

export const updateClinicBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  timezone: timezone.optional(),
  currency: currency.optional(),
  isActive: z.boolean().optional(),
});

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

export type CreateClinicBody = z.infer<typeof createClinicBody>;
export type UpdateClinicBody = z.infer<typeof updateClinicBody>;
export type CreateClinicUserBody = z.infer<typeof createClinicUserBody>;
export type UpdateClinicUserBody = z.infer<typeof updateClinicUserBody>;
