import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { buildApp } from "../../src/app.js";
import {
  bookAppointment,
  cancelAppointment,
} from "../../src/modules/appointments/service.js";
import { createAvailabilityRule } from "../../src/modules/availability/service.js";
import {
  acceptWaitlistOffer,
  cancelWaitlistEntry,
  createWaitlistEntry,
  declineWaitlistOffer,
  expireWaitlistOffers,
} from "../../src/modules/waitlist/service.js";
import { startTestDatabase, type TestDatabase } from "../helpers/test-db.js";
import { createStaffUser } from "../helpers/auth.js";

const TZ = "America/Mexico_City";

let testDb: TestDatabase | undefined;
let appDb: Database;
let adminDb: Database;

let clinicId: string;
let patientId: string;
let monday: string;
let staffToken: string;

const practitioners = {
  accept: randomUUID(),
  decline: randomUUID(),
  expiry: randomUUID(),
  window: randomUUID(),
  cancelEntry: randomUUID(),
};

function at(time: string): Date {
  return new Date(`${monday}T${time}:00-06:00`);
}

function plusMinutes(time: string, minutes: number): string {
  const [h = "0", m = "0"] = time.split(":");
  const total = Number(h) * 60 + Number(m) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

async function book(practitionerId: string, time: string) {
  return bookAppointment(appDb, {
    clinicId,
    patientId,
    practitionerId,
    startsAt: at(time),
    endsAt: at(plusMinutes(time, 30)),
    timezone: TZ,
    bookedVia: "staff",
  });
}

async function addEntry(
  practitionerId: string,
  priority: number,
  window?: { from: string; to: string },
) {
  return createWaitlistEntry(appDb, {
    clinicId,
    patientId,
    practitionerId,
    earliestDate: monday,
    latestDate: monday,
    priority,
    ...(window
      ? { preferredTimeFrom: window.from, preferredTimeTo: window.to }
      : {}),
  });
}

async function offersFor(entryId: string) {
  return adminDb
    .select()
    .from(schema.waitlistOffers)
    .where(eq(schema.waitlistOffers.entryId, entryId));
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  appDb = testDb.appDb;
  adminDb = testDb.adminDb;

  clinicId = randomUUID();
  patientId = randomUUID();

  monday = DateTime.now()
    .setZone(TZ)
    .plus({ days: 7 })
    .startOf("week")
    .toISODate() as string;

  await adminDb.insert(schema.clinics).values({
    id: clinicId,
    name: "Clinica Lista de Espera",
    timezone: TZ,
  });

  await adminDb.insert(schema.practitioners).values(
    Object.values(practitioners).map((id) => ({
      id,
      clinicId,
      fullName: `Dra. ${id.slice(0, 4)}`,
    })),
  );

  await adminDb.insert(schema.patients).values({
    id: patientId,
    clinicId,
    firstName: "Paciente",
    lastName: "Espera",
    phoneE164: "+5215512345678",
    email: "espera@example.com",
  });

  for (const practitionerId of Object.values(practitioners)) {
    await createAvailabilityRule(appDb, {
      clinicId,
      practitionerId,
      weekday: 1,
      startTime: "09:00",
      endTime: "12:00",
      validFrom: monday,
      slotMinutes: 15,
    });
  }

  const staff = await createStaffUser(adminDb, {
    clinicId,
    role: "receptionist",
  });
  staffToken = staff.token;
}, 300_000);

afterAll(async () => {
  await testDb?.close();
}, 60_000);

