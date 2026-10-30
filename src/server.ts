import { buildApp } from "./app.js";
import { ensurePlatformAdmin } from "./bootstrap/platform-admin.js";
import { createDatabase } from "./db/client.js";
import { env } from "./env.js";

const { db, pool } = createDatabase(env.DATABASE_URL);
const app = buildApp({ db });

if (env.PLATFORM_ADMIN_BOOTSTRAP) {
  try {
    const result = await ensurePlatformAdmin(db, {
      email: env.PLATFORM_ADMIN_EMAIL,
      password: env.PLATFORM_ADMIN_PASSWORD,
      fullName: env.PLATFORM_ADMIN_NAME,
    });

    if (result.status === "created") {
      app.log.info(
        { email: result.email },
        "platform_admin.bootstrap_created",
      );
    } else if (result.status === "exists") {
      app.log.debug({ email: result.email }, "platform_admin.bootstrap_exists");
    } else {
      app.log.warn(
        { reason: result.reason },
        "platform_admin.bootstrap_skipped",
      );
    }
  } catch (error) {
    app.log.error({ err: error }, "platform_admin.bootstrap_failed");
  }
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting_down");
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.PORT, host: env.HOST });
