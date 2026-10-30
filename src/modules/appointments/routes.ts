import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { auditFromRequest } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
import { requirePermission } from "../../lib/require-permission.js";
import { publishRealtime } from "../realtime/bus.js";
import {
  appointmentParams,
  cancelAppointmentBody,
  checkInAppointmentBody,
  confirmAppointmentBody,
  createAppointmentBody,
  listAppointmentsQuery,
  noShowAppointmentBody,
  rescheduleAppointmentBody,
} from "./schema.js";
import {
  bookAppointment,
  cancelAppointment,
  listAppointments,
  rescheduleAppointment,
} from "./service.js";
import {
  listAppointmentHistory,
  transitionAppointment,
} from "./transitions.js";

function practitionerScope(request: FastifyRequest): string | null {
  if (request.auth?.role !== "practitioner") return null;

  if (!request.auth.practitionerId) {
    throw new AppError(
      403,
      "NO_PRACTITIONER_PROFILE",
      "El usuario no tiene especialista asociado",
    );
  }

  return request.auth.practitionerId;
}

function notifyAppointment(
  request: FastifyRequest,
  type: string,
  appointment: { id: string; patientId: string },
  sala = false,
): void {
  publishRealtime(request.clinicId, "agenda", type, {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
  });
  if (sala) {
    publishRealtime(request.clinicId, "sala", type, {
      appointmentId: appointment.id,
      patientId: appointment.patientId,
    });
  }
}

