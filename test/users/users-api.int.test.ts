import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import * as schema from "../../src/db/schema/index.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let testDb: TestDatabase | undefined;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let adminId: string;
let receptionToken: string;
let receptionEmail: string;
let clinicId: string;
let practitionerId: string;
let createdUserId: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = buildApp({ db: testDb.appDb, logger: false });

  clinicId = randomUUID();
  practitionerId = randomUUID();

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Configuracion",
    timezone: "America/Mexico_City",
  });
  await testDb.adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Config",
  });

  const admin = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "admin",
  });
  const reception = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  adminToken = admin.token;
  adminId = admin.id;
  receptionToken = reception.token;
  receptionEmail = reception.email;
}, 300_000);

afterAll(async () => {
  await app.close();
  await testDb?.close();
}, 60_000);

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("configuracion de usuarios", () => {
  it("solo admin lista usuarios", async () => {
    const admin = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: headers(adminToken),
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().length).toBeGreaterThanOrEqual(2);

    const reception = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: headers(receptionToken),
    });
    expect(reception.statusCode).toBe(403);
  });

  it("crea un usuario y permite iniciar sesion con su password", async () => {
    const avatarData = "data:image/png;base64,iVBORw0KGgo=";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: headers(adminToken),
      payload: {
        email: "nueva@clinica.com",
        password: "PasswordSegura123",
        fullName: "Nueva Recepcion",
        avatarData,
        role: "receptionist",
      },
    });

    expect(response.statusCode).toBe(201);
    createdUserId = response.json().id;
    expect(response.json().email).toBe("nueva@clinica.com");
    expect(response.json().avatarData).toBe(avatarData);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "nueva@clinica.com",
        password: "PasswordSegura123",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.avatarData).toBe(avatarData);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: headers(login.json().token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().avatarData).toBe(avatarData);
  });

  it("permite quitar la foto del usuario", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${createdUserId}`,
      headers: headers(adminToken),
      payload: { avatarData: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().avatarData).toBeNull();
  });

  it("rechaza correo duplicado y practitioner sin especialista", async () => {    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: headers(adminToken),
      payload: {
        email: "nueva@clinica.com",
        password: "PasswordSegura123",
        fullName: "Otra",
        role: "receptionist",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("USER_EMAIL_EXISTS");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: headers(adminToken),
      payload: {
        email: "medico@clinica.com",
        password: "PasswordSegura123",
        fullName: "Medico",
        role: "practitioner",
      },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("crea usuario practitioner vinculado y lo actualiza", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: headers(adminToken),
      payload: {
        email: "medico@clinica.com",
        password: "PasswordSegura123",
        fullName: "Dr. Medico",
        role: "practitioner",
        practitionerId,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().practitionerName).toBe("Dra. Config");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${created.json().id}`,
      headers: headers(adminToken),
      payload: { fullName: "Dr. Medico Editado", isActive: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().fullName).toBe("Dr. Medico Editado");
    expect(updated.json().isActive).toBe(false);
  });

  it("desactiva y reactiva un usuario", async () => {
    const deactivated = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${createdUserId}`,
      headers: headers(adminToken),
    });
    expect(deactivated.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: headers(adminToken),
    });
    const user = list
      .json()
      .find((item: { id: string }) => item.id === createdUserId);
    expect(user.isActive).toBe(false);

    const reactivated = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${createdUserId}`,
      headers: headers(adminToken),
      payload: { isActive: true },
    });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().isActive).toBe(true);
  });

  it("permite editar el propio perfil sin cambiar rol ni estado", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: headers(receptionToken),
      payload: {
        fullName: "Recepción Editada",
        avatarData: "data:image/png;base64,iVBORw0KGgo=",
        password: "NuevaPassword123",
        role: "admin",
        isActive: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().fullName).toBe("Recepción Editada");
    expect(response.json().role).toBe("receptionist");
    expect(response.json().isActive).toBe(true);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: receptionEmail,
        password: "NuevaPassword123",
      },
    });
    expect(login.statusCode).toBe(200);
  });

  it("no permite desactivar el propio usuario", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${adminId}`,
      headers: headers(adminToken),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CANNOT_DEACTIVATE_SELF");
  });
});
