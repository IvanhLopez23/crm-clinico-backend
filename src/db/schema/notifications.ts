import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";
import { users } from "./users.js";

/**
 * Notificacion interna del personal. Se crea una fila por usuario destinatario
 * para que cada quien controle su propio estado de leida.
 *
 * `data` guarda el contexto estructurado (cita, paciente, servicio, horario)
 * para que la interfaz pueda traducir y formatear sin depender de un texto
 * fijo en la base de datos.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notifications_user_created_idx").on(
      t.clinicId,
      t.userId,
      t.createdAt,
    ),
    index("notifications_user_unread_idx").on(
      t.clinicId,
      t.userId,
      t.readAt,
    ),
  ],
);
