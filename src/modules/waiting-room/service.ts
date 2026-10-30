import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Database } from "../../db/client.js";
import { appointments } from "../../db/schema/appointments.js";
import { clinics } from "../../db/schema/clinics.js";
import { patientAllergies } from "../../db/schema/patient-allergies.js";
import { patients } from "../../db/schema/patients.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";

export type WaitingRoomLevel = "green" | "amber" | "red";

export type WaitingRoomItem = {
  appointmentId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  practitionerId: string;
  practitionerName: string;
  practitionerColor: string;
  serviceName: string | null;
  status: string;
  scheduledAt: string;
  checkedInAt: string | null;
  roomedAt: string | null;
  consultStartedAt: string | null;
  waitMinutes: number;
  delayMinutes: number;
  expectedConsultMinutes: number;
  level: WaitingRoomLevel;
  levelReason: string;
  allergyAlert: boolean;
};

export type WaitingRoomResponse = {
  generatedAt: string;
  timezone: string;
  date: string;
  inRoom: WaitingRoomItem[];
  inConsultation: WaitingRoomItem[];
  upcoming: WaitingRoomItem[];
  practitionerStatus: Array<{
    practitionerId: string;
    practitionerName: string;
    color: string;
    delayMinutes: number;
    level: WaitingRoomLevel;
    waitingCount: number;
  }>;
};

const ACTIVE_STATUSES = [
  "requested",
  "confirmed",
  "arrived",
  "in_consultation",
] as const;

export async function getWaitingRoom(
  db: Database,
  params: { clinicId: string; date?: string; now?: Date; practitionerId?: string },
): Promise<WaitingRoomResponse> {
  const now = params.now ?? new Date();

  return withTenant(db, params.clinicId, async (tx) => {
    const [clinic] = await tx
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, params.clinicId))
      .limit(1);

    if (!clinic) {
      throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
    }

    const date =
      params.date ?? DateTime.fromJSDate(now, { zone: clinic.timezone }).toISODate();
    if (!date) {
      throw new AppError(422, "INVALID_DATE", "Fecha invalida");
    }

    const dayStart = DateTime.fromISO(date, { zone: clinic.timezone })
      .startOf("day")
      .toUTC()
      .toJSDate();
    const dayEnd = DateTime.fromISO(date, { zone: clinic.timezone })
      .startOf("day")
      .plus({ days: 1 })
      .toUTC()
      .toJSDate();

    const rows = await tx
      .select({
        appointmentId: appointments.id,
        patientId: appointments.patientId,
        patientFirstName: patients.firstName,
        patientLastName: patients.lastName,
        practitionerId: appointments.practitionerId,
        practitionerName: practitioners.fullName,
        practitionerColor: practitioners.color,
        avgConsultMinutes: practitioners.avgConsultMinutes,
        serviceName: appointments.serviceNameSnapshot,
        durationMinutes: appointments.durationMinutesSnapshot,
        status: appointments.status,
        startsAt: appointments.startsAt,
        checkedInAt: appointments.checkedInAt,
        roomedAt: appointments.roomedAt,
        consultStartedAt: appointments.consultStartedAt,
      })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .innerJoin(
        practitioners,
        eq(practitioners.id, appointments.practitionerId),
      )
      .where(
        and(
          eq(appointments.clinicId, params.clinicId),
          params.practitionerId
            ? eq(appointments.practitionerId, params.practitionerId)
            : undefined,
          inArray(appointments.status, [...ACTIVE_STATUSES]),
          gte(appointments.startsAt, dayStart),
          lt(appointments.startsAt, dayEnd),
        ),
      )
      .orderBy(asc(appointments.startsAt));

    const patientIds = [...new Set(rows.map((row) => row.patientId))];
    const allergyRows =
      patientIds.length > 0
        ? await tx
            .select({
              patientId: patientAllergies.patientId,
              severity: patientAllergies.severity,
            })
            .from(patientAllergies)
            .where(
              and(
                eq(patientAllergies.clinicId, params.clinicId),
                eq(patientAllergies.isActive, true),
                inArray(patientAllergies.patientId, patientIds),
                inArray(patientAllergies.severity, ["severe", "anaphylaxis"]),
              ),
            )
        : [];
    const allergyPatients = new Set(allergyRows.map((row) => row.patientId));

    const items = rows.map((row) =>
      toWaitingRoomItem(row, now, allergyPatients.has(row.patientId)),
    );

    const inRoom = items.filter((item) => item.status === "arrived");
    const inConsultation = items.filter(
      (item) => item.status === "in_consultation",
    );
    const upcoming = items
      .filter(
        (item) =>
          ["requested", "confirmed"].includes(item.status) &&
          new Date(item.scheduledAt).getTime() > now.getTime() &&
          new Date(item.scheduledAt).getTime() <=
            now.getTime() + 30 * 60_000,
      )
      .slice(0, 8);

    const practitionerMap = new Map<
      string,
      {
        practitionerId: string;
        practitionerName: string;
        color: string;
        delayMinutes: number;
        level: WaitingRoomLevel;
        waitingCount: number;
      }
    >();

    for (const item of [...inRoom, ...inConsultation]) {
      const existing = practitionerMap.get(item.practitionerId);
      const level = worseLevel(existing?.level ?? "green", item.level);
      practitionerMap.set(item.practitionerId, {
        practitionerId: item.practitionerId,
        practitionerName: item.practitionerName,
        color: item.practitionerColor,
        delayMinutes: Math.max(existing?.delayMinutes ?? 0, item.delayMinutes),
        level,
        waitingCount:
          (existing?.waitingCount ?? 0) + (item.status === "arrived" ? 1 : 0),
      });
    }

    return {
      generatedAt: now.toISOString(),
      timezone: clinic.timezone,
      date,
      inRoom,
      inConsultation,
      upcoming,
      practitionerStatus: [...practitionerMap.values()],
    };
  });
}

