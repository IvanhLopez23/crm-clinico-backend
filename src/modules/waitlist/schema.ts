import { z } from "zod";

const isoDate = z.iso.date();

const timeHm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato HH:MM");

const waitlistStatus = z.enum([
  "waiting",
  "offered",
  "booked",
  "expired",
  "cancelled",
]);

const offerStatus = z.enum([
  "pending",
  "accepted",
  "expired",
  "declined",
  "superseded",
]);

export const createWaitlistBody = z.object({
  patientId: z.uuid(),
  practitionerId: z.uuid().optional(),
  earliestDate: isoDate,
  latestDate: isoDate,
  preferredTimeFrom: timeHm.optional(),
  preferredTimeTo: timeHm.optional(),
  priority: z.coerce.number().int().min(0).max(100).default(0),
  notes: z.string().max(500).optional(),
});

export const waitlistQuery = z.object({
  status: waitlistStatus.optional(),
  practitionerId: z.uuid().optional(),
});

export const offerParams = z.object({
  id: z.uuid(),
});

export const offersQuery = z.object({
  status: offerStatus.optional(),
});
