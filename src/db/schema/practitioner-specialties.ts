import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";
import { practitioners } from "./practitioners.js";
import { specialties } from "./specialties.js";

export const practitionerSpecialties = pgTable(
  "practitioner_specialties",
  {
    clinicId: uuid("clinic_id").notNull(),
    practitionerId: uuid("practitioner_id").notNull(),
    specialtyId: uuid("specialty_id").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    primaryKey({
      columns: [t.practitionerId, t.specialtyId],
      name: "practitioner_specialties_pk",
    }),
    index("practitioner_specialties_clinic_idx").on(
      t.clinicId,
      t.practitionerId,
    ),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "practitioner_specialties_practitioner_clinic_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.specialtyId, t.clinicId],
      foreignColumns: [specialties.id, specialties.clinicId],
      name: "practitioner_specialties_specialty_clinic_fk",
    }).onDelete("cascade"),
    check(
      "practitioner_specialties_primary_chk",
      sql`${t.isPrimary} in (true, false)`,
    ),
  ],
);
