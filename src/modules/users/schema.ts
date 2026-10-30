import { z } from "zod";
import { USER_ROLES } from "../../db/schema/users.js";

const avatarData = z
  .string()
  .max(400_000)
  .refine(
    (value) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value),
    "La foto debe ser una imagen PNG, JPEG o WebP",
  )
  .nullable()
  .optional();

export const userParams = z.object({
  id: z.uuid(),
});

export const createUserBody = z.object({
  email: z.email().max(320),
  password: z.string().min(8).max(200),
  fullName: z.string().trim().min(1).max(160),
  avatarData,
  role: z.enum(USER_ROLES),
  practitionerId: z.uuid().nullable().optional(),
});

export const updateUserBody = z.object({
  email: z.email().max(320).optional(),
  password: z.string().min(8).max(200).optional(),
  fullName: z.string().trim().min(1).max(160).optional(),
  avatarData,
  role: z.enum(USER_ROLES).optional(),
  practitionerId: z.uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updateOwnUserBody = z.object({
  email: z.email().max(320).optional(),
  password: z.string().min(8).max(200).optional(),
  fullName: z.string().trim().min(1).max(160).optional(),
  avatarData,
});

export type CreateUserBody = z.infer<typeof createUserBody>;
export type UpdateUserBody = z.infer<typeof updateUserBody>;
export type UpdateOwnUserBody = z.infer<typeof updateOwnUserBody>;
