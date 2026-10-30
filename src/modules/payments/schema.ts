import { z } from "zod";

export const appointmentParams = z.object({ id: z.uuid() });

export const checkoutBody = z.object({
  amountCents: z.coerce.number().int().min(0).optional(),
  method: z.enum(["cash", "card", "transfer", "other"]).default("cash"),
  notes: z.string().trim().max(500).optional(),
});

export type CheckoutBody = z.infer<typeof checkoutBody>;
