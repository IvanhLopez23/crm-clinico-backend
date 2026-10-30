import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import {
  publicAvailabilityQuery,
  publicBookingBody,
  publicSlugParams,
} from "./schema.js";
import {
  bookPublicAppointment,
  getPublicAvailability,
  getPublicClinic,
} from "./service.js";

export const publicRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.get("/public/clinics/:slug", async (request) => {
    const { slug } = publicSlugParams.parse(request.params);
    return getPublicClinic(db, slug);
  });

  app.get("/public/clinics/:slug/availability", async (request) => {
    const { slug } = publicSlugParams.parse(request.params);
    const query = publicAvailabilityQuery.parse(request.query);
    return getPublicAvailability(db, { slug, ...query });
  });

  app.post("/public/clinics/:slug/appointments", async (request, reply) => {
    const { slug } = publicSlugParams.parse(request.params);
    const body = publicBookingBody.parse(request.body);
    const appointment = await bookPublicAppointment(db, {
      slug,
      input: body,
    });
    return reply.code(201).send(appointment);
  });
};
