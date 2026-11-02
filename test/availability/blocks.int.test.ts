import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import {
  createAvailabilityRule,
  createScheduleBlock,
  deleteScheduleBlock,
  getAvailability,
} from "../../src/modules/availability/service.js";
import { createStaffUser } from "../helpers/auth.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;
let app: ReturnType<typeof buildApp>;
let clinicId: string;
let practitionerId: string;
let adminToken: string;
let monday: string;

function plusDays(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: TZ })
    .plus({ days })
    .toISODate() as string;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  app = buildApp({ db: appDb, logger: false });

  clinicId = randomUUID();
  practitionerId = randomUUID();
  monday = DateTime.now()
    .setZone(TZ)
    .plus({ days: 7 })
    .startOf("week")
    .toISODate() as string;

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Bloqueos",
    timezone: TZ,
  });

  await testDb.adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Bloqueos",
  });

  for (const weekday of [1, 2]) {
    await createAvailabilityRule(appDb, {
      clinicId,
      practitionerId,
      weekday,
      startTime: "09:00",
      endTime: "12:00",
      validFrom: monday,
      slotMinutes: 15,
    });
  }

  const admin = await createStaffUser(testDb.adminDb, {
    clinicId,
    role: "admin",
  });
  adminToken = admin.token;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await testDb?.close();
}, 60_000);

describe("bloqueos de agenda", () => {
  it("un dia completo deja la agenda sin slots", async () => {
    const block = await createScheduleBlock(appDb, {
      clinicId,
      practitionerId,
      startDate: monday,
      endDate: monday,
      startAllDay: true,
      endAllDay: true,
      type: "vacation",
    });

    const result = await getAvailability(appDb, {
      clinicId,
      practitionerId,
      from: monday,
      to: plusDays(monday, 1),
      durationMinutes: 30,
    });

    expect(result.slots).toHaveLength(0);

    await deleteScheduleBlock(appDb, { clinicId, id: block.id });
  });

  it("varios dias completos bloquean todo el rango", async () => {
    const block = await createScheduleBlock(appDb, {
      clinicId,
      practitionerId,
      startDate: monday,
      endDate: plusDays(monday, 1),
      startAllDay: true,
      endAllDay: true,
      type: "vacation",
    });

    for (const day of [0, 1]) {
      const result = await getAvailability(appDb, {
        clinicId,
        practitionerId,
        from: plusDays(monday, day),
        to: plusDays(monday, day + 1),
        durationMinutes: 30,
      });
      expect(result.slots).toHaveLength(0);
    }

    await deleteScheduleBlock(appDb, { clinicId, id: block.id });
  });

  it("un rango parcial solo bloquea las horas indicadas", async () => {
    const block = await createScheduleBlock(appDb, {
      clinicId,
      practitionerId,
      startDate: monday,
      endDate: monday,
      startAllDay: false,
      endAllDay: false,
      startTime: "10:00",
      endTime: "11:00",
      type: "meeting",
    });

    const result = await getAvailability(appDb, {
      clinicId,
      practitionerId,
      from: monday,
      to: plusDays(monday, 1),
      durationMinutes: 30,
    });

    const times = result.slots.map((slot) =>
      DateTime.fromJSDate(slot.startsAt, { zone: TZ }).toFormat("HH:mm"),
    );

    expect(times).toContain("09:00");
    expect(times).not.toContain("10:00");
    expect(times).not.toContain("10:30");
    expect(times).toContain("11:00");

    await deleteScheduleBlock(appDb, { clinicId, id: block.id });
  });

  it("acepta el modo anterior con startsAt y endsAt", async () => {
    const startsAt = DateTime.fromISO(`${monday}T10:00`, { zone: TZ })
      .toUTC()
      .toJSDate();
    const endsAt = DateTime.fromISO(`${monday}T11:00`, { zone: TZ })
      .toUTC()
      .toJSDate();

    const block = await createScheduleBlock(appDb, {
      clinicId,
      practitionerId,
      startsAt,
      endsAt,
      type: "meeting",
    });

    expect(block.startsAt.toISOString()).toBe(startsAt.toISOString());
    expect(block.endsAt.toISOString()).toBe(endsAt.toISOString());

    await deleteScheduleBlock(appDb, { clinicId, id: block.id });
  });

  it("crea un dia completo desde la API", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/availability/blocks",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        practitionerId,
        startDate: monday,
        endDate: monday,
        startAllDay: true,
        endAllDay: true,
        type: "vacation",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    const expectedStart = DateTime.fromISO(monday, { zone: TZ })
      .startOf("day")
      .toUTC()
      .toISO();
    const expectedEnd = DateTime.fromISO(monday, { zone: TZ })
      .plus({ days: 1 })
      .startOf("day")
      .toUTC()
      .toISO();

    expect(new Date(body.startsAt).toISOString()).toBe(expectedStart);
    expect(new Date(body.endsAt).toISOString()).toBe(expectedEnd);
  });

  it("rechaza un rango sin hora ni todo el dia", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/availability/blocks",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        practitionerId,
        startDate: monday,
        endDate: monday,
        type: "meeting",
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
