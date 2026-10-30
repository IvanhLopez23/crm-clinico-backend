CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"slot_minutes" integer DEFAULT 15 NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_rules_weekday_chk" CHECK ("availability_rules"."weekday" between 1 and 7),
	CONSTRAINT "availability_rules_time_chk" CHECK ("availability_rules"."start_time" < "availability_rules"."end_time"),
	CONSTRAINT "availability_rules_slot_chk" CHECK ("availability_rules"."slot_minutes" between 5 and 120),
	CONSTRAINT "availability_rules_dates_chk" CHECK ("availability_rules"."valid_to" is null or "availability_rules"."valid_to" >= "availability_rules"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "schedule_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"type" text DEFAULT 'other' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_blocks_range_chk" CHECK ("schedule_blocks"."ends_at" > "schedule_blocks"."starts_at"),
	CONSTRAINT "schedule_blocks_type_chk" CHECK ("schedule_blocks"."type" in ('vacation', 'meeting', 'surgery', 'personal', 'holiday', 'maintenance', 'other'))
);
--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_practitioner_clinic_fk" FOREIGN KEY ("practitioner_id","clinic_id") REFERENCES "public"."practitioners"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_practitioner_clinic_fk" FOREIGN KEY ("practitioner_id","clinic_id") REFERENCES "public"."practitioners"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_rules_practitioner_idx" ON "availability_rules" USING btree ("practitioner_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_rules_unique_idx" ON "availability_rules" USING btree ("practitioner_id","weekday","start_time","valid_from");--> statement-breakpoint
CREATE INDEX "schedule_blocks_practitioner_idx" ON "schedule_blocks" USING btree ("practitioner_id","starts_at");