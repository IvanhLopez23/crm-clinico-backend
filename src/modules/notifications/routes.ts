import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requirePermission } from "../../lib/require-permission.js";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./service.js";

const notificationParams = z.object({ id: z.uuid() });

export const notificationRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/notifications",
    { preHandler: requirePermission("appointments:read") },
    async (request) =>
      listNotifications(db, {
        clinicId: request.clinicId,
        userId: request.auth!.userId,
      }),
  );

  app.post(
    "/notifications/read-all",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      await markAllNotificationsRead(db, {
        clinicId: request.clinicId,
        userId: request.auth!.userId,
      });
      return { ok: true };
    },
  );

  app.post(
    "/notifications/:id/read",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const { id } = notificationParams.parse(request.params);
      await markNotificationRead(db, {
        clinicId: request.clinicId,
        userId: request.auth!.userId,
        notificationId: id,
      });
      return { ok: true };
    },
  );
};
