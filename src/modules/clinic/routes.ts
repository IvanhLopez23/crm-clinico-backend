import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { requirePermission } from "../../lib/require-permission.js";
import {
  createPractitioner,
  getClinic,
  listPractitioners,
  updatePractitioner,
} from "./service.js";

const practitionerParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

const createBody = z.object({
  fullName: z.string().trim().min(1).max(160),
  specialty: z.string().trim().max(120).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  defaultSlotMinutes: z.coerce.number().int().min(5).max(120).optional(),
  bufferBeforeMinutes: z.coerce.number().int().min(0).max(120).optional(),
  bufferAfterMinutes: z.coerce.number().int().min(0).max(120).optional(),
  isAcceptingNewPatients: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const updateBody = createBody.partial();

export const clinicRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/clinic",
    { preHandler: requirePermission("clinic:read") },
    async (request) => getClinic(db, request.clinicId),
  );

  app.get(
    "/practitioners",
    { preHandler: requirePermission("clinic:read") },
    async (request) => {
      const query = listQuery.parse(request.query);
      return listPractitioners(db, request.clinicId, {
        includeInactive: query.includeInactive ?? false,
        ...(request.auth?.role === "practitioner" && request.auth.practitionerId
          ? { practitionerId: request.auth.practitionerId }
          : {}),
      });
    },
  );

  app.post(
    "/practitioners",
    { preHandler: requirePermission("settings:write") },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const practitioner = await createPractitioner(
        db,
        request.clinicId,
        body,
      );

      await auditFromRequest(db, request, {
        action: "practitioner.create",
        resourceType: "practitioner",
        resourceId: practitioner.id,
        after: {
          id: practitioner.id,
          fullName: practitioner.fullName,
          specialty: practitioner.specialty,
        },
      });

      return reply.code(201).send(practitioner);
    },
  );

  app.patch(
    "/practitioners/:id",
    { preHandler: requirePermission("settings:write") },
    async (request) => {
      const { id } = practitionerParams.parse(request.params);
      const body = updateBody.parse(request.body);
      const practitioner = await updatePractitioner(
        db,
        request.clinicId,
        id,
        body,
      );

      await auditFromRequest(db, request, {
        action: "practitioner.update",
        resourceType: "practitioner",
        resourceId: practitioner.id,
        after: {
          id: practitioner.id,
          fullName: practitioner.fullName,
          isActive: practitioner.isActive,
        },
      });

      return practitioner;
    },
  );
};
