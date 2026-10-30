ALTER TABLE "reminder_jobs" DROP CONSTRAINT "reminder_jobs_status_chk";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "reminder_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD COLUMN "template_code" text DEFAULT 'reminder_manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_attempts_chk" CHECK ("reminder_jobs"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_status_chk" CHECK ("reminder_jobs"."status" in ('pending', 'processing', 'sent', 'failed', 'cancelled'));