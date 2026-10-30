import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { clinics } from "../../db/schema/clinics.js";
import { practitionerServices } from "../../db/schema/practitioner-services.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { services } from "../../db/schema/services.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";

export type ClinicInfo = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
};

export type PractitionerSummary = {
  id: string;
  fullName: string;
  specialty: string | null;
  color: string;
  defaultSlotMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  isAcceptingNewPatients: boolean;
  isActive: boolean;
  createdAt: Date;
};

export type CreatePractitionerInput = {
  fullName: string;
  specialty?: string | null;
  color?: string;
  defaultSlotMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  isAcceptingNewPatients?: boolean;
  isActive?: boolean;
};

export type UpdatePractitionerInput = Partial<CreatePractitionerInput>;

export async function getClinic(
  db: Database,
  clinicId: string,
): Promise<ClinicInfo> {
  return withTenant(db, clinicId, async (tx) => {
    const [clinic] = await tx
      .select({
        id: clinics.id,
        name: clinics.name,
        slug: clinics.slug,
        timezone: clinics.timezone,
      })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    if (!clinic) {
      throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
    }

    return clinic;
  });
}

export async function listPractitioners(
  db: Database,
  clinicId: string,
  options: { includeInactive?: boolean; practitionerId?: string } = {},
): Promise<PractitionerSummary[]> {
  return withTenant(db, clinicId, (tx) =>
    tx
      .select({
        id: practitioners.id,
        fullName: practitioners.fullName,
        specialty: practitioners.specialty,
        color: practitioners.color,
        defaultSlotMinutes: practitioners.defaultSlotMinutes,
        bufferBeforeMinutes: practitioners.bufferBeforeMinutes,
        bufferAfterMinutes: practitioners.bufferAfterMinutes,
        isAcceptingNewPatients: practitioners.isAcceptingNewPatients,
        isActive: practitioners.isActive,
        createdAt: practitioners.createdAt,
      })
      .from(practitioners)
      .where(
        and(
          options.includeInactive
            ? undefined
            : eq(practitioners.isActive, true),
          options.practitionerId
            ? eq(practitioners.id, options.practitionerId)
            : undefined,
          isNull(practitioners.deletedAt),
        ),
      )
      .orderBy(asc(practitioners.fullName)),
  );
}

export async function createPractitioner(
  db: Database,
  clinicId: string,
  input: CreatePractitionerInput,
): Promise<PractitionerSummary> {
  return withTenant(db, clinicId, async (tx) => {
    const [created] = await tx
      .insert(practitioners)
      .values({
        id: randomUUID(),
        clinicId,
        fullName: input.fullName,
        specialty: input.specialty || null,
        color: input.color ?? "#0F766E",
        defaultSlotMinutes: input.defaultSlotMinutes ?? 30,
        bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
        bufferAfterMinutes: input.bufferAfterMinutes ?? 5,
        isAcceptingNewPatients: input.isAcceptingNewPatients ?? true,
        isActive: input.isActive ?? true,
      })
      .returning({
        id: practitioners.id,
        fullName: practitioners.fullName,
        specialty: practitioners.specialty,
        color: practitioners.color,
        defaultSlotMinutes: practitioners.defaultSlotMinutes,
        bufferBeforeMinutes: practitioners.bufferBeforeMinutes,
        bufferAfterMinutes: practitioners.bufferAfterMinutes,
        isAcceptingNewPatients: practitioners.isAcceptingNewPatients,
        isActive: practitioners.isActive,
        createdAt: practitioners.createdAt,
      });

    if (!created) {
      throw new AppError(
        500,
        "INSERT_FAILED",
        "No se pudo crear el especialista",
      );
    }

    // Arranca con todo el catalogo activo; luego se ajusta por especialista.
    const catalog = await tx
      .select({
        id: services.id,
        durationMinutes: services.durationMinutes,
        priceCents: services.priceCents,
        currency: services.currency,
      })
      .from(services)
      .where(
        and(eq(services.clinicId, clinicId), eq(services.isActive, true)),
      );

    if (catalog.length > 0) {
      await tx.insert(practitionerServices).values(
        catalog.map((service) => ({
          clinicId,
          practitionerId: created.id,
          serviceId: service.id,
          durationMinutes: service.durationMinutes,
          priceCents: service.priceCents,
          currency: service.currency,
          isActive: true,
        })),
      );
    }

    return created;
  });
}

export async function updatePractitioner(
  db: Database,
  clinicId: string,
  practitionerId: string,
  input: UpdatePractitionerInput,
): Promise<PractitionerSummary> {
  return withTenant(db, clinicId, async (tx) => {
    const [existing] = await tx
      .select({ id: practitioners.id })
      .from(practitioners)
      .where(
        and(
          eq(practitioners.id, practitionerId),
          isNull(practitioners.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new AppError(
        404,
        "PRACTITIONER_NOT_FOUND",
        "Especialista no encontrado",
      );
    }

    const [updated] = await tx
      .update(practitioners)
      .set({
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.specialty !== undefined
          ? { specialty: input.specialty || null }
          : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.defaultSlotMinutes !== undefined
          ? { defaultSlotMinutes: input.defaultSlotMinutes }
          : {}),
        ...(input.bufferBeforeMinutes !== undefined
          ? { bufferBeforeMinutes: input.bufferBeforeMinutes }
          : {}),
        ...(input.bufferAfterMinutes !== undefined
          ? { bufferAfterMinutes: input.bufferAfterMinutes }
          : {}),
        ...(input.isAcceptingNewPatients !== undefined
          ? { isAcceptingNewPatients: input.isAcceptingNewPatients }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      })
      .where(eq(practitioners.id, practitionerId))
      .returning({
        id: practitioners.id,
        fullName: practitioners.fullName,
        specialty: practitioners.specialty,
        color: practitioners.color,
        defaultSlotMinutes: practitioners.defaultSlotMinutes,
        bufferBeforeMinutes: practitioners.bufferBeforeMinutes,
        bufferAfterMinutes: practitioners.bufferAfterMinutes,
        isAcceptingNewPatients: practitioners.isAcceptingNewPatients,
        isActive: practitioners.isActive,
        createdAt: practitioners.createdAt,
      });

    if (!updated) {
      throw new AppError(
        500,
        "UPDATE_FAILED",
        "No se pudo actualizar el especialista",
      );
    }
    return updated;
  });
}
