CREATE TABLE "appointment_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"changed_by_user_id" uuid,
	"reason_code" text,
	"reason_text" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appt_status_history_actor_chk" CHECK ("appointment_status_history"."actor_type" in ('user','patient','system','api')),
	CONSTRAINT "appt_status_history_to_chk" CHECK ("appointment_status_history"."to_status" in ('requested','confirmed','arrived','in_consultation','completed','cancelled','no_show')),
	CONSTRAINT "appt_status_history_from_chk" CHECK ("appointment_status_history"."from_status" is null or "appointment_status_history"."from_status" in ('requested','confirmed','arrived','in_consultation','completed','cancelled','no_show'))
);
--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_status_chk";--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "household_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "service_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "duration_minutes_snapshot" bigint;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "buffer_before_minutes_snapshot" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "buffer_after_minutes_snapshot" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "price_cents_snapshot" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "currency_snapshot" char(3);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "booked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "booked_by_patient_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "confirmation_channel" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "roomed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "consult_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "consult_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "checked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "no_show_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "no_show_reason" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "overbooking_reason" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "overbooking_approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancellation_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "deposit_required_cents" bigint;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Necesario para la FK compuesta del historial y depositos.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_id_clinic_uq" UNIQUE("id","clinic_id");--> statement-breakpoint
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appt_status_history_appointment_clinic_fk" FOREIGN KEY ("appointment_id","clinic_id") REFERENCES "public"."appointments"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appt_status_history_appt_idx" ON "appointment_status_history" USING btree ("appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "appt_status_history_clinic_idx" ON "appointment_status_history" USING btree ("clinic_id","created_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_overbooking_approved_by_user_id_users_id_fk" FOREIGN KEY ("overbooking_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_clinic_fk" FOREIGN KEY ("service_id","clinic_id") REFERENCES "public"."services"("id","clinic_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_household_clinic_fk" FOREIGN KEY ("household_id","clinic_id") REFERENCES "public"."households"("id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_by_patient_clinic_fk" FOREIGN KEY ("booked_by_patient_id","clinic_id") REFERENCES "public"."patients"("id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_service_start_idx" ON "appointments" USING btree ("service_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_household_start_idx" ON "appointments" USING btree ("household_id","starts_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_overbooking_reason_chk" CHECK ("appointments"."overbooking_reason" is null or "appointments"."overbooking_reason" in ('urgency', 'clinical_fit', 'vip', 'other'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_status_chk" CHECK ("appointments"."status" in ('requested', 'confirmed', 'arrived', 'in_consultation', 'completed', 'cancelled', 'no_show'));--> statement-breakpoint
-- ============================================================================
-- Backfill de citas existentes. Las columnas nuevas quedan nullable donde el
-- dato historico no se puede inventar; el servicio las completa en altas nuevas.
-- ============================================================================
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

UPDATE "appointments" a
SET
  "service_id" = s."id",
  "service_name_snapshot" = s."name",
  "duration_minutes_snapshot" = round(extract(epoch FROM (a."ends_at" - a."starts_at")) / 60),
  "buffer_before_minutes_snapshot" = s."buffer_before_minutes",
  "buffer_after_minutes_snapshot" = s."buffer_after_minutes",
  "price_cents_snapshot" = s."price_cents",
  "currency_snapshot" = s."currency"
FROM "services" s
WHERE s."clinic_id" = a."clinic_id"
  AND s."code" = 'GENERAL'
  AND a."service_id" IS NULL;
--> statement-breakpoint

UPDATE "appointments" a
SET "household_id" = p."household_id"
FROM "patients" p
WHERE p."id" = a."patient_id"
  AND a."household_id" IS NULL;
--> statement-breakpoint

UPDATE "appointments" SET "status_changed_at" = "updated_at";
--> statement-breakpoint
UPDATE "appointments" SET "confirmed_at" = "updated_at"
WHERE "status" IN ('confirmed','arrived','in_consultation','completed')
  AND "confirmed_at" IS NULL;
--> statement-breakpoint
UPDATE "appointments" SET "checked_in_at" = "starts_at"
WHERE "status" IN ('arrived','in_consultation','completed')
  AND "checked_in_at" IS NULL;
--> statement-breakpoint
UPDATE "appointments" SET "consult_started_at" = "starts_at"
WHERE "status" = 'completed' AND "consult_started_at" IS NULL;
--> statement-breakpoint
UPDATE "appointments" SET "consult_ended_at" = "ends_at"
WHERE "status" = 'completed' AND "consult_ended_at" IS NULL;
--> statement-breakpoint
UPDATE "appointments" SET "checked_out_at" = "ends_at"
WHERE "status" = 'completed' AND "checked_out_at" IS NULL;
--> statement-breakpoint
UPDATE "appointments" SET "no_show_marked_at" = "updated_at"
WHERE "status" = 'no_show' AND "no_show_marked_at" IS NULL;
--> statement-breakpoint

INSERT INTO "appointment_status_history" (
  "id", "clinic_id", "appointment_id", "from_status", "to_status",
  "actor_type", "created_at"
)
SELECT
  gen_random_uuid(),
  a."clinic_id",
  a."id",
  NULL,
  a."status",
  'system',
  a."created_at"
FROM "appointments" a
WHERE NOT EXISTS (
  SELECT 1 FROM "appointment_status_history" h
  WHERE h."appointment_id" = a."id"
);
--> statement-breakpoint

-- ============================================================================
-- La constraint de exclusion debe cubrir el nuevo estado in_consultation.
-- ============================================================================
ALTER TABLE "appointments" DROP CONSTRAINT "appt_no_overlap";
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appt_no_overlap"
  EXCLUDE USING gist (
    "practitioner_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE (
    "status" IN ('requested', 'confirmed', 'arrived', 'in_consultation', 'completed')
    AND "is_overbooking" = false
    AND "deleted_at" IS NULL
  );
--> statement-breakpoint

-- ============================================================================
-- Historial append-only: RLS y grants (sin UPDATE/DELETE).
-- ============================================================================
ALTER TABLE "appointment_status_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_status_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "appointment_status_history_tenant" ON "appointment_status_history"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON "appointment_status_history" TO "crm_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "appointment_status_history" FROM "crm_app";
