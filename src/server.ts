import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { env } from "./env.js";

const { db, pool } = createDatabase(env.DATABASE_URL);
const app = buildApp({ db });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting_down");
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.PORT, host: env.HOST });
