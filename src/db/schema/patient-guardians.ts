import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { patients } from "./patients.js";

/**
 * Tutor o cuidador de un paciente (menor o dependiente). Si el tutor tambien
 * es paciente, se enlaza por `guardian_patient_id`; si no, se guardan sus
 * datos minimos. La tutela puede ser temporal (`valid_from`/`valid_to`).
 */
export const patientGuardians = pgTable(
  "patient_guardians",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    guardianPatientId: uuid("guardian_patient_id"),
    guardianName: text("guardian_name"),
    guardianDocumentEnc: bytea("guardian_document_enc"),
    guardianDocumentBidx: text("guardian_document_bidx"),
    guardianPhoneE164: text("guardian_phone_e164"),
    relationship: text("relationship").notNull(),
    isLegalGuardian: boolean("is_legal_guardian").notNull().default(false),
    validFrom: date("valid_from", { mode: "string" })
      .notNull()
      .default(sql`current_date`),
    validTo: date("valid_to", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("patient_guardians_patient_idx").on(t.clinicId, t.patientId),
    index("patient_guardians_guardian_idx").on(
      t.clinicId,
      t.guardianPatientId,
    ),
    foreignKey({
      columns: [t.patientId, t.clinicId],
      foreignColumns: [patients.id, patients.clinicId],
      name: "patient_guardians_patient_clinic_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.guardianPatientId, t.clinicId],
      foreignColumns: [patients.id, patients.clinicId],
      name: "patient_guardians_guardian_clinic_fk",
    }),
    check(
      "patient_guardians_relationship_chk",
      sql`${t.relationship} in ('parent','legal_guardian','caregiver','spouse','other')`,
    ),
    check(
      "patient_guardians_identity_chk",
      sql`${t.guardianPatientId} is not null or ${t.guardianName} is not null`,
    ),
    check(
      "patient_guardians_not_self_chk",
      sql`${t.guardianPatientId} is null or ${t.guardianPatientId} <> ${t.patientId}`,
    ),
    check(
      "patient_guardians_validity_chk",
      sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`,
    ),
  ],
);
