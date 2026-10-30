import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { platformAdmins } from "../db/schema/platform-admins.js";
import { users } from "../db/schema/users.js";
import { hashPassword } from "../lib/password.js";
import { pgErrorCode } from "../lib/pg-error.js";

export type PlatformAdminBootstrapInput = {
  email?: string | null;
  password?: string | null;
  fullName?: string | null;
};

export type PlatformAdminBootstrapResult =
  | { status: "created"; email: string }
  | { status: "exists"; email: string }
  | {
      status: "skipped";
      reason: "missing_credentials" | "invalid_credentials" | "email_in_use";
    };

const DEFAULT_NAME = "Administrador de plataforma";

/**
 * Garantiza que exista el primer superadmin de plataforma.
 *
 * - Solo crea si la tabla `platform_admins` no tiene ese correo.
 * - No actualiza contrasenas existentes: reiniciar el servidor no cambia
 *   credenciales.
 * - Es idempotente y tolera carreras entre instancias (indice unico).
 */
export async function ensurePlatformAdmin(
  db: Database,
  input: PlatformAdminBootstrapInput,
): Promise<PlatformAdminBootstrapResult> {
  const email = input.email?.trim().toLowerCase();
  const password = input.password;
  const fullName = input.fullName?.trim() || DEFAULT_NAME;

  if (!email || !password) {
    return { status: "skipped", reason: "missing_credentials" };
  }

  if (password.length < 8) {
    return { status: "skipped", reason: "invalid_credentials" };
  }

  const [existing] = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.email, email))
    .limit(1);

  if (existing) {
    return { status: "exists", email };
  }

  // El login resuelve primero usuarios de tenant; evitamos un correo ambiguo.
  const [tenantUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (tenantUser) {
    return { status: "skipped", reason: "email_in_use" };
  }

  try {
    await db.insert(platformAdmins).values({
      email,
      passwordHash: hashPassword(password),
      fullName,
    });
    return { status: "created", email };
  } catch (error) {
    // Otra instancia pudo crear el mismo correo entre el SELECT y el INSERT.
    if (pgErrorCode(error) === "23505") {
      return { status: "exists", email };
    }
    throw error;
  }
}
