import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { requirePermission } from "../../lib/require-permission.js";
import { reminderListQuery, reminderParams } from "./schema.js";
import {
  cancelReminderJob,
  listReminderJobs,
  reminderSummary,
  retryReminderJob,
} from "./list-service.js";

export const reminderRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/reminders",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const query = reminderListQuery.parse(request.query);
      return listReminderJobs(db, {
        clinicId: request.clinicId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        limit: query.limit,
      });
    },
  );

  app.get(
    "/reminders/summary",
    { preHandler: requirePermission("appointments:read") },
    async (request) => reminderSummary(db, request.clinicId),
  );

  app.post(
    "/reminders/:id/cancel",
    { preHandler: requirePermission("appointments:write") },
    async (request, reply) => {
      const { id } = reminderParams.parse(request.params);
      await cancelReminderJob(db, { clinicId: request.clinicId, id });
      await auditFromRequest(db, request, {
        action: "reminder.cancel",
        resourceType: "reminder_job",
        resourceId: id,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/reminders/:id/retry",
    { preHandler: requirePermission("appointments:write") },
    async (request, reply) => {
      const { id } = reminderParams.parse(request.params);
      await retryReminderJob(db, { clinicId: request.clinicId, id });
      await auditFromRequest(db, request, {
        action: "reminder.retry",
        resourceType: "reminder_job",
        resourceId: id,
      });
      return reply.code(204).send();
    },
  );
};
