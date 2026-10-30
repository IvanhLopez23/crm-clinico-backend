import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { requirePermission } from "../../lib/require-permission.js";
import { publishRealtime } from "../realtime/bus.js";
import {
  createWaitlistBody,
  offerParams,
  offersQuery,
  waitlistQuery,
} from "./schema.js";
import {
  acceptWaitlistOffer,
  cancelWaitlistEntry,
  createWaitlistEntry,
  declineWaitlistOffer,
  listWaitlistEntries,
  listWaitlistOffers,
} from "./service.js";

export const waitlistRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.post(
    "/waitlist",
    { preHandler: requirePermission("waitlist:write") },
    async (request, reply) => {
      const body = createWaitlistBody.parse(request.body);

      const entry = await createWaitlistEntry(db, {
        clinicId: request.clinicId,
        ...body,
      });

      await auditFromRequest(db, request, {
        action: "waitlist.entry_create",
        resourceType: "waitlist_entry",
        resourceId: entry.id,
        patientId: entry.patientId,
        after: entry,
      });

      return reply.code(201).send(entry);
    },
  );

  app.get(
    "/waitlist",
    { preHandler: requirePermission("waitlist:read") },
    async (request) => {
      const query = waitlistQuery.parse(request.query);

      return listWaitlistEntries(db, {
        clinicId: request.clinicId,
        status: query.status,
        practitionerId: query.practitionerId,
      });
    },
  );

  app.delete(
    "/waitlist/:id",
    { preHandler: requirePermission("waitlist:write") },
    async (request, reply) => {
      const { id } = offerParams.parse(request.params);

      const entry = await cancelWaitlistEntry(db, {
        clinicId: request.clinicId,
        id,
      });

      await auditFromRequest(db, request, {
        action: "waitlist.entry_cancel",
        resourceType: "waitlist_entry",
        resourceId: entry.id,
        patientId: entry.patientId,
        after: entry,
      });

      return reply.code(204).send();
    },
  );

  app.get(
    "/waitlist/offers",
    { preHandler: requirePermission("waitlist:read") },
    async (request) => {
      const query = offersQuery.parse(request.query);

      return listWaitlistOffers(db, {
        clinicId: request.clinicId,
        status: query.status,
      });
    },
  );

  app.post(
    "/waitlist/offers/:id/accept",
    { preHandler: requirePermission("waitlist:write") },
    async (request, reply) => {
      const { id } = offerParams.parse(request.params);

      const appointment = await acceptWaitlistOffer(db, {
        clinicId: request.clinicId,
        offerId: id,
        bookedVia: "waitlist",
      });

      await auditFromRequest(db, request, {
        action: "waitlist.offer_accept",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: appointment,
        reason: `offer:${id}`,
      });

      publishRealtime(request.clinicId, "agenda", "appointment.created", {
        appointmentId: appointment.id,
        patientId: appointment.patientId,
      });

      return reply.code(201).send(appointment);
    },
  );

  app.post(
    "/waitlist/offers/:id/decline",
    { preHandler: requirePermission("waitlist:write") },
    async (request) => {
      const { id } = offerParams.parse(request.params);

      const result = await declineWaitlistOffer(db, {
        clinicId: request.clinicId,
        offerId: id,
      });

      await auditFromRequest(db, request, {
        action: "waitlist.offer_decline",
        resourceType: "waitlist_offer",
        resourceId: id,
      });

      return result;
    },
  );
};
