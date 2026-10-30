CREATE TABLE "practitioner_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"duration_minutes" integer NOT NULL,
	"price_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practitioner_services_practitioner_service_uq" UNIQUE("practitioner_id","service_id"),
	CONSTRAINT "practitioner_services_id_clinic_uq" UNIQUE("id","clinic_id"),
	CONSTRAINT "practitioner_services_duration_chk" CHECK ("practitioner_services"."duration_minutes" between 5 and 480),
	CONSTRAINT "practitioner_services_price_chk" CHECK ("practitioner_services"."price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD CONSTRAINT "practitioner_services_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD CONSTRAINT "practitioner_services_practitioner_clinic_fk" FOREIGN KEY ("practitioner_id","clinic_id") REFERENCES "public"."practitioners"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD CONSTRAINT "practitioner_services_service_clinic_fk" FOREIGN KEY ("service_id","clinic_id") REFERENCES "public"."services"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practitioner_services_clinic_practitioner_idx" ON "practitioner_services" USING btree ("clinic_id","practitioner_id");--> statement-breakpoint

-- ============================================================================
-- RLS y privilegios.
-- ============================================================================
ALTER TABLE "practitioner_services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "practitioner_services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "practitioner_services_tenant" ON "practitioner_services"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "practitioner_services" TO "crm_app";
--> statement-breakpoint

-- ============================================================================
-- Backfill: cada especialista activo recibe el catalogo activo con sus valores
-- base; despues puede ajustar duracion y precio por servicio.
-- ============================================================================
INSERT INTO "practitioner_services" (
  "id", "clinic_id", "practitioner_id", "service_id",
  "duration_minutes", "price_cents", "currency", "is_active"
)
SELECT
  gen_random_uuid(),
  p."clinic_id",
  p."id",
  s."id",
  s."duration_minutes",
  s."price_cents",
  s."currency",
  true
FROM "practitioners" p
JOIN "services" s
  ON s."clinic_id" = p."clinic_id"
 AND s."is_active" = true
WHERE p."is_active" = true
  AND p."deleted_at" IS NULL
ON CONFLICT ("practitioner_id", "service_id") DO NOTHING;
