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
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { patients } from "./patients.js";
import { practitioners } from "./practitioners.js";

export const WAITLIST_STATUSES = [
  "waiting",
  "offered",
  "booked",
  "expired",
  "cancelled",
] as const;

/**
 * Entrada en lista de espera. `practitionerId` nulo significa "cualquier
 * especialista". La prioridad la fija el personal (urgencia clinica).
 */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    practitionerId: uuid("practitioner_id"),
    earliestDate: date("earliest_date", { mode: "string" }).notNull(),
    latestDate: date("latest_date", { mode: "string" }).notNull(),
    preferredTimeFrom: time("preferred_time_from"),
    preferredTimeTo: time("preferred_time_to"),
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull().default("waiting"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("waitlist_entries_clinic_status_idx").on(
      t.clinicId,
      t.status,
      t.priority,
    ),
    index("waitlist_entries_patient_idx").on(t.patientId),
    foreignKey({
      columns: [t.patientId, t.clinicId],
      foreignColumns: [patients.id, patients.clinicId],
      name: "waitlist_entries_patient_clinic_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "waitlist_entries_practitioner_clinic_fk",
    }).onDelete("cascade"),
    check(
      "waitlist_entries_status_chk",
      sql`${t.status} in ('waiting', 'offered', 'booked', 'expired', 'cancelled')`,
    ),
    check(
      "waitlist_entries_priority_chk",
      sql`${t.priority} between 0 and 100`,
    ),
    check(
      "waitlist_entries_dates_chk",
      sql`${t.latestDate} >= ${t.earliestDate}`,
    ),
    check(
      "waitlist_entries_time_window_chk",
      sql`${t.preferredTimeFrom} is null or ${t.preferredTimeTo} is null or ${t.preferredTimeFrom} < ${t.preferredTimeTo}`,
    ),
  ],
);
