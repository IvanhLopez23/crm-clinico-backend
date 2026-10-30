import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import { loginBody } from "./schema.js";
import { login } from "./service.js";

export const authRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.post("/auth/login", async (request) => {
    const body = loginBody.parse(request.body);

    return login(db, {
      email: body.email,
      password: body.password,
      ip: request.ip,
      ...(request.headers["user-agent"]
        ? { userAgent: request.headers["user-agent"] }
        : {}),
    });
  });

  app.get("/auth/me", async (request) => {
    if (request.platformAdmin) {
      return {
        scope: "platform" as const,
        userId: request.platformAdmin.platformAdminId,
        platformAdminId: request.platformAdmin.platformAdminId,
        email: request.platformAdmin.email,
        fullName: request.platformAdmin.fullName,
        role: "platform_admin" as const,
        avatarData: null,
      };
    }

    if (!request.auth) {
      throw new AppError(401, "UNAUTHORIZED", "No autenticado");
    }

    return { ...request.auth, scope: "tenant" as const };
  });
};
