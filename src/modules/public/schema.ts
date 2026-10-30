import { z } from "zod";

const isoDate = z.iso.date();

export const publicSlugParams = z.object({
  slug: z.string().trim().min(1).max(120),
});

export const publicAvailabilityQuery = z.object({
  serviceId: z.uuid(),
  practitionerId: z.uuid(),
  date: isoDate,
});

export const publicBookingBody = z.object({
  serviceId: z.uuid(),
  practitionerId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  patient: z.object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(7).max(30),
    email: z.email().max(254).optional(),
  }),
});

export type PublicBookingBody = z.infer<typeof publicBookingBody>;
