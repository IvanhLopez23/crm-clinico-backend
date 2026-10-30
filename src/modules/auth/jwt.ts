import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "../../db/schema/users.js";
import { env } from "../../env.js";

const secret = new TextEncoder().encode(env.AUTH_SECRET);

export type TenantTokenPayload = {
  scope: "tenant";
  userId: string;
  clinicId: string;
  role: UserRole;
};

export type PlatformTokenPayload = {
  scope: "platform";
  platformAdminId: string;
};

export type AccessTokenPayload = TenantTokenPayload | PlatformTokenPayload;

export async function signAccessToken(
  payload: Omit<TenantTokenPayload, "scope">,
): Promise<string> {
  return new SignJWT({
    scope: "tenant",
    clinicId: payload.clinicId,
    role: payload.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(env.AUTH_TOKEN_TTL)
    .sign(secret);
}

export async function signPlatformAccessToken(
  payload: Omit<PlatformTokenPayload, "scope">,
): Promise<string> {
  return new SignJWT({ scope: "platform" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.platformAdminId)
    .setIssuedAt()
    .setExpirationTime(env.AUTH_TOKEN_TTL)
    .sign(secret);
}

export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
  });

  if (typeof payload.sub !== "string") {
    throw new Error("invalid_token_payload");
  }

  if (payload.scope === "platform") {
    return { scope: "platform", platformAdminId: payload.sub };
  }

  if (
    typeof payload.clinicId !== "string" ||
    typeof payload.role !== "string"
  ) {
    throw new Error("invalid_token_payload");
  }

  return {
    scope: "tenant",
    userId: payload.sub,
    clinicId: payload.clinicId,
    role: payload.role as UserRole,
  };
}
