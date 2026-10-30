-- RLS para las tablas de disponibilidad. Mismo patron que 0001: el tenant
-- vive en el GUC app.clinic_id y sin contexto la consulta devuelve cero filas.

ALTER TABLE "availability_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "availability_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "availability_rules_tenant" ON "availability_rules"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "schedule_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "schedule_blocks_tenant" ON "schedule_blocks"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

-- Los default privileges de 0001 ya cubren tablas nuevas; se repite de forma
-- explicita para no depender del orden de creacion.
GRANT SELECT, INSERT, UPDATE, DELETE ON "availability_rules" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "schedule_blocks" TO "crm_app";
