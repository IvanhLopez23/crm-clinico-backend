import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { patients } from "./patients.js";

export const ALLERGY_SEVERITIES = [
  "mild",
  "moderate",
  "severe",
  "anaphylaxis",
] as const;

/**
 * Alergia clinica. No es una etiqueta: tiene severidad y verificacion. Una
 * alergia `severe`/`anaphylaxis` produce banner rojo en agenda, ficha y sala.
 */
export const patientAllergies = pgTable(
  "patient_allergies",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    allergen: text("allergen").notNull(),
    reaction: text("reaction"),
    severity: text("severity").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    verifiedByUserId: uuid("verified_by_user_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("patient_allergies_patient_idx").on(t.clinicId, t.patientId),
    uniqueIndex("patient_allergies_active_uq")
      .on(t.patientId, sql`lower(${t.allergen})`)
      .where(sql`${t.isActive} and ${t.deletedAt} is null`),
    index("patient_allergies_alert_idx")
      .on(t.clinicId, t.patientId)
      .where(sql`${t.isActive} and ${t.severity} in ('severe','anaphylaxis')`),
    foreignKey({
      columns: [t.patientId, t.clinicId],
      foreignColumns: [patients.id, patients.clinicId],
      name: "patient_allergies_patient_clinic_fk",
    }).onDelete("cascade"),
    check(
      "patient_allergies_severity_chk",
      sql`${t.severity} in ('mild','moderate','severe','anaphylaxis')`,
    ),
  ],
);
