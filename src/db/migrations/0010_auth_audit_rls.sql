-- Auditoria: aislamiento por clinica y append-only real.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_events_tenant" ON "audit_events"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

-- Los default privileges de 0001 dan CRUD a crm_app en tablas nuevas.
-- Se revoca a proposito: el log no se modifica ni se borra desde la app.
GRANT SELECT, INSERT ON "audit_events" TO "crm_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_events" FROM "crm_app";
--> statement-breakpoint

-- Usuarios del personal: sin RLS (el login resuelve por email antes del
-- tenant), pero sin DELETE desde la aplicacion.
GRANT SELECT, INSERT, UPDATE ON "users" TO "crm_app";
--> statement-breakpoint
REVOKE DELETE ON "users" FROM "crm_app";
