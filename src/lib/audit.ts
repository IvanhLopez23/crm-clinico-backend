import { createHash } from "node:crypto";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { auditEvents } from "../db/schema/audit-events.js";
import type { UserRole } from "../db/schema/users.js";
import { withTenant } from "../db/tenant.js";

export type AuditActorType = "user" | "public" | "system" | "platform_admin";

export type AuditInput = {
  clinicId: string;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorRole?: UserRole | "platform_admin" | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  patientId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

/**
 * Escribe un evento append-only. El hash encadena el evento anterior del
 * mismo tenant; un advisory lock serializa la cadena por clinica.
 */
export async function recordAudit(
  db: Database,
  input: AuditInput,
): Promise<void> {
  const before = normalize(input.before);
  const after = normalize(input.after);

  await withTenant(db, input.clinicId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`audit:${input.clinicId}`}))`,
    );

    const [last] = await tx
      .select({ hash: auditEvents.hash })
      .from(auditEvents)
      .orderBy(desc(auditEvents.seq))
      .limit(1);

    const createdAt = new Date();

    const payload = {
      clinicId: input.clinicId,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      patientId: input.patientId ?? null,
      before,
      after,
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      createdAt: createdAt.toISOString(),
    };

    const hash = createHash("sha256")
      .update((last?.hash ?? "") + JSON.stringify(payload))
      .digest("hex");

    await tx.insert(auditEvents).values({
      ...payload,
      prevHash: last?.hash ?? null,
      hash,
      createdAt,
    });
  });
}

export type ListAuditParams = {
  clinicId: string;
  action?: string;
  patientId?: string;
  from?: Date;
  to?: Date;
  limit: number;
};

export async function listAuditEvents(
  db: Database,
  params: ListAuditParams,
): Promise<(typeof auditEvents.$inferSelect)[]> {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(
        and(
          params.action ? eq(auditEvents.action, params.action) : undefined,
          params.patientId
            ? eq(auditEvents.patientId, params.patientId)
            : undefined,
          params.from ? gte(auditEvents.createdAt, params.from) : undefined,
          params.to ? lte(auditEvents.createdAt, params.to) : undefined,
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(params.limit),
  );
}

function normalize(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export type AuditActionInput = {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  patientId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
};

/**
 * Auditoria desde la capa HTTP. Es best-effort: si falla, se loguea y la
 * operacion ya confirmada no se revierte (ver limitaciones en README).
 */
export async function auditFromRequest(
  db: Database,
  request: FastifyRequest,
  input: AuditActionInput,
): Promise<void> {
  try {
    await recordAudit(db, {
      clinicId: request.clinicId,
      actorType: request.auth ? "user" : "public",
      actorUserId: request.auth?.userId ?? null,
      actorRole: request.auth?.role ?? null,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      requestId: request.id,
      ...input,
    });
  } catch (err) {
    request.log.error({ err }, "audit_write_failed");
  }
}
