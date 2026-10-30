import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function readKey(envName: string, label: string): Buffer {
  const raw = process.env[envName]?.trim();
  if (raw) {
    const base64 = Buffer.from(raw, "base64");
    if (base64.length === 32) return base64;
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
    // Cualquier otra cadena se deriva; evita fallar por formato en dev.
    return createHash("sha256").update(raw).digest();
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(`${envName} es obligatoria en produccion`);
  }

  const fallback = process.env.AUTH_SECRET ?? "dev-only-insecure-secret";
  return createHash("sha256").update(`${label}:${fallback}`).digest();
}

let encryptionKey: Buffer | undefined;
let indexKey: Buffer | undefined;

function getEncryptionKey(): Buffer {
  encryptionKey ??= readKey("PHI_ENCRYPTION_KEY", "phi-enc");
  return encryptionKey;
}

function getIndexKey(): Buffer {
  indexKey ??= readKey("PHI_INDEX_KEY", "phi-index");
  return indexKey;
}

/**
 * AES-256-GCM. Formato: version(1) || iv(12) || tag(16) || ciphertext.
 * El IV es aleatorio por valor: el mismo telefono produce ciphertext distinto.
 */
export function encryptPhi(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
}

export function decryptPhi(payload: Buffer): string {
  if (payload.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error("phi_ciphertext_invalid");
  }
  if (payload[0] !== VERSION) {
    throw new Error("phi_ciphertext_version_unsupported");
  }

  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(1 + IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return digits;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDocument(value: string): string {
  return value.trim().toUpperCase();
}

/** HMAC-SHA256 determinista para busqueda por igualdad sin exponer el valor. */
export function blindIndex(value: string): string {
  return createHmac("sha256", getIndexKey()).update(value).digest("hex");
}

export function phoneBlindIndex(value: string): string {
  return blindIndex(`phone:${normalizePhone(value)}`);
}

export function emailBlindIndex(value: string): string {
  return blindIndex(`email:${normalizeEmail(value)}`);
}

export function documentBlindIndex(value: string): string {
  return blindIndex(`doc:${normalizeDocument(value)}`);
}

export function maskPhone(value: string): string {
  const normalized = normalizePhone(value);
  const digits = normalized.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  const prefix = normalized.startsWith("+") ? `+${digits.slice(0, 2)}` : "";
  return `${prefix}******${digits.slice(-4)}`;
}

export function maskEmail(value: string): string {
  const normalized = normalizeEmail(value);
  const [local = "", domain = ""] = normalized.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1) || "*"}***@${domain}`;
}

export function maskDocument(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 4) return "****";
  return `****${normalized.slice(-4)}`;
}
