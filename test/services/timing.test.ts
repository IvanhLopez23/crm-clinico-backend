import { describe, expect, it } from "vitest";
import { resolveServiceTiming } from "../../src/modules/services/timing.js";

describe("resolveServiceTiming", () => {
  it("hereda los buffers del especialista cuando el servicio no los define", () => {
    const timing = resolveServiceTiming({
      service: {
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      },
      practitioner: { bufferBeforeMinutes: 5, bufferAfterMinutes: 10 },
    });

    expect(timing).toEqual({
      durationMinutes: 30,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
    });
  });

  it("prioriza los buffers del servicio cuando son mayores a cero", () => {
    const timing = resolveServiceTiming({
      service: {
        durationMinutes: 30,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 15,
      },
      practitioner: { bufferBeforeMinutes: 5, bufferAfterMinutes: 5 },
    });

    expect(timing).toEqual({
      durationMinutes: 30,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
    });
  });

  it("usa la duracion del override del especialista", () => {
    const timing = resolveServiceTiming({
      service: {
        durationMinutes: 30,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 5,
      },
      override: { durationMinutes: 20 },
      practitioner: { bufferBeforeMinutes: 5, bufferAfterMinutes: 5 },
    });

    expect(timing.durationMinutes).toBe(20);
  });
});
