import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { clinics } from "../../db/schema/clinics.js";
import { platformAdmins } from "../../db/schema/platform-admins.js";
import { users, type UserRole } from "../../db/schema/users.js";
import { withTenant } from "../../db/tenant.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { verifyAgainstDummy, verifyPassword } from "../../lib/password.js";
import { signAccessToken, signPlatformAccessToken } from "./jwt.js";

export type LoginInput = {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
};

export type LoginResult = {
  token: string;
  user: {
    id: string;
    email: string;
    fullName: string;
    avatarData: string | null;
    role: UserRole | "platform_admin";
    clinicId: string | null;
    scope: "tenant" | "platform";
  };
};

export async function login(
  db: Database,
  input: LoginInput,
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.isActive, true)))
    .limit(1);

  if (!user) {
    return loginPlatformAdmin(db, input, email);
  }

  if (!verifyPassword(input.password, user.passwordHash)) {
    await safeAudit(db, {
      clinicId: user.clinicId,
      actorType: "user",
      actorUserId: user.id,
      actorRole: user.role as UserRole,
      action: "auth.login_failed",
      resourceType: "user",
      resourceId: user.id,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });

    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "Credenciales invalidas",
    );
  }

  const clinic = await withTenant(db, user.clinicId, async (tx) => {
    const [row] = await tx
      .select({ isActive: clinics.isActive })
      .from(clinics)
      .where(eq(clinics.id, user.clinicId))
      .limit(1);
    return row ?? null;
  });

  if (!clinic) {
    throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
  }
  if (!clinic.isActive) {
    throw new AppError(
      403,
      "CLINIC_INACTIVE",
      "La clinica esta suspendida. Contacta al administrador de la plataforma.",
    );
  }

  const now = new Date();

  await db
    .update(users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, user.id));

  await safeAudit(db, {
    clinicId: user.clinicId,
    actorType: "user",
    actorUserId: user.id,
    actorRole: user.role as UserRole,
    action: "auth.login",
    resourceType: "user",
    resourceId: user.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  const token = await signAccessToken({
    userId: user.id,
    clinicId: user.clinicId,
    role: user.role as UserRole,
  });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarData: user.avatarData,
      role: user.role as UserRole,
      clinicId: user.clinicId,
      scope: "tenant",
    },
  };
}

async function loginPlatformAdmin(
  db: Database,
  input: LoginInput,
  email: string,
): Promise<LoginResult> {
  const [admin] = await db
    .select()
    .from(platformAdmins)
    .where(
      and(eq(platformAdmins.email, email), eq(platformAdmins.isActive, true)),
    )
    .limit(1);

  if (!admin || !verifyPassword(input.password, admin.passwordHash)) {
    verifyAgainstDummy(input.password);
    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "Credenciales invalidas",
    );
  }

  await db
    .update(platformAdmins)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(platformAdmins.id, admin.id));

  const token = await signPlatformAccessToken({
    platformAdminId: admin.id,
  });

  return {
    token,
    user: {
      id: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      avatarData: null,
      role: "platform_admin",
      clinicId: null,
      scope: "platform",
    },
  };
}

async function safeAudit(
  db: Database,
  input: Parameters<typeof recordAudit>[1],
): Promise<void> {
  try {
    await recordAudit(db, input);
  } catch {
    // Un fallo de auditoria no debe tumbar el login; queda en el log del server.
  }
}
