import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { practitioners } from "./practitioners.js";

export const SCHEDULE_BLOCK_TYPES = [
  "vacation",
  "meeting",
  "surgery",
  "personal",
  "holiday",
  "maintenance",
  "break",
  "other",
] as const;

/**
 * Bloqueo puntual de agenda (vacaciones, reunion, cirugia...). Siempre gana
 * sobre las reglas de disponibilidad.
 */
export const scheduleBlocks = pgTable(
  "schedule_blocks",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    practitionerId: uuid("practitioner_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    type: text("type").notNull().default("other"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("schedule_blocks_practitioner_idx").on(t.practitionerId, t.startsAt),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "schedule_blocks_practitioner_clinic_fk",
    }).onDelete("cascade"),
    check("schedule_blocks_range_chk", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "schedule_blocks_type_chk",
      sql`${t.type} in ('vacation', 'meeting', 'surgery', 'personal', 'holiday', 'maintenance', 'break', 'other')`,
    ),
  ],
);
