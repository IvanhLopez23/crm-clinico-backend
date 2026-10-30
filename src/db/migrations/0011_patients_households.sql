CREATE TABLE "contact_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_enc" "bytea" NOT NULL,
	"value_bidx" text NOT NULL,
	"value_masked" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"transactional_opt_in" boolean DEFAULT false NOT NULL,
	"transactional_opt_in_at" timestamp with time zone,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"marketing_opt_in_at" timestamp with time zone,
	"opt_out_at" timestamp with time zone,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_points_owner_type_chk" CHECK ("contact_points"."owner_type" in ('patient','household')),
	CONSTRAINT "contact_points_kind_chk" CHECK ("contact_points"."kind" in ('phone','email','whatsapp'))
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"billing_patient_id" uuid,
	"preferred_channel" text DEFAULT 'whatsapp' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "households_id_clinic_uq" UNIQUE("id","clinic_id"),
	CONSTRAINT "households_preferred_channel_chk" CHECK ("households"."preferred_channel" in ('whatsapp','sms','email','phone'))
);
--> statement-breakpoint
CREATE TABLE "patient_allergies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"allergen" text NOT NULL,
	"reaction" text,
	"severity" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "patient_allergies_severity_chk" CHECK ("patient_allergies"."severity" in ('mild','moderate','severe','anaphylaxis'))
);
--> statement-breakpoint
CREATE TABLE "patient_guardians" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"guardian_patient_id" uuid,
	"guardian_name" text,
	"guardian_document_enc" "bytea",
	"guardian_document_bidx" text,
	"guardian_phone_e164" text,
	"relationship" text NOT NULL,
	"is_legal_guardian" boolean DEFAULT false NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_guardians_relationship_chk" CHECK ("patient_guardians"."relationship" in ('parent','legal_guardian','caregiver','spouse','other')),
	CONSTRAINT "patient_guardians_identity_chk" CHECK ("patient_guardians"."guardian_patient_id" is not null or "patient_guardians"."guardian_name" is not null),
	CONSTRAINT "patient_guardians_not_self_chk" CHECK ("patient_guardians"."guardian_patient_id" is null or "patient_guardians"."guardian_patient_id" <> "patient_guardians"."patient_id"),
	CONSTRAINT "patient_guardians_validity_chk" CHECK ("patient_guardians"."valid_to" is null or "patient_guardians"."valid_to" >= "patient_guardians"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "patient_tags" (
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"severity" smallint DEFAULT 1 NOT NULL,
	"note" text,
	"expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_tags_pk" PRIMARY KEY("patient_id","tag_id"),
	CONSTRAINT "patient_tags_severity_chk" CHECK ("patient_tags"."severity" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"category" text NOT NULL,
	"color" text,
	"is_alert" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_clinic_code_uq" UNIQUE("clinic_id","code"),
	CONSTRAINT "tags_id_clinic_uq" UNIQUE("id","clinic_id"),
	CONSTRAINT "tags_category_chk" CHECK ("tags"."category" in ('behavior','risk','vip','operational','clinical_alert'))
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "currency" char(3) DEFAULT 'MXN' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "household_id" uuid;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "relationship" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "is_account_holder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "preferred_name" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "document_type" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "document_number_enc" "bytea";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "document_number_bidx" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "sex_at_birth" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "gender_identity" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "blood_type" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "preferred_language" text DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "marketing_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "first_visit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "last_visit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "deceased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "merged_into_patient_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_patient_clinic_fk" FOREIGN KEY ("patient_id","clinic_id") REFERENCES "public"."patients"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_guardians" ADD CONSTRAINT "patient_guardians_patient_clinic_fk" FOREIGN KEY ("patient_id","clinic_id") REFERENCES "public"."patients"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_guardians" ADD CONSTRAINT "patient_guardians_guardian_clinic_fk" FOREIGN KEY ("guardian_patient_id","clinic_id") REFERENCES "public"."patients"("id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_tags" ADD CONSTRAINT "patient_tags_patient_clinic_fk" FOREIGN KEY ("patient_id","clinic_id") REFERENCES "public"."patients"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_tags" ADD CONSTRAINT "patient_tags_tag_clinic_fk" FOREIGN KEY ("tag_id","clinic_id") REFERENCES "public"."tags"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_points_owner_kind_value_uq" ON "contact_points" USING btree ("clinic_id","owner_type","owner_id","kind","value_bidx");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_points_primary_uq" ON "contact_points" USING btree ("owner_type","owner_id","kind") WHERE "contact_points"."is_primary" and "contact_points"."opt_out_at" is null;--> statement-breakpoint
CREATE INDEX "contact_points_lookup_idx" ON "contact_points" USING btree ("clinic_id","kind","value_bidx");--> statement-breakpoint
CREATE INDEX "households_clinic_idx" ON "households" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "patient_allergies_patient_idx" ON "patient_allergies" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_allergies_active_uq" ON "patient_allergies" USING btree ("patient_id",lower("allergen")) WHERE "patient_allergies"."is_active" and "patient_allergies"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "patient_allergies_alert_idx" ON "patient_allergies" USING btree ("clinic_id","patient_id") WHERE "patient_allergies"."is_active" and "patient_allergies"."severity" in ('severe','anaphylaxis');--> statement-breakpoint
CREATE INDEX "patient_guardians_patient_idx" ON "patient_guardians" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_guardians_guardian_idx" ON "patient_guardians" USING btree ("clinic_id","guardian_patient_id");--> statement-breakpoint
CREATE INDEX "patient_tags_patient_idx" ON "patient_tags" USING btree ("clinic_id","patient_id");--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_merged_into_patient_id_patients_id_fk" FOREIGN KEY ("merged_into_patient_id") REFERENCES "public"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_household_clinic_fk" FOREIGN KEY ("household_id","clinic_id") REFERENCES "public"."households"("id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patients_household_idx" ON "patients" USING btree ("clinic_id","household_id");--> statement-breakpoint
CREATE INDEX "patients_last_visit_idx" ON "patients" USING btree ("clinic_id","last_visit_at");--> statement-breakpoint
CREATE INDEX "patients_merged_idx" ON "patients" USING btree ("merged_into_patient_id") WHERE "patients"."merged_into_patient_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_document_bidx_uq" ON "patients" USING btree ("clinic_id","document_number_bidx") WHERE "patients"."document_number_bidx" is not null and "patients"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_relationship_chk" CHECK ("patients"."relationship" in ('self','spouse','child','parent','sibling','other_dependent'));--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_document_type_chk" CHECK ("patients"."document_type" is null or "patients"."document_type" in ('ine','passport','curp','ssn','other'));--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_sex_at_birth_chk" CHECK ("patients"."sex_at_birth" is null or "patients"."sex_at_birth" in ('female','male','intersex','unknown'));--> statement-breakpoint
-- ============================================================================
-- FKs que Drizzle no puede modelar por el ciclo households <-> patients.
-- El responsable de pago debe ser un paciente de la misma clinica.
-- ============================================================================
ALTER TABLE "households"
  ADD CONSTRAINT "households_billing_patient_fk"
  FOREIGN KEY ("billing_patient_id", "clinic_id")
  REFERENCES "public"."patients"("id", "clinic_id")
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE INDEX "households_billing_patient_idx"
  ON "households" USING btree ("clinic_id", "billing_patient_id");
--> statement-breakpoint

-- ============================================================================
-- RLS: mismo patron que 0001/0003. Sin app.clinic_id la consulta devuelve 0.
-- ============================================================================
ALTER TABLE "households" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "households" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "households_tenant" ON "households"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "contact_points" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "contact_points" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "contact_points_tenant" ON "contact_points"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "patient_guardians" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_guardians" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "patient_guardians_tenant" ON "patient_guardians"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "patient_allergies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_allergies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "patient_allergies_tenant" ON "patient_allergies"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tags_tenant" ON "tags"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "patient_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_tags" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "patient_tags_tenant" ON "patient_tags"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
--> statement-breakpoint

-- ============================================================================
-- Privilegios. Default privileges de 0001 ya dan CRUD; se explicita y se
-- revoca DELETE en PHI: estas tablas se desactivan/soft-deletean, no se borran.
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON "households" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "contact_points" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_guardians" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_allergies" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tags" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "patient_tags" TO "crm_app";
--> statement-breakpoint

REVOKE DELETE ON "households" FROM "crm_app";
--> statement-breakpoint
REVOKE DELETE ON "contact_points" FROM "crm_app";
--> statement-breakpoint
REVOKE DELETE ON "patient_guardians" FROM "crm_app";
--> statement-breakpoint
REVOKE DELETE ON "patient_allergies" FROM "crm_app";
--> statement-breakpoint
REVOKE DELETE ON "tags" FROM "crm_app";
