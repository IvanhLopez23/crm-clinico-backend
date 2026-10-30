import "fastify";
import type { AuthContext } from "../lib/permissions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Tenant resuelto: JWT para staff, header para el portal publico. */
    clinicId: string;
    /** Contexto autenticado; null en rutas publicas o de plataforma. */
    auth: AuthContext | null;
    /** Administrador SaaS; null en sesiones de tenant. */
    platformAdmin: {
      platformAdminId: string;
      email: string;
      fullName: string;
    } | null;
  }
}
