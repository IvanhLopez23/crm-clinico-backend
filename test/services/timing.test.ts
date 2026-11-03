import { describe, expect, it } from "vitest";
import { resolveServiceTiming } from "../../src/modules/services/timing.js";

describe("resolveServiceTiming", () => {
  it("usa los buffers del especialista aunque el servicio defina otros", () => {
    const timing = resolveServiceTiming({
      service: {
        durationMinutes: 30,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 15,
      },
      practitioner: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    });

    expect(timing).toEqual({
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    });
  });

  it("respeta los buffers configurados en el especialista", () => {
    const timing = resolveServiceTiming({
      service: {
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 5,
      },
      practitioner: { bufferBeforeMinutes: 5, bufferAfterMinutes: 10 },
    });

    expect(timing).toEqual({
      durationMinutes: 30,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
    });
  });

  it("hereda los buffers del servicio cuando no hay especialista", () => {
    const timing = resolveServiceTiming({
      service: {
        durationMinutes: 30,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 10,
      },
    });

    expect(timing).toEqual({
      durationMinutes: 30,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
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
