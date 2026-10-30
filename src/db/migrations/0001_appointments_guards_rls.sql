-- ============================================================================
-- Guardrails que Drizzle no modela en el schema: exclusion constraint, RLS y
-- privilegios del rol de aplicacion.
-- ============================================================================

-- 1) Anti doble reserva -------------------------------------------------------
-- Una sola cita activa por especialista y franja. El sobrecupo queda excluido
-- de la constraint y se valida en el servicio (con advisory lock).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

ALTER TABLE "appointments"
  ADD CONSTRAINT "appt_no_overlap"
  EXCLUDE USING gist (
    "practitioner_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE (
    "status" IN ('requested', 'confirmed', 'arrived', 'completed')
    AND "is_overbooking" = false
    AND "deleted_at" IS NULL
  );
--> statement-breakpoint

-- 2) Row Level Security -------------------------------------------------------
-- El tenant vive en el GUC app.clinic_id, fijado por transaccion.
-- current_setting(..., true) devuelve NULL si no se fijo: la policy no matchea
-- y la query devuelve cero filas (fail closed).
ALTER TABLE "clinics" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinics" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "clinics_tenant" ON "clinics"
  USING ("id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "practitioners" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "practitioners" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "practitioners_tenant" ON "practitioners"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "patients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "patients_tenant" ON "patients"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "appointments_tenant" ON "appointments"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "reminder_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reminder_jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "reminder_jobs_tenant" ON "reminder_jobs"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "idempotency_keys_tenant" ON "idempotency_keys"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

-- 3) Privilegios del rol de aplicacion ---------------------------------------
-- crm_app NO es owner de las tablas: por eso RLS le aplica de verdad.
GRANT USAGE ON SCHEMA public TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "crm_app";
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "crm_app";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "crm_app";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "crm_app";
