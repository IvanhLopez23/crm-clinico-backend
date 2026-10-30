import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    env: {
      AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
      AUTH_TOKEN_TTL: "1h",
      DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
    },
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
