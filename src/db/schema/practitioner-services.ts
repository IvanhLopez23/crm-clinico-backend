import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { practitioners } from "./practitioners.js";
import { services } from "./services.js";

/**
 * Catalogo de servicios propio de cada especialista. Hereda el nombre y los
 * buffers del servicio base, pero puede ajustar duracion y precio.
 */
export const practitionerServices = pgTable(
  "practitioner_services",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    practitionerId: uuid("practitioner_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("practitioner_services_clinic_practitioner_idx").on(
      t.clinicId,
      t.practitionerId,
    ),
    unique("practitioner_services_practitioner_service_uq").on(
      t.practitionerId,
      t.serviceId,
    ),
    unique("practitioner_services_id_clinic_uq").on(t.id, t.clinicId),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "practitioner_services_practitioner_clinic_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.serviceId, t.clinicId],
      foreignColumns: [services.id, services.clinicId],
      name: "practitioner_services_service_clinic_fk",
    }).onDelete("cascade"),
    check(
      "practitioner_services_duration_chk",
      sql`${t.durationMinutes} between 5 and 480`,
    ),
    check("practitioner_services_price_chk", sql`${t.priceCents} >= 0`),
  ],
);
