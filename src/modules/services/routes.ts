import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { requirePermission } from "../../lib/require-permission.js";
import {
  createServiceBody,
  createSpecialtyBody,
  practitionerParams,
  practitionerServiceListQuery,
  practitionerServiceParams,
  serviceListQuery,
  serviceParams,
  updatePractitionerServiceBody,
  updateServiceBody,
  upsertPractitionerServiceBody,
} from "./schema.js";
import {
  createService,
  createSpecialty,
  listServices,
  listSpecialties,
  updateService,
} from "./service.js";
import {
  deletePractitionerService,
  listPractitionerServices,
  updatePractitionerService,
  upsertPractitionerService,
} from "./practitioner-service.js";

export const serviceRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/services",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const query = serviceListQuery.parse(request.query);
      return listServices(db, {
        clinicId: request.clinicId,
        ...(query.active !== undefined ? { active: query.active } : {}),
      });
    },
  );

  app.post(
    "/services",
    { preHandler: requirePermission("settings:write") },
    async (request, reply) => {
      const body = createServiceBody.parse(request.body);
      const service = await createService(db, {
        clinicId: request.clinicId,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "service.create",
        resourceType: "service",
        resourceId: service.id,
        after: { id: service.id, code: service.code },
      });

      return reply.code(201).send(service);
    },
  );

  app.patch(
    "/services/:id",
    { preHandler: requirePermission("settings:write") },
    async (request) => {
      const { id } = serviceParams.parse(request.params);
      const body = updateServiceBody.parse(request.body);
      const service = await updateService(db, {
        clinicId: request.clinicId,
        serviceId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "service.update",
        resourceType: "service",
        resourceId: service.id,
        after: { id: service.id, code: service.code, isActive: service.isActive },
      });

      return service;
    },
  );

  app.get(
    "/practitioner-services",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const query = practitionerServiceListQuery.parse(request.query);
      return listPractitionerServices(db, {
        clinicId: request.clinicId,
        ...(query.practitionerId
          ? { practitionerId: query.practitionerId }
          : {}),
        ...(query.active !== undefined ? { active: query.active } : {}),
      });
    },
  );

  app.post(
    "/practitioners/:id/services",
    { preHandler: requirePermission("settings:write") },
    async (request, reply) => {
      const { id } = practitionerParams.parse(request.params);
      const body = upsertPractitionerServiceBody.parse(request.body);
      const assignment = await upsertPractitionerService(db, {
        clinicId: request.clinicId,
        practitionerId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "practitioner_service.upsert",
        resourceType: "practitioner_service",
        resourceId: assignment.id,
        after: {
          practitionerId: id,
          serviceId: assignment.serviceId,
          durationMinutes: assignment.durationMinutes,
          priceCents: assignment.priceCents,
          isActive: assignment.isActive,
        },
      });

      return reply.code(200).send(assignment);
    },
  );

  app.patch(
    "/practitioner-services/:id",
    { preHandler: requirePermission("settings:write") },
    async (request) => {
      const { id } = practitionerServiceParams.parse(request.params);
      const body = updatePractitionerServiceBody.parse(request.body);
      const assignment = await updatePractitionerService(db, {
        clinicId: request.clinicId,
        assignmentId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "practitioner_service.update",
        resourceType: "practitioner_service",
        resourceId: assignment.id,
        after: {
          durationMinutes: assignment.durationMinutes,
          priceCents: assignment.priceCents,
          isActive: assignment.isActive,
        },
      });

      return assignment;
    },
  );

  app.delete(
    "/practitioner-services/:id",
    { preHandler: requirePermission("settings:write") },
    async (request, reply) => {
      const { id } = practitionerServiceParams.parse(request.params);
      await deletePractitionerService(db, {
        clinicId: request.clinicId,
        assignmentId: id,
      });

      await auditFromRequest(db, request, {
        action: "practitioner_service.delete",
        resourceType: "practitioner_service",
        resourceId: id,
      });

      return reply.code(204).send();
    },
  );

  app.get(
    "/specialties",
    { preHandler: requirePermission("appointments:read") },
    async (request) => listSpecialties(db, { clinicId: request.clinicId }),
  );

  app.post(
    "/specialties",
    { preHandler: requirePermission("settings:write") },
    async (request, reply) => {
      const body = createSpecialtyBody.parse(request.body);
      const specialty = await createSpecialty(db, {
        clinicId: request.clinicId,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "specialty.create",
        resourceType: "specialty",
        resourceId: specialty.id,
        after: { id: specialty.id, code: specialty.code },
      });

      return reply.code(201).send(specialty);
    },
  );
};