export const appointmentRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  const { db } = opts;

  // Publico (portal) o staff autenticado.
  app.post("/appointments", async (request, reply) => {
    const body = createAppointmentBody.parse(request.body);

    if (request.auth && !can(request.auth.role, "appointments:write")) {
      throw new AppError(403, "FORBIDDEN", "Sin permiso para crear citas");
    }

    const rawKey = request.headers["idempotency-key"];
    let idempotencyKey: string | undefined;

    if (rawKey !== undefined) {
      const parsed = z.uuid().safeParse(rawKey);
      if (!parsed.success) {
        throw new AppError(
          400,
          "INVALID_IDEMPOTENCY_KEY",
          "Idempotency-Key debe ser un UUID",
        );
      }
      idempotencyKey = parsed.data;
    }

    const isStaff = request.auth !== null;

    const appointment = await bookAppointment(db, {
      clinicId: request.clinicId,
      ...body,
      bookedVia: isStaff ? "staff" : "public",
      isOverbooking: isStaff ? body.isOverbooking : false,
      confirm: isStaff ? (body.confirm ?? true) : false,
      ...(isStaff && request.auth
        ? {
            bookedByUserId: request.auth.userId,
            ...(body.isOverbooking
              ? { overbookingApprovedByUserId: request.auth.userId }
              : {}),
          }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    await auditFromRequest(db, request, {
      action: "appointment.create",
      resourceType: "appointment",
      resourceId: appointment.id,
      patientId: appointment.patientId,
      after: appointment,
    });

    notifyAppointment(request, "appointment.created", appointment);

    return reply.code(201).send(appointment);
  });

  app.get(
    "/appointments",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const query = listAppointmentsQuery.parse(request.query);
      const scope = practitionerScope(request);

      return listAppointments(db, {
        clinicId: request.clinicId,
        from: query.from,
        to: query.to,
        ...(scope ?? query.practitionerId
          ? { practitionerId: scope ?? query.practitionerId }
          : {}),
        ...(query.patientId ? { patientId: query.patientId } : {}),
        ...(query.status ? { status: query.status } : {}),
      });
    },
  );

  app.post(
    "/appointments/:id/cancel",
    { preHandler: requirePermission("appointments:write") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const body = cancelAppointmentBody.parse(request.body ?? {});
      const scope = practitionerScope(request);

      const appointment = await cancelAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        reasonCode: body.reasonCode,
        cancelledBy: "staff",
        ...(scope ? { requirePractitionerId: scope } : {}),
      });

      await auditFromRequest(db, request, {
        action: "appointment.cancel",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: appointment,
        reason: body.reasonCode,
      });

      notifyAppointment(request, "appointment.cancelled", appointment, true);

      return appointment;
    },
  );

  app.post(
    "/appointments/:id/reschedule",
    { preHandler: requirePermission("appointments:write") },
    async (request, reply) => {
      const { id } = appointmentParams.parse(request.params);
      const body = rescheduleAppointmentBody.parse(request.body);
      const scope = practitionerScope(request);

      const appointment = await rescheduleAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        ...body,
        bookedVia: "staff",
        cancelledBy: "staff",
        ...(scope ? { requirePractitionerId: scope } : {}),
      });

      await auditFromRequest(db, request, {
        action: "appointment.reschedule",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: appointment,
        reason: `rescheduled_from:${id}`,
      });

      notifyAppointment(request, "appointment.rescheduled", appointment, true);

      return reply.code(201).send(appointment);
    },
  );

  app.get(
    "/appointments/:id/history",
    { preHandler: requirePermission("appointments:read") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      return listAppointmentHistory(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        actor: auth,
      });
    },
  );

  app.post(
    "/appointments/:id/confirm",
    { preHandler: requirePermission("appointments:write") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const body = confirmAppointmentBody.parse(request.body ?? {});
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const appointment = await transitionAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        action: "confirm",
        actor: auth,
        ...(body.channel ? { source: body.channel } : {}),
      });

      await auditFromRequest(db, request, {
        action: "appointment.confirm",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: { id: appointment.id, status: appointment.status },
      });

      notifyAppointment(request, "appointment.confirmed", appointment);

      return appointment;
    },
  );

  app.post(
    "/appointments/:id/check-in",
    { preHandler: requirePermission("appointments:write") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const body = checkInAppointmentBody.parse(request.body ?? {});
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const appointment = await transitionAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        action: "check-in",
        actor: auth,
        ...(body.source ? { source: body.source } : {}),
        ...(body.force ? { force: true } : {}),
      });

      await auditFromRequest(db, request, {
        action: "appointment.check_in",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: {
          id: appointment.id,
          status: appointment.status,
          checkedInAt: appointment.checkedInAt,
        },
      });

      notifyAppointment(request, "appointment.checked_in", appointment, true);

      return appointment;
    },
  );

  app.post(
    "/appointments/:id/room",
    { preHandler: requirePermission("appointments:write") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const appointment = await transitionAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        action: "room",
        actor: auth,
      });

      await auditFromRequest(db, request, {
        action: "appointment.room",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: { id: appointment.id, roomedAt: appointment.roomedAt },
      });

      notifyAppointment(request, "appointment.roomed", appointment, true);

      return appointment;
    },
  );

  app.post(
    "/appointments/:id/start",
    { preHandler: requirePermission("appointments:write") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const appointment = await transitionAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        action: "start",
        actor: auth,
      });

      await auditFromRequest(db, request, {
        action: "appointment.start",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: { id: appointment.id, status: appointment.status },
      });

      notifyAppointment(request, "appointment.started", appointment, true);

      return appointment;
    },
  );

  app.post(
    "/appointments/:id/complete",
    { preHandler: requirePermission("appointments:write") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const appointment = await transitionAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        action: "complete",
        actor: auth,
      });

      await auditFromRequest(db, request, {
        action: "appointment.complete",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: { id: appointment.id, status: appointment.status },
      });

      notifyAppointment(request, "appointment.completed", appointment, true);

      return appointment;
    },
  );

  app.post(
    "/appointments/:id/no-show",
    { preHandler: requirePermission("appointments:write") },
    async (request) => {
      const { id } = appointmentParams.parse(request.params);
      const body = noShowAppointmentBody.parse(request.body ?? {});
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHORIZED", "No autenticado");

      const appointment = await transitionAppointment(db, {
        clinicId: request.clinicId,
        appointmentId: id,
        action: "no-show",
        actor: auth,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.force ? { force: true } : {}),
      });

      await auditFromRequest(db, request, {
        action: "appointment.no_show",
        resourceType: "appointment",
        resourceId: appointment.id,
        patientId: appointment.patientId,
        after: { id: appointment.id, status: appointment.status },
        reason: body.reason ?? null,
      });

      notifyAppointment(request, "appointment.no_show", appointment, true);

      return appointment;
    },
  );
};
