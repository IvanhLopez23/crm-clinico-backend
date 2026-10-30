import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { clinics } from "./clinics.js";
import { users } from "./users.js";

export const APPOINTMENT_ACTOR_TYPES = [
  "user",
  "patient",
  "system",
  "api",
] as const;

/**
 * Historial append-only de transiciones. Es la fuente de verdad para metricas
 * de tiempos y para la futura timeline; la app solo tiene SELECT/INSERT.
 */
export const appointmentStatusHistory = pgTable(
  "appointment_status_history",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    appointmentId: uuid("appointment_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorType: text("actor_type").notNull().default("system"),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reasonCode: text("reason_code"),
    reasonText: text("reason_text"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("appt_status_history_appt_idx").on(t.appointmentId, t.createdAt),
    index("appt_status_history_clinic_idx").on(t.clinicId, t.createdAt),
    foreignKey({
      columns: [t.appointmentId, t.clinicId],
      foreignColumns: [appointments.id, appointments.clinicId],
      name: "appt_status_history_appointment_clinic_fk",
    }).onDelete("cascade"),
    check(
      "appt_status_history_actor_chk",
      sql`${t.actorType} in ('user','patient','system','api')`,
    ),
    check(
      "appt_status_history_to_chk",
      sql`${t.toStatus} in ('requested','confirmed','arrived','in_consultation','completed','cancelled','no_show')`,
    ),
    check(
      "appt_status_history_from_chk",
      sql`${t.fromStatus} is null or ${t.fromStatus} in ('requested','confirmed','arrived','in_consultation','completed','cancelled','no_show')`,
    ),
  ],
);
