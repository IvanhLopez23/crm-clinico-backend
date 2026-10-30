import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { clinics } from "./clinics.js";

export const REMINDER_CHANNELS = ["whatsapp", "sms", "email"] as const;

export const REMINDER_STATUSES = [
  "pending",
  "processing",
  "sent",
  "failed",
  "cancelled",
] as const;

/**
 * Recordatorio materializado. Se crea al reservar (48h/24h/2h) y se cancela
 * en la misma transaccion que la cancelacion o el reagendado de la cita.
 */
export const reminderJobs = pgTable(
  "reminder_jobs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    templateCode: text("template_code").notNull().default("reminder_manual"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("reminder_jobs_unique_idx").on(
      t.appointmentId,
      t.channel,
      t.scheduledFor,
    ),
    index("reminder_jobs_pending_idx").on(t.status, t.scheduledFor),
    check(
      "reminder_jobs_channel_chk",
      sql`${t.channel} in ('whatsapp', 'sms', 'email')`,
    ),
    check(
      "reminder_jobs_status_chk",
      sql`${t.status} in ('pending', 'processing', 'sent', 'failed', 'cancelled')`,
    ),
    check("reminder_jobs_attempts_chk", sql`${t.attempts} >= 0`),
  ],
);
