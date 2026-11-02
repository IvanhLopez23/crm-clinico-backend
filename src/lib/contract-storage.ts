import { createReadStream, type ReadStream } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(
  process.env.CONTRACTS_DIR ?? path.join(process.cwd(), "uploads", "contracts"),
);

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
};

export const MAX_CONTRACT_BYTES = 10 * 1024 * 1024;

export function isContractMimeType(mimeType: string): boolean {
  return Object.hasOwn(EXTENSIONS, mimeType);
}

export async function saveContractFile(
  clinicId: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ storageKey: string; sizeBytes: number }> {
  const extension = Object.hasOwn(EXTENSIONS, mimeType)
    ? EXTENSIONS[mimeType]
    : undefined;
  if (!extension) {
    throw new Error("unsupported_contract_mime_type");
  }

  const storageKey = path.posix.join(
    clinicId,
    `${randomUUID()}${extension}`,
  );
  const filePath = resolveStoragePath(storageKey);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer, { flag: "wx" });

  return { storageKey, sizeBytes: buffer.length };
}

export async function contractFileExists(storageKey: string): Promise<boolean> {
  try {
    await access(resolveStoragePath(storageKey));
    return true;
  } catch {
    return false;
  }
}

export function openContractFile(storageKey: string): ReadStream {
  return createReadStream(resolveStoragePath(storageKey));
}

export async function deleteContractFile(storageKey: string): Promise<void> {
  try {
    await unlink(resolveStoragePath(storageKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function resolveStoragePath(storageKey: string): string {
  const resolved = path.resolve(ROOT, storageKey);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("invalid_contract_storage_key");
  }
  return resolved;
}
