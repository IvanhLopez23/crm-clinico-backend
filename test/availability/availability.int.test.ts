import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { bookAppointment } from "../../src/modules/appointments/service.js";
import { buildApp } from "../../src/app.js";
import {
  createAvailabilityRule,
  createScheduleBlock,
  getAvailability,
} from "../../src/modules/availability/service.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;

let clinicId: string;
let practitionerA: string;
let practitionerB: string;
let patientId: string;
let monday: string;

function plusDays(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: TZ })
    .plus({ days })
    .toISODate() as string;
}

// Hora local del consultorio (-06:00 todo el ano en Mexico desde 2022).
function local(isoDate: string, time: string): Date {
  return new Date(`${isoDate}T${time}:00-06:00`);
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;

  clinicId = randomUUID();
  practitionerA = randomUUID();
  practitionerB = randomUUID();
  patientId = randomUUID();

  // Un lunes futuro: evita que el filtro de "slots pasados" rompa el test.
  monday = DateTime.now()
    .setZone(TZ)
    .plus({ days: 7 })
    .startOf("week")
    .toISODate() as string;

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Disponibilidad",
    timezone: TZ,
  });

  await testDb.adminDb.insert(schema.practitioners).values([
    { id: practitionerA, clinicId, fullName: "Dra. Disponible" },
    { id: practitionerB, clinicId, fullName: "Dr. ConCita" },
  ]);

  await testDb.adminDb.insert(schema.patients).values({
    id: patientId,
    clinicId,
    firstName: "Paciente",
    lastName: "DePrueba",
  });

  await createAvailabilityRule(appDb, {
    clinicId,
    practitionerId: practitionerA,
    weekday: 1,
    startTime: "09:00",
    endTime: "12:00",
    validFrom: monday,
    slotMinutes: 15,
  });
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("disponibilidad", () => {
  it("genera los slots de la regla semanal", async () => {
    const result = await getAvailability(appDb, {
      clinicId,
      practitionerId: practitionerA,
      from: monday,
      to: plusDays(monday, 1),
      durationMinutes: 30,
    });

    expect(result.timezone).toBe(TZ);
    expect(result.slots).toHaveLength(11);
    expect(result.slots[0]?.startsAt.toISOString()).toBe(
      `${monday}T15:00:00.000Z`,
    );
    expect(result.slots[10]?.startsAt.toISOString()).toBe(
      `${monday}T17:30:00.000Z`,
    );
  });

  it("un bloqueo de agenda elimina los slots que solapa", async () => {
    const blockStart = local(monday, "10:00");
    const blockEnd = local(monday, "11:00");

    await createScheduleBlock(appDb, {
      clinicId,
      practitionerId: practitionerA,
      startsAt: blockStart,
      endsAt: blockEnd,
      type: "meeting",
      reason: "Reunion clinica",
    });

    const result = await getAvailability(appDb, {
      clinicId,
      practitionerId: practitionerA,
      from: monday,
      to: plusDays(monday, 1),
      durationMinutes: 30,
    });

    // 11 slots menos 09:45, 10:00, 10:15, 10:30 y 10:45 (todos solapan
    // el bloqueo de 10:00 a 11:00).
    expect(result.slots).toHaveLength(6);
    expect(
      result.slots.some(
        (slot) =>
          slot.startsAt.getTime() >= blockStart.getTime() &&
          slot.startsAt.getTime() < blockEnd.getTime(),
      ),
    ).toBe(false);
  });

  it("usa la duracion de la regla cuando no se envia durationMinutes", async () => {
    const result = await getAvailability(appDb, {
      clinicId,
      practitionerId: practitionerA,
      from: monday,
      to: plusDays(monday, 1),
    });

    // La regla es de 09:00 a 12:00 con slots de 15 min. Sin duracion explicita
    // cada cita dura 15 min, por lo que el bloqueo de 10:00 a 11:00 solo
    // elimina cuatro inicios (10:00, 10:15, 10:30 y 10:45).
    expect(result.slots).toHaveLength(8);
    expect(result.slots.at(-1)?.startsAt.toISOString()).toBe(
      `${monday}T17:45:00.000Z`,
    );
  });

  it("una cita reservada elimina sus slots de inicio", async () => {
    await createAvailabilityRule(appDb, {
      clinicId,
      practitionerId: practitionerB,
      weekday: 1,
      startTime: "09:00",
      endTime: "12:00",
      validFrom: monday,
      slotMinutes: 15,
    });

    await bookAppointment(appDb, {
      clinicId,
      patientId,
      practitionerId: practitionerB,
      startsAt: local(monday, "09:00"),
      endsAt: local(monday, "09:30"),
      timezone: TZ,
    });

    const result = await getAvailability(appDb, {
      clinicId,
      practitionerId: practitionerB,
      from: monday,
      to: plusDays(monday, 1),
      durationMinutes: 30,
    });

    // 11 slots menos 09:00 y 09:15 (ambos solapan la cita).
    expect(result.slots).toHaveLength(9);
    expect(result.slots[0]?.startsAt.toISOString()).toBe(
      `${monday}T15:30:00.000Z`,
    );
  });

  it("rechaza rangos mayores a 31 dias", async () => {
    await expect(
      getAvailability(appDb, {
        clinicId,
        practitionerId: practitionerA,
        from: monday,
        to: plusDays(monday, 40),
        durationMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: "RANGE_TOO_LARGE" });
  });

  it("rechaza una regla duplicada", async () => {
    await expect(
      createAvailabilityRule(appDb, {
        clinicId,
        practitionerId: practitionerA,
        weekday: 1,
        startTime: "09:00",
        endTime: "12:00",
        validFrom: monday,
        slotMinutes: 15,
      }),
    ).rejects.toMatchObject({ code: "RULE_DUPLICATED" });
  });

  it("devuelve 404 si el especialista es de otra clinica", async () => {
    await expect(
      getAvailability(appDb, {
        clinicId,
        practitionerId: randomUUID(),
        from: monday,
        to: plusDays(monday, 1),
        durationMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: "PRACTITIONER_NOT_FOUND" });
  });

  it("expone GET /api/v1/availability", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const url =
      `/api/v1/availability?practitionerId=${practitionerA}` +
      `&from=${monday}&to=${plusDays(monday, 1)}&durationMinutes=30`;

    const response = await app.inject({
      method: "GET",
      url,
      headers: { "x-clinic-id": clinicId },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.timezone).toBe(TZ);
    // La clinica A ya tiene el bloqueo de 10:00 a 11:00.
    expect(body.slots).toHaveLength(6);
    expect(typeof body.slots[0].startsAt).toBe("string");

    await app.close();
  });
});
