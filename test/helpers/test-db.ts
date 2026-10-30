import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDatabase, type Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";

export type TestDatabase = {
  container: StartedPostgreSqlContainer;
  adminPool: Pool;
  adminDb: Database;
  appDb: Database;
  appPool: Pool;
  close: () => Promise<void>;
};

/**
 * Postgres efimero con migraciones aplicadas y dos conexiones:
 * - adminDb (superusuario): seed y verificaciones, ignora RLS.
 * - appDb (crm_app): el rol real de la API, sujeto a RLS.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const adminUri = container.getConnectionUri();

  const adminPool = new Pool({ connectionString: adminUri, max: 5 });
  await adminPool.query(
    "create role crm_app login password 'crm_app' nosuperuser nobypassrls",
  );
  await adminPool.query(
    "create role crm_worker login password 'crm_worker' nosuperuser bypassrls",
  );

  const adminDb = drizzle({ client: adminPool, schema });
  await migrate(adminDb, { migrationsFolder: "src/db/migrations" });

  const appUri = new URL(adminUri);
  appUri.username = "crm_app";
  appUri.password = "crm_app";
  const { db: appDb, pool: appPool } = createDatabase(appUri.toString());

  return {
    container,
    adminPool,
    adminDb,
    appDb,
    appPool,
    close: async () => {
      await appPool.end();
      await adminPool.end();
      await container.stop();
    },
  };
}
