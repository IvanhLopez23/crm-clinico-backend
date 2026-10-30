import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { requirePermission } from "../../lib/require-permission.js";
import {
  createUserBody,
  updateOwnUserBody,
  updateUserBody,
  userParams,
} from "./schema.js";
import {
  createUser,
  deactivateUser,
  listUsers,
  updateOwnUser,
  updateUser,
} from "./service.js";

export const userRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/users",
    { preHandler: requirePermission("users:manage") },
    async (request) => listUsers(db, request.clinicId),
  );

  app.patch("/users/me", async (request) => {
    const auth = request.auth;
    if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");
    const body = updateOwnUserBody.parse(request.body);
    const user = await updateOwnUser(db, {
      clinicId: request.clinicId,
      userId: auth.userId,
      input: body,
    });

    await auditFromRequest(db, request, {
      action: "user.update_self",
      resourceType: "user",
      resourceId: user.id,
      after: { id: user.id, fullName: user.fullName, email: user.email },
    });

    return user;
  });

  app.post(
    "/users",
    { preHandler: requirePermission("users:manage") },
    async (request, reply) => {
      const body = createUserBody.parse(request.body);
      const user = await createUser(db, {
        clinicId: request.clinicId,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "user.create",
        resourceType: "user",
        resourceId: user.id,
        after: {
          id: user.id,
          email: user.email,
          role: user.role,
          isActive: user.isActive,
        },
      });

      return reply.code(201).send(user);
    },
  );

  app.patch(
    "/users/:id",
    { preHandler: requirePermission("users:manage") },
    async (request) => {
      const { id } = userParams.parse(request.params);
      const body = updateUserBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const user = await updateUser(db, {
        clinicId: request.clinicId,
        userId: id,
        actorUserId: auth.userId,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "user.update",
        resourceType: "user",
        resourceId: user.id,
        after: {
          id: user.id,
          email: user.email,
          role: user.role,
          isActive: user.isActive,
        },
      });

      return user;
    },
  );

  app.delete(
    "/users/:id",
    { preHandler: requirePermission("users:manage") },
    async (request, reply) => {
      const { id } = userParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      await deactivateUser(db, {
        clinicId: request.clinicId,
        userId: id,
        actorUserId: auth.userId,
      });

      await auditFromRequest(db, request, {
        action: "user.deactivate",
        resourceType: "user",
        resourceId: id,
      });

      return reply.code(204).send();
    },
  );
};
