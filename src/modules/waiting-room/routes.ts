import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { requirePermission } from "../../lib/require-permission.js";
import { waitingRoomQuery } from "./schema.js";
import { getWaitingRoom } from "./service.js";

export const waitingRoomRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/waiting-room",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const query = waitingRoomQuery.parse(request.query);
      return getWaitingRoom(db, {
        clinicId: request.clinicId,
        ...(query.date ? { date: query.date } : {}),
        ...(request.auth?.role === "practitioner" && request.auth.practitionerId
          ? { practitionerId: request.auth.practitionerId }
          : {}),
      });
    },
  );
};
