import { asc } from "drizzle-orm";
import { createDatabase } from "../db/client.js";
import { clinics } from "../db/schema/clinics.js";
import { env } from "../env.js";
import { backfillClinicPhase1 } from "../modules/patients/backfill.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const clinicArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--clinic="))
  ?.slice("--clinic=".length);

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
const { db, pool } = createDatabase(connectionString);

try {
  const clinicIds = clinicArg
    ? [clinicArg]
    : (await db.select({ id: clinics.id }).from(clinics).orderBy(asc(clinics.id))).map(
        (row) => row.id,
      );

  const results = [];
  for (const clinicId of clinicIds) {
    const stats = await backfillClinicPhase1(db, clinicId, { dryRun });
    results.push(stats);
  }

  console.log(
    JSON.stringify(
      {
        event: "phase1.backfill",
        dryRun,
        clinics: results.length,
        totals: results.reduce(
          (acc, item) => ({
            patientsProcessed: acc.patientsProcessed + item.patientsProcessed,
            householdsCreated: acc.householdsCreated + item.householdsCreated,
            phonesCreated: acc.phonesCreated + item.phonesCreated,
            emailsCreated: acc.emailsCreated + item.emailsCreated,
          }),
          {
            patientsProcessed: 0,
            householdsCreated: 0,
            phonesCreated: 0,
            emailsCreated: 0,
          },
        ),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
