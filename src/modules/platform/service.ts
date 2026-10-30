import { randomUUID } from "node:crypto";
import { count, desc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Database } from "../../db/client.js";
import { appointments } from "../../db/schema/appointments.js";
import { clinicSlugs } from "../../db/schema/clinic-slugs.js";
import { clinics } from "../../db/schema/clinics.js";
import { patients } from "../../db/schema/patients.js";
import { platformAdmins } from "../../db/schema/platform-admins.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { services } from "../../db/schema/services.js";
import { users, type UserRole } from "../../db/schema/users.js";
import { withTenant } from "../../db/tenant.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { hashPassword } from "../../lib/password.js";
import { pgErrorCode } from "../../lib/pg-error.js";
import type {
  CreateClinicBody,
  CreateClinicUserBody,
  UpdateClinicBody,
  UpdateClinicUserBody,
} from "./schema.js";

export type TenantSummary = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  usersCount: number;
  practitionersCount: number;
  patientsCount: number;
  appointmentsCount: number;
};

export type TenantUser = {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  practitionerId: string | null;
  practitionerName: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
};

export type TenantDetail = TenantSummary & {
  users: TenantUser[];
  practitioners: Array<{ id: string; fullName: string; isActive: boolean }>;
};

function assertTimezone(timezone: string): void {
  if (!DateTime.now().setZone(timezone).isValid) {
    throw new AppError(422, "INVALID_TIMEZONE", "Zona horaria invalida");
  }
}

