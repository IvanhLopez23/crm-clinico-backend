import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";

/**
 * Cierre de toda la clinica (feriado, mantenimiento, evento). Siempre gana
 * sobre la disponibilidad; si solapa citas, el servicio devuelve conflicto.
 */
export const clinicClosures = pgTable(
  "clinic_closures",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("clinic_closures_clinic_start_idx").on(t.clinicId, t.startsAt),
    check("clinic_closures_range_chk", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
