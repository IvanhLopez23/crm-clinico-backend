CREATE TABLE "tenant_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"starts_at" date NOT NULL,
	"ends_at" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_contracts_storage_key_uq" UNIQUE("storage_key"),
	CONSTRAINT "tenant_contracts_size_chk" CHECK ("tenant_contracts"."size_bytes" > 0),
	CONSTRAINT "tenant_contracts_dates_chk" CHECK ("tenant_contracts"."ends_at" is null or "tenant_contracts"."ends_at" >= "tenant_contracts"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_clinic_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_contracts_clinic_idx" ON "tenant_contracts" USING btree ("clinic_id","created_at");--> statement-breakpoint
ALTER TABLE "tenant_contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_contracts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_contracts_tenant" ON "tenant_contracts"
  USING ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK ("clinic_id" = NULLIF(current_setting('app.clinic_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_contracts" TO "crm_app";