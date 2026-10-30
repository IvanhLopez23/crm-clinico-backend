CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"practitioner_id" uuid,
	"earliest_date" date NOT NULL,
	"latest_date" date NOT NULL,
	"preferred_time_from" time,
	"preferred_time_to" time,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_status_chk" CHECK ("waitlist_entries"."status" in ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
	CONSTRAINT "waitlist_entries_priority_chk" CHECK ("waitlist_entries"."priority" between 0 and 100),
	CONSTRAINT "waitlist_entries_dates_chk" CHECK ("waitlist_entries"."latest_date" >= "waitlist_entries"."earliest_date"),
	CONSTRAINT "waitlist_entries_time_window_chk" CHECK ("waitlist_entries"."preferred_time_from" is null or "waitlist_entries"."preferred_time_to" is null or "waitlist_entries"."preferred_time_from" < "waitlist_entries"."preferred_time_to")
);
--> statement-breakpoint
CREATE TABLE "waitlist_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"appointment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "waitlist_offers_status_chk" CHECK ("waitlist_offers"."status" in ('pending', 'accepted', 'expired', 'declined', 'superseded')),
	CONSTRAINT "waitlist_offers_range_chk" CHECK ("waitlist_offers"."ends_at" > "waitlist_offers"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_patient_clinic_fk" FOREIGN KEY ("patient_id","clinic_id") REFERENCES "public"."patients"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_practitioner_clinic_fk" FOREIGN KEY ("practitioner_id","clinic_id") REFERENCES "public"."practitioners"("id","clinic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_entry_id_waitlist_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."waitlist_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_practitioner_clinic_fk" FOREIGN KEY ("practitioner_id","clinic_id") REFERENCES "public"."practitioners"("id","clinic_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waitlist_entries_clinic_status_idx" ON "waitlist_entries" USING btree ("clinic_id","status","priority");--> statement-breakpoint
CREATE INDEX "waitlist_entries_patient_idx" ON "waitlist_entries" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offers_pending_entry_uq" ON "waitlist_offers" USING btree ("entry_id") WHERE "waitlist_offers"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "waitlist_offers_due_idx" ON "waitlist_offers" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "waitlist_offers_slot_idx" ON "waitlist_offers" USING btree ("practitioner_id","starts_at");