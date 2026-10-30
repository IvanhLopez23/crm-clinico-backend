import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";

/**
 * Directorio publico slug -> clinica. Vive fuera de RLS para resolver el
 * tenant antes de abrir la transaccion con `app.clinic_id`.
 */
export const clinicSlugs = pgTable(
  "clinic_slugs",
  {
    slug: text("slug").primaryKey(),
    clinicId: uuid("clinic_id")
      .notNull()
      .unique()
      .references(() => clinics.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("clinic_slugs_clinic_idx").on(t.clinicId)],
);
