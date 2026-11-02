import { DateTime } from "luxon";
import { AppError } from "../../lib/errors.js";

export type BlockRangeInput = {
  startsAt?: Date;
  endsAt?: Date;
  startDate?: string;
  endDate?: string;
  startAllDay?: boolean;
  endAllDay?: boolean;
  startTime?: string;
  endTime?: string;
};

/**
 * Resuelve el rango real de un bloqueo.
 *
 * Acepta dos modos:
 * - `startsAt`/`endsAt`: fechas absolutas (compatibilidad con la API anterior).
 * - `startDate`/`endDate` + `startAllDay`/`endAllDay`: fechas locales de la
 *   clinica. Un extremo "todo el dia" empieza a las 00:00 del dia indicado; el
 *   fin "todo el dia" termina a las 00:00 del dia siguiente (rango exclusivo).
 *
 * El calculo se hace en la zona de la clinica para que un dia completo siga
 * cubriendo el dia correcto en cambios de horario.
 */
export function resolveBlockRange(
  input: BlockRangeInput,
  timezone: string,
): { startsAt: Date; endsAt: Date } {
  if (input.startsAt || input.endsAt) {
    if (!input.startsAt || !input.endsAt) {
      throw new AppError(
        422,
        "INVALID_RANGE",
        "Indica inicio y fin del bloqueo",
      );
    }
    if (input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw new AppError(
        422,
        "INVALID_RANGE",
        "El fin debe ser posterior al inicio",
      );
    }
    return { startsAt: input.startsAt, endsAt: input.endsAt };
  }

  if (!input.startDate || !input.endDate) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "Indica el dia y la fecha de fin del bloqueo",
    );
  }

  const startDay = DateTime.fromISO(input.startDate, { zone: timezone }).startOf(
    "day",
  );
  const endDay = DateTime.fromISO(input.endDate, { zone: timezone }).startOf(
    "day",
  );

  if (!startDay.isValid || !endDay.isValid) {
    throw new AppError(422, "INVALID_RANGE", "Fechas invalidas");
  }
  if (endDay < startDay) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "La fecha de fin debe ser igual o posterior al dia",
    );
  }

  const startsAt = input.startAllDay
    ? startDay
    : startDay.set(parseTime(input.startTime, "inicio"));
  const endsAt = input.endAllDay
    ? endDay.plus({ days: 1 }).startOf("day")
    : endDay.set(parseTime(input.endTime, "fin"));

  if (!startsAt.isValid || !endsAt.isValid) {
    throw new AppError(422, "INVALID_RANGE", "Horario invalido");
  }
  if (endsAt.toMillis() <= startsAt.toMillis()) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "El fin debe ser posterior al inicio",
    );
  }

  return {
    startsAt: startsAt.toUTC().toJSDate(),
    endsAt: endsAt.toUTC().toJSDate(),
  };
}

function parseTime(
  value: string | undefined,
  label: string,
): { hour: number; minute: number; second: number; millisecond: number } {
  if (!value) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      `Indica la hora de ${label} o marca todo el dia`,
    );
  }

  const [rawHour = "", rawMinute = ""] = value.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new AppError(422, "INVALID_RANGE", "Horario invalido");
  }

  return { hour, minute, second: 0, millisecond: 0 };
}
