-- ============================================================================
-- Guardrail de transiciones de cita. El servicio devuelve errores de dominio
-- claros; este trigger impide que un UPDATE directo salte la maquina de estados.
-- ============================================================================
CREATE OR REPLACE FUNCTION enforce_appointment_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('completed', 'cancelled', 'no_show') THEN
    RAISE EXCEPTION 'appointment_terminal_state'
      USING ERRCODE = '23514',
            CONSTRAINT = 'appointments_transition_terminal';
  END IF;

  IF NOT (
    (OLD."status" = 'requested' AND NEW."status" IN ('confirmed', 'cancelled', 'no_show')) OR
    (OLD."status" = 'confirmed' AND NEW."status" IN ('arrived', 'cancelled', 'no_show')) OR
    (OLD."status" = 'arrived' AND NEW."status" IN ('in_consultation', 'cancelled', 'no_show')) OR
    (OLD."status" = 'in_consultation' AND NEW."status" IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid_appointment_transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'appointments_transition_invalid';
  END IF;

  NEW."status_changed_at" := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "appointments_enforce_transition" ON "appointments";
--> statement-breakpoint
CREATE TRIGGER "appointments_enforce_transition"
  BEFORE UPDATE OF "status" ON "appointments"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_appointment_transition();
--> statement-breakpoint

-- ============================================================================
-- Verificacion de grants de la fase (idempotente; las policies viven en 0011-0013).
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON "appointments" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patients" TO "crm_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "services" TO "crm_app";

--> statement-breakpoint

-- Etiquetas de sistema para clinicas existentes. Las clinicas nuevas las crea
-- el onboarding (misma lista) para no depender de una migracion por alta.
INSERT INTO "tags" (
  "id", "clinic_id", "code", "label", "category", "is_alert", "is_system"
)
SELECT
  gen_random_uuid(),
  c."id",
  v."code",
  v."label",
  v."category",
  v."is_alert",
  true
FROM "clinics" c
CROSS JOIN (
  VALUES
    ('vip', 'VIP', 'vip', false),
    ('frequent_no_show', 'No-show frecuente', 'risk', true),
    ('payment_late', 'Pago tardio', 'risk', true),
    ('anxious', 'Paciente ansioso', 'behavior', false),
    ('requires_interpreter', 'Requiere interprete', 'operational', false),
    ('whatsapp_only', 'Solo WhatsApp', 'operational', false),
    ('do_not_rebook', 'No reagendar automaticamente', 'operational', true),
    ('new_patient', 'Paciente nuevo', 'operational', false)
) AS v("code", "label", "category", "is_alert")
ON CONFLICT ("clinic_id", "code") DO NOTHING;
