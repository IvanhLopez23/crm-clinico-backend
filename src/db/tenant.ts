import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.js";

/**
 * Ejecuta `fn` dentro de una transaccion con el tenant fijado.
 *
 * `set_config(..., true)` es local a la transaccion, imprescindible con pool
 * de conexiones: un SET global filtraria el tenant entre requests.
 */
export async function withTenant<T>(
  db: Database,
  clinicId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    return fn(tx);
  });
}
