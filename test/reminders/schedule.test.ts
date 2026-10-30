import { describe, expect, it } from "vitest";
import { computeReminderSchedules } from "../../src/modules/reminders/schedule.js";

const TZ = "America/Mexico_City";

describe("computeReminderSchedules", () => {
  it("programa 48h, 24h y 2h antes", () => {
    const reminders = computeReminderSchedules({
      startsAt: new Date("2027-05-10T10:00:00-06:00"),
      timezone: TZ,
      now: new Date("2027-05-01T00:00:00-06:00"),
    });

    expect(reminders.map((r) => r.code)).toEqual([
      "reminder_48h",
      "reminder_24h",
      "reminder_2h",
    ]);
    expect(reminders.map((r) => r.scheduledFor.toISOString())).toEqual([
      "2027-05-08T16:00:00.000Z", // 10:00 local
      "2027-05-09T16:00:00.000Z",
      "2027-05-10T14:00:00.000Z", // 08:00 local
    ]);
  });

  it("mueve el recordatorio de horario de silencio a las 08:00", () => {
    const reminders = computeReminderSchedules({
      startsAt: new Date("2027-05-10T08:30:00-06:00"),
      timezone: TZ,
      now: new Date("2027-05-01T00:00:00-06:00"),
    });

    // 2h antes = 06:30 local (silencio) -> 08:00 local, aun antes de la cita.
    const twoHours = reminders.find((r) => r.code === "reminder_2h");
    expect(twoHours?.scheduledFor.toISOString()).toBe(
      "2027-05-10T14:00:00.000Z",
    );
  });

  it("no programa recordatorios en el pasado", () => {
    const now = new Date("2027-05-10T09:00:00-06:00");

    const reminders = computeReminderSchedules({
      startsAt: new Date("2027-05-10T10:00:00-06:00"),
      timezone: TZ,
      now,
    });

    expect(reminders).toHaveLength(0);
  });

  it("no programa un recordatorio despues de la cita al moverlo por silencio", () => {
    // Cita a las 07:00; el recordatorio de 2h cae a las 05:00 y se mueve a
    // las 08:00, que ya seria despues de la cita.
    const reminders = computeReminderSchedules({
      startsAt: new Date("2027-05-10T07:00:00-06:00"),
      timezone: TZ,
      now: new Date("2027-05-01T00:00:00-06:00"),
    });

    expect(reminders.some((r) => r.code === "reminder_2h")).toBe(false);
  });

  it("respeta el cambio de horario (DST)", () => {
    // 2027-03-14 en New York: la cita es a las 10:00 EDT. 48h reales antes
    // caen a las 09:00 EST del dia 12, no a las 10:00.
    const reminders = computeReminderSchedules({
      startsAt: new Date("2027-03-14T10:00:00-04:00"),
      timezone: "America/New_York",
      now: new Date("2027-03-01T00:00:00-05:00"),
    });

    const fortyEight = reminders.find((r) => r.code === "reminder_48h");
    expect(fortyEight?.scheduledFor.toISOString()).toBe(
      "2027-03-12T14:00:00.000Z",
    );
  });

  it("omite el aviso que quedaria despues de la cita al moverlo por silencio", () => {
    // Cita a las 23:00: el aviso de 2h cae a las 21:00 (silencio) y al moverlo
    // a las 08:00 del dia siguiente ya seria despues de la cita.
    const reminders = computeReminderSchedules({
      startsAt: new Date("2027-05-10T23:00:00-06:00"),
      timezone: TZ,
      now: new Date("2027-05-01T00:00:00-06:00"),
    });

    expect(reminders).toHaveLength(2);
    expect(reminders.some((r) => r.code === "reminder_2h")).toBe(false);
    // El de 24h se mueve de 23:00 a 08:00 del mismo dia de la cita.
    expect(
      reminders.find((r) => r.code === "reminder_24h")?.scheduledFor.toISOString(),
    ).toBe("2027-05-10T14:00:00.000Z");
  });
});
