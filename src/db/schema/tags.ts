import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { patients } from "./patients.js";

export const TAG_CATEGORIES = [
  "behavior",
  "risk",
  "vip",
  "operational",
  "clinical_alert",
] as const;

/**
 * Catalogo de etiquetas por clinica. Las de sistema (is_system=true) no se
 * editan; las de comportamiento se asignan con vigencia.
 */
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    label: text("label").notNull(),
    category: text("category").notNull(),
    color: text("color"),
    isAlert: boolean("is_alert").notNull().default(false),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("tags_clinic_code_uq").on(t.clinicId, t.code),
    unique("tags_id_clinic_uq").on(t.id, t.clinicId),
    check(
      "tags_category_chk",
      sql`${t.category} in ('behavior','risk','vip','operational','clinical_alert')`,
    ),
  ],
);

/**
 * Asignacion de etiqueta a paciente. `expires_at` permite etiquetas
 * temporales (p. ej. `new_patient` 90 dias) sin job de limpieza.
 */
export const patientTags = pgTable(
  "patient_tags",
  {
    clinicId: uuid("clinic_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    severity: smallint("severity").notNull().default(1),
    note: text("note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("patient_tags_patient_idx").on(t.clinicId, t.patientId),
    foreignKey({
      columns: [t.patientId, t.clinicId],
      foreignColumns: [patients.id, patients.clinicId],
      name: "patient_tags_patient_clinic_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tagId, t.clinicId],
      foreignColumns: [tags.id, tags.clinicId],
      name: "patient_tags_tag_clinic_fk",
    }).onDelete("cascade"),
    check("patient_tags_severity_chk", sql`${t.severity} between 1 and 3`),
    // PK compuesta: una etiqueta por paciente.
    primaryKey({
      columns: [t.patientId, t.tagId],
      name: "patient_tags_pk",
    }),
  ],
);
