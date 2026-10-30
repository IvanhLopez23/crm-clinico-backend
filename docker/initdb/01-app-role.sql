-- Rol de aplicacion: SIN privilegios elevados para que RLS aplique.
-- Las migraciones corren como postgres (owner de las tablas).
CREATE ROLE crm_app LOGIN PASSWORD 'crm_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE crm TO crm_app;
GRANT USAGE ON SCHEMA public TO crm_app;

-- Rol de sistema para el worker de recordatorios: necesita ver jobs de todas
-- las clinicas, por eso BYPASSRLS. No se expone a la API.
CREATE ROLE crm_worker LOGIN PASSWORD 'crm_worker' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE crm TO crm_worker;
GRANT USAGE ON SCHEMA public TO crm_worker;
