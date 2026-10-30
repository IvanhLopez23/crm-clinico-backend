import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlatformAdmin } from "../../src/bootstrap/platform-admin.js";
import { clinics, platformAdmins, users } from "../../src/db/schema/index.js";
import { hashPassword, verifyPassword } from "../../src/lib/password.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let testDb: TestDatabase | undefined;

beforeAll(async () => {
  testDb = await startTestDatabase();
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("bootstrap del superadmin de plataforma", () => {
  it("omite la creacion si faltan credenciales", async () => {
    const result = await ensurePlatformAdmin(testDb!.appDb, {});

    expect(result).toEqual({
      status: "skipped",
      reason: "missing_credentials",
    });
  });

  it("omite la creacion si la contrasena es corta", async () => {
    const result = await ensurePlatformAdmin(testDb!.appDb, {
      email: "platform@test.local",
      password: "short",
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "invalid_credentials",
    });
  });

  it("omite la creacion si el correo ya pertenece a un tenant", async () => {
    const clinicId = randomUUID();

    await testDb!.adminDb.insert(clinics).values({
      id: clinicId,
      name: "Clinica existente",
      timezone: "America/Mexico_City",
    });

    await testDb!.adminDb.insert(users).values({
      clinicId,
      email: "taken@test.local",
      passwordHash: hashPassword("TenantPass123"),
      fullName: "Usuario del tenant",
      role: "admin",
    });

    const result = await ensurePlatformAdmin(testDb!.appDb, {
      email: "taken@test.local",
      password: "PlatformPass123",
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "email_in_use",
    });
  });

  it("crea el admin una sola vez y no cambia la contrasena", async () => {
    const first = await ensurePlatformAdmin(testDb!.appDb, {
      email: "Platform@Test.Local",
      password: "PlatformPass123",
      fullName: "Platform Admin",
    });

    expect(first).toEqual({
      status: "created",
      email: "platform@test.local",
    });

    const [created] = await testDb!.adminDb
      .select()
      .from(platformAdmins)
      .limit(1);

    expect(created?.email).toBe("platform@test.local");
    expect(created?.fullName).toBe("Platform Admin");
    expect(verifyPassword("PlatformPass123", created!.passwordHash)).toBe(true);

    const second = await ensurePlatformAdmin(testDb!.appDb, {
      email: "platform@test.local",
      password: "AnotherPass123",
    });

    expect(second).toEqual({
      status: "exists",
      email: "platform@test.local",
    });

    const rows = await testDb!.adminDb.select().from(platformAdmins);
    expect(rows).toHaveLength(1);
    expect(verifyPassword("AnotherPass123", rows[0]!.passwordHash)).toBe(false);
  });
});
