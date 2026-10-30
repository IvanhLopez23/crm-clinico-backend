import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transaction } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { pgErrorCode } from "../../src/lib/pg-error.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let testDb: TestDatabase | undefined;
let appDb: Database;

let clinicA: string;
let clinicB: string;
let practitionerA: string;
let practitionerB: string;
let specialtyA: string;
let specialtyB: string;
let serviceA: string;
let serviceB: string;
let closureA: string;

async function asTenant<T>(
  clinicId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    return fn(tx);
  });
}

async function expectPgError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(pgErrorCode(err)).toBe(code);
    return;
  }
  throw new Error(`se esperaba error PostgreSQL ${code}`);
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;

  clinicA = randomUUID();
  clinicB = randomUUID();
  practitionerA = randomUUID();
  practitionerB = randomUUID();
  specialtyA = randomUUID();
  specialtyB = randomUUID();
  serviceA = randomUUID();
  serviceB = randomUUID();
  closureA = randomUUID();

  await testDb.adminDb.insert(schema.clinics).values([
    { id: clinicA, name: "Clinica A", timezone: "America/Mexico_City" },
    { id: clinicB, name: "Clinica B", timezone: "America/Mexico_City" },
  ]);

  await testDb.adminDb.insert(schema.practitioners).values([
    {
      id: practitionerA,
      clinicId: clinicA,
      fullName: "Dra. A",
      specialty: "Medicina general",
    },
    {
      id: practitionerB,
      clinicId: clinicB,
      fullName: "Dr. B",
      specialty: "Medicina general",
    },
  ]);

  await testDb.adminDb.insert(schema.specialties).values([
    { id: specialtyA, clinicId: clinicA, code: "GENERAL", name: "General" },
    { id: specialtyB, clinicId: clinicB, code: "GENERAL", name: "General" },
  ]);

  await testDb.adminDb.insert(schema.practitionerSpecialties).values([
    {
      clinicId: clinicA,
      practitionerId: practitionerA,
      specialtyId: specialtyA,
      isPrimary: true,
    },
    {
      clinicId: clinicB,
      practitionerId: practitionerB,
      specialtyId: specialtyB,
      isPrimary: true,
    },
  ]);

  await testDb.adminDb.insert(schema.services).values([
    {
      id: serviceA,
      clinicId: clinicA,
      code: "CONSULTA",
      name: "Consulta general",
      specialtyId: specialtyA,
      durationMinutes: 30,
      priceCents: 50_000,
      currency: "MXN",
    },
    {
      id: serviceB,
      clinicId: clinicB,
      code: "CONSULTA",
      name: "Consulta general",
      specialtyId: specialtyB,
      durationMinutes: 30,
      priceCents: 60_000,
      currency: "MXN",
    },
  ]);

  await testDb.adminDb.insert(schema.clinicClosures).values({
    id: closureA,
    clinicId: clinicA,
    startsAt: new Date("2027-12-24T06:00:00Z"),
    endsAt: new Date("2027-12-25T06:00:00Z"),
    reason: "Navidad",
  });
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("0012: defaults y constraints", () => {
  it("practitioner nace con color, slot y buffers", async () => {
    const [practitioner] = await testDb!.adminDb
      .select({
        color: schema.practitioners.color,
        slot: schema.practitioners.defaultSlotMinutes,
        bufferBefore: schema.practitioners.bufferBeforeMinutes,
        bufferAfter: schema.practitioners.bufferAfterMinutes,
        accepting: schema.practitioners.isAcceptingNewPatients,
      })
      .from(schema.practitioners)
      .where(eq(schema.practitioners.id, practitionerA))
      .limit(1);

    expect(practitioner).toEqual({
      color: "#0F766E",
      slot: 30,
      bufferBefore: 0,
      bufferAfter: 5,
      accepting: true,
    });
  });

  it("impide código de servicio duplicado por clinica y lo permite en otra", async () => {
    await testDb!.adminDb.insert(schema.services).values({
      clinicId: clinicA,
      code: "UNICO",
      name: "Servicio unico",
      durationMinutes: 45,
      priceCents: 0,
      currency: "MXN",
    });

    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.services).values({
          clinicId: clinicA,
          code: "UNICO",
          name: "Otra",
          durationMinutes: 45,
          priceCents: 0,
          currency: "MXN",
        }),
      "23505",
    );

    await testDb!.adminDb.insert(schema.services).values({
      clinicId: clinicB,
      code: "UNICO",
      name: "Otra",
      durationMinutes: 45,
      priceCents: 0,
      currency: "MXN",
    });
  });

  it("valida duración y depósito", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.services).values({
          clinicId: clinicA,
          code: "SHORT",
          name: "Muy corto",
          durationMinutes: 4,
          priceCents: 0,
          currency: "MXN",
        }),
      "23514",
    );

    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.services).values({
          clinicId: clinicA,
          code: "DEPOSIT",
          name: "Sin monto",
          durationMinutes: 30,
          priceCents: 0,
          currency: "MXN",
          depositRequired: true,
        }),
      "23514",
    );

    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.services).values({
          clinicId: clinicA,
          code: "DEPOSIT2",
          name: "Doble monto",
          durationMinutes: 30,
          priceCents: 0,
          currency: "MXN",
          depositRequired: true,
          depositCents: 100,
          depositBps: 1000,
        }),
      "23514",
    );
  });

  it("impide que un servicio apunte a especialidad de otra clinica", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.services).values({
          clinicId: clinicA,
          code: "CROSS",
          name: "Cruzado",
          specialtyId: specialtyB,
          durationMinutes: 30,
          priceCents: 0,
          currency: "MXN",
        }),
      "23503",
    );
  });

  it("impide que practitioner_specialties cruce clinicas", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.practitionerSpecialties).values({
          clinicId: clinicA,
          practitionerId: practitionerA,
          specialtyId: specialtyB,
        }),
      "23503",
    );
  });

  it("valida el rango de un cierre de clinica", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.clinicClosures).values({
          clinicId: clinicA,
          startsAt: new Date("2027-12-25T06:00:00Z"),
          endsAt: new Date("2027-12-24T06:00:00Z"),
          reason: "Invalido",
        }),
      "23514",
    );
  });

  it("acepta type=break en schedule_blocks y rechaza tipos desconocidos", async () => {
    await testDb!.adminDb.insert(schema.scheduleBlocks).values({
      clinicId: clinicA,
      practitionerId: practitionerA,
      startsAt: new Date("2027-12-20T16:00:00Z"),
      endsAt: new Date("2027-12-20T16:15:00Z"),
      type: "break",
      reason: "Descanso",
    });

    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.scheduleBlocks).values({
          clinicId: clinicA,
          practitionerId: practitionerA,
          startsAt: new Date("2027-12-20T17:00:00Z"),
          endsAt: new Date("2027-12-20T17:15:00Z"),
          type: "lunch",
        }),
      "23514",
    );
  });
});