function toWaitingRoomItem(
  row: {
    appointmentId: string;
    patientId: string;
    patientFirstName: string;
    patientLastName: string;
    practitionerId: string;
    practitionerName: string;
    practitionerColor: string;
    avgConsultMinutes: string | null;
    serviceName: string | null;
    durationMinutes: number | null;
    status: string;
    startsAt: Date;
    checkedInAt: Date | null;
    roomedAt: Date | null;
    consultStartedAt: Date | null;
  },
  now: Date,
  allergyAlert: boolean,
): WaitingRoomItem {
  const expectedConsultMinutes =
    Number(row.avgConsultMinutes ?? row.durationMinutes ?? 30) || 30;

  const waitMinutes =
    row.checkedInAt && row.status !== "in_consultation"
      ? minutesBetween(row.checkedInAt, now)
      : 0;

  const delayMinutes =
    row.consultStartedAt && row.status === "in_consultation"
      ? Math.max(
          0,
          minutesBetween(
            row.startsAt,
            new Date(
              row.consultStartedAt.getTime() +
                expectedConsultMinutes * 60_000,
            ),
          ),
        )
      : Math.max(0, minutesBetween(row.startsAt, now));

  const level = levelFor(waitMinutes, delayMinutes);

  return {
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    patientFirstName: row.patientFirstName,
    patientLastName: row.patientLastName,
    practitionerId: row.practitionerId,
    practitionerName: row.practitionerName,
    practitionerColor: row.practitionerColor,
    serviceName: row.serviceName,
    status: row.status,
    scheduledAt: row.startsAt.toISOString(),
    checkedInAt: row.checkedInAt?.toISOString() ?? null,
    roomedAt: row.roomedAt?.toISOString() ?? null,
    consultStartedAt: row.consultStartedAt?.toISOString() ?? null,
    waitMinutes,
    delayMinutes,
    expectedConsultMinutes,
    level,
    levelReason: levelReason(level, waitMinutes, delayMinutes),
    allergyAlert,
  };
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

function levelFor(waitMinutes: number, delayMinutes: number): WaitingRoomLevel {
  if (waitMinutes > 30 || delayMinutes > 25) return "red";
  if (waitMinutes > 15 || delayMinutes > 10) return "amber";
  return "green";
}

function levelReason(
  level: WaitingRoomLevel,
  waitMinutes: number,
  delayMinutes: number,
): string {
  if (level === "red") {
    return waitMinutes > 30 ? "wait_gt_30" : "delay_gt_25";
  }
  if (level === "amber") {
    return waitMinutes > 15 ? "wait_16_30" : "delay_11_25";
  }
  return "on_time";
}

const LEVEL_ORDER: Record<WaitingRoomLevel, number> = {
  green: 0,
  amber: 1,
  red: 2,
};

function worseLevel(a: WaitingRoomLevel, b: WaitingRoomLevel): WaitingRoomLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}
