import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { requirePermission } from "../../lib/require-permission.js";
import {
  allergyParams,
  assignTagBody,
  createAllergyBody,
  createHouseholdBody,
  createPatientBody,
  createTagBody,
  guardianBody,
  guardianParams,
  patientParams,
  patientSearchQuery,
  patientTagParams,
  updateAllergyBody,
  updatePatientBody,
} from "./schema.js";
import {
  addGuardian,
  assignTag,
  createAllergy,
  createHousehold,
  createPatient,
  createTag,
  getHousehold,
  getPatient,
  listAllergies,
  listTags,
  removeTag,
  searchPatients,
  updateAllergy,
  updatePatient,
} from "./service.js";

export const patientRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get(
    "/patients",
    { preHandler: requirePermission("patients:read") },
    async (request) => {
      const query = patientSearchQuery.parse(request.query);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      return searchPatients(db, {
        actor: auth,
        q: query.q,
        limit: query.limit,
      });
    },
  );

  app.post(
    "/patients",
    { preHandler: requirePermission("patients:write") },
    async (request, reply) => {
      const body = createPatientBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const patient = await createPatient(db, { actor: auth, input: body });

      await auditFromRequest(db, request, {
        action: "patient.create",
        resourceType: "patient",
        resourceId: patient.id,
        patientId: patient.id,
        after: { id: patient.id, householdId: patient.householdId },
      });

      return reply.code(201).send(patient);
    },
  );

  app.get(
    "/patients/:id",
    { preHandler: requirePermission("patients:read") },
    async (request) => {
      const { id } = patientParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      return getPatient(db, { actor: auth, patientId: id });
    },
  );

  app.patch(
    "/patients/:id",
    { preHandler: requirePermission("patients:write") },
    async (request) => {
      const { id } = patientParams.parse(request.params);
      const body = updatePatientBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const patient = await updatePatient(db, {
        actor: auth,
        patientId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "patient.update",
        resourceType: "patient",
        resourceId: patient.id,
        patientId: patient.id,
        after: { id: patient.id, householdId: patient.householdId },
      });

      return patient;
    },
  );

  app.post(
    "/households",
    { preHandler: requirePermission("patients:write") },
    async (request, reply) => {
      const body = createHouseholdBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const household = await createHousehold(db, { actor: auth, input: body });

      await auditFromRequest(db, request, {
        action: "household.create",
        resourceType: "household",
        resourceId: household.id,
        after: { id: household.id },
      });

      return reply.code(201).send(household);
    },
  );

  app.get(
    "/households/:id",
    { preHandler: requirePermission("patients:read") },
    async (request) => {
      const { id } = patientParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      return getHousehold(db, { actor: auth, householdId: id });
    },
  );

  app.post(
    "/patients/:id/guardians",
    { preHandler: requirePermission("patients:write") },
    async (request, reply) => {
      const { id } = guardianParams.parse(request.params);
      const body = guardianBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const guardian = await addGuardian(db, {
        actor: auth,
        patientId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "guardian.create",
        resourceType: "patient_guardian",
        resourceId: guardian.id,
        patientId: id,
        after: { id: guardian.id, relationship: guardian.relationship },
      });

      return reply.code(201).send(guardian);
    },
  );

  app.get(
    "/patients/:id/allergies",
    { preHandler: requirePermission("patients:read") },
    async (request) => {
      const { id } = patientParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      return listAllergies(db, { actor: auth, patientId: id });
    },
  );

  app.post(
    "/patients/:id/allergies",
    { preHandler: requirePermission("clinical:write") },
    async (request, reply) => {
      const { id } = patientParams.parse(request.params);
      const body = createAllergyBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const allergy = await createAllergy(db, {
        actor: auth,
        patientId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "allergy.create",
        resourceType: "patient_allergy",
        resourceId: allergy.id,
        patientId: id,
        after: { id: allergy.id, severity: allergy.severity },
      });

      return reply.code(201).send(allergy);
    },
  );

  app.patch(
    "/allergies/:id",
    { preHandler: requirePermission("clinical:write") },
    async (request) => {
      const { id } = allergyParams.parse(request.params);
      const body = updateAllergyBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const allergy = await updateAllergy(db, {
        actor: auth,
        allergyId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "allergy.update",
        resourceType: "patient_allergy",
        resourceId: allergy.id,
        after: { id: allergy.id, severity: allergy.severity },
      });

      return allergy;
    },
  );

  app.get(
    "/tags",
    { preHandler: requirePermission("patients:read") },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");
      return listTags(db, { actor: auth });
    },
  );

  app.post(
    "/tags",
    { preHandler: requirePermission("settings:write") },
    async (request, reply) => {
      const body = createTagBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const tag = await createTag(db, { actor: auth, input: body });

      await auditFromRequest(db, request, {
        action: "tag.create",
        resourceType: "tag",
        resourceId: tag.id,
        after: { id: tag.id, code: tag.code },
      });

      return reply.code(201).send(tag);
    },
  );

  app.post(
    "/patients/:id/tags",
    { preHandler: requirePermission("patients:write") },
    async (request, reply) => {
      const { id } = patientParams.parse(request.params);
      const body = assignTagBody.parse(request.body);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      const tag = await assignTag(db, {
        actor: auth,
        patientId: id,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "patient.tag_assign",
        resourceType: "patient_tag",
        resourceId: `${id}:${tag.id}`,
        patientId: id,
        after: { tagId: tag.id, code: tag.code, severity: tag.severity },
      });

      return reply.code(201).send(tag);
    },
  );

  app.delete(
    "/patients/:id/tags/:tagId",
    { preHandler: requirePermission("patients:write") },
    async (request, reply) => {
      const { id, tagId } = patientTagParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new Error("auth requerido");

      await removeTag(db, { actor: auth, patientId: id, tagId });

      await auditFromRequest(db, request, {
        action: "patient.tag_remove",
        resourceType: "patient_tag",
        resourceId: `${id}:${tagId}`,
        patientId: id,
      });

      return reply.code(204).send();
    },
  );
};