describe("0012: RLS y grants", () => {
  it("sin app.clinic_id las tablas nuevas devuelven cero filas", async () => {
    const rows = await appDb.transaction((tx) =>
      tx.select({ id: schema.services.id }).from(schema.services),
    );
    expect(rows).toHaveLength(0);
  });

  it("aísla servicios, especialidades, relación y cierres por clinica", async () => {
    const data = await asTenant(clinicA, async (tx) => ({
      services: await tx
        .select({ id: schema.services.id })
        .from(schema.services),
      specialties: await tx
        .select({ id: schema.specialties.id })
        .from(schema.specialties),
      links: await tx
        .select({ practitionerId: schema.practitionerSpecialties.practitionerId })
        .from(schema.practitionerSpecialties),
      closures: await tx
        .select({ id: schema.clinicClosures.id })
        .from(schema.clinicClosures),
    }));

    expect(data.services.map((r) => r.id)).toContain(serviceA);
    expect(data.services.map((r) => r.id)).not.toContain(serviceB);
    expect(data.specialties.map((r) => r.id)).toEqual([specialtyA]);
    expect(data.links.map((r) => r.practitionerId)).toEqual([practitionerA]);
    expect(data.closures.map((r) => r.id)).toEqual([closureA]);
  });

  it("no permite borrar servicios ni especialidades desde crm_app", async () => {
    await expectPgError(
      () =>
        asTenant(clinicA, (tx) =>
          tx.delete(schema.services).where(eq(schema.services.id, serviceA)),
        ),
      "42501",
    );

    await expectPgError(
      () =>
        asTenant(clinicA, (tx) =>
          tx
            .delete(schema.specialties)
            .where(eq(schema.specialties.id, specialtyA)),
        ),
      "42501",
    );
  });

  it("permite desasignar especialidad y borrar cierre desde crm_app", async () => {
    await asTenant(clinicA, async (tx) => {
      await tx
        .delete(schema.practitionerSpecialties)
        .where(eq(schema.practitionerSpecialties.practitionerId, practitionerA));
      await tx
        .delete(schema.clinicClosures)
        .where(eq(schema.clinicClosures.id, closureA));
    });
  });
});
