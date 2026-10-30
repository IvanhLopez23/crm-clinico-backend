CREATE TABLE "appointment_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"method" text DEFAULT 'cash' NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_payments_appointment_uq" UNIQUE("appointment_id"),
	CONSTRAINT "appointment_payments_amount_chk" CHECK ("appointment_payments"."amount_cents" >= 0),
	CONSTRAINT "appointment_payments_method_chk" CHECK ("appointment_payments"."method" in ('cash', 'card', 'transfer', 'other')),
	CONSTRAINT "appointment_payments_status_chk" CHECK ("appointment_payments"."status" in ('paid', 'refunded', 'void'))
);
--> statement-breakpoint
CREATE TABLE "clinic_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_slugs_clinic_id_unique" UNIQUE("clinic_id")
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "appointment_payments" ADD CONSTRAINT "appointment_payments_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_payments" ADD CONSTRAINT "appointment_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_payments" ADD CONSTRAINT "appointment_payments_appointment_clinic_fk" FOREIGN KEY ("appointment_id","clinic_id") REFERENCES "public"."appointments"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_slugs" ADD CONSTRAINT "clinic_slugs_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_payments_clinic_paid_idx" ON "appointment_payments" USING btree ("clinic_id","paid_at");--> statement-breakpoint
CREATE INDEX "clinic_slugs_clinic_idx" ON "clinic_slugs" USING btree ("clinic_id");--> statement-breakpoint

-- Backfill de slugs. Se desactiva FORCE RLS temporalmente porque el usuario
-- de migraciones es dueno de las tablas y las policies ocultan las filas.
ALTER TABLE "clinics" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "clinics"
SET "slug" = coalesce(
  nullif(trim(both '-' from lower(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'))), ''),
  'clinica'
) || '-' || substring("id"::text, 1, 6)
WHERE "slug" IS NULL;
--> statement-breakpoint
INSERT INTO "clinic_slugs" ("slug", "clinic_id")
SELECT "slug", "id" FROM "clinics" WHERE "slug" IS NOT NULL
ON CONFLICT ("clinic_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "clinics" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "clinics" ALTER COLUMN "slug" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "clinics_slug_uq" ON "clinics" USING btree ("slug");
--> statement-breakpoint

ALTER TABLE "appointment_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "appointment_payments_tenant" ON "appointment_payments"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "appointment_payments" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clinic_slugs" TO "crm_app";
