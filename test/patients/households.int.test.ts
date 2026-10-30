import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
let patientA: string;
let patientB: string;
let householdA: string;
let householdB: string;
let contactB: string;
let tagA: string;
let tagB: string;
let allergyA: string;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  patientA = randomUUID();
  patientB = randomUUID();
  householdA = randomUUID();
  householdB = randomUUID();
  contactB = randomUUID();
  tagA = randomUUID();
  tagB = randomUUID();
  allergyA = randomUUID();

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

  await testDb.adminDb.insert(schema.households).values([
    { id: householdA, clinicId: clinicA, name: "Familia A" },
    { id: householdB, clinicId: clinicB, name: "Familia B" },
  ]);

  await testDb.adminDb.insert(schema.patients).values([
    {
      id: patientA,
      clinicId: clinicA,
      householdId: householdA,
      firstName: "Ana",
      lastName: "A",
      documentNumberBidx: "DOC-A",
    },
    {
      id: patientB,
      clinicId: clinicB,
      householdId: householdB,
      firstName: "Beto",
      lastName: "B",
      documentNumberBidx: "DOC-B",
    },
  ]);

  await testDb.adminDb
    .update(schema.households)
    .set({ billingPatientId: patientA })
    .where(eq(schema.households.id, householdA));

  await testDb.adminDb.insert(schema.contactPoints).values([
    {
      clinicId: clinicA,
      ownerType: "patient",
      ownerId: patientA,
      kind: "phone",
      valueEnc: Buffer.from("cifrado-a"),
      valueBidx: "bidx-phone-a",
      valueMasked: "+52******0001",
      isPrimary: true,
    },
    {
      clinicId: clinicA,
      ownerType: "household",
      ownerId: householdA,
      kind: "phone",
      valueEnc: Buffer.from("cifrado-h"),
      valueBidx: "bidx-phone-h",
      valueMasked: "+52******0002",
      isPrimary: true,
    },
    {
      id: contactB,
      clinicId: clinicB,
      ownerType: "patient",
      ownerId: patientB,
      kind: "phone",
      valueEnc: Buffer.from("cifrado-b"),
      valueBidx: "bidx-phone-b",
      valueMasked: "+52******0003",
      isPrimary: true,
    },
  ]);
  await testDb.adminDb.insert(schema.tags).values([
    {
      id: tagA,
      clinicId: clinicA,
      code: "vip",
      label: "VIP",
      category: "vip",
      isAlert: false,
      isSystem: true,
    },
    {
      id: tagB,
      clinicId: clinicB,
      code: "vip",
      label: "VIP",
      category: "vip",
      isAlert: false,
      isSystem: true,
    },
  ]);

  await testDb.adminDb.insert(schema.patientTags).values({
    clinicId: clinicA,
    patientId: patientA,
    tagId: tagA,
    severity: 2,
  });

  await testDb.adminDb.insert(schema.patientAllergies).values({
    id: allergyA,
    clinicId: clinicA,
    patientId: patientA,
    allergen: "Penicilina",
    severity: "anaphylaxis",
    isActive: true,
  });

  await testDb.adminDb.insert(schema.patientGuardians).values({
    clinicId: clinicA,
    patientId: patientA,
    guardianName: "Tutora A",
    relationship: "parent",
    isLegalGuardian: true,
    validFrom: today(),
  });
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("0011: defaults y constraints", () => {
  it("clinics nace con MXN y settings vacio", async () => {
    const [clinic] = await testDb!.adminDb
      .select({
        currency: schema.clinics.currency,
        settings: schema.clinics.settings,
      })
      .from(schema.clinics)
      .where(eq(schema.clinics.id, clinicA))
      .limit(1);

    expect(clinic?.currency).toBe("MXN");
    expect(clinic?.settings).toEqual({});
  });

  it("impide documento duplicado en la misma clinica y lo permite en otra", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.patients).values({
          clinicId: clinicA,
          householdId: householdA,
          firstName: "Otra",
          lastName: "Ana",
          documentNumberBidx: "DOC-A",
        }),
      "23505",
    );

    await testDb!.adminDb.insert(schema.patients).values({
      clinicId: clinicB,
      householdId: householdB,
      firstName: "Otra",
      lastName: "Beto",
      documentNumberBidx: "DOC-A",
    });
  });

  it("impide que un paciente apunte a un household de otra clinica", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.patients).values({
          clinicId: clinicA,
          householdId: householdB,
          firstName: "Cruzado",
          lastName: "Tenant",
        }),
      "23503",
    );
  });

  it("impide dos contactos primarios del mismo owner/kind", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.contactPoints).values({
          clinicId: clinicA,
          ownerType: "patient",
          ownerId: patientA,
          kind: "phone",
          valueEnc: Buffer.from("cifrado-2"),
          valueBidx: "bidx-phone-a-2",
          valueMasked: "+52******0004",
          isPrimary: true,
        }),
      "23505",
    );
  });

  it("permite el mismo telefono en owners distintos", async () => {
    await testDb!.adminDb.insert(schema.contactPoints).values({
      clinicId: clinicA,
      ownerType: "patient",
      ownerId: patientA,
      kind: "phone",
      valueEnc: Buffer.from("cifrado-3"),
      valueBidx: "bidx-phone-shared",
      valueMasked: "+52******0005",
      isPrimary: false,
    });

    await testDb!.adminDb.insert(schema.contactPoints).values({
      clinicId: clinicA,
      ownerType: "household",
      ownerId: householdA,
      kind: "phone",
      valueEnc: Buffer.from("cifrado-4"),
      valueBidx: "bidx-phone-shared",
      valueMasked: "+52******0005",
      isPrimary: false,
    });
  });

  it("trata la alergia activa como case-insensitive y permite reactivar tras desactivar", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.patientAllergies).values({
          clinicId: clinicA,
          patientId: patientA,
          allergen: "penicilina",
          severity: "severe",
        }),
      "23505",
    );

    await testDb!.adminDb
      .update(schema.patientAllergies)
      .set({ isActive: false })
      .where(eq(schema.patientAllergies.id, allergyA));

    await testDb!.adminDb.insert(schema.patientAllergies).values({
      clinicId: clinicA,
      patientId: patientA,
      allergen: "penicilina",
      severity: "severe",
    });
  });

  it("valida identidad y relación del tutor", async () => {
    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.patientGuardians).values({
          clinicId: clinicA,
          patientId: patientA,
          relationship: "parent",
        }),
      "23514",
    );

    await expectPgError(
      () =>
        testDb!.adminDb.insert(schema.patientGuardians).values({
          clinicId: clinicA,
          patientId: patientA,
          guardianPatientId: patientA,
          relationship: "parent",
        }),
      "23514",
    );
  });

  it("impide que el responsable de pago sea de otra clinica (FK diferida)", async () => {
    const client = await testDb!.adminPool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into households (id, clinic_id, name, billing_patient_id)
         values ($1, $2, $3, $4)`,
        [randomUUID(), clinicA, "Familia cruzada", patientB],
      );
      await expect(client.query("commit")).rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});

describe("0011: RLS y grants", () => {
  it("sin app.clinic_id las tablas nuevas devuelven cero filas", async () => {
    const rows = await appDb.transaction((tx) =>
      tx.select({ id: schema.households.id }).from(schema.households),
    );
    expect(rows).toHaveLength(0);
  });

  it("aísla households, contact_points, alergias, tags y tutores por clinica", async () => {
    const data = await asTenant(clinicA, async (tx) => ({
      households: await tx
        .select({ id: schema.households.id })
        .from(schema.households),
      contacts: await tx
        .select({ id: schema.contactPoints.id })
        .from(schema.contactPoints),
      allergies: await tx
        .select({ id: schema.patientAllergies.id })
        .from(schema.patientAllergies),
      guardians: await tx
        .select({ id: schema.patientGuardians.id })
        .from(schema.patientGuardians),
      tags: await tx.select({ id: schema.tags.id }).from(schema.tags),
      patientTags: await tx
        .select({ patientId: schema.patientTags.patientId })
        .from(schema.patientTags),
    }));

    expect(data.households.map((r) => r.id)).toEqual([householdA]);
    expect(data.contacts.map((r) => r.id)).not.toContain(contactB);
    expect(data.contacts.length).toBeGreaterThanOrEqual(2);
    expect(data.allergies.map((r) => r.id)).toContain(allergyA);
    expect(data.guardians).toHaveLength(1);
    expect(data.tags.map((r) => r.id)).toEqual([tagA]);
    expect(data.patientTags.map((r) => r.patientId)).toEqual([patientA]);
  });

  it("no permite borrar PHI desde crm_app", async () => {
    await expectPgError(
      () =>
        asTenant(clinicA, (tx) =>
          tx
            .delete(schema.patientAllergies)
            .where(eq(schema.patientAllergies.id, allergyA)),
        ),
      "42501",
    );

    await expectPgError(
      () =>
        asTenant(clinicA, (tx) =>
          tx.delete(schema.households).where(eq(schema.households.id, householdA)),
        ),
      "42501",
    );
  });

  it("permite crear y quitar etiquetas desde crm_app", async () => {
    await asTenant(clinicA, async (tx) => {
      await tx
        .delete(schema.patientTags)
        .where(
          and(
            eq(schema.patientTags.patientId, patientA),
            eq(schema.patientTags.tagId, tagA),
          ),
        );
      await tx.insert(schema.patientTags).values({
        clinicId: clinicA,
        patientId: patientA,
        tagId: tagA,
        severity: 1,
      });
    });
  });
});
