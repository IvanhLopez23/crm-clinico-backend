import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";

export const practitioners = pgTable(
  "practitioners",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    fullName: text("full_name").notNull(),
    specialty: text("specialty"),
    color: char("color", { length: 7 }).notNull().default("#0F766E"),
    defaultSlotMinutes: integer("default_slot_minutes").notNull().default(30),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(5),
    avgConsultMinutes: numeric("avg_consult_minutes", {
      precision: 5,
      scale: 2,
    }),
    isAcceptingNewPatients: boolean("is_accepting_new_patients")
      .notNull()
      .default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("practitioners_clinic_idx").on(t.clinicId),
    // Necesario para la FK compuesta desde appointments (integridad de tenant).
    unique("practitioners_id_clinic_uq").on(t.id, t.clinicId),
    check(
      "practitioners_default_slot_chk",
      sql`${t.defaultSlotMinutes} between 5 and 120`,
    ),
    check(
      "practitioners_buffer_before_chk",
      sql`${t.bufferBeforeMinutes} between 0 and 120`,
    ),
    check(
      "practitioners_buffer_after_chk",
      sql`${t.bufferAfterMinutes} between 0 and 120`,
    ),
    check(
      "practitioners_avg_consult_chk",
      sql`${t.avgConsultMinutes} is null or ${t.avgConsultMinutes} between 0 and 480`,
    ),
  ],
);
