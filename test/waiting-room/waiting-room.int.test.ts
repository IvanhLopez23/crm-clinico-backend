import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { getWaitingRoom } from "../../src/modules/waiting-room/service.js";
import { realtimeBus, publishRealtime } from "../../src/modules/realtime/bus.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;

let clinicId: string;
let practitionerId: string;
let patientA: string;
let patientB: string;
let patientC: string;
let patientD: string;

const now = new Date("2026-10-28T18:00:00Z");

function at(minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;

  clinicId = randomUUID();
  practitionerId = randomUUID();
  patientA = randomUUID();
  patientB = randomUUID();
  patientC = randomUUID();
  patientD = randomUUID();

  await testDb.adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Sala",
    timezone: TZ,
  });

  await testDb.adminDb.insert(schema.practitioners).values({
    id: practitionerId,
    clinicId,
    fullName: "Dra. Sala",
    avgConsultMinutes: "30.00",
  });

  await testDb.adminDb.insert(schema.patients).values([
    { id: patientA, clinicId, firstName: "Ana", lastName: "Uno" },
    { id: patientB, clinicId, firstName: "Beto", lastName: "Dos" },
    { id: patientC, clinicId, firstName: "Carla", lastName: "Tres" },
    { id: patientD, clinicId, firstName: "Dora", lastName: "Cuatro" },
  ]);

  await testDb.adminDb.insert(schema.patientAllergies).values({
    clinicId,
    patientId: patientA,
    allergen: "Penicilina",
    severity: "anaphylaxis",
  });

  await testDb.adminDb.insert(schema.appointments).values([
    {
      clinicId,
      patientId: patientA,
      practitionerId,
      startsAt: at(-15),
      endsAt: at(5),
      timezone: TZ,
      status: "arrived",
      checkedInAt: at(-20),
      serviceNameSnapshot: "Consulta general",
    },
    {
      clinicId,
      patientId: patientB,
      practitionerId,
      startsAt: at(-45),
      endsAt: at(-15),
      timezone: TZ,
      status: "arrived",
      checkedInAt: at(-40),
      serviceNameSnapshot: "Consulta general",
    },
    {
      clinicId,
      patientId: patientC,
      practitionerId,
      startsAt: at(-100),
      endsAt: at(-70),
      timezone: TZ,
      status: "in_consultation",
      checkedInAt: at(-105),
      consultStartedAt: at(-60),
      serviceNameSnapshot: "Consulta general",
    },
    {
      clinicId,
      patientId: patientD,
      practitionerId,
      startsAt: at(10),
      endsAt: at(40),
      timezone: TZ,
      status: "confirmed",
      serviceNameSnapshot: "Consulta general",
    },
    {
      clinicId,
      patientId: patientD,
      practitionerId,
      startsAt: at(-240),
      endsAt: at(-210),
      timezone: TZ,
      status: "completed",
      checkedInAt: at(-240),
      consultStartedAt: at(-235),
      consultEndedAt: at(-215),
      serviceNameSnapshot: "Consulta general",
    },
  ]);
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("sala de espera", () => {
  it("separa en sala, en consulta y próximos, con semáforo y alergia", async () => {
    const room = await getWaitingRoom(appDb, {
      clinicId,
      date: "2026-10-28",
      now,
    });

    expect(room.inRoom).toHaveLength(2);
    expect(room.inConsultation).toHaveLength(1);
    expect(room.upcoming).toHaveLength(1);

    const ana = room.inRoom.find((item) => item.patientId === patientA);
    expect(ana?.waitMinutes).toBe(20);
    expect(ana?.level).toBe("amber");
    expect(ana?.allergyAlert).toBe(true);

    const beto = room.inRoom.find((item) => item.patientId === patientB);
    expect(beto?.waitMinutes).toBe(40);
    expect(beto?.level).toBe("red");

    const carla = room.inConsultation[0];
    expect(carla?.patientId).toBe(patientC);
    expect(carla?.delayMinutes).toBeGreaterThan(25);
    expect(carla?.level).toBe("red");

    expect(room.practitionerStatus[0]).toMatchObject({
      practitionerId,
      waitingCount: 2,
      level: "red",
    });

    expect(room.upcoming[0]?.patientId).toBe(patientD);
    expect(room.upcoming[0]?.level).toBe("green");
  });
});

describe("bus de tiempo real", () => {
  it("entrega eventos solo al tenant suscrito y permite desuscribir", () => {
    const received: string[] = [];
    const unsubscribe = realtimeBus.subscribe(clinicId, (event) => {
      received.push(`${event.topic}:${event.type}`);
    });

    publishRealtime(clinicId, "agenda", "appointment.created", {
      appointmentId: randomUUID(),
    });
    publishRealtime(randomUUID(), "sala", "appointment.checked_in");
    publishRealtime(clinicId, "sala", "appointment.checked_in");

    expect(received).toEqual([
      "agenda:appointment.created",
      "sala:appointment.checked_in",
    ]);

    unsubscribe();
    publishRealtime(clinicId, "agenda", "appointment.updated");
    expect(received).toHaveLength(2);
  });
});
