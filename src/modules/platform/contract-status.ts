import { DateTime } from "luxon";

export type ContractStatus =
  | "none"
  | "active"
  | "expiring"
  | "expired"
  | "inactive";

export type ContractSummary = {
  contractCount: number;
  contractEndsAt: string | null;
  contractStatus: ContractStatus;
  contractDaysLeft: number | null;
};

export const CONTRACT_EXPIRING_DAYS = 30;

type ContractRow = {
  endsAt: string | null;
  isActive: boolean;
};

/**
 * Resume las licencias de un tenant para el grid de plataforma.
 *
 * - Si no hay contratos: `none`.
 * - Si ninguno esta activo: `inactive`.
 * - Con un contrato activo sin fecha de fin: `active` sin vencimiento.
 * - Si varios activos, manda la fecha de fin mas lejana.
 * - `expiring` cuando vence en los proximos 30 dias.
 */
export function summarizeContracts(
  rows: ContractRow[],
  today: string,
): ContractSummary {
  if (rows.length === 0) {
    return {
      contractCount: 0,
      contractEndsAt: null,
      contractStatus: "none",
      contractDaysLeft: null,
    };
  }

  const active = rows.filter((row) => row.isActive);

  if (active.length === 0) {
    const lastEnd = latestEnd(rows);
    return {
      contractCount: rows.length,
      contractEndsAt: lastEnd,
      contractStatus: "inactive",
      contractDaysLeft: lastEnd ? daysBetween(today, lastEnd) : null,
    };
  }

  if (active.some((row) => row.endsAt === null)) {
    return {
      contractCount: rows.length,
      contractEndsAt: null,
      contractStatus: "active",
      contractDaysLeft: null,
    };
  }

  const lastEnd = latestEnd(active);

  if (!lastEnd) {
    return {
      contractCount: rows.length,
      contractEndsAt: null,
      contractStatus: "active",
      contractDaysLeft: null,
    };
  }

  const daysLeft = daysBetween(today, lastEnd);
  const status: ContractStatus =
    lastEnd < today
      ? "expired"
      : daysLeft <= CONTRACT_EXPIRING_DAYS
        ? "expiring"
        : "active";

  return {
    contractCount: rows.length,
    contractEndsAt: lastEnd,
    contractStatus: status,
    contractDaysLeft: daysLeft,
  };
}

function latestEnd(rows: ContractRow[]): string | null {
  return (
    rows
      .map((row) => row.endsAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    DateTime.fromISO(to, { zone: "utc" })
      .startOf("day")
      .diff(DateTime.fromISO(from, { zone: "utc" }).startOf("day"), "days").days,
  );
}
