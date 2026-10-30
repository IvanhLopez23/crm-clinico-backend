import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { clinics } from "../db/schema/clinics.js";
import { platformAdmins } from "../db/schema/platform-admins.js";
import { users, type UserRole } from "../db/schema/users.js";
import { withTenant } from "../db/tenant.js";
import { AppError } from "../lib/errors.js";
import { verifyAccessToken } from "../modules/auth/jwt.js";

const PUBLIC_ROUTES: { method: string; path: RegExp }[] = [
  { method: "GET", path: /^\/health$/ },
  { method: "POST", path: /^\/api\/v1\/auth\/login$/ },
  { method: "GET", path: /^\/api\/v1\/availability$/ },
  { method: "POST", path: /^\/api\/v1\/appointments$/ },
  { method: "GET", path: /^\/api\/v1\/public\/clinics\/[^/]+$/ },
  { method: "GET", path: /^\/api\/v1\/public\/clinics\/[^/]+\/availability$/ },
  {
    method: "POST",
    path: /^\/api\/v1\/public\/clinics\/[^/]+\/appointments$/,
  },
];

const TENANT_HEADER_ROUTES = new Set([
  "/api/v1/availability",
  "/api/v1/appointments",
]);

const PLATFORM_ROUTE = /^\/api\/v1\/platform(\/|$)/;
const PLATFORM_ALLOWED = new Set(["/api/v1/auth/me"]);

export function registerAuth(app: FastifyInstance, db: Database): void {
  app.decorateRequest("auth", null);
  app.decorateRequest("platformAdmin", null);
  app.decorateRequest("clinicId", "");

  app.addHook("onRequest", async (request) => {
    const path = (request.url.split("?")[0] ?? "").replace(/\/$/, "") || "/";

    if (path === "/health") return;

    const isPublic = PUBLIC_ROUTES.some(
      (route) => route.method === request.method && route.path.test(path),
    );

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : null;

    // Rutas publicas sin token: el tenant (si aplica) viene del header.
    // Si traen token, se autentican igual y el tenant sale del usuario.
    if (isPublic && !token) {
      if (TENANT_HEADER_ROUTES.has(path)) {
        // Portal publico: el tenant viene del header. En produccion deberia
        // salir de un slug de clinica o de un token de reserva firmado.
        const parsed = z.uuid().safeParse(request.headers["x-clinic-id"]);
        if (!parsed.success) {
          throw new AppError(
            401,
            "TENANT_REQUIRED",
            "Falta x-clinic-id para el portal publico",
          );
        }
        request.clinicId = parsed.data;
      }
      return;
    }

    if (!token) {
      throw new AppError(401, "UNAUTHORIZED", "Falta el token de acceso");
    }

    let payload;
    try {
      payload = await verifyAccessToken(token);
    } catch {
      throw new AppError(401, "INVALID_TOKEN", "Token invalido o expirado");
    }

    if (payload.scope === "platform") {
      if (!PLATFORM_ROUTE.test(path) && !PLATFORM_ALLOWED.has(path)) {
        throw new AppError(
          403,
          "PLATFORM_SCOPE_REQUIRED",
          "Esta sesion es de plataforma; usa el panel de tenants",
        );
      }

      const [admin] = await db
        .select({
          id: platformAdmins.id,
          email: platformAdmins.email,
          fullName: platformAdmins.fullName,
          isActive: platformAdmins.isActive,
        })
        .from(platformAdmins)
        .where(
          and(
            eq(platformAdmins.id, payload.platformAdminId),
            eq(platformAdmins.isActive, true),
          ),
        )
        .limit(1);

      if (!admin) {
        throw new AppError(401, "UNAUTHORIZED", "Administrador inactivo");
      }

      request.platformAdmin = {
        platformAdminId: admin.id,
        email: admin.email,
        fullName: admin.fullName,
      };
      request.auth = null;
      request.clinicId = "";
      return;
    }

    // Se relee el usuario para que desactivar una cuenta tenga efecto inmediato.
    const [user] = await db
      .select({
        id: users.id,
        clinicId: users.clinicId,
        role: users.role,
        practitionerId: users.practitionerId,
        email: users.email,
        fullName: users.fullName,
        avatarData: users.avatarData,
      })
      .from(users)
      .where(and(eq(users.id, payload.userId), eq(users.isActive, true)))
      .limit(1);

    if (!user) {
      throw new AppError(401, "UNAUTHORIZED", "Usuario inactivo");
    }

    const clinic = await withTenant(db, user.clinicId, async (tx) => {
      const [row] = await tx
        .select({ isActive: clinics.isActive })
        .from(clinics)
        .where(eq(clinics.id, user.clinicId))
        .limit(1);
      return row ?? null;
    });

    if (!clinic || !clinic.isActive) {
      throw new AppError(
        403,
        "CLINIC_INACTIVE",
        "La clinica esta suspendida",
      );
    }

    request.auth = {
      userId: user.id,
      clinicId: user.clinicId,
      role: user.role as UserRole,
      practitionerId: user.practitionerId,
      email: user.email,
      fullName: user.fullName,
      avatarData: user.avatarData,
    };
    request.clinicId = user.clinicId;
  });
}
