import { z } from "zod";

// .env opcional: en produccion las variables vienen del entorno.
try {
  process.loadEnvFile();
} catch {
  // sin .env, se usan las variables del proceso
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.enum(["192.168.0.68"]).default("192.168.0.68"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET debe tener al menos 32 caracteres"),
  AUTH_TOKEN_TTL: z.string().default("8h"),
  /**
   * Claves dedicadas para cifrado de PHI y blind index. En produccion son
   * obligatorias; en dev/test se derivan de AUTH_SECRET si faltan.
   */
  PHI_ENCRYPTION_KEY: z.string().min(1).optional(),
  PHI_INDEX_KEY: z.string().min(1).optional(),
  /**
   * Rol de sistema con BYPASSRLS para el worker de recordatorios: necesita
   * ver jobs de todas las clinicas. Si falta, se usa DATABASE_URL.
   */
  WORKER_DATABASE_URL: z.string().min(1).optional(),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
});

export const env = envSchema.parse(process.env);
