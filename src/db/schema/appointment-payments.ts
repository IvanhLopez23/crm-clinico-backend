import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { clinics } from "./clinics.js";
import { users } from "./users.js";

export const PAYMENT_METHODS = ["cash", "card", "transfer", "other"] as const;
export const PAYMENT_STATUSES = ["paid", "refunded", "void"] as const;

export const appointmentPayments = pgTable(
  "appointment_payments",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    appointmentId: uuid("appointment_id").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    method: text("method").notNull().default("cash"),
    status: text("status").notNull().default("paid"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("appointment_payments_appointment_uq").on(t.appointmentId),
    index("appointment_payments_clinic_paid_idx").on(t.clinicId, t.paidAt),
    foreignKey({
      columns: [t.appointmentId, t.clinicId],
      foreignColumns: [appointments.id, appointments.clinicId],
      name: "appointment_payments_appointment_clinic_fk",
    }).onDelete("cascade"),
    check("appointment_payments_amount_chk", sql`${t.amountCents} >= 0`),
    check(
      "appointment_payments_method_chk",
      sql`${t.method} in ('cash', 'card', 'transfer', 'other')`,
    ),
    check(
      "appointment_payments_status_chk",
      sql`${t.status} in ('paid', 'refunded', 'void')`,
    ),
  ],
);
