import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { SlotTakenError } from "../../src/lib/errors.js";
import { pgErrorCode } from "../../src/lib/pg-error.js";
import { bookAppointment } from "../../src/modules/appointments/service.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let adminPool: Pool;
let appDb: Database;

let clinicId: string;
let otherClinicId: string;
let practitionerId: string;
let patientId: string;
let otherPatientId: string;
let staffToken: string;

function slot(day: number): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(`2027-03-${String(day).padStart(2, "0")}T15:00:00-06:00`),
    endsAt: new Date(`2027-03-${String(day).padStart(2, "0")}T15:30:00-06:00`),
  };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  adminPool = testDb.adminPool;
  appDb = testDb.appDb;

  clinicId = randomUUID();
  otherClinicId = randomUUID();
  practitionerId = randomUUID();
  patientId = randomUUID();
  otherPatientId = randomUUID();

  // Seed como superusuario: RLS se ignora, valido para preparar el escenario.
  await testDb.adminDb.insert(schema.clinics).values([
    { id: clinicId, name: "Clinica Norte", timezone: TZ },
    { id: otherClinicId, name: "Clinica Sur", timezone: TZ },
  ]);

  await testDb.adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Ana Torres",
    specialty: "Medicina general",
  });

  await testDb.adminDb.insert(schema.patients).values([
    {
      id: patientId,
      clinicId,
      firstName: "Luis",
      lastName: "Ramirez",
      phoneE164: "+5215512345678",
      email: "luis@example.com",
    },
    {
      id: otherPatientId,
      clinicId: otherClinicId,
      firstName: "Paciente",
      lastName: "DeOtraClinica",
    },
  ]);

  const staff = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "receptionist",
  });
  staffToken = staff.token;
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("agenda: reserva atomica", () => {
  it("crea una cita en estado requested", async () => {
    const { startsAt, endsAt } = slot(10);

    const appointment = await bookAppointment(appDb, {
      clinicId,
      patientId,
      practitionerId,
      startsAt,
      endsAt,
      timezone: TZ,
    });

    expect(appointment.id).toBeTruthy();
    expect(appointment.status).toBe("requested");
    expect(appointment.isOverbooking).toBe(false);
    expect(appointment.clinicId).toBe(clinicId);
  });

  it("de dos reservas concurrentes del mismo horario solo una gana", async () => {
    const { startsAt, endsAt } = slot(11);

    const attempt = () =>
      bookAppointment(appDb, {
        clinicId,
        patientId,
        practitionerId,
        startsAt,
        endsAt,
        timezone: TZ,
      });

    const results = await Promise.allSettled([attempt(), attempt()]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(SlotTakenError);

    const { rows } = await adminPool.query<{ count: number }>(
      `select count(*)::int as count
         from appointments
        where practitioner_id = $1 and starts_at = $2`,
      [practitionerId, startsAt],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("la constraint de PostgreSQL bloquea un insert que evade el servicio", async () => {
    const { startsAt, endsAt } = slot(12);

    let code: string | undefined;

    try {
      await appDb.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.clinic_id', ${clinicId}, true)`,
        );
        await tx.insert(schema.appointments).values({
          clinicId,
          patientId,
          practitionerId,
          startsAt,
          endsAt,
          timezone: TZ,
        });
        await tx.insert(schema.appointments).values({
          clinicId,
          patientId,
          practitionerId,
          startsAt,
          endsAt,
          timezone: TZ,
        });
      });
    } catch (err) {
      code = pgErrorCode(err);
    }

    expect(code).toBe("23P01");
  });

  it("repetir la misma Idempotency-Key devuelve la misma cita", async () => {
    const { startsAt, endsAt } = slot(13);
    const key = randomUUID();

    const first = await bookAppointment(appDb, {
      clinicId,
      patientId,
      practitionerId,
      startsAt,
      endsAt,
      timezone: TZ,
      idempotencyKey: key,
    });

    const second = await bookAppointment(appDb, {
      clinicId,
      patientId,
      practitionerId,
      startsAt,
      endsAt,
      timezone: TZ,
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
  });

  it("RLS oculta pacientes de otra clinica", async () => {
    const visible = await appDb.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.clinic_id', ${clinicId}, true)`,
      );
      return tx
        .select({ id: schema.patients.id, clinicId: schema.patients.clinicId })
        .from(schema.patients);
    });

    expect(visible.map((p) => p.id)).toContain(patientId);
    expect(visible.map((p) => p.id)).not.toContain(otherPatientId);
    expect(visible.every((p) => p.clinicId === clinicId)).toBe(true);
  });
});

describe("API HTTP", () => {
  it("expone POST /api/v1/appointments y mapea el conflicto a 409", async () => {
    const app = buildApp({ db: appDb, logger: false });
    const { startsAt, endsAt } = slot(14);

    const payload = {
      patientId,
      practitionerId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timezone: TZ,
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/appointments",
      headers: { authorization: `Bearer ${staffToken}` },
      payload,
    });

    expect(created.statusCode).toBe(201);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/appointments",
      headers: { authorization: `Bearer ${staffToken}` },
      payload,
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("SLOT_TAKEN");

    await app.close();
  });
});
