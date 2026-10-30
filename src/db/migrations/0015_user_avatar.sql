ALTER TABLE "users" ADD COLUMN "avatar_data" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_size_chk"
  CHECK ("avatar_data" IS NULL OR length("avatar_data") <= 400000);
