import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { listAuditEvents } from "../../lib/audit.js";
import { requirePermission } from "../../lib/require-permission.js";

const isoDateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const auditQuery = z.object({
  action: z.string().min(1).max(120).optional(),
  patientId: z.uuid().optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const auditRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/audit",
    { preHandler: requirePermission("audit:read") },
    async (request) => {
      const query = auditQuery.parse(request.query);

      return listAuditEvents(db, {
        clinicId: request.clinicId,
        ...query,
      });
    },
  );
};
