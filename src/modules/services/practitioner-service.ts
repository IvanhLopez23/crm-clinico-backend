import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import { clinics } from "../../db/schema/clinics.js";
import { practitionerServices } from "../../db/schema/practitioner-services.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { services } from "../../db/schema/services.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import type {
  UpdatePractitionerServiceBody,
  UpsertPractitionerServiceBody,
} from "./schema.js";

export type PractitionerServiceView = {
  id: string;
  practitionerId: string;
  serviceId: string;
  name: string;
  code: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  isActive: boolean;
};

const viewColumns = {
  id: practitionerServices.id,
  practitionerId: practitionerServices.practitionerId,
  serviceId: practitionerServices.serviceId,
  name: services.name,
  code: services.code,
  durationMinutes: practitionerServices.durationMinutes,
  priceCents: practitionerServices.priceCents,
  currency: practitionerServices.currency,
  isActive: practitionerServices.isActive,
};

export async function listPractitionerServices(
  db: Database,
  params: {
    clinicId: string;
    practitionerId?: string;
    active?: boolean;
  },
): Promise<PractitionerServiceView[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select(viewColumns)
      .from(practitionerServices)
      .innerJoin(services, eq(services.id, practitionerServices.serviceId))
      .where(
        and(
          params.practitionerId
            ? eq(practitionerServices.practitionerId, params.practitionerId)
            : undefined,
          params.active !== undefined
            ? eq(practitionerServices.isActive, params.active)
            : undefined,
        ),
      )
      .orderBy(asc(services.name)),
  );
}

export async function upsertPractitionerService(
  db: Database,
  params: {
    clinicId: string;
    practitionerId: string;
    input: UpsertPractitionerServiceBody;
  },
): Promise<PractitionerServiceView> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [practitioner] = await tx
      .select({ id: practitioners.id })
      .from(practitioners)
      .where(
        and(
          eq(practitioners.id, params.practitionerId),
          isNull(practitioners.deletedAt),
        ),
      )
      .limit(1);

    if (!practitioner) {
      throw new AppError(
        404,
        "PRACTITIONER_NOT_FOUND",
        "Especialista no encontrado",
      );
    }

    let service: typeof services.$inferSelect | null = null;

    if (params.input.serviceId) {
      const [found] = await tx
        .select()
        .from(services)
        .where(eq(services.id, params.input.serviceId))
        .limit(1);
      service = found ?? null;
    } else if (params.input.serviceName) {
      const catalog = await tx.select().from(services);
      const name = params.input.serviceName.trim().toLowerCase();
      service =
        catalog.find((item) => item.name.trim().toLowerCase() === name) ?? null;

      if (!service) {
        const [clinic] = await tx
          .select({ currency: clinics.currency })
          .from(clinics)
          .where(eq(clinics.id, params.clinicId))
          .limit(1);

        if (!clinic) {
          throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
        }

        const [created] = await tx
          .insert(services)
          .values({
            clinicId: params.clinicId,
            code: `PX-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`,
            name: params.input.serviceName.trim(),
            durationMinutes: params.input.durationMinutes,
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            priceCents: params.input.priceCents,
            currency: clinic.currency,
            taxRateBps: 0,
            depositRequired: false,
            isActive: true,
          })
          .returning();

        if (!created) {
          throw new AppError(
            500,
            "INSERT_FAILED",
            "No se pudo crear el servicio",
          );
        }
        service = created;
      }
    }

    if (!service) {
      throw new AppError(404, "SERVICE_NOT_FOUND", "Servicio no encontrado");
    }

    const [existing] = await tx
      .select({ id: practitionerServices.id })
      .from(practitionerServices)
      .where(
        and(
          eq(practitionerServices.practitionerId, params.practitionerId),
          eq(practitionerServices.serviceId, service.id),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await tx
        .update(practitionerServices)
        .set({
          durationMinutes: params.input.durationMinutes,
          priceCents: params.input.priceCents,
          currency: service.currency,
          isActive: params.input.isActive,
          updatedAt: new Date(),
        })
        .where(eq(practitionerServices.id, existing.id))
        .returning({ id: practitionerServices.id });

      if (!updated) {
        throw new AppError(
          500,
          "UPDATE_FAILED",
          "No se pudo actualizar el servicio del especialista",
        );
      }
      return getPractitionerService(tx, updated.id);
    }

    const [created] = await tx
      .insert(practitionerServices)
      .values({
        clinicId: params.clinicId,
        practitionerId: params.practitionerId,
        serviceId: service.id,
        durationMinutes: params.input.durationMinutes,
        priceCents: params.input.priceCents,
        currency: service.currency,
        isActive: params.input.isActive,
      })
      .returning({ id: practitionerServices.id });

    if (!created) {
      throw new AppError(
        500,
        "INSERT_FAILED",
        "No se pudo asignar el servicio al especialista",
      );
    }
    return getPractitionerService(tx, created.id);
  });
}

export async function updatePractitionerService(
  db: Database,
  params: {
    clinicId: string;
    assignmentId: string;
    input: UpdatePractitionerServiceBody;
  },
): Promise<PractitionerServiceView> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(practitionerServices)
      .where(eq(practitionerServices.id, params.assignmentId))
      .limit(1);

    if (!existing) {
      throw new AppError(
        404,
        "PRACTITIONER_SERVICE_NOT_FOUND",
        "Servicio del especialista no encontrado",
      );
    }

    const [updated] = await tx
      .update(practitionerServices)
      .set({
        durationMinutes:
          params.input.durationMinutes ?? existing.durationMinutes,
        priceCents: params.input.priceCents ?? existing.priceCents,
        isActive: params.input.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(practitionerServices.id, params.assignmentId))
      .returning({ id: practitionerServices.id });

    if (!updated) {
      throw new AppError(
        500,
        "UPDATE_FAILED",
        "No se pudo actualizar el servicio del especialista",
      );
    }
    return getPractitionerService(tx, updated.id);
  });
}

export async function deletePractitionerService(
  db: Database,
  params: { clinicId: string; assignmentId: string },
): Promise<void> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [deleted] = await tx
      .delete(practitionerServices)
      .where(eq(practitionerServices.id, params.assignmentId))
      .returning({ id: practitionerServices.id });

    if (!deleted) {
      throw new AppError(
        404,
        "PRACTITIONER_SERVICE_NOT_FOUND",
        "Servicio del especialista no encontrado",
      );
    }
  });
}

/** Resuelve el override del especialista dentro de una transaccion abierta. */
export async function findPractitionerServiceTx(
  tx: Transaction,
  params: { practitionerId: string; serviceId: string },
) {
  const [row] = await tx
    .select({
      durationMinutes: practitionerServices.durationMinutes,
      priceCents: practitionerServices.priceCents,
      currency: practitionerServices.currency,
      isActive: practitionerServices.isActive,
    })
    .from(practitionerServices)
    .where(
      and(
        eq(practitionerServices.practitionerId, params.practitionerId),
        eq(practitionerServices.serviceId, params.serviceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getPractitionerService(
  tx: Transaction,
  id: string,
): Promise<PractitionerServiceView> {
  const [row] = await tx
    .select(viewColumns)
    .from(practitionerServices)
    .innerJoin(services, eq(services.id, practitionerServices.serviceId))
    .where(eq(practitionerServices.id, id))
    .limit(1);

  if (!row) {
    throw new AppError(
      404,
      "PRACTITIONER_SERVICE_NOT_FOUND",
      "Servicio del especialista no encontrado",
    );
  }
  return row;
}
