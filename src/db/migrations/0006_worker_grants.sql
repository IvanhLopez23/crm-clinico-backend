-- Rol de sistema del worker de recordatorios (BYPASSRLS: procesa jobs de todas
-- las clinicas). Privilegio minimo: solo lee el contexto de la cita y escribe
-- en reminder_jobs.
GRANT USAGE ON SCHEMA public TO "crm_worker";
--> statement-breakpoint
GRANT SELECT ON "clinics", "practitioners", "patients", "appointments" TO "crm_worker";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "reminder_jobs" TO "crm_worker";
