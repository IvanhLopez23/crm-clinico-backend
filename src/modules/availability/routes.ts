import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { requirePermission } from "../../lib/require-permission.js";
import {
  availabilityQuery,
  blockParams,
  blocksQuery,
  createBlockBody,
  createRuleBody,
  createWeeklyRulesBody,
  practitionerQuery,
  ruleParams,
  updateRuleBody,
} from "./schema.js";
import {
  createAvailabilityRule,
  createScheduleBlock,
  createWeeklyRules,
  deleteAvailabilityRule,
  deleteScheduleBlock,
  getAvailability,
  listAvailabilityRules,
  listScheduleBlocks,
  updateAvailabilityRule,
} from "./service.js";

function assertOwnPractitioner(
  request: FastifyRequest,
  practitionerId: string,
): void {
  if (request.auth?.role !== "practitioner") return;

  if (request.auth.practitionerId !== practitionerId) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Solo puede modificar su propia agenda",
    );
  }
}

export const availabilityRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  // Publico: es la consulta de slots del portal.
  app.get("/availability", async (request) => {
    const query = availabilityQuery.parse(request.query);
    return getAvailability(db, { clinicId: request.clinicId, ...query });
  });

  app.get(
    "/availability/rules",
    { preHandler: requirePermission("availability:read") },
    async (request) => {
      const { practitionerId } = practitionerQuery.parse(request.query);
      assertOwnPractitioner(request, practitionerId);
      return listAvailabilityRules(db, {
        clinicId: request.clinicId,
        practitionerId,
      });
    },
  );

  app.post(
    "/availability/rules",
    { preHandler: requirePermission("availability:write") },
    async (request, reply) => {
      const body = createRuleBody.parse(request.body);
      assertOwnPractitioner(request, body.practitionerId);

      const rule = await createAvailabilityRule(db, {
        clinicId: request.clinicId,
        ...body,
      });

      await auditFromRequest(db, request, {
        action: "availability.rule_create",
        resourceType: "availability_rule",
        resourceId: rule.id,
        after: rule,
      });

      return reply.code(201).send(rule);
    },
  );

  app.post(
    "/availability/rules/bulk",
    { preHandler: requirePermission("availability:write") },
    async (request, reply) => {
      const body = createWeeklyRulesBody.parse(request.body);
      assertOwnPractitioner(request, body.practitionerId);

      const rules = await createWeeklyRules(db, {
        clinicId: request.clinicId,
        ...body,
      });

      await auditFromRequest(db, request, {
        action: "availability.weekly_create",
        resourceType: "availability_rule",
        resourceId: rules[0]?.id ?? null,
        after: {
          weekdays: body.weekdays,
          startTime: body.startTime,
          endTime: body.endTime,
          lunchStart: body.lunchStart ?? null,
          lunchEnd: body.lunchEnd ?? null,
          rules: rules.length,
        },
      });

      return reply.code(201).send({ rules });
    },
  );

  app.patch(
    "/availability/rules/:id",
    { preHandler: requirePermission("availability:write") },
    async (request) => {
      const { id } = ruleParams.parse(request.params);
      const body = updateRuleBody.parse(request.body);

      const rule = await updateAvailabilityRule(db, {
        clinicId: request.clinicId,
        ruleId: id,
        ...body,
        requirePractitionerId:
          request.auth?.role === "practitioner"
            ? request.auth.practitionerId
            : null,
      });

      await auditFromRequest(db, request, {
        action: "availability.rule_update",
        resourceType: "availability_rule",
        resourceId: rule.id,
        after: rule,
      });

      return rule;
    },
  );

  app.delete(
    "/availability/rules/:id",
    { preHandler: requirePermission("availability:write") },
    async (request, reply) => {
      const { id } = ruleParams.parse(request.params);

      await deleteAvailabilityRule(db, {
        clinicId: request.clinicId,
        ruleId: id,
        requirePractitionerId:
          request.auth?.role === "practitioner"
            ? request.auth.practitionerId
            : null,
      });

      await auditFromRequest(db, request, {
        action: "availability.rule_delete",
        resourceType: "availability_rule",
        resourceId: id,
      });

      return reply.code(204).send();
    },
  );

  app.get(
    "/availability/blocks",
    { preHandler: requirePermission("availability:read") },
    async (request) => {
      const query = blocksQuery.parse(request.query);
      assertOwnPractitioner(request, query.practitionerId);
      return listScheduleBlocks(db, {
        clinicId: request.clinicId,
        ...query,
      });
    },
  );

  app.post(
    "/availability/blocks",
    { preHandler: requirePermission("availability:write") },
    async (request, reply) => {
      const body = createBlockBody.parse(request.body);
      assertOwnPractitioner(request, body.practitionerId);

      const block = await createScheduleBlock(db, {
        clinicId: request.clinicId,
        ...body,
      });

      await auditFromRequest(db, request, {
        action: "availability.block_create",
        resourceType: "schedule_block",
        resourceId: block.id,
        after: block,
      });

      return reply.code(201).send(block);
    },
  );

  app.delete(
    "/availability/blocks/:id",
    { preHandler: requirePermission("availability:write") },
    async (request, reply) => {
      const { id } = blockParams.parse(request.params);

      await deleteScheduleBlock(db, {
        clinicId: request.clinicId,
        id,
        requirePractitionerId:
          request.auth?.role === "practitioner"
            ? request.auth.practitionerId
            : null,
      });

      await auditFromRequest(db, request, {
        action: "availability.block_delete",
        resourceType: "schedule_block",
        resourceId: id,
      });

      return reply.code(204).send();
    },
  );
};
