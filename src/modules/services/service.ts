import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import { clinics } from "../../db/schema/clinics.js";
import { practitionerServices } from "../../db/schema/practitioner-services.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { services } from "../../db/schema/services.js";
import { specialties } from "../../db/schema/specialties.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { pgErrorCode } from "../../lib/pg-error.js";
import type {
  CreateServiceBody,
  CreateSpecialtyBody,
  UpdateServiceBody,
} from "./schema.js";

export async function listServices(
  db: Database,
  params: { clinicId: string; active?: boolean },
): Promise<(typeof services.$inferSelect)[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select()
      .from(services)
      .where(
        and(
          eq(services.clinicId, params.clinicId),
          params.active !== undefined
            ? eq(services.isActive, params.active)
            : undefined,
        ),
      )
      .orderBy(asc(services.name)),
  );
}

export async function createService(
  db: Database,
  params: { clinicId: string; input: CreateServiceBody },
): Promise<(typeof services.$inferSelect)> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [clinic] = await tx
      .select({ currency: clinics.currency })
      .from(clinics)
      .where(eq(clinics.id, params.clinicId))
      .limit(1);

    if (!clinic) {
      throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
    }

    if (params.input.specialtyId) {
      await assertSpecialtyTx(tx, params.input.specialtyId);
    }

    try {
      const [created] = await tx
        .insert(services)
        .values({
          clinicId: params.clinicId,
          code: params.input.code,
          name: params.input.name,
          specialtyId: params.input.specialtyId ?? null,
          durationMinutes: params.input.durationMinutes,
          bufferBeforeMinutes: params.input.bufferBeforeMinutes,
          bufferAfterMinutes: params.input.bufferAfterMinutes,
          priceCents: params.input.priceCents,
          currency: params.input.currency ?? clinic.currency,
          taxRateBps: params.input.taxRateBps,
          depositRequired: params.input.depositRequired,
          depositCents: params.input.depositCents ?? null,
          depositBps: params.input.depositBps ?? null,
          color: params.input.color ?? null,
          isTelehealth: params.input.isTelehealth,
          isActive: params.input.isActive,
        })
        .returning();

      if (!created) {
        throw new AppError(500, "INSERT_FAILED", "No se pudo crear el servicio");
      }

      await assignServiceToActivePractitioners(tx, params.clinicId, created);

      return created;
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "SERVICE_CODE_EXISTS",
          "Ya existe un servicio con ese codigo",
        );
      }
      if (pgErrorCode(err) === "23514") {
        throw new AppError(422, "INVALID_SERVICE", "Configuracion de servicio invalida");
      }
      throw err;
    }
  });
}

export async function updateService(
  db: Database,
  params: {
    clinicId: string;
    serviceId: string;
    input: UpdateServiceBody;
  },
): Promise<(typeof services.$inferSelect)> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(services)
      .where(eq(services.id, params.serviceId))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "SERVICE_NOT_FOUND", "Servicio no encontrado");
    }

    if (params.input.specialtyId !== undefined && params.input.specialtyId !== null) {
      await assertSpecialtyTx(tx, params.input.specialtyId);
    }

    const input = params.input;
    try {
      const [updated] = await tx
        .update(services)
        .set({
          name: input.name ?? existing.name,
          specialtyId:
            input.specialtyId !== undefined
              ? input.specialtyId
              : existing.specialtyId,
          durationMinutes: input.durationMinutes ?? existing.durationMinutes,
          bufferBeforeMinutes:
            input.bufferBeforeMinutes ?? existing.bufferBeforeMinutes,
          bufferAfterMinutes:
            input.bufferAfterMinutes ?? existing.bufferAfterMinutes,
          priceCents: input.priceCents ?? existing.priceCents,
          currency: input.currency ?? existing.currency,
          taxRateBps: input.taxRateBps ?? existing.taxRateBps,
          depositRequired: input.depositRequired ?? existing.depositRequired,
          depositCents:
            input.depositCents !== undefined
              ? input.depositCents
              : existing.depositCents,
          depositBps:
            input.depositBps !== undefined
              ? input.depositBps
              : existing.depositBps,
          color: input.color !== undefined ? input.color : existing.color,
          isTelehealth: input.isTelehealth ?? existing.isTelehealth,
          isActive: input.isActive ?? existing.isActive,
          updatedAt: new Date(),
        })
        .where(eq(services.id, params.serviceId))
        .returning();

      if (!updated) {
        throw new AppError(500, "UPDATE_FAILED", "No se pudo actualizar el servicio");
      }
      return updated;
    } catch (err) {
      if (pgErrorCode(err) === "23514") {
        throw new AppError(422, "INVALID_SERVICE", "Configuracion de servicio invalida");
      }
      throw err;
    }
  });
}

export async function listSpecialties(
  db: Database,
  params: { clinicId: string },
): Promise<(typeof specialties.$inferSelect)[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select()
      .from(specialties)
      .where(eq(specialties.clinicId, params.clinicId))
      .orderBy(asc(specialties.name)),
  );
}

export async function createSpecialty(
  db: Database,
  params: { clinicId: string; input: CreateSpecialtyBody },
): Promise<{ id: string; code: string; name: string }> {
  return withTenant(db, params.clinicId, async (tx) => {
    try {
      const [created] = await tx
        .insert(specialties)
        .values({
          clinicId: params.clinicId,
          code: params.input.code,
          name: params.input.name,
        })
        .returning({
          id: specialties.id,
          code: specialties.code,
          name: specialties.name,
        });

      if (!created) {
        throw new AppError(500, "INSERT_FAILED", "No se pudo crear la especialidad");
      }
      return created;
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        throw new AppError(
          409,
          "SPECIALTY_EXISTS",
          "Ya existe una especialidad con ese codigo",
        );
      }
      throw err;
    }
  });
}

async function assertSpecialtyTx(
  tx: Transaction,
  specialtyId: string,
): Promise<void> {
  const [specialty] = await tx
    .select({ id: specialties.id })
    .from(specialties)
    .where(eq(specialties.id, specialtyId))
    .limit(1);
  if (!specialty) {
    throw new AppError(404, "SPECIALTY_NOT_FOUND", "Especialidad no encontrada");
  }
}

/**
 * Un servicio nuevo entra al catalogo de todos los especialistas activos con
 * sus valores base. Administracion puede ajustar despues precio y duracion.
 */
async function assignServiceToActivePractitioners(
  tx: Transaction,
  clinicId: string,
  service: typeof services.$inferSelect,
): Promise<void> {
  const rows = await tx
    .select({ id: practitioners.id })
    .from(practitioners)
    .where(
      and(
        eq(practitioners.clinicId, clinicId),
        eq(practitioners.isActive, true),
        isNull(practitioners.deletedAt),
      ),
    );

  if (rows.length === 0) return;

  await tx
    .insert(practitionerServices)
    .values(
      rows.map((practitioner) => ({
        clinicId,
        practitionerId: practitioner.id,
        serviceId: service.id,
        durationMinutes: service.durationMinutes,
        priceCents: service.priceCents,
        currency: service.currency,
        isActive: service.isActive,
      })),
    )
    .onConflictDoNothing();
}
