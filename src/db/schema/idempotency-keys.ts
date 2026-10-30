import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appointments } from "./appointments.js";
import { clinics } from "./clinics.js";

/**
 * Idempotencia de reservas: la PK es (clinic_id, key) para que una clave
 * no pueda reutilizarse entre clinicas.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clinicId, t.key] })],
);
