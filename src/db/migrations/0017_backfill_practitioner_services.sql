-- El backfill de 0016 corre como dueno de las tablas y las politicas FORCE RLS
-- ocultaban el catalogo. Se desactiva temporalmente FORCE para poder sembrar
-- una asignacion por especialista y servicio activo.
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

ALTER TABLE "practitioner_services" FORCE ROW LEVEL SECURITY;
