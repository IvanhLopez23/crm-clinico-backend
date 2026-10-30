import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { practitioners } from "./practitioners.js";

/**
 * Regla semanal de disponibilidad, con vigencia. Varias reglas pueden
 * solaparse: el generador de slots deduplica.
 *
 * `weekday` sigue ISO-8601: 1 = lunes ... 7 = domingo.
 */
export const availabilityRules = pgTable(
  "availability_rules",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    practitionerId: uuid("practitioner_id").notNull(),
    weekday: integer("weekday").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    slotMinutes: integer("slot_minutes").notNull().default(15),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("availability_rules_practitioner_idx").on(t.practitionerId, t.weekday),
    uniqueIndex("availability_rules_unique_idx").on(
      t.practitionerId,
      t.weekday,
      t.startTime,
      t.validFrom,
    ),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "availability_rules_practitioner_clinic_fk",
    }).onDelete("cascade"),
    check("availability_rules_weekday_chk", sql`${t.weekday} between 1 and 7`),
    check("availability_rules_time_chk", sql`${t.startTime} < ${t.endTime}`),
    check(
      "availability_rules_slot_chk",
      sql`${t.slotMinutes} between 5 and 120`,
    ),
    check(
      "availability_rules_dates_chk",
      sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`,
    ),
  ],
);
