import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

/** Tipo de la transaccion que entrega `db.transaction`. */
export type Transaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export function createDatabase(connectionString: string): {
  db: Database;
  pool: Pool;
} {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  const db = drizzle({ client: pool, schema });

  return { db, pool };
}
