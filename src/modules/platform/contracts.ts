import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { tenantContracts } from "../../db/schema/tenant-contracts.js";
import { withTenant } from "../../db/tenant.js";
import { recordAudit } from "../../lib/audit.js";
import {
  contractFileExists,
  deleteContractFile,
  isContractMimeType,
  MAX_CONTRACT_BYTES,
  openContractFile,
  saveContractFile,
} from "../../lib/contract-storage.js";
import { AppError } from "../../lib/errors.js";

export type TenantContract = {
  id: string;
  clinicId: string;
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateContractInput = {
  name: string;
  startsAt: string;
  endsAt?: string | null;
  notes?: string | null;
  isActive?: boolean;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

export async function listTenantContracts(
  db: Database,
  clinicId: string,
): Promise<TenantContract[]> {
  return withTenant(db, clinicId, async (tx) => {
    const rows = await tx
      .select()
      .from(tenantContracts)
      .where(eq(tenantContracts.clinicId, clinicId))
      .orderBy(desc(tenantContracts.createdAt));

    return rows.map(toView);
  });
}

export async function createTenantContract(
  db: Database,
  clinicId: string,
  input: CreateContractInput,
  platformAdminId: string,
): Promise<TenantContract> {
  if (input.endsAt && input.endsAt < input.startsAt) {
    throw new AppError(
      422,
      "INVALID_CONTRACT_DATES",
      "La fecha de fin debe ser igual o posterior al inicio",
    );
  }
  if (!isContractMimeType(input.mimeType)) {
    throw new AppError(
      422,
      "INVALID_CONTRACT_FILE",
      "El archivo debe ser PDF, imagen o documento de Word",
    );
  }
  if (input.buffer.length === 0) {
    throw new AppError(422, "EMPTY_CONTRACT_FILE", "El archivo esta vacio");
  }
  if (input.buffer.length > MAX_CONTRACT_BYTES) {
    throw new AppError(
      413,
      "CONTRACT_FILE_TOO_LARGE",
      "El archivo supera el limite de 10 MB",
    );
  }

  const saved = await saveContractFile(
    clinicId,
    input.mimeType,
    input.buffer,
  );

  try {
    const [created] = await withTenant(db, clinicId, (tx) =>
      tx
        .insert(tenantContracts)
        .values({
          clinicId,
          name: input.name,
          fileName: input.fileName,
          storageKey: saved.storageKey,
          mimeType: input.mimeType,
          sizeBytes: saved.sizeBytes,
          startsAt: input.startsAt,
          endsAt: input.endsAt ?? null,
          isActive: input.isActive ?? true,
          notes: input.notes ?? null,
        })
        .returning(),
    );

    if (!created) {
      throw new AppError(
        500,
        "INSERT_FAILED",
        "No se pudo guardar el contrato",
      );
    }

    await safeAudit(db, {
      clinicId,
      platformAdminId,
      action: "platform.contract_create",
      resourceId: created.id,
      after: {
        name: created.name,
        fileName: created.fileName,
        startsAt: created.startsAt,
        endsAt: created.endsAt,
      },
    });

    return toView(created);
  } catch (error) {
    await deleteContractFile(saved.storageKey).catch(() => undefined);
    throw error;
  }
}

export async function deleteTenantContract(
  db: Database,
  clinicId: string,
  contractId: string,
  platformAdminId: string,
): Promise<void> {
  const deleted = await withTenant(db, clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(tenantContracts)
      .where(
        and(
          eq(tenantContracts.id, contractId),
          eq(tenantContracts.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new AppError(404, "CONTRACT_NOT_FOUND", "Contrato no encontrado");
    }

    await tx
      .delete(tenantContracts)
      .where(eq(tenantContracts.id, contractId));

    return existing;
  });

  await deleteContractFile(deleted.storageKey).catch((error) => {
    console.error("contract_file_delete_failed", error);
  });

  await safeAudit(db, {
    clinicId,
    platformAdminId,
    action: "platform.contract_delete",
    resourceId: contractId,
    after: { name: deleted.name, fileName: deleted.fileName },
  });
}

export async function getTenantContractFile(
  db: Database,
  clinicId: string,
  contractId: string,
): Promise<{
  contract: TenantContract;
  stream: ReturnType<typeof openContractFile>;
}> {
  const contract = await withTenant(db, clinicId, async (tx) => {
    const [row] = await tx
      .select()
      .from(tenantContracts)
      .where(
        and(
          eq(tenantContracts.id, contractId),
          eq(tenantContracts.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, "CONTRACT_NOT_FOUND", "Contrato no encontrado");
    }

    if (!(await contractFileExists(row.storageKey))) {
      throw new AppError(404, "CONTRACT_FILE_NOT_FOUND", "Archivo no encontrado");
    }

    return row;
  });

  return {
    contract: toView(contract),
    stream: openContractFile(contract.storageKey),
  };
}

function toView(row: typeof tenantContracts.$inferSelect): TenantContract {
  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isActive: row.isActive,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function safeAudit(
  db: Database,
  input: {
    clinicId: string;
    platformAdminId: string;
    action: string;
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
      resourceType: "tenant_contract",
      resourceId: input.resourceId,
      after: input.after ?? null,
    });
  } catch {
    // La auditoria es best-effort; no revierte la operacion.
  }
}
