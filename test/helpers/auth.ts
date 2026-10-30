import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db/client.js";
import { users, type UserRole } from "../../src/db/schema/users.js";
import { hashPassword } from "../../src/lib/password.js";
import { signAccessToken } from "../../src/modules/auth/jwt.js";

export const TEST_PASSWORD = "test-password-123";

export type TestUser = {
  id: string;
  email: string;
  password: string;
  token: string;
};

export async function createStaffUser(
  db: Database,
  params: {
    clinicId: string;
    role: UserRole;
    practitionerId?: string | null;
  },
): Promise<TestUser> {
  const email = `${params.role}-${randomUUID()}@example.com`;
  const password = TEST_PASSWORD;

  const [user] = await db
    .insert(users)
    .values({
      clinicId: params.clinicId,
      email,
      passwordHash: hashPassword(password),
      fullName: `Test ${params.role}`,
      role: params.role,
      practitionerId: params.practitionerId ?? null,
    })
    .returning();

  if (!user) throw new Error("no se pudo crear el usuario de prueba");

  const token = await signAccessToken({
    userId: user.id,
    clinicId: user.clinicId,
    role: params.role,
  });

  return { id: user.id, email, password, token };
}
