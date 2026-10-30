CREATE TABLE "clinic_closures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_closures_range_chk" CHECK ("clinic_closures"."ends_at" > "clinic_closures"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "practitioner_specialties" (
	"clinic_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"specialty_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "practitioner_specialties_pk" PRIMARY KEY("practitioner_id","specialty_id"),
	CONSTRAINT "practitioner_specialties_primary_chk" CHECK ("practitioner_specialties"."is_primary" in (true, false))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"specialty_id" uuid,
	"duration_minutes" integer NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"price_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"deposit_required" boolean DEFAULT false NOT NULL,
	"deposit_cents" bigint,
	"deposit_bps" integer,
	"cancellation_policy_id" uuid,
	"requires_consent_template_id" uuid,
	"is_telehealth" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_clinic_code_uq" UNIQUE("clinic_id","code"),
	CONSTRAINT "services_id_clinic_uq" UNIQUE("id","clinic_id"),
	CONSTRAINT "services_duration_chk" CHECK ("services"."duration_minutes" between 5 and 480),
	CONSTRAINT "services_buffer_before_chk" CHECK ("services"."buffer_before_minutes" between 0 and 120),
	CONSTRAINT "services_buffer_after_chk" CHECK ("services"."buffer_after_minutes" between 0 and 120),
	CONSTRAINT "services_price_chk" CHECK ("services"."price_cents" >= 0),
	CONSTRAINT "services_tax_chk" CHECK ("services"."tax_rate_bps" between 0 and 10000),
	CONSTRAINT "services_deposit_cents_chk" CHECK ("services"."deposit_cents" is null or "services"."deposit_cents" >= 0),
	CONSTRAINT "services_deposit_bps_chk" CHECK ("services"."deposit_bps" is null or "services"."deposit_bps" between 0 and 10000),
	CONSTRAINT "services_deposit_exclusive_chk" CHECK ("services"."deposit_cents" is null or "services"."deposit_bps" is null),
	CONSTRAINT "services_deposit_required_chk" CHECK (not "services"."deposit_required" or "services"."deposit_cents" is not null or "services"."deposit_bps" is not null)
);
--> statement-breakpoint
CREATE TABLE "specialties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specialties_clinic_code_uq" UNIQUE("clinic_id","code"),
	CONSTRAINT "specialties_id_clinic_uq" UNIQUE("id","clinic_id")
);
--> statement-breakpoint
ALTER TABLE "schedule_blocks" DROP CONSTRAINT "schedule_blocks_type_chk";--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "color" char(7) DEFAULT '#0F766E' NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "default_slot_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "buffer_before_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "buffer_after_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "avg_consult_minutes" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "is_accepting_new_patients" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "practitioners" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinic_closures" ADD CONSTRAINT "clinic_closures_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_specialties" ADD CONSTRAINT "practitioner_specialties_practitioner_clinic_fk" FOREIGN KEY ("practitioner_id","clinic_id") REFERENCES "public"."practitioners"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_specialties" ADD CONSTRAINT "practitioner_specialties_specialty_clinic_fk" FOREIGN KEY ("specialty_id","clinic_id") REFERENCES "public"."specialties"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_specialty_clinic_fk" FOREIGN KEY ("specialty_id","clinic_id") REFERENCES "public"."specialties"("id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_closures_clinic_start_idx" ON "clinic_closures" USING btree ("clinic_id","starts_at");--> statement-breakpoint
CREATE INDEX "practitioner_specialties_clinic_idx" ON "practitioner_specialties" USING btree ("clinic_id","practitioner_id");--> statement-breakpoint
CREATE INDEX "services_clinic_active_idx" ON "services" USING btree ("clinic_id","is_active");--> statement-breakpoint
CREATE INDEX "specialties_clinic_idx" ON "specialties" USING btree ("clinic_id");--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_default_slot_chk" CHECK ("practitioners"."default_slot_minutes" between 5 and 120);--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_buffer_before_chk" CHECK ("practitioners"."buffer_before_minutes" between 0 and 120);--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_buffer_after_chk" CHECK ("practitioners"."buffer_after_minutes" between 0 and 120);--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_avg_consult_chk" CHECK ("practitioners"."avg_consult_minutes" is null or "practitioners"."avg_consult_minutes" between 0 and 480);--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_type_chk" CHECK ("schedule_blocks"."type" in ('vacation', 'meeting', 'surgery', 'personal', 'holiday', 'maintenance', 'break', 'other'));--> statement-breakpoint
-- ============================================================================
-- Seed de catalogos para clinicas existentes.
-- 1) Una especialidad por valor distinto de practitioners.specialty.
-- 2) Un servicio GENERAL por clinica, con la moneda de la clinica.
-- Las clinicas futuras los crean desde la app/seed.
-- ============================================================================
INSERT INTO "specialties" ("id", "clinic_id", "code", "name")
SELECT
  gen_random_uuid(),
  p."clinic_id",
  lower(regexp_replace(trim(p."specialty"), '[^a-zA-Z0-9]+', '_', 'g')),
  trim(p."specialty")
FROM "practitioners" p
WHERE p."specialty" IS NOT NULL
  AND trim(p."specialty") <> ''
GROUP BY p."clinic_id", trim(p."specialty")
ON CONFLICT ("clinic_id", "code") DO NOTHING;
--> statement-breakpoint

INSERT INTO "services" (
  "id", "clinic_id", "code", "name", "duration_minutes",
  "buffer_before_minutes", "buffer_after_minutes",
  "price_cents", "currency", "tax_rate_bps", "is_active"
)
SELECT
  gen_random_uuid(),
  c."id",
  'GENERAL',
  'Consulta general',
  30,
  0,
  5,
  0,
  c."currency",
  0,
  true
FROM "clinics" c
WHERE NOT EXISTS (
  SELECT 1 FROM "services" s
  WHERE s."clinic_id" = c."id" AND s."code" = 'GENERAL'
);
--> statement-breakpoint

-- ============================================================================
-- RLS: mismo patron que 0001/0003.
-- ============================================================================
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "services_tenant" ON "services"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "specialties" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "specialties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "specialties_tenant" ON "specialties"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "practitioner_specialties" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "practitioner_specialties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "practitioner_specialties_tenant" ON "practitioner_specialties"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "clinic_closures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinic_closures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "clinic_closures_tenant" ON "clinic_closures"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

-- ============================================================================
-- Privilegios.
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON "services" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "specialties" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "practitioner_specialties" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clinic_closures" TO "crm_app";
--> statement-breakpoint
REVOKE DELETE ON "services" FROM "crm_app";
--> statement-breakpoint
REVOKE DELETE ON "specialties" FROM "crm_app";
