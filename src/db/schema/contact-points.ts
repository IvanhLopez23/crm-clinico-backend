import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { bytea } from "./custom-types.js";

/**
 * Punto de contacto canonico. Puede pertenecer a un paciente o a un
 * household. El valor va cifrado y se busca por blind index (HMAC-SHA256 del
 * valor normalizado); nunca se hace LIKE sobre PHI.
 */
export const contactPoints = pgTable(
  "contact_points",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    kind: text("kind").notNull(),
    valueEnc: bytea("value_enc").notNull(),
    valueBidx: text("value_bidx").notNull(),
    valueMasked: text("value_masked").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    isVerified: boolean("is_verified").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    transactionalOptIn: boolean("transactional_opt_in").notNull().default(false),
    transactionalOptInAt: timestamp("transactional_opt_in_at", {
      withTimezone: true,
    }),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    marketingOptInAt: timestamp("marketing_opt_in_at", { withTimezone: true }),
    optOutAt: timestamp("opt_out_at", { withTimezone: true }),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "contact_points_owner_type_chk",
      sql`${t.ownerType} in ('patient','household')`,
    ),
    check(
      "contact_points_kind_chk",
      sql`${t.kind} in ('phone','email','whatsapp')`,
    ),
    // La unicidad es por owner, no global: un mismo telefono puede ser el
    // contacto personal del padre y el contacto compartido del household.
    uniqueIndex("contact_points_owner_kind_value_uq").on(
      t.clinicId,
      t.ownerType,
      t.ownerId,
      t.kind,
      t.valueBidx,
    ),
    uniqueIndex("contact_points_primary_uq")
      .on(t.ownerType, t.ownerId, t.kind)
      .where(sql`${t.isPrimary} and ${t.optOutAt} is null`),
    index("contact_points_lookup_idx").on(t.clinicId, t.kind, t.valueBidx),
  ],
);
