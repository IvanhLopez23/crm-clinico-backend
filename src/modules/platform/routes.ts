import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import {
  clinicParams,
  clinicUserParams,
  createClinicBody,
  createClinicUserBody,
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

export const platformRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

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
};
