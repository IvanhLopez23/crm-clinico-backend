import { eq } from "drizzle-orm";
import { createDatabase } from "../db/client.js";
import { platformAdmins } from "../db/schema/platform-admins.js";
import { users } from "../db/schema/users.js";
import { env } from "../env.js";
import { hashPassword } from "../lib/password.js";

const [email, password, fullName = "Administrador de plataforma"] =
  process.argv.slice(2);

if (!email || !password) {
  console.error(
    "Uso: pnpm platform:admin <email> <password> [nombre]",
  );
  process.exit(1);
}

if (password.length < 8) {
  console.error("La contrasena debe tener al menos 8 caracteres.");
  process.exit(1);
}

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;

const { db, pool } = createDatabase(connectionString);

try {
  const normalizedEmail = email.trim().toLowerCase();
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existingUser) {
    console.error("Ese correo ya pertenece a un usuario de un tenant.");
    process.exit(1);
  }

  const [admin] = await db
    .insert(platformAdmins)
    .values({
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      fullName,
    })
    .returning({
      id: platformAdmins.id,
      email: platformAdmins.email,
      fullName: platformAdmins.fullName,
    });

  console.log(JSON.stringify({ event: "platform_admin.created", ...admin }));
} finally {
  await pool.end();
}
