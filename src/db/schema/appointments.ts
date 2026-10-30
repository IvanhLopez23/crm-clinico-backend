import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { households } from "./households.js";
import { patients } from "./patients.js";
import { practitioners } from "./practitioners.js";
import { services } from "./services.js";
import { users } from "./users.js";

/**
 * Estados de la cita. Se modelan como text + CHECK (no pgEnum) para poder
 * evolucionar sin migraciones destructivas de tipo.
 */
export const APPOINTMENT_STATUSES = [
  "requested",
  "confirmed",
  "arrived",
  "in_consultation",
  "completed",
  "cancelled",
  "no_show",
] as const;

export const BOOKED_VIA_VALUES = [
  "public",
  "staff",
  "waitlist",
  "api",
  "recurrence",
] as const;

export const CANCELLATION_REASONS = [
  "patient_request",
  "rescheduled",
  "clinic_cancelled",
  "financial",
  "other",
] as const;

export const OVERBOOKING_REASONS = [
  "urgency",
  "clinical_fit",
  "vip",
  "other",
] as const;

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    practitionerId: uuid("practitioner_id").notNull(),
    serviceId: uuid("service_id"),
    householdId: uuid("household_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull().default("requested"),
    bookedVia: text("booked_via").notNull().default("staff"),
    isOverbooking: boolean("is_overbooking").notNull().default(false),
    notesInternal: text("notes_internal"),

    // Snapshot del servicio: la cita historica no cambia si el catalogo cambia.
    serviceNameSnapshot: text("service_name_snapshot"),
    durationMinutesSnapshot: bigint("duration_minutes_snapshot", {
      mode: "number",
    }),
    bufferBeforeMinutesSnapshot: bigint("buffer_before_minutes_snapshot", {
      mode: "number",
    })
      .notNull()
      .default(0),
    bufferAfterMinutesSnapshot: bigint("buffer_after_minutes_snapshot", {
      mode: "number",
    })
      .notNull()
      .default(0),
    priceCentsSnapshot: bigint("price_cents_snapshot", { mode: "number" })
      .notNull()
      .default(0),
    currencySnapshot: char("currency_snapshot", { length: 3 }),

    bookedByUserId: uuid("booked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    bookedByPatientId: uuid("booked_by_patient_id"),

    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmationChannel: text("confirmation_channel"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    roomedAt: timestamp("roomed_at", { withTimezone: true }),
    consultStartedAt: timestamp("consult_started_at", { withTimezone: true }),
    consultEndedAt: timestamp("consult_ended_at", { withTimezone: true }),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    noShowMarkedAt: timestamp("no_show_marked_at", { withTimezone: true }),
    noShowReason: text("no_show_reason"),

    overbookingReason: text("overbooking_reason"),
    overbookingApprovedByUserId: uuid("overbooking_approved_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),

    // Fase 3: política y depósito. Se guardan desde ahora para no migrar dos veces.
    cancellationPolicyId: uuid("cancellation_policy_id"),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown> | null>(),
    depositRequiredCents: bigint("deposit_required_cents", { mode: "number" }),

    statusChangedAt: timestamp("status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancellationReasonCode: text("cancellation_reason_code"),
    rescheduledFromId: uuid("rescheduled_from_id").references(
      (): AnyPgColumn => appointments.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("appointments_practitioner_start_idx").on(t.practitionerId, t.startsAt),
    index("appointments_patient_start_idx").on(t.patientId, t.startsAt),
    index("appointments_clinic_start_idx").on(t.clinicId, t.startsAt),
    index("appointments_service_start_idx").on(t.serviceId, t.startsAt),
    index("appointments_household_start_idx").on(t.householdId, t.startsAt),
    index("appointments_rescheduled_from_idx").on(t.rescheduledFromId),

    // FKs compuestas: impiden en la DB que una cita cruce clinicas.
    foreignKey({
      columns: [t.patientId, t.clinicId],
      foreignColumns: [patients.id, patients.clinicId],
      name: "appointments_patient_clinic_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "appointments_practitioner_clinic_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.serviceId, t.clinicId],
      foreignColumns: [services.id, services.clinicId],
      name: "appointments_service_clinic_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.householdId, t.clinicId],
      foreignColumns: [households.id, households.clinicId],
      name: "appointments_household_clinic_fk",
    }),
    foreignKey({
      columns: [t.bookedByPatientId, t.clinicId],
      foreignColumns: [patients.id, patients.clinicId],
      name: "appointments_booked_by_patient_clinic_fk",
    }),

    unique("appointments_id_clinic_uq").on(t.id, t.clinicId),

    check(
      "appointments_status_chk",
      sql`${t.status} in ('requested', 'confirmed', 'arrived', 'in_consultation', 'completed', 'cancelled', 'no_show')`,
    ),
    check(
      "appointments_booked_via_chk",
      sql`${t.bookedVia} in ('public', 'staff', 'waitlist', 'api', 'recurrence')`,
    ),
    check(
      "appointments_cancelled_by_chk",
      sql`${t.cancelledBy} is null or ${t.cancelledBy} in ('staff', 'patient', 'system')`,
    ),
    check(
      "appointments_cancel_reason_chk",
      sql`${t.cancellationReasonCode} is null or ${t.cancellationReasonCode} in ('patient_request', 'rescheduled', 'clinic_cancelled', 'financial', 'other')`,
    ),
    check(
      "appointments_overbooking_reason_chk",
      sql`${t.overbookingReason} is null or ${t.overbookingReason} in ('urgency', 'clinical_fit', 'vip', 'other')`,
    ),
    // Una cita cancelada siempre tiene fecha de cancelacion (y viceversa).
    check(
      "appointments_cancelled_at_chk",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    check("appointments_range_chk", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
