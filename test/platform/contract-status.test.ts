import { describe, expect, it } from "vitest";
import { summarizeContracts } from "../../src/modules/platform/contract-status.js";

const TODAY = "2026-11-02";

describe("summarizeContracts", () => {
  it("marca sin contrato cuando no hay filas", () => {
    expect(summarizeContracts([], TODAY)).toEqual({
      contractCount: 0,
      contractEndsAt: null,
      contractStatus: "none",
      contractDaysLeft: null,
    });
  });

  it("marca activo cuando vence a mas de 30 dias", () => {
    const summary = summarizeContracts(
      [{ endsAt: "2027-01-15", isActive: true }],
      TODAY,
    );

    expect(summary.contractStatus).toBe("active");
    expect(summary.contractEndsAt).toBe("2027-01-15");
    expect(summary.contractDaysLeft).toBeGreaterThan(30);
  });

  it("marca por vencer dentro de los proximos 30 dias", () => {
    const summary = summarizeContracts(
      [{ endsAt: "2026-11-20", isActive: true }],
      TODAY,
    );

    expect(summary.contractStatus).toBe("expiring");
    expect(summary.contractDaysLeft).toBe(18);
  });

  it("marca por vencer si vence hoy", () => {
    const summary = summarizeContracts(
      [{ endsAt: TODAY, isActive: true }],
      TODAY,
    );

    expect(summary.contractStatus).toBe("expiring");
    expect(summary.contractDaysLeft).toBe(0);
  });

  it("marca vencido cuando la fecha ya paso", () => {
    const summary = summarizeContracts(
      [{ endsAt: "2026-10-01", isActive: true }],
      TODAY,
    );

    expect(summary.contractStatus).toBe("expired");
    expect(summary.contractDaysLeft).toBeLessThan(0);
  });

  it("con varios activos usa la fecha de fin mas lejana", () => {
    const summary = summarizeContracts(
      [
        { endsAt: "2026-11-10", isActive: true },
        { endsAt: "2027-02-01", isActive: true },
      ],
      TODAY,
    );

    expect(summary.contractStatus).toBe("active");
    expect(summary.contractEndsAt).toBe("2027-02-01");
    expect(summary.contractCount).toBe(2);
  });

  it("un contrato activo sin fin no tiene vencimiento", () => {
    const summary = summarizeContracts(
      [{ endsAt: null, isActive: true }],
      TODAY,
    );

    expect(summary.contractStatus).toBe("active");
    expect(summary.contractEndsAt).toBeNull();
    expect(summary.contractDaysLeft).toBeNull();
  });

  it("sin contratos activos marca inactivo", () => {
    const summary = summarizeContracts(
      [{ endsAt: "2026-09-01", isActive: false }],
      TODAY,
    );

    expect(summary.contractStatus).toBe("inactive");
    expect(summary.contractEndsAt).toBe("2026-09-01");
  });
});
