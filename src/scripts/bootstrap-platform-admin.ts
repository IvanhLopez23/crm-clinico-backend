import { ensurePlatformAdmin } from "../bootstrap/platform-admin.js";
import { createDatabase } from "../db/client.js";
import { env } from "../env.js";

const [argEmail, argPassword, argName] = process.argv.slice(2);

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;

const { db, pool } = createDatabase(connectionString);

try {
  const result = await ensurePlatformAdmin(db, {
    email: argEmail ?? env.PLATFORM_ADMIN_EMAIL,
    password: argPassword ?? env.PLATFORM_ADMIN_PASSWORD,
    fullName: argName ?? env.PLATFORM_ADMIN_NAME,
  });

  console.log(
    JSON.stringify({ event: "platform_admin.bootstrap", ...result }, null, 2),
  );

  if (result.status === "skipped") {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
