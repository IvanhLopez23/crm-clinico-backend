import { createDatabase } from "../db/client.js";
import { USER_ROLES, users, type UserRole } from "../db/schema/users.js";
import { env } from "../env.js";
import { hashPassword } from "../lib/password.js";

const [clinicId, email, password, roleArg = "admin", practitionerId] =
  process.argv.slice(2);

if (!clinicId || !email || !password) {
  console.error(
    "Uso: npm run user:create -- <clinicId> <email> <password> <admin|practitioner|receptionist> [practitionerId]",
  );
  process.exit(1);
}

if (!USER_ROLES.includes(roleArg as UserRole)) {
  console.error(`Rol invalido. Valores: ${USER_ROLES.join(", ")}`);
  process.exit(1);
}

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;

const { db, pool } = createDatabase(connectionString);

try {
  const [user] = await db
    .insert(users)
    .values({
      clinicId,
      email: email.trim().toLowerCase(),
      passwordHash: hashPassword(password),
      fullName: email,
      role: roleArg as UserRole,
      practitionerId: practitionerId ?? null,
    })
    .returning({ id: users.id, email: users.email, role: users.role });

  console.log(
    JSON.stringify({ event: "user.created", id: user?.id, email: user?.email, role: user?.role }),
  );
} finally {
  await pool.end();
}
