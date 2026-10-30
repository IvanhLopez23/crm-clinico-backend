import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { specialties } from "./specialties.js";

/**
 * Servicio clinico reservable. `starts_at`/`ends_at` de una cita representan
 * el tiempo de servicio; los buffers se guardan como snapshot en la cita y
 * se usan para calcular el bloque ocupado.
 */
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    specialtyId: uuid("specialty_id"),
    durationMinutes: integer("duration_minutes").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    taxRateBps: integer("tax_rate_bps").notNull().default(0),
    depositRequired: boolean("deposit_required").notNull().default(false),
    depositCents: bigint("deposit_cents", { mode: "number" }),
    depositBps: integer("deposit_bps"),
    cancellationPolicyId: uuid("cancellation_policy_id"),
    requiresConsentTemplateId: uuid("requires_consent_template_id"),
    isTelehealth: boolean("is_telehealth").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("services_clinic_active_idx").on(t.clinicId, t.isActive),
    unique("services_clinic_code_uq").on(t.clinicId, t.code),
    unique("services_id_clinic_uq").on(t.id, t.clinicId),
    foreignKey({
      columns: [t.specialtyId, t.clinicId],
      foreignColumns: [specialties.id, specialties.clinicId],
      name: "services_specialty_clinic_fk",
    }),
    check(
      "services_duration_chk",
      sql`${t.durationMinutes} between 5 and 480`,
    ),
    check(
      "services_buffer_before_chk",
      sql`${t.bufferBeforeMinutes} between 0 and 120`,
    ),
    check(
      "services_buffer_after_chk",
      sql`${t.bufferAfterMinutes} between 0 and 120`,
    ),
    check("services_price_chk", sql`${t.priceCents} >= 0`),
    check("services_tax_chk", sql`${t.taxRateBps} between 0 and 10000`),
    check(
      "services_deposit_cents_chk",
      sql`${t.depositCents} is null or ${t.depositCents} >= 0`,
    ),
    check(
      "services_deposit_bps_chk",
      sql`${t.depositBps} is null or ${t.depositBps} between 0 and 10000`,
    ),
    check(
      "services_deposit_exclusive_chk",
      sql`${t.depositCents} is null or ${t.depositBps} is null`,
    ),
    check(
      "services_deposit_required_chk",
      sql`not ${t.depositRequired} or ${t.depositCents} is not null or ${t.depositBps} is not null`,
    ),
  ],
);
