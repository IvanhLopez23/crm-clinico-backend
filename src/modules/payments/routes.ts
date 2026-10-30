import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { requirePermission } from "../../lib/require-permission.js";
import { publishRealtime } from "../realtime/bus.js";
import { appointmentParams, checkoutBody } from "./schema.js";
import { checkoutAppointment, getAppointmentPayment } from "./service.js";

export const paymentRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  app.post(
    "/appointments/:id/checkout",
    { preHandler: requirePermission("appointments:write") },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const { id } = appointmentParams.parse(request.params);
      const body = checkoutBody.parse(request.body);
      const result = await checkoutAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        actor: auth,
        input: body,
      });

      await auditFromRequest(db, request, {
        action: "payment.checkout",
        resourceType: "appointment",
        resourceId: id,
        patientId: result.appointment.patientId,
        after: {
          amountCents: result.payment.amountCents,
          method: result.payment.method,
          status: result.appointment.status,
        },
      });

      publishRealtime(request.clinicId, "agenda", "appointment.updated", {
        appointmentId: id,
        patientId: result.appointment.patientId,
      });
      publishRealtime(request.clinicId, "sala", "appointment.updated", {
        appointmentId: id,
      });

      return reply.code(201).send(result);
    },
  );

  app.get(
    "/appointments/:id/payment",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");
      const { id } = appointmentParams.parse(request.params);
      return getAppointmentPayment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        actor: auth,
      });
    },
  );
};
