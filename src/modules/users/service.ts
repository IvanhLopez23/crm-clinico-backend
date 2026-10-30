import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { users, type UserRole } from "../../db/schema/users.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { hashPassword } from "../../lib/password.js";
import { pgErrorCode } from "../../lib/pg-error.js";
import type { CreateUserBody, UpdateOwnUserBody, UpdateUserBody } from "./schema.js";

export type UserSummary = {
  id: string;
  email: string;
  fullName: string;
  avatarData: string | null;
  role: UserRole;
  practitionerId: string | null;
  practitionerName: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
};

const userColumns = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  avatarData: users.avatarData,
  role: users.role,
  practitionerId: users.practitionerId,
  isActive: users.isActive,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

export async function listUsers(
  db: Database,
  clinicId: string,
): Promise<UserSummary[]> {
  const rows = await withTenant(db, clinicId, (tx) =>
    tx
      .select({
        ...userColumns,
        practitionerName: practitioners.fullName,
      })
      .from(users)
      .leftJoin(practitioners, eq(practitioners.id, users.practitionerId))
      .where(eq(users.clinicId, clinicId))
      .orderBy(asc(users.fullName)),
  );

  return rows.map((row) => ({ ...row, role: row.role as UserRole }));
}

export async function createUser(
  db: Database,
  params: { clinicId: string; input: CreateUserBody },
): Promise<UserSummary> {
  return withTenant(db, params.clinicId, async (tx) => {
    const practitionerId = await resolvePractitionerIdTx(
      tx,
      params.input.role,
      params.input.practitionerId ?? null,
    );

    try {
      const [created] = await tx
        .insert(users)
        .values({
          clinicId: params.clinicId,
          email: params.input.email.trim().toLowerCase(),
          passwordHash: hashPassword(params.input.password),
          fullName: params.input.fullName,
          avatarData: params.input.avatarData ?? null,
          role: params.input.role,
          practitionerId,
          isActive: true,
        })
        .returning(userColumns);

      if (!created) {
        throw new AppError(500, "INSERT_FAILED", "No se pudo crear el usuario");
      }

      const [practitioner] = practitionerId
        ? await tx
            .select({ fullName: practitioners.fullName })
            .from(practitioners)
            .where(eq(practitioners.id, practitionerId))
            .limit(1)
        : [];

      return {
        ...created,
        role: created.role as UserRole,
        practitionerName: practitioner?.fullName ?? null,
      };
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "USER_EMAIL_EXISTS",
          "Ya existe un usuario con ese correo",
        );
      }
      throw err;
    }
  });
}

export async function updateUser(
  db: Database,
  params: {
    clinicId: string;
    userId: string;
    actorUserId: string;
    input: UpdateUserBody;
  },
): Promise<UserSummary> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, params.userId), eq(users.clinicId, params.clinicId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "USER_NOT_FOUND", "Usuario no encontrado");
    }

    if (params.userId === params.actorUserId && params.input.isActive === false) {
      throw new AppError(
        409,
        "CANNOT_DEACTIVATE_SELF",
        "No puedes desactivar tu propio usuario",
      );
    }

    if (
      params.userId === params.actorUserId &&
      params.input.role !== undefined &&
      params.input.role !== existing.role
    ) {
      throw new AppError(
        409,
        "CANNOT_CHANGE_OWN_ROLE",
        "No puedes cambiar tu propio rol",
      );
    }

    const nextRole = (params.input.role ?? existing.role) as UserRole;
    const nextActive = params.input.isActive ?? existing.isActive;

    if (
      existing.role === "admin" &&
      (nextRole !== "admin" || nextActive === false)
    ) {
      const activeAdmins = await countActiveAdminsTx(tx, params.clinicId);
      if (activeAdmins <= 1) {
        throw new AppError(
          409,
          "LAST_ADMIN",
          "No puedes dejar la clinica sin un administrador activo",
        );
      }
    }

    const practitionerId = await resolvePractitionerIdTx(
      tx,
      nextRole,
      params.input.practitionerId !== undefined
        ? params.input.practitionerId
        : existing.practitionerId,
    );

    try {
      const [updated] = await tx
        .update(users)
        .set({
          ...(params.input.email !== undefined
            ? { email: params.input.email.trim().toLowerCase() }
            : {}),
          ...(params.input.password !== undefined
            ? { passwordHash: hashPassword(params.input.password) }
            : {}),
          ...(params.input.fullName !== undefined
            ? { fullName: params.input.fullName }
            : {}),
          ...(params.input.avatarData !== undefined
            ? { avatarData: params.input.avatarData }
            : {}),
          role: nextRole,
          practitionerId,
          ...(params.input.isActive !== undefined
            ? { isActive: params.input.isActive }
            : {}),
        })
        .where(eq(users.id, params.userId))
        .returning(userColumns);

      if (!updated) {
        throw new AppError(500, "UPDATE_FAILED", "No se pudo actualizar el usuario");
      }

      const [practitioner] = practitionerId
        ? await tx
            .select({ fullName: practitioners.fullName })
            .from(practitioners)
            .where(eq(practitioners.id, practitionerId))
            .limit(1)
        : [];

      return {
        ...updated,
        role: updated.role as UserRole,
        practitionerName: practitioner?.fullName ?? null,
      };
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "USER_EMAIL_EXISTS",
          "Ya existe un usuario con ese correo",
        );
      }
      throw err;
    }
  });
}

