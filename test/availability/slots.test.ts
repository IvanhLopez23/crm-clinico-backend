import { describe, expect, it } from "vitest";
import { generateSlots, type AvailabilityRule } from "../../src/modules/availability/slots.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");

const mondayRule: AvailabilityRule = {
  weekday: 1,
  startTime: "09:00:00",
  endTime: "12:00:00",
  validFrom: "2027-01-01",
  validTo: null,
  slotMinutes: 15,
};

describe("generateSlots", () => {
  it("genera slots de 30 min cada 15 min dentro de la regla", () => {
    const slots = generateSlots({
      rules: [mondayRule],
      from: "2027-03-01",
      to: "2027-03-02",
      timezone: "America/Mexico_City",
      durationMinutes: 30,
      now: NOW,
    });

    expect(slots).toHaveLength(11);
    expect(slots[0]?.startsAt.toISOString()).toBe("2027-03-01T15:00:00.000Z");
    expect(slots[0]?.endsAt.toISOString()).toBe("2027-03-01T15:30:00.000Z");
    expect(slots[10]?.startsAt.toISOString()).toBe("2027-03-01T17:30:00.000Z");
  });

  it("respeta el ultimo slot que cabe completo antes del fin de la regla", () => {
    const slots = generateSlots({
      rules: [{ ...mondayRule, endTime: "10:00:00" }],
      from: "2027-03-01",
      to: "2027-03-02",
      timezone: "America/Mexico_City",
      durationMinutes: 30,
      now: NOW,
    });

    // 09:00, 09:15 y 09:30; 09:45 no cabe (terminaria 10:15).
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2027-03-01T15:00:00.000Z",
      "2027-03-01T15:15:00.000Z",
      "2027-03-01T15:30:00.000Z",
    ]);
  });

  it("descarta slots que solapan un intervalo ocupado", () => {
    const slots = generateSlots({
      rules: [mondayRule],
      from: "2027-03-01",
      to: "2027-03-02",
      timezone: "America/Mexico_City",
      durationMinutes: 30,
      now: NOW,
      busy: [
        {
          startsAt: new Date("2027-03-01T15:00:00.000Z"),
          endsAt: new Date("2027-03-01T15:30:00.000Z"),
        },
      ],
    });

    expect(slots).toHaveLength(9);
    expect(slots.some((s) => s.startsAt.toISOString() === "2027-03-01T15:00:00.000Z")).toBe(false);
    expect(slots.some((s) => s.startsAt.toISOString() === "2027-03-01T15:15:00.000Z")).toBe(false);
    // 09:30 ya no solapa con 09:00-09:30.
    expect(slots.some((s) => s.startsAt.toISOString() === "2027-03-01T15:30:00.000Z")).toBe(true);
  });

  it("no ofrece slots en el pasado", () => {
    const slots = generateSlots({
      rules: [mondayRule],
      from: "2027-03-01",
      to: "2027-03-02",
      timezone: "America/Mexico_City",
      durationMinutes: 30,
      now: new Date("2027-03-01T16:00:00.000Z"), // 10:00 local
    });

    expect(slots).toHaveLength(6);
    expect(slots[0]?.startsAt.toISOString()).toBe("2027-03-01T16:15:00.000Z");
  });

  it("deduplica reglas solapadas", () => {
    const slots = generateSlots({
      rules: [mondayRule, { ...mondayRule }],
      from: "2027-03-01",
      to: "2027-03-02",
      timezone: "America/Mexico_City",
      durationMinutes: 30,
      now: NOW,
    });

    expect(slots).toHaveLength(11);
  });

  it("ignora reglas fuera de su vigencia", () => {
    const slots = generateSlots({
      rules: [{ ...mondayRule, validFrom: "2027-03-08" }],
      from: "2027-03-01",
      to: "2027-03-02",
      timezone: "America/Mexico_City",
      durationMinutes: 30,
      now: NOW,
    });

    expect(slots).toHaveLength(0);
  });

  it("en el cambio de primavera no inventa horas inexistentes", () => {
    // 2027-03-14 en New York: 02:00 -> 03:00.
    const slots = generateSlots({
      rules: [
        {
          weekday: 7,
          startTime: "01:00:00",
          endTime: "04:00:00",
          validFrom: "2027-01-01",
          validTo: null,
          slotMinutes: 30,
        },
      ],
      from: "2027-03-14",
      to: "2027-03-15",
      timezone: "America/New_York",
      durationMinutes: 30,
      now: NOW,
    });

    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2027-03-14T06:00:00.000Z", // 01:00 EST
      "2027-03-14T06:30:00.000Z", // 01:30 EST
      "2027-03-14T07:00:00.000Z", // 03:00 EDT
      "2027-03-14T07:30:00.000Z", // 03:30 EDT
    ]);
  });

  it("en el cambio de otono conserva la hora repetida", () => {
    // 2027-11-07 en New York: 02:00 -> 01:00 (01:00 ocurre dos veces).
    const slots = generateSlots({
      rules: [
        {
          weekday: 7,
          startTime: "00:00:00",
          endTime: "04:00:00",
          validFrom: "2027-01-01",
          validTo: null,
          slotMinutes: 30,
        },
      ],
      from: "2027-11-07",
      to: "2027-11-08",
      timezone: "America/New_York",
      durationMinutes: 30,
      now: NOW,
    });

    expect(slots).toHaveLength(10);
    expect(new Set(slots.map((s) => s.startsAt.getTime())).size).toBe(10);

    const starts = slots.map((s) => s.startsAt.toISOString());
    expect(starts).toContain("2027-11-07T05:00:00.000Z"); // 01:00 EDT
    expect(starts).toContain("2027-11-07T06:00:00.000Z"); // 01:00 EST
  });

  it("devuelve vacio si el rango esta invertido", () => {
    const slots = generateSlots({
      rules: [mondayRule],
      from: "2027-03-02",
      to: "2027-03-01",
      timezone: "America/Mexico_City",
      durationMinutes: 30,
      now: NOW,
    });

    expect(slots).toHaveLength(0);
  });
});
