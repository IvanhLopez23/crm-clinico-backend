import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const clinics = pgTable("clinics", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  slug: text("slug")
    .notNull()
    .$defaultFn(() => randomUUID().slice(0, 12)),
  timezone: text("timezone").notNull().default("America/Mexico_City"),
  currency: char("currency", { length: 3 }).notNull().default("MXN"),
  isActive: boolean("is_active").notNull().default(true),
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
