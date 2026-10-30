import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { bytea } from "./custom-types.js";
import { households } from "./households.js";

export const PATIENT_RELATIONSHIPS = [
  "self",
  "spouse",
  "child",
  "parent",
  "sibling",
  "other_dependent",
] as const;

export const PATIENT_DOCUMENT_TYPES = [
  "ine",
  "passport",
  "curp",
  "ssn",
  "other",
] as const;

export const PATIENT_SEX_AT_BIRTH = [
  "female",
  "male",
  "intersex",
  "unknown",
] as const;

export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    // Nulo durante la migracion 0011; 0014/backfill lo deja NOT NULL.
    householdId: uuid("household_id"),
    relationship: text("relationship").notNull().default("self"),
    isAccountHolder: boolean("is_account_holder").notNull().default(false),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    preferredName: text("preferred_name"),
    // Campos desnormalizados de display; la fuente canonica es contact_points.
    phoneE164: text("phone_e164"),
    email: text("email"),
    birthDate: date("birth_date", { mode: "string" }),
    documentType: text("document_type"),
    documentNumberEnc: bytea("document_number_enc"),
    documentNumberBidx: text("document_number_bidx"),
    sexAtBirth: text("sex_at_birth"),
    genderIdentity: text("gender_identity"),
    bloodType: text("blood_type"),
    preferredLanguage: text("preferred_language").notNull().default("es"),
    status: text("status").notNull().default("lead"),
    reminderOptOut: boolean("reminder_opt_out").notNull().default(false),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    source: text("source"),
    firstVisitAt: timestamp("first_visit_at", { withTimezone: true }),
    lastVisitAt: timestamp("last_visit_at", { withTimezone: true }),
    deceasedAt: timestamp("deceased_at", { withTimezone: true }),
    mergedIntoPatientId: uuid("merged_into_patient_id").references(
      (): AnyPgColumn => patients.id,
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
    index("patients_clinic_idx").on(t.clinicId),
    index("patients_name_idx").on(t.lastName, t.firstName),
    index("patients_household_idx").on(t.clinicId, t.householdId),
    index("patients_last_visit_idx").on(t.clinicId, t.lastVisitAt),
    index("patients_merged_idx")
      .on(t.mergedIntoPatientId)
      .where(sql`${t.mergedIntoPatientId} is not null`),
    uniqueIndex("patients_document_bidx_uq")
      .on(t.clinicId, t.documentNumberBidx)
      .where(sql`${t.documentNumberBidx} is not null and ${t.deletedAt} is null`),
    // Necesario para las FKs compuestas de citas y waitlist.
    unique("patients_id_clinic_uq").on(t.id, t.clinicId),
    foreignKey({
      columns: [t.householdId, t.clinicId],
      foreignColumns: [households.id, households.clinicId],
      name: "patients_household_clinic_fk",
    }),
    check(
      "patients_status_chk",
      sql`${t.status} in ('lead', 'active', 'inactive', 'blocked', 'deceased')`,
    ),
    check(
      "patients_relationship_chk",
      sql`${t.relationship} in ('self','spouse','child','parent','sibling','other_dependent')`,
    ),
    check(
      "patients_document_type_chk",
      sql`${t.documentType} is null or ${t.documentType} in ('ine','passport','curp','ssn','other')`,
    ),
    check(
      "patients_sex_at_birth_chk",
      sql`${t.sexAtBirth} is null or ${t.sexAtBirth} in ('female','male','intersex','unknown')`,
    ),
  ],
);