function buildSlug(name: string, clinicId: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "clinica"}-${clinicId.slice(0, 6)}`;
}

export async function listTenants(db: Database): Promise<TenantSummary[]> {
  const grouped = await db
    .select({ clinicId: users.clinicId, total: count() })
    .from(users)
    .groupBy(users.clinicId);

  const rows = await Promise.all(
    grouped.map(async (group) => {
      try {
        return await tenantStats(db, group.clinicId, Number(group.total));
      } catch {
        return null;
      }
    }),
  );

  return rows
    .filter((row): row is TenantSummary => Boolean(row))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function getTenant(
  db: Database,
  clinicId: string,
): Promise<TenantDetail> {
  const stats = await tenantStats(db, clinicId);
  if (!stats) {
    throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
  }

  const [userRows, practitionerRows] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        practitionerId: users.practitionerId,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.clinicId, clinicId))
      .orderBy(desc(users.createdAt)),
    withTenant(db, clinicId, (tx) =>
      tx
        .select({
          id: practitioners.id,
          fullName: practitioners.fullName,
          isActive: practitioners.isActive,
        })
        .from(practitioners)
        .orderBy(practitioners.fullName),
    ),
  ]);

  const practitionerNames = new Map(
    practitionerRows.map((item) => [item.id, item.fullName]),
  );

  return {
    ...stats,
    practitioners: practitionerRows,
    users: userRows.map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role as UserRole,
      practitionerId: user.practitionerId,
      practitionerName: user.practitionerId
        ? practitionerNames.get(user.practitionerId) ?? null
        : null,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    })),
  };
}

export async function createTenant(
  db: Database,
  input: CreateClinicBody,
  platformAdminId: string,
): Promise<TenantDetail> {
  assertTimezone(input.timezone);
  await assertPlatformEmailFree(db, input.admin.email);
  const clinicId = randomUUID();
  const slug = buildSlug(input.name, clinicId);

  try {
    await withTenant(db, clinicId, async (tx) => {
      await tx.insert(clinics).values({
        id: clinicId,
        name: input.name,
        slug,
        timezone: input.timezone,
        currency: input.currency,
      });

      await tx.insert(clinicSlugs).values({ slug, clinicId });

      await tx.insert(services).values({
        clinicId,
        code: "GENERAL",
        name: "Consulta general",
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 5,
        priceCents: 0,
        currency: input.currency,
        isActive: true,
      });

      await tx.insert(users).values({
        clinicId,
        email: input.admin.email.trim().toLowerCase(),
        passwordHash: hashPassword(input.admin.password),
        fullName: input.admin.fullName,
        role: "admin",
      });
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new AppError(
        409,
        "EMAIL_EXISTS",
        "Ya existe un usuario con ese correo",
      );
    }
    throw error;
  }

  await safeAudit(db, {
    clinicId,
    platformAdminId,
    action: "platform.tenant_create",
    resourceType: "clinic",
    resourceId: clinicId,
    after: { name: input.name, timezone: input.timezone },
  });

  return getTenant(db, clinicId);
}

export async function updateTenant(
  db: Database,
  clinicId: string,
  input: UpdateClinicBody,
  platformAdminId: string,
): Promise<TenantDetail> {
  if (input.timezone) assertTimezone(input.timezone);

  await withTenant(db, clinicId, async (tx) => {
    const [existing] = await tx
      .select({ id: clinics.id })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
    }

    await tx
      .update(clinics)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      })
      .where(eq(clinics.id, clinicId));
  });

  await safeAudit(db, {
    clinicId,
    platformAdminId,
    action: "platform.tenant_update",
    resourceType: "clinic",
    resourceId: clinicId,
    after: { ...input },
  });

  return getTenant(db, clinicId);
}

export async function createTenantUser(
  db: Database,
  clinicId: string,
  input: CreateClinicUserBody,
  platformAdminId: string,
): Promise<TenantUser> {
  await assertTenant(db, clinicId);
  await assertPlatformEmailFree(db, input.email);
  await assertPractitioner(db, clinicId, input.role, input.practitionerId);

  try {
    const [created] = await db
      .insert(users)
      .values({
        clinicId,
        email: input.email.trim().toLowerCase(),
        passwordHash: hashPassword(input.password),
        fullName: input.fullName,
        role: input.role,
        practitionerId:
          input.role === "practitioner" ? input.practitionerId ?? null : null,
      })
      .returning({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        practitionerId: users.practitionerId,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      });

    if (!created) {
      throw new AppError(500, "INSERT_FAILED", "No se pudo crear el usuario");
    }

    await safeAudit(db, {
      clinicId,
      platformAdminId,
      action: "platform.user_create",
      resourceType: "user",
      resourceId: created.id,
      after: { email: created.email, role: created.role },
    });

    return {
      ...created,
      role: created.role as UserRole,
      practitionerName: null,
    };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new AppError(
        409,
        "EMAIL_EXISTS",
        "Ya existe un usuario con ese correo",
      );
    }
    throw error;
  }
}

export async function updateTenantUser(
  db: Database,
  clinicId: string,
  userId: string,
  input: UpdateClinicUserBody,
  platformAdminId: string,
): Promise<TenantUser> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!existing || existing.clinicId !== clinicId) {
    throw new AppError(404, "USER_NOT_FOUND", "Usuario no encontrado");
  }

  const nextRole = input.role ?? (existing.role as UserRole);
  const nextActive = input.isActive ?? existing.isActive;

  if (input.email) {
    await assertPlatformEmailFree(db, input.email);
  }

  if (
    existing.role === "admin" &&
    existing.isActive &&
    (!nextActive || nextRole !== "admin")
  ) {
    const admins = await db
      .select({ id: users.id, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.clinicId, clinicId));
    const activeAdminCount = admins.filter(
      (item) => item.role === "admin" && item.isActive,
    ).length;
    if (activeAdminCount <= 1) {
      throw new AppError(
        409,
        "LAST_ADMIN",
        "La clinica necesita al menos un administrador activo",
      );
    }
  }

  await assertPractitioner(
    db,
    clinicId,
    nextRole,
    input.practitionerId !== undefined
      ? input.practitionerId
      : existing.practitionerId,
  );

  try {
    const [updated] = await db
      .update(users)
      .set({
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.email !== undefined
          ? { email: input.email.trim().toLowerCase() }
          : {}),
        ...(input.password !== undefined
          ? { passwordHash: hashPassword(input.password) }
          : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.role !== undefined || input.practitionerId !== undefined
          ? {
              practitionerId:
                nextRole === "practitioner"
                  ? input.practitionerId !== undefined
                    ? input.practitionerId
                    : existing.practitionerId
                  : null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        practitionerId: users.practitionerId,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      });

    if (!updated) {
      throw new AppError(500, "UPDATE_FAILED", "No se pudo actualizar");
    }

    await safeAudit(db, {
      clinicId,
      platformAdminId,
      action: "platform.user_update",
      resourceType: "user",
      resourceId: updated.id,
      after: { email: updated.email, role: updated.role, isActive: updated.isActive },
    });

    return {
      ...updated,
      role: updated.role as UserRole,
      practitionerName: null,
    };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new AppError(
        409,
        "EMAIL_EXISTS",
        "Ya existe un usuario con ese correo",
      );
    }
    throw error;
  }
}

async function tenantStats(
  db: Database,
  clinicId: string,
  knownUsers?: number,
): Promise<TenantSummary | null> {
  return withTenant(db, clinicId, async (tx) => {
    const [clinic] = await tx
      .select()
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    if (!clinic) return null;

    const [patientCount] = await tx
      .select({ total: count() })
      .from(patients);
    const [practitionerCount] = await tx
      .select({ total: count() })
      .from(practitioners);
    const [appointmentCount] = await tx
      .select({ total: count() })
      .from(appointments);
    const [userCount] =
      knownUsers !== undefined
        ? [{ total: knownUsers }]
        : await tx
            .select({ total: count() })
            .from(users)
            .where(eq(users.clinicId, clinicId));

    return {
      id: clinic.id,
      name: clinic.name,
      slug: clinic.slug ?? "",
      timezone: clinic.timezone,
      currency: clinic.currency,
      isActive: clinic.isActive,
      createdAt: clinic.createdAt,
      usersCount: Number(userCount?.total ?? 0),
      practitionersCount: Number(practitionerCount?.total ?? 0),
      patientsCount: Number(patientCount?.total ?? 0),
      appointmentsCount: Number(appointmentCount?.total ?? 0),
    };
  });
}

async function assertPlatformEmailFree(
  db: Database,
  email: string,
): Promise<void> {
  const [admin] = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.email, email.trim().toLowerCase()))
    .limit(1);

  if (admin) {
    throw new AppError(
      409,
      "EMAIL_EXISTS",
      "Ese correo pertenece a un administrador de plataforma",
    );
  }
}

async function assertTenant(db: Database, clinicId: string): Promise<void> {
  const [clinic] = await withTenant(db, clinicId, (tx) =>
    tx
      .select({ id: clinics.id })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1),
  );
  if (!clinic) {
    throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
  }
}

async function assertPractitioner(
  db: Database,
  clinicId: string,
  role: UserRole,
  practitionerId: string | null | undefined,
): Promise<void> {
  if (role !== "practitioner") return;
  if (!practitionerId) {
    throw new AppError(
      422,
      "PRACTITIONER_REQUIRED",
      "Selecciona el especialista para el usuario",
    );
  }

  const [practitioner] = await withTenant(db, clinicId, (tx) =>
    tx
      .select({ id: practitioners.id })
      .from(practitioners)
      .where(eq(practitioners.id, practitionerId!))
      .limit(1),
  );
  if (!practitioner) {
    throw new AppError(
      404,
      "PRACTITIONER_NOT_FOUND",
      "Especialista no encontrado en la clinica",
    );
  }
}

async function safeAudit(
  db: Database,
  input: {
    clinicId: string;
    platformAdminId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await recordAudit(db, {
      clinicId: input.clinicId,
      actorType: "platform_admin",
      actorUserId: input.platformAdminId,
      actorRole: "platform_admin",
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      after: input.after ?? null,
    });
  } catch {
    // La auditoria es best-effort; no revierte la operacion.
  }
}
