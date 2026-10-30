ALTER TABLE "appointments" ADD COLUMN "booked_via" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancellation_reason_code" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "rescheduled_from_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_id_appointments_id_fk" FOREIGN KEY ("rescheduled_from_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_rescheduled_from_idx" ON "appointments" USING btree ("rescheduled_from_id");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_via_chk" CHECK ("appointments"."booked_via" in ('public', 'staff', 'waitlist', 'api', 'recurrence'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_chk" CHECK ("appointments"."cancelled_by" is null or "appointments"."cancelled_by" in ('staff', 'patient', 'system'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancel_reason_chk" CHECK ("appointments"."cancellation_reason_code" is null or "appointments"."cancellation_reason_code" in ('patient_request', 'rescheduled', 'clinic_cancelled', 'financial', 'other'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_at_chk" CHECK (("appointments"."status" = 'cancelled') = ("appointments"."cancelled_at" is not null));