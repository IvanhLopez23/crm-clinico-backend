import { describe, expect, it } from "vitest";
import { resolveBlockRange } from "../../src/modules/availability/blocks.js";

describe("resolveBlockRange", () => {
  it("resuelve un dia completo en la zona de la clinica", () => {
    const range = resolveBlockRange(
      {
        startDate: "2026-11-03",
        endDate: "2026-11-03",
        startAllDay: true,
        endAllDay: true,
      },
      "America/Mexico_City",
    );

    expect(range.startsAt.toISOString()).toBe("2026-11-03T06:00:00.000Z");
    expect(range.endsAt.toISOString()).toBe("2026-11-04T06:00:00.000Z");
  });

  it("resuelve varios dias completos", () => {
    const range = resolveBlockRange(
      {
        startDate: "2026-11-03",
        endDate: "2026-11-05",
        startAllDay: true,
        endAllDay: true,
      },
      "America/Mexico_City",
    );

    expect(range.startsAt.toISOString()).toBe("2026-11-03T06:00:00.000Z");
    expect(range.endsAt.toISOString()).toBe("2026-11-06T06:00:00.000Z");
  });

  it("resuelve un rango parcial con horas", () => {
    const range = resolveBlockRange(
      {
        startDate: "2026-11-03",
        endDate: "2026-11-05",
        startAllDay: false,
        endAllDay: false,
        startTime: "18:00",
        endTime: "09:00",
      },
      "America/Mexico_City",
    );

    expect(range.startsAt.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(range.endsAt.toISOString()).toBe("2026-11-05T15:00:00.000Z");
  });

  it("cubre el dia completo de 23 horas en primavera", () => {
    const range = resolveBlockRange(
      {
        startDate: "2027-03-14",
        endDate: "2027-03-14",
        startAllDay: true,
        endAllDay: true,
      },
      "America/New_York",
    );

    const hours =
      (range.endsAt.getTime() - range.startsAt.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(23);
  });

  it("cubre el dia completo de 25 horas en otono", () => {
    const range = resolveBlockRange(
      {
        startDate: "2027-11-07",
        endDate: "2027-11-07",
        startAllDay: true,
        endAllDay: true,
      },
      "America/New_York",
    );

    const hours =
      (range.endsAt.getTime() - range.startsAt.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(25);
  });

  it("rechaza un fin anterior al inicio", () => {
    expect(() =>
      resolveBlockRange(
        {
          startDate: "2026-11-05",
          endDate: "2026-11-03",
          startAllDay: true,
          endAllDay: true,
        },
        "America/Mexico_City",
      ),
    ).toThrow(/fecha de fin/i);
  });
});
