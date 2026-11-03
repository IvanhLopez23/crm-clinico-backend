import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Database } from "./db/client.js";
import { AppError } from "./lib/errors.js";
import { pgErrorCode } from "./lib/pg-error.js";
import { registerAuth } from "./plugins/auth.js";
import { appointmentRoutes } from "./modules/appointments/routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { availabilityRoutes } from "./modules/availability/routes.js";
import { clinicRoutes } from "./modules/clinic/routes.js";
import { patientRoutes } from "./modules/patients/routes.js";
import { paymentRoutes } from "./modules/payments/routes.js";
import { platformRoutes } from "./modules/platform/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { publicRoutes } from "./modules/public/routes.js";
import { realtimeRoutes } from "./modules/realtime/routes.js";
import { reminderRoutes } from "./modules/reminders/routes.js";
import { serviceRoutes } from "./modules/services/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { waitlistRoutes } from "./modules/waitlist/routes.js";
import { waitingRoomRoutes } from "./modules/waiting-room/routes.js";

export type BuildAppOptions = {
  db: Database;
  logger?: boolean;
};

export function buildApp({ db, logger = true }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: logger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              'res.headers["set-cookie"]',
              "*.phoneE164",
              "*.email",
              "*.firstName",
              "*.lastName",
              "*.notesInternal",
              "*.passwordHash",
            ],
            censor: "[redacted]",
          },
        }
      : false,
  });

  // Debe registrarse antes que las rutas: el hook resuelve auth y tenant.
  registerAuth(app, db);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Payload invalido",
          requestId: request.id,
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          details: error.details,
        },
      });
    }

    // Red de seguridad si un error de constraint escapa del servicio.
    if (pgErrorCode(error) === "23P01") {
      return reply.code(409).send({
        error: {
          code: "SLOT_TAKEN",
          message: "El horario ya no esta disponible",
          requestId: request.id,
        },
      });
    }

    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === "number" ? rawStatus : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled_error");
    }

    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
        message:
          statusCode >= 500 ? "Error inesperado" : "Solicitud invalida",
        requestId: request.id,
      },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.register(authRoutes, { prefix: "/api/v1", db });
  app.register(auditRoutes, { prefix: "/api/v1", db });
  app.register(appointmentRoutes, { prefix: "/api/v1", db });
  app.register(availabilityRoutes, { prefix: "/api/v1", db });
  app.register(waitlistRoutes, { prefix: "/api/v1", db });
  app.register(clinicRoutes, { prefix: "/api/v1", db });
  app.register(patientRoutes, { prefix: "/api/v1", db });
  app.register(notificationRoutes, { prefix: "/api/v1", db });
  app.register(paymentRoutes, { prefix: "/api/v1", db });
  app.register(platformRoutes, { prefix: "/api/v1", db });
  app.register(publicRoutes, { prefix: "/api/v1", db });
  app.register(serviceRoutes, { prefix: "/api/v1", db });
  app.register(waitingRoomRoutes, { prefix: "/api/v1", db });
  app.register(reminderRoutes, { prefix: "/api/v1", db });
  app.register(realtimeRoutes, { prefix: "/api/v1", db });
  app.register(userRoutes, { prefix: "/api/v1", db });

  return app;
}
