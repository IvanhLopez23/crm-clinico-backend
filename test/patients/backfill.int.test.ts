import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { backfillClinicPhase1 } from "../../src/modules/patients/backfill.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let testDb: TestDatabase | undefined;
let appDb: Database;

let clinicId: string;
let patientA: string;
let patientB: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;

  clinicId = randomUUID();
  patientA = randomUUID();
  patientB = randomUUID();

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Backfill",
    timezone: "America/Mexico_City",
  });

  await testDb.adminDb.insert(schema.patients).values([
    {
      id: patientA,
      clinicId,
      firstName: "Ana",
      lastName: "Backfill",
      phoneE164: "+5215512345678",
      email: "ana@example.com",
    },
    {
      id: patientB,
      clinicId,
      firstName: "Beto",
      lastName: "Backfill",
      phoneE164: "+5215587654321",
    },
  ]);
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("backfill fase 1", () => {
  it("dry-run no escribe nada", async () => {
    const stats = await backfillClinicPhase1(appDb, clinicId, { dryRun: true });

    expect(stats.patientsProcessed).toBe(2);
    expect(stats.householdsCreated).toBe(2);

    const rows = await testDb!.adminDb
      .select({ id: schema.patients.id, householdId: schema.patients.householdId })
      .from(schema.patients)
      .where(eq(schema.patients.clinicId, clinicId));

    expect(rows.every((row) => row.householdId === null)).toBe(true);
  });

  it("crea household y contactos cifrados, y es idempotente", async () => {
    const first = await backfillClinicPhase1(appDb, clinicId);
    expect(first.householdsCreated).toBe(2);
    expect(first.phonesCreated).toBe(2);
    expect(first.emailsCreated).toBe(1);

    const patients = await testDb!.adminDb
      .select({
        id: schema.patients.id,
        householdId: schema.patients.householdId,
        isAccountHolder: schema.patients.isAccountHolder,
      })
      .from(schema.patients)
      .where(eq(schema.patients.clinicId, clinicId));

    expect(patients.every((row) => row.householdId !== null)).toBe(true);
    expect(patients.every((row) => row.isAccountHolder)).toBe(true);

    const contacts = await testDb!.adminDb
      .select()
      .from(schema.contactPoints)
      .where(eq(schema.contactPoints.clinicId, clinicId));

    expect(contacts).toHaveLength(3);
    expect(contacts.every((row) => row.source === "migration")).toBe(true);
    expect(contacts.every((row) => row.transactionalOptIn === false)).toBe(true);
    expect(contacts.filter((row) => row.kind === "phone")).toHaveLength(2);
    expect(contacts.filter((row) => row.kind === "email")).toHaveLength(1);

    const second = await backfillClinicPhase1(appDb, clinicId);
    expect(second.householdsCreated).toBe(0);
    expect(second.phonesCreated).toBe(0);
    expect(second.emailsCreated).toBe(0);

    const after = await testDb!.adminDb
      .select({ id: schema.contactPoints.id })
      .from(schema.contactPoints)
      .where(eq(schema.contactPoints.clinicId, clinicId));
    expect(after).toHaveLength(3);
  });
});
