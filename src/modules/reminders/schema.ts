import { z } from "zod";

export const reminderParams = z.object({ id: z.uuid() });

export const reminderListQuery = z.object({
  status: z
    .enum(["pending", "processing", "sent", "failed", "cancelled"])
    .optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
