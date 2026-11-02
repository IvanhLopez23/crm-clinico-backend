import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.js";

/**
 * Contratos o licencias del tenant. El archivo vive fuera de la base; aqui
 * solo se guardan metadatos y la clave de almacenamiento.
 */
export const tenantContracts = pgTable(
  "tenant_contracts",
  {
    id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
    clinicId: uuid("clinic_id").notNull(),
    name: text("name").notNull(),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    startsAt: date("starts_at").notNull(),
    endsAt: date("ends_at"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tenant_contracts_clinic_idx").on(t.clinicId, t.createdAt),
    unique("tenant_contracts_storage_key_uq").on(t.storageKey),
    foreignKey({
      columns: [t.clinicId],
      foreignColumns: [clinics.id],
      name: "tenant_contracts_clinic_fk",
    }).onDelete("cascade"),
    check("tenant_contracts_size_chk", sql`${t.sizeBytes} > 0`),
    check(
      "tenant_contracts_dates_chk",
      sql`${t.endsAt} is null or ${t.endsAt} >= ${t.startsAt}`,
    ),
  ],
);
