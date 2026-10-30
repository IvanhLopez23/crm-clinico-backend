type PgLikeError = {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
};

/** Drizzle puede envolver el error original en DrizzleQueryError.cause. */
export function pgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as PgLikeError;
  if (typeof e.code === "string") return e.code;
  return e.cause !== undefined ? pgErrorCode(e.cause) : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as PgLikeError;
  if (typeof e.constraint === "string") return e.constraint;
  return e.cause !== undefined ? pgConstraint(e.cause) : undefined;
}
