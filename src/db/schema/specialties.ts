import { randomUUID } from "node:crypto";
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";

export const specialties = pgTable(
  "specialties",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("specialties_clinic_idx").on(t.clinicId),
    unique("specialties_clinic_code_uq").on(t.clinicId, t.code),
    unique("specialties_id_clinic_uq").on(t.id, t.clinicId),
  ],
);
