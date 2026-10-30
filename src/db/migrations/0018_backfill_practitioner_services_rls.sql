-- El SELECT del backfill tambien lee practitioners y services, que tienen
-- FORCE RLS. Sin desactivarlo temporalmente el dueno ve cero filas.
ALTER TABLE "practitioners" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "services" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "practitioner_services" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

INSERT INTO "practitioner_services" (
  "id", "clinic_id", "practitioner_id", "service_id",
  "duration_minutes", "price_cents", "currency", "is_active"
)
SELECT
  gen_random_uuid(),
  p."clinic_id",
  p."id",
  s."id",
  s."duration_minutes",
  s."price_cents",
  s."currency",
  true
FROM "practitioners" p
JOIN "services" s
  ON s."clinic_id" = p."clinic_id"
 AND s."is_active" = true
WHERE p."is_active" = true
  AND p."deleted_at" IS NULL
ON CONFLICT ("practitioner_id", "service_id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "practitioners" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "practitioner_services" FORCE ROW LEVEL SECURITY;
