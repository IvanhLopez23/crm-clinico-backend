import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { practitioners } from "./practitioners.js";

export const USER_ROLES = ["admin", "practitioner", "receptionist"] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Usuarios del personal. Sin RLS a proposito: el login necesita resolver el
 * usuario por email antes de conocer el tenant. No contiene PHI clinica.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    fullName: text("full_name").notNull(),
    avatarData: text("avatar_data"),
    role: text("role").notNull().default("receptionist"),
    practitionerId: uuid("practitioner_id"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    index("users_clinic_idx").on(t.clinicId),
    foreignKey({
      columns: [t.practitionerId, t.clinicId],
      foreignColumns: [practitioners.id, practitioners.clinicId],
      name: "users_practitioner_clinic_fk",
    }).onDelete("set null"),
    check(
      "users_role_chk",
      sql`${t.role} in ('admin', 'practitioner', 'receptionist')`,
    ),
  ],
);
