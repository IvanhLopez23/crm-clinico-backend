import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");

  if (scheme !== "scrypt" || !salt || !hash) return false;

  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);

  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

let dummyHash: string | null = null;

/**
 * Verificacion contra un hash descartable cuando el email no existe: mantiene
 * un costo de tiempo similar y evita enumerar usuarios.
 */
export function verifyAgainstDummy(password: string): boolean {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  return verifyPassword(password, dummyHash);
}
