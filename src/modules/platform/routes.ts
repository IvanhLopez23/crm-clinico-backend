import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import {
  clinicParams,
  clinicUserParams,
  contractParams,
  createClinicBody,
  createClinicUserBody,
  createContractFields,
  updateClinicBody,
  updateClinicUserBody,
} from "./schema.js";
import {
  createTenant,
  createTenantUser,
  getTenant,
  listTenants,
  updateTenant,
  updateTenantUser,
} from "./service.js";
import {
  createTenantContract,
  deleteTenantContract,
  getTenantContractFile,
  listTenantContracts,
} from "./contracts.js";

function requirePlatformAdmin(request: FastifyRequest) {
  if (!request.platformAdmin) {
    throw new AppError(
      403,
      "PLATFORM_ADMIN_REQUIRED",
      "Se requiere una sesion de administrador de plataforma",
    );
  }
  return request.platformAdmin;
}

function multipartErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export const platformRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 20,
    },
  });

  app.get("/platform/clinics", async (request) => {
    requirePlatformAdmin(request);
    return listTenants(db);
  });

  app.post("/platform/clinics", async (request, reply) => {
    const admin = requirePlatformAdmin(request);
    const body = createClinicBody.parse(request.body);
    const tenant = await createTenant(db, body, admin.platformAdminId);
    return reply.code(201).send(tenant);
  });

  app.get("/platform/clinics/:id", async (request) => {
    requirePlatformAdmin(request);
    const { id } = clinicParams.parse(request.params);
    return getTenant(db, id);
  });

  app.patch("/platform/clinics/:id", async (request) => {
    const admin = requirePlatformAdmin(request);
    const { id } = clinicParams.parse(request.params);
    const body = updateClinicBody.parse(request.body);
    return updateTenant(db, id, body, admin.platformAdminId);
  });

  app.post("/platform/clinics/:id/users", async (request, reply) => {
    const admin = requirePlatformAdmin(request);
    const { id } = clinicParams.parse(request.params);
    const body = createClinicUserBody.parse(request.body);
    const user = await createTenantUser(db, id, body, admin.platformAdminId);
    return reply.code(201).send(user);
  });

  app.patch("/platform/clinics/:id/users/:userId", async (request) => {
    const admin = requirePlatformAdmin(request);
    const { id, userId } = clinicUserParams.parse(request.params);
    const body = updateClinicUserBody.parse(request.body);
    return updateTenantUser(db, id, userId, body, admin.platformAdminId);
  });

  app.get("/platform/clinics/:id/contracts", async (request) => {
    requirePlatformAdmin(request);
    const { id } = clinicParams.parse(request.params);
    return listTenantContracts(db, id);
  });

  app.post("/platform/clinics/:id/contracts", async (request, reply) => {
    const admin = requirePlatformAdmin(request);
    const { id } = clinicParams.parse(request.params);

    const fields: Record<string, string> = {};
    let fileBuffer: Buffer | null = null;
    let fileName = "contrato";
    let mimeType = "application/octet-stream";

    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (fileBuffer) {
            throw new AppError(
              400,
              "TOO_MANY_FILES",
              "Adjunta un solo archivo de contrato",
            );
          }
          fileName = part.filename || "contrato";
          mimeType = part.mimetype;
          fileBuffer = await part.toBuffer();
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (error) {
      const code = multipartErrorCode(error);
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        throw new AppError(
          413,
          "CONTRACT_FILE_TOO_LARGE",
          "El archivo supera el limite de 10 MB",
        );
      }
      if (code === "FST_FILES_LIMIT") {
        throw new AppError(
          400,
          "TOO_MANY_FILES",
          "Adjunta un solo archivo de contrato",
        );
      }
      throw error;
    }

    if (!fileBuffer) {
      throw new AppError(
        400,
        "CONTRACT_FILE_REQUIRED",
        "Adjunta el archivo del contrato",
      );
    }

    const body = createContractFields.parse(fields);
    const contract = await createTenantContract(
      db,
      id,
      { ...body, fileName, mimeType, buffer: fileBuffer },
      admin.platformAdminId,
    );

    return reply.code(201).send(contract);
  });

  app.get(
    "/platform/clinics/:id/contracts/:contractId/file",
    async (request, reply) => {
      requirePlatformAdmin(request);
      const { id, contractId } = contractParams.parse(request.params);
      const { contract, stream } = await getTenantContractFile(
        db,
        id,
        contractId,
      );

      reply.header("content-type", contract.mimeType);
      reply.header(
        "content-disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(contract.fileName)}`,
      );

      return reply.send(stream);
    },
  );

  app.delete(
    "/platform/clinics/:id/contracts/:contractId",
    async (request, reply) => {
      const admin = requirePlatformAdmin(request);
      const { id, contractId } = contractParams.parse(request.params);
      await deleteTenantContract(db, id, contractId, admin.platformAdminId);
      return reply.code(204).send();
    },
  );
};
