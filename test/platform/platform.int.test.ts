import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { hashPassword } from "../../src/lib/password.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let testDb: TestDatabase | undefined;
let appDb: Database;
let app: ReturnType<typeof buildApp>;

let clinicId: string;
let tenantAdminToken: string;
let tenantAdminEmail: string;
let tenantAdminPassword: string;
let platformToken: string;
let platformAdminId: string;

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function multipartPayload(
  fields: Record<string, string>,
  file?: { name: string; type: string; data: Buffer },
): { boundary: string; payload: Buffer } {
  const boundary = `----crmtest${Date.now()}`;
  const chunks: Buffer[] = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return { boundary, payload: Buffer.concat(chunks) };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  app = buildApp({ db: appDb, logger: false });

  clinicId = randomUUID();
  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Existente",
    timezone: "America/Mexico_City",
  });

  const tenantAdmin = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "admin",
  });
  tenantAdminToken = tenantAdmin.token;
  tenantAdminEmail = tenantAdmin.email;
  tenantAdminPassword = tenantAdmin.password;

  platformAdminId = randomUUID();
  await testDb.adminDb.insert(schema.platformAdmins).values({
    id: platformAdminId,
    email: "platform@test.local",
    passwordHash: hashPassword("PlatformPass123"),
    fullName: "Platform Admin",
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email: "platform@test.local",
      password: "PlatformPass123",
    },
  });
  expect(login.statusCode).toBe(200);
  expect(login.json().user.role).toBe("platform_admin");
  expect(login.json().user.scope).toBe("platform");
  platformToken = login.json().token;
}, 300_000);

afterAll(async () => {
  await app.close();
  await testDb?.close();
}, 60_000);