export async function updateOwnUser(
  db: Database,
  params: {
    clinicId: string;
    userId: string;
    input: UpdateOwnUserBody;
  },
): Promise<UserSummary> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, params.userId), eq(users.clinicId, params.clinicId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "USER_NOT_FOUND", "Usuario no encontrado");
    }

    try {
      const [updated] = await tx
        .update(users)
        .set({
          ...(params.input.email !== undefined
            ? { email: params.input.email.trim().toLowerCase() }
            : {}),
          ...(params.input.password !== undefined
            ? { passwordHash: hashPassword(params.input.password) }
            : {}),
          ...(params.input.fullName !== undefined
            ? { fullName: params.input.fullName }
            : {}),
          ...(params.input.avatarData !== undefined
            ? { avatarData: params.input.avatarData }
            : {}),
        })
        .where(eq(users.id, params.userId))
        .returning(userColumns);

      if (!updated) {
        throw new AppError(500, "UPDATE_FAILED", "No se pudo actualizar el perfil");
      }

      const [practitioner] = updated.practitionerId
        ? await tx
            .select({ fullName: practitioners.fullName })
            .from(practitioners)
            .where(eq(practitioners.id, updated.practitionerId))
            .limit(1)
        : [];

      return {
        ...updated,
        role: updated.role as UserRole,
        practitionerName: practitioner?.fullName ?? null,
      };
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "USER_EMAIL_EXISTS",
          "Ya existe un usuario con ese correo",
        );
      }
      throw err;
    }
  });
}

export async function deactivateUser(
  db: Database,
  params: {
    clinicId: string;
    userId: string;
    actorUserId: string;
  },
): Promise<void> {
  await withTenant(db, params.clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, params.userId), eq(users.clinicId, params.clinicId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "USER_NOT_FOUND", "Usuario no encontrado");
    }
    if (params.userId === params.actorUserId) {
      throw new AppError(
        409,
        "CANNOT_DEACTIVATE_SELF",
        "No puedes desactivar tu propio usuario",
      );
    }
    if (existing.role === "admin") {
      const activeAdmins = await countActiveAdminsTx(tx, params.clinicId);
      if (activeAdmins <= 1) {
        throw new AppError(
          409,
          "LAST_ADMIN",
          "No puedes dejar la clinica sin un administrador activo",
        );
      }
    }

    await tx
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, params.userId));
  });
}

async function resolvePractitionerIdTx(
  tx: Transaction,
  role: UserRole,
  practitionerId: string | null,
): Promise<string | null> {
  if (role !== "practitioner") return null;
  if (!practitionerId) {
    throw new AppError(
      422,
      "PRACTITIONER_REQUIRED",
      "Un usuario con rol practitioner debe tener un especialista asociado",
    );
  }

  const [practitioner] = await tx
    .select({ id: practitioners.id })
    .from(practitioners)
    .where(
      and(
        eq(practitioners.id, practitionerId),
        eq(practitioners.isActive, true),
        isNull(practitioners.deletedAt),
      ),
    )
    .limit(1);

  if (!practitioner) {
    throw new AppError(
      404,
      "PRACTITIONER_NOT_FOUND",
      "Especialista no encontrado o inactivo",
    );
  }
  return practitioner.id;
}

async function countActiveAdminsTx(
  tx: Transaction,
  clinicId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(users)
    .where(
      and(
        eq(users.clinicId, clinicId),
        eq(users.role, "admin"),
        eq(users.isActive, true),
      ),
    );
  return Number(row?.count ?? 0);
}