describe("lista de espera", () => {
  it("registra una entrada en espera", async () => {
    const entry = await addEntry(practitioners.accept, 0);

    expect(entry.status).toBe("waiting");
    expect(entry.practitionerId).toBe(practitioners.accept);
  });

  it("al cancelar una cita ofrece el hueco al de mayor prioridad", async () => {
    const low = await addEntry(practitioners.accept, 0);
    const high = await addEntry(practitioners.accept, 10);

    const appointment = await book(practitioners.accept, "09:00");
    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    const highOffers = await offersFor(high.id);
    expect(highOffers).toHaveLength(1);
    expect(highOffers[0]?.status).toBe("pending");
    expect(highOffers[0]?.startsAt.toISOString()).toBe(at("09:00").toISOString());
    expect(highOffers[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [lowEntry] = await adminDb
      .select()
      .from(schema.waitlistEntries)
      .where(eq(schema.waitlistEntries.id, low.id));
    expect(lowEntry?.status).toBe("waiting");
    expect(await offersFor(low.id)).toHaveLength(0);
  });

  it("aceptar la oferta crea la cita y cierra la entrada", async () => {
    const high = await adminDb
      .select()
      .from(schema.waitlistEntries)
      .where(eq(schema.waitlistEntries.practitionerId, practitioners.accept));
    const offeredEntry = high.find((e) => e.status === "offered");
    if (!offeredEntry) throw new Error("entrada ofertada no encontrada");

    const [offer] = await offersFor(offeredEntry.id);
    if (!offer) throw new Error("oferta no encontrada");

    const appointment = await acceptWaitlistOffer(appDb, {
      clinicId,
      offerId: offer.id,
      bookedVia: "waitlist",
    });

    expect(appointment.bookedVia).toBe("waitlist");
    expect(appointment.status).toBe("requested");

    const [updatedOffer] = await offersFor(offeredEntry.id);
    expect(updatedOffer?.status).toBe("accepted");
    expect(updatedOffer?.appointmentId).toBe(appointment.id);

    const [entry] = await adminDb
      .select()
      .from(schema.waitlistEntries)
      .where(eq(schema.waitlistEntries.id, offeredEntry.id));
    expect(entry?.status).toBe("booked");
  });

  it("rechazar la oferta pasa el hueco al siguiente candidato", async () => {
    const first = await addEntry(practitioners.decline, 5);
    const second = await addEntry(practitioners.decline, 0);

    const appointment = await book(practitioners.decline, "10:00");
    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    const firstOffers = await offersFor(first.id);
    expect(firstOffers[0]?.status).toBe("pending");

    const result = await declineWaitlistOffer(appDb, {
      clinicId,
      offerId: firstOffers[0]!.id,
    });

    expect(result.declined.status).toBe("declined");
    expect(result.nextOffer?.entryId).toBe(second.id);

    const secondOffers = await offersFor(second.id);
    expect(secondOffers[0]?.status).toBe("pending");
  });

  it("una oferta vencida se expira y encadena al siguiente", async () => {
    const first = await addEntry(practitioners.expiry, 5);
    const second = await addEntry(practitioners.expiry, 0);

    const appointment = await book(practitioners.expiry, "11:00");
    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    const [firstOffer] = await offersFor(first.id);
    if (!firstOffer) throw new Error("oferta no creada");

    const now = new Date();
    await adminDb
      .update(schema.waitlistOffers)
      .set({ expiresAt: new Date(now.getTime() - 60_000) })
      .where(eq(schema.waitlistOffers.id, firstOffer.id));

    const summary = await expireWaitlistOffers(adminDb, { now });

    expect(summary.expired).toBe(1);
    expect(summary.reoffered).toBe(1);

    const [expired] = await offersFor(first.id);
    expect(expired?.status).toBe("expired");

    const secondOffers = await offersFor(second.id);
    expect(secondOffers[0]?.status).toBe("pending");
  });

  it("respeta la ventana horaria preferida", async () => {
    const entry = await addEntry(practitioners.window, 50, {
      from: "11:00",
      to: "12:00",
    });

    const appointment = await book(practitioners.window, "09:30");
    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    expect(await offersFor(entry.id)).toHaveLength(0);

    const [stored] = await adminDb
      .select()
      .from(schema.waitlistEntries)
      .where(eq(schema.waitlistEntries.id, entry.id));
    expect(stored?.status).toBe("waiting");
  });

  it("cancelar la entrada libera la oferta y la pasa al siguiente", async () => {
    const first = await addEntry(practitioners.cancelEntry, 5);
    const second = await addEntry(practitioners.cancelEntry, 0);

    const appointment = await book(practitioners.cancelEntry, "10:30");
    await cancelAppointment(appDb, {
      clinicId,
      appointmentId: appointment.id,
      reasonCode: "patient_request",
      cancelledBy: "staff",
    });

    const [offer] = await offersFor(first.id);
    if (!offer) throw new Error("oferta no creada");

    await cancelWaitlistEntry(appDb, { clinicId, id: first.id });

    const [superseded] = await offersFor(first.id);
    expect(superseded?.status).toBe("superseded");

    const secondOffers = await offersFor(second.id);
    expect(secondOffers[0]?.status).toBe("pending");
  });

  it("expone la lista y las ofertas por HTTP", async () => {
    const app = buildApp({ db: appDb, logger: false });

    const entries = await app.inject({
      method: "GET",
      url: "/api/v1/waitlist?status=waiting",
      headers: { authorization: `Bearer ${staffToken}` },
    });

    expect(entries.statusCode).toBe(200);
    expect(Array.isArray(entries.json())).toBe(true);

    const offers = await app.inject({
      method: "GET",
      url: "/api/v1/waitlist/offers?status=pending",
      headers: { authorization: `Bearer ${staffToken}` },
    });

    expect(offers.statusCode).toBe(200);
    expect(Array.isArray(offers.json())).toBe(true);

    await app.close();
  });
});
