-- RLS para lista de espera.
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waitlist_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "waitlist_entries_tenant" ON "waitlist_entries"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "waitlist_offers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "waitlist_offers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "waitlist_offers_tenant" ON "waitlist_offers"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

-- API
GRANT SELECT, INSERT, UPDATE, DELETE ON "waitlist_entries" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "waitlist_offers" TO "crm_app";
--> statement-breakpoint

-- Worker: ademas de leer reglas/bloqueos para recalcular el hueco.
GRANT SELECT ON "availability_rules", "schedule_blocks" TO "crm_worker";
--> statement-breakpoint
GRANT SELECT, UPDATE ON "waitlist_entries" TO "crm_worker";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "waitlist_offers" TO "crm_worker";
