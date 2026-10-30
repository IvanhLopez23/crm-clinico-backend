import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { createDatabase } from "../db/client.js";
import * as schema from "../db/schema/index.js";
import { withTenant } from "../db/tenant.js";
import { env } from "../env.js";
import { hashPassword } from "../lib/password.js";
import {
  emailBlindIndex,
  encryptPhi,
  maskEmail,
  maskPhone,
  phoneBlindIndex,
} from "../lib/phi-crypto.js";

const TZ = "America/Mexico_City";
const EMAIL = "admin@demo.local";
const PASSWORD = "demo-password-123";

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
const { db, pool } = createDatabase(connectionString);

try {
  const clinicId = randomUUID();
  const practitionerA = randomUUID();
  const practitionerB = randomUUID();
  const serviceGeneral = randomUUID();
  const serviceCardio = randomUUID();
  const householdIds = [randomUUID(), randomUUID(), randomUUID()];

  const patients = [
    { id: randomUUID(), firstName: "Ana", lastName: "Martinez" },
    { id: randomUUID(), firstName: "Luis", lastName: "Ramirez" },
    { id: randomUUID(), firstName: "Sofia", lastName: "Castro" },
  ];

  const [patientA, patientB, patientC] = patients;
  if (!patientA || !patientB || !patientC) {
    throw new Error("no se pudieron crear los pacientes demo");
  }

  const today = DateTime.now().setZone(TZ).startOf("day");
  const validFrom = today.minus({ days: 30 }).toISODate();

  if (!validFrom) throw new Error("fecha invalida");

  const agenda = [
    { hour: 9, minute: 0, practitionerId: practitionerA, patient: patientA, status: "confirmed" },
    { hour: 9, minute: 30, practitionerId: practitionerB, patient: patientB, status: "requested" },
    { hour: 10, minute: 30, practitionerId: practitionerA, patient: patientC, status: "confirmed" },
    { hour: 12, minute: 0, practitionerId: practitionerB, patient: patientA, status: "completed" },
  ];

  // Todo el seed corre con el tenant fijado: funciona con cualquier rol
  // (no requiere superusuario) y respeta RLS.
  await withTenant(db, clinicId, async (tx) => {
    await tx.insert(schema.clinics).values({
      id: clinicId,
      name: "Clinica Aurora",
      timezone: TZ,
    });

    await tx.insert(schema.practitioners).values([
      {
        id: practitionerA,
        clinicId,
        fullName: "Dra. Valentina Rios",
        specialty: "Medicina general",
      },
      {
        id: practitionerB,
        clinicId,
        fullName: "Dr. Mateo Herrera",
        specialty: "Cardiologia",
      },
    ]);

    await tx.insert(schema.households).values(
      patients.map((patient, index) => ({
        id: householdIds[index],
        clinicId,
        name: `${patient.firstName} ${patient.lastName}`,
      })),
    );

    await tx.insert(schema.patients).values(
      patients.map((patient, index) => ({
        id: patient.id,
        clinicId,
        householdId: householdIds[index],
        relationship: "self",
        isAccountHolder: true,
        firstName: patient.firstName,
        lastName: patient.lastName,
        phoneE164: "+5215512345678",
        email: `${patient.firstName.toLowerCase()}@example.com`,
        status: "active",
      })),
    );

    for (const [index, patient] of patients.entries()) {
      await tx
        .update(schema.households)
        .set({ billingPatientId: patient.id })
        .where(eq(schema.households.id, householdIds[index] as string));
    }

    await tx.insert(schema.contactPoints).values(
      patients.flatMap((patient) => {
        const phone = "+5215512345678";
        const email = `${patient.firstName.toLowerCase()}@example.com`;
        return [
          {
            clinicId,
            ownerType: "patient",
            ownerId: patient.id,
            kind: "phone",
            valueEnc: encryptPhi(phone),
            valueBidx: phoneBlindIndex(phone),
            valueMasked: maskPhone(phone),
            isPrimary: true,
            source: "seed",
          },
          {
            clinicId,
            ownerType: "patient",
            ownerId: patient.id,
            kind: "email",
            valueEnc: encryptPhi(email),
            valueBidx: emailBlindIndex(email),
            valueMasked: maskEmail(email),
            isPrimary: true,
            source: "seed",
          },
        ];
      }),
    );

    await tx.insert(schema.services).values([
      {
        id: serviceGeneral,
        clinicId,
        code: "GENERAL",
        name: "Consulta general",
        durationMinutes: 30,
        bufferAfterMinutes: 5,
        priceCents: 80_000,
        currency: "MXN",
      },
      {
        id: serviceCardio,
        clinicId,
        code: "CARDIO",
        name: "Consulta de cardiologia",
        durationMinutes: 45,
        bufferAfterMinutes: 10,
        priceCents: 120_000,
        currency: "MXN",
      },
    ]);

    await tx.insert(schema.users).values({
      clinicId,
      email: EMAIL,
      passwordHash: hashPassword(PASSWORD),
      fullName: "Admin Demo",
      role: "admin",
    });

    await tx.insert(schema.availabilityRules).values(
      [1, 2, 3, 4, 5].map((weekday) => ({
        clinicId,
        practitionerId: practitionerA,
        weekday,
        startTime: "09:00",
        endTime: "14:00",
        validFrom,
        slotMinutes: 15,
      })),
    );

    await tx.insert(schema.appointments).values(
      agenda.map((item) => {
        const startsAt = today.set({
          hour: item.hour,
          minute: item.minute,
          second: 0,
          millisecond: 0,
        });

        return {
          clinicId,
          patientId: item.patient.id,
          practitionerId: item.practitionerId,
          serviceId: serviceGeneral,
          householdId: householdIds[patients.indexOf(item.patient)] ?? null,
          startsAt: startsAt.toUTC().toJSDate(),
          endsAt: startsAt.plus({ minutes: 30 }).toUTC().toJSDate(),
          timezone: TZ,
          status: item.status,
          bookedVia: "staff",
          serviceNameSnapshot: "Consulta general",
          durationMinutesSnapshot: 30,
          bufferBeforeMinutesSnapshot: 0,
          bufferAfterMinutesSnapshot: 5,
          priceCentsSnapshot: 80_000,
          currencySnapshot: "MXN",
          confirmedAt: ["confirmed", "completed"].includes(item.status)
            ? startsAt.minus({ hours: 1 }).toUTC().toJSDate()
            : null,
          checkedInAt:
            item.status === "completed"
              ? startsAt.toUTC().toJSDate()
              : null,
          consultStartedAt:
            item.status === "completed"
              ? startsAt.toUTC().toJSDate()
              : null,
          consultEndedAt:
            item.status === "completed"
              ? startsAt.plus({ minutes: 30 }).toUTC().toJSDate()
              : null,
          checkedOutAt:
            item.status === "completed"
              ? startsAt.plus({ minutes: 30 }).toUTC().toJSDate()
              : null,
        };
      }),
    );
  });

  console.log(
    JSON.stringify(
      {
        event: "demo.seeded",
        clinicId,
        database: connectionString.replace(/:\/\/[^@]+@/, "://***@"),
        email: EMAIL,
        password: PASSWORD,
        loginUrl: "http://localhost:3001/login",
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
