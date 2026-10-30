import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { clinics } from "./clinics.js";
import { practitioners } from "./practitioners.js";
import { waitlistEntries } from "./waitlist-entries.js";

export const WAITLIST_OFFER_STATUSES = [
  "pending",
  "accepted",
  "expired",
  "declined",
  "superseded",
] as const;

/**
 * Oferta de un hueco concreto a una entrada de la lista de espera.
 * Solo puede haber una oferta `pending` por entrada.
 */
export const waitlistOffers = pgTable(
  "waitlist_offers",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => waitlistEntries.id, { onDelete: "cascade" }),
    practitionerId: uuid("practitioner_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("waitlist_offers_pending_entry_uq")
      .on(t.entryId)
      .where(sql`${t.status} = 'pending'`),
    index("waitlist_offers_due_idx").on(t.status, t.expiresAt),
    index("waitlist_offers_slot_idx").on(t.practitionerId, t.startsAt),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "waitlist_offers_practitioner_clinic_fk",
    }).onDelete("restrict"),
    check(
      "waitlist_offers_status_chk",
      sql`${t.status} in ('pending', 'accepted', 'expired', 'declined', 'superseded')`,
    ),
    check("waitlist_offers_range_chk", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
