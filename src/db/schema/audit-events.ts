import { randomUUID } from "node:crypto";
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";

export const AUDIT_ACTOR_TYPES = [
  "user",
  "public",
  "system",
  "platform_admin",
] as const;

/**
 * Log append-only. La API solo tiene GRANT SELECT/INSERT (sin UPDATE/DELETE).
 * `hash` encadena el evento anterior del mismo tenant para detectar
 * manipulacion.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    actorType: text("actor_type").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    patientId: uuid("patient_id"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    reason: text("reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_events_clinic_created_idx").on(t.clinicId, t.createdAt),
    index("audit_events_resource_idx").on(t.resourceType, t.resourceId),
    index("audit_events_patient_idx").on(t.patientId),
    index("audit_events_action_idx").on(t.action),
  ],
);
