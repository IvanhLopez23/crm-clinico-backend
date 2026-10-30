import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";

/**
 * Cuenta familiar. Agrupa pacientes que comparten telefono, email, direccion
 * o responsable de pago. El titular es `patients.is_account_holder`; el
 * responsable de pago es `billing_patient_id` (FK compuesta añadida en SQL
 * manual porque patients se define despues y hay ciclo).
 */
export const households = pgTable(
  "households",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    billingPatientId: uuid("billing_patient_id"),
    preferredChannel: text("preferred_channel").notNull().default("whatsapp"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("households_clinic_idx").on(t.clinicId),
    unique("households_id_clinic_uq").on(t.id, t.clinicId),
    check(
      "households_preferred_channel_chk",
      sql`${t.preferredChannel} in ('whatsapp','sms','email','phone')`,
    ),
  ],
);
