import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import { can, type Permission } from "./permissions.js";

/**
 * Guard de RBAC para `preHandler`. Exige autenticacion y el permiso indicado.
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = request.auth;

    if (!auth) {
      throw new AppError(401, "UNAUTHORIZED", "No autenticado");
    }

    if (!can(auth.role, permission)) {
      throw new AppError(
        403,
        "FORBIDDEN",
        `El rol ${auth.role} no puede ejecutar esta accion`,
      );
    }
  };
}
