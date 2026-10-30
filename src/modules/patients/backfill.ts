import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import { contactPoints } from "../../db/schema/contact-points.js";
import { households } from "../../db/schema/households.js";
import { patients } from "../../db/schema/patients.js";
import { withTenant } from "../../db/tenant.js";
import {
  emailBlindIndex,
  encryptPhi,
  maskEmail,
  maskPhone,
  phoneBlindIndex,
} from "../../lib/phi-crypto.js";

export type BackfillOptions = {
  dryRun?: boolean;
  batchSize?: number;
};

export type BackfillStats = {
  clinicId: string;
  dryRun: boolean;
  patientsProcessed: number;
  householdsCreated: number;
  phonesCreated: number;
  emailsCreated: number;
};

type PatientRow = {
  id: string;
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  householdId: string | null;
};

/**
 * Backfill idempotente de Fase 1:
 * - Un household por paciente sin familia (no fusiona automaticamente).
 * - Copia telefono/email a contact_points cifrados, solo si faltan.
 * - No inventa opt-in: transactional_opt_in queda en false.
 * - Incluye pacientes soft-deleted para que el NOT NULL posterior no falle.
 */
export async function backfillClinicPhase1(
  db: Database,
  clinicId: string,
  options: BackfillOptions = {},
): Promise<BackfillStats> {
  const dryRun = options.dryRun ?? false;
  const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 5_000);

  const stats: BackfillStats = {
    clinicId,
    dryRun,
    patientsProcessed: 0,
    householdsCreated: 0,
    phonesCreated: 0,
    emailsCreated: 0,
  };

  let cursor: string | null = null;

  for (;;) {
    const rows = await withTenant(db, clinicId, (tx) =>
      tx
        .select({
          id: patients.id,
          firstName: patients.firstName,
          lastName: patients.lastName,
          phoneE164: patients.phoneE164,
          email: patients.email,
          householdId: patients.householdId,
        })
        .from(patients)
        .where(
          and(
            eq(patients.clinicId, clinicId),
            cursor ? gt(patients.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(patients.id))
        .limit(batchSize),
    );

    if (rows.length === 0) break;

    if (dryRun) {
      for (const row of rows) {
        stats.patientsProcessed += 1;
        if (!row.householdId) stats.householdsCreated += 1;
        if (row.phoneE164) stats.phonesCreated += 1;
        if (row.email) stats.emailsCreated += 1;
      }
    } else {
      await withTenant(db, clinicId, async (tx) => {
        for (const row of rows) {
          await backfillPatientTx(tx, clinicId, row, stats);
        }
      });
    }

    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = last.id;
    if (rows.length < batchSize) break;
  }

  return stats;
}

async function backfillPatientTx(
  tx: Transaction,
  clinicId: string,
  row: PatientRow,
  stats: BackfillStats,
): Promise<void> {
  stats.patientsProcessed += 1;

  if (!row.householdId) {
    const householdId = randomUUID();
    await tx.insert(households).values({
      id: householdId,
      clinicId,
      name: `${row.firstName} ${row.lastName}`.trim(),
      billingPatientId: row.id,
    });

    await tx
      .update(patients)
      .set({ householdId, isAccountHolder: true, updatedAt: new Date() })
      .where(and(eq(patients.id, row.id), eq(patients.clinicId, clinicId)));

    stats.householdsCreated += 1;
  }

  if (row.phoneE164) {
    const [existing] = await tx
      .select({ id: contactPoints.id })
      .from(contactPoints)
      .where(
        and(
          eq(contactPoints.clinicId, clinicId),
          eq(contactPoints.ownerType, "patient"),
          eq(contactPoints.ownerId, row.id),
          eq(contactPoints.kind, "phone"),
        ),
      )
      .limit(1);

    if (!existing) {
      await tx.insert(contactPoints).values({
        clinicId,
        ownerType: "patient",
        ownerId: row.id,
        kind: "phone",
        valueEnc: encryptPhi(row.phoneE164),
        valueBidx: phoneBlindIndex(row.phoneE164),
        valueMasked: maskPhone(row.phoneE164),
        isPrimary: true,
        source: "migration",
        transactionalOptIn: false,
        marketingOptIn: false,
      });
      stats.phonesCreated += 1;
    }
  }

  if (row.email) {
    const [existing] = await tx
      .select({ id: contactPoints.id })
      .from(contactPoints)
      .where(
        and(
          eq(contactPoints.clinicId, clinicId),
          eq(contactPoints.ownerType, "patient"),
          eq(contactPoints.ownerId, row.id),
          eq(contactPoints.kind, "email"),
        ),
      )
      .limit(1);

    if (!existing) {
      await tx.insert(contactPoints).values({
        clinicId,
        ownerType: "patient",
        ownerId: row.id,
        kind: "email",
        valueEnc: encryptPhi(row.email),
        valueBidx: emailBlindIndex(row.email),
        valueMasked: maskEmail(row.email),
        isPrimary: true,
        source: "migration",
        transactionalOptIn: false,
        marketingOptIn: false,
      });
      stats.emailsCreated += 1;
    }
  }
}
