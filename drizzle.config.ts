import { defineConfig } from "drizzle-kit";

const url =
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/crm";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