describe("plataforma SaaS", () => {
  it("aísla los scopes de plataforma y tenant", async () => {
    const platformOnTenant = await app.inject({
      method: "GET",
      url: "/api/v1/patients",
      headers: headers(platformToken),
    });
    expect(platformOnTenant.statusCode).toBe(403);

    const tenantOnPlatform = await app.inject({
      method: "GET",
      url: "/api/v1/platform/clinics",
      headers: headers(tenantAdminToken),
    });
    expect(tenantOnPlatform.statusCode).toBe(403);
  });

  it("lista tenants existentes con sus métricas", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/platform/clinics",
      headers: headers(platformToken),
    });

    expect(response.statusCode).toBe(200);
    const tenants = response.json() as Array<{
      id: string;
      usersCount: number;
    }>;
    expect(tenants.some((tenant) => tenant.id === clinicId)).toBe(true);
    expect(
      tenants.find((tenant) => tenant.id === clinicId)?.usersCount,
    ).toBeGreaterThanOrEqual(1);
  });

  it("crea un tenant con su administrador y servicio base", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/platform/clinics",
      headers: headers(platformToken),
      payload: {
        name: "Clinica Nueva",
        timezone: "America/Monterrey",
        currency: "MXN",
        admin: {
          fullName: "Admin Nuevo",
          email: "nuevo.admin@test.local",
          password: "NuevoPass123",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const tenant = response.json();
    expect(tenant.name).toBe("Clinica Nueva");
    expect(tenant.usersCount).toBe(1);
    expect(tenant.isActive).toBe(true);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "nuevo.admin@test.local",
        password: "NuevoPass123",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.scope).toBe("tenant");
  });

  it("guarda y actualiza las coordenadas del tenant", async () => {
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/clinics/${clinicId}`,
      headers: headers(platformToken),
      payload: { latitude: 25.6866, longitude: -100.3161 },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      latitude: 25.6866,
      longitude: -100.3161,
    });

    const invalidPair = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/clinics/${clinicId}`,
      headers: headers(platformToken),
      payload: { latitude: 25.6866 },
    });
    expect(invalidPair.statusCode).toBe(400);

    const outOfRange = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/clinics/${clinicId}`,
      headers: headers(platformToken),
      payload: { latitude: 120, longitude: -100.3161 },
    });
    expect(outOfRange.statusCode).toBe(400);
  });

  it("permite definir la URL publica y no la cambia al renombrar", async () => {
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/clinics/${clinicId}`,
      headers: headers(platformToken),
      payload: { slug: "Clinica Las Puentes" },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().slug).toBe("clinica-las-puentes");

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/clinics/${clinicId}`,
      headers: headers(platformToken),
      payload: { name: "Clinica Las Puentes Renombrada" },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().slug).toBe("clinica-las-puentes");

    const publicResponse = await app.inject({
      method: "GET",
      url: "/api/v1/public/clinics/clinica-las-puentes",
    });
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.json().clinic.id).toBe(clinicId);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/platform/clinics",
      headers: headers(platformToken),
      payload: {
        name: "Clinica Duplicada",
        slug: "clinica-las-puentes",
        admin: {
          fullName: "Admin Duplicado",
          email: "duplicado.admin@test.local",
          password: "DuplicadoPass123",
        },
      },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("SLUG_TAKEN");
  });

  it("sube, lista, descarga y elimina contratos del tenant", async () => {
    const pdf = Buffer.from("%PDF-1.4\nLicencia de prueba\n%%EOF");
    const upload = multipartPayload(
      {
        name: "Licencia anual 2026",
        startsAt: "2026-01-01",
        endsAt: "2026-12-31",
        notes: "Contrato de prueba",
      },
      { name: "licencia.pdf", type: "application/pdf", data: pdf },
    );

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/platform/clinics/${clinicId}/contracts`,
      headers: {
        ...headers(platformToken),
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
      },
      payload: upload.payload,
    });

    expect(created.statusCode).toBe(201);
    const contract = created.json() as {
      id: string;
      name: string;
      fileName: string;
      sizeBytes: number;
    };
    expect(contract.name).toBe("Licencia anual 2026");
    expect(contract.fileName).toBe("licencia.pdf");
    expect(contract.sizeBytes).toBe(pdf.length);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/platform/clinics/${clinicId}/contracts`,
      headers: headers(platformToken),
    });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json() as Array<{ id: string }>).some(
        (item) => item.id === contract.id,
      ),
    ).toBe(true);

    const file = await app.inject({
      method: "GET",
      url: `/api/v1/platform/clinics/${clinicId}/contracts/${contract.id}/file`,
      headers: headers(platformToken),
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
    expect(file.rawPayload.toString("utf8")).toContain("%PDF");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/platform/clinics/${clinicId}/contracts/${contract.id}`,
      headers: headers(platformToken),
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("rechaza archivos no permitidos y uploads sin archivo", async () => {
    const text = multipartPayload(
      { name: "Contrato invalido", startsAt: "2026-01-01" },
      { name: "nota.txt", type: "text/plain", data: Buffer.from("hola") },
    );

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/platform/clinics/${clinicId}/contracts`,
      headers: {
        ...headers(platformToken),
        "content-type": `multipart/form-data; boundary=${text.boundary}`,
      },
      payload: text.payload,
    });
    expect(invalid.statusCode).toBe(422);

    const noFile = multipartPayload({
      name: "Sin archivo",
      startsAt: "2026-01-01",
    });
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/platform/clinics/${clinicId}/contracts`,
      headers: {
        ...headers(platformToken),
        "content-type": `multipart/form-data; boundary=${noFile.boundary}`,
      },
      payload: noFile.payload,
    });
    expect(missing.statusCode).toBe(400);
  });

  it("crea usuarios del tenant y protege al último admin", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/platform/clinics/${clinicId}/users`,
      headers: headers(platformToken),
      payload: {
        fullName: "Recepción Plataforma",
        email: "reception.platform@test.local",
        password: "ReceptionPass123",
        role: "receptionist",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().role).toBe("receptionist");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/platform/clinics/${clinicId}`,
      headers: headers(platformToken),
    });
    expect(detail.statusCode).toBe(200);
    const admin = (detail.json().users as Array<{ id: string; role: string }>).find(
      (user) => user.role === "admin",
    );
    expect(admin).toBeTruthy();

    const lastAdmin = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/clinics/${clinicId}/users/${admin?.id}`,
      headers: headers(platformToken),
      payload: { isActive: false },
    });
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().error.code).toBe("LAST_ADMIN");
  });

  it("suspende un tenant y bloquea a sus usuarios", async () => {
    const suspended = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/clinics/${clinicId}`,
      headers: headers(platformToken),
      payload: { isActive: false },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().isActive).toBe(false);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: tenantAdminEmail,
        password: tenantAdminPassword,
      },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe("CLINIC_INACTIVE");

    const existingToken = await app.inject({
      method: "GET",
      url: "/api/v1/patients",
      headers: headers(tenantAdminToken),
    });
    expect(existingToken.statusCode).toBe(403);
  });
});
