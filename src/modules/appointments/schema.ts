import { z } from "zod";

const isoDateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const ianaTimezone = z.string().min(1).refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Zona horaria IANA invalida");

export const createAppointmentBody = z.object({
  patientId: z.uuid(),
  practitionerId: z.uuid(),
  serviceId: z.uuid().optional(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  timezone: ianaTimezone,
  confirm: z.boolean().optional(),
  isOverbooking: z.boolean().optional(),
  overbookingReason: z
    .enum(["urgency", "clinical_fit", "vip", "other"])
    .optional(),
  notesInternal: z.string().max(2000).optional(),
});

export const listAppointmentsQuery = z.object({
  from: isoDateTime,
  to: isoDateTime,
  practitionerId: z.uuid().optional(),
  patientId: z.uuid().optional(),
  status: z
    .enum([
      "requested",
      "confirmed",
      "arrived",
      "in_consultation",
      "completed",
      "cancelled",
      "no_show",
    ])
    .optional(),
});

export const confirmAppointmentBody = z.object({
  channel: z.string().trim().max(40).optional(),
});

export const checkInAppointmentBody = z.object({
  source: z.enum(["reception", "kiosk", "mobile", "staff"]).optional(),
  force: z.boolean().optional(),
});

export const noShowAppointmentBody = z.object({
  reason: z.string().trim().max(500).optional(),
  force: z.boolean().optional(),
});

export const appointmentParams = z.object({
  id: z.uuid(),
});

export const cancelAppointmentBody = z.object({
  reasonCode: z
    .enum([
      "patient_request",
      "rescheduled",
      "clinic_cancelled",
      "financial",
      "other",
    ])
    .default("other"),
});

export const rescheduleAppointmentBody = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  timezone: ianaTimezone,
});

export type CreateAppointmentBody = z.infer<typeof createAppointmentBody>;
