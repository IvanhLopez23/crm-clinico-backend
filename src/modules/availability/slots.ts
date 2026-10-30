import { DateTime } from "luxon";

export type AvailabilityRule = {
  weekday: number; // 1 = lunes ... 7 = domingo
  startTime: string; // 'HH:MM' o 'HH:MM:SS'
  endTime: string;
  validFrom: string; // 'YYYY-MM-DD'
  validTo: string | null;
  slotMinutes: number;
};

export type BusyInterval = {
  startsAt: Date;
  endsAt: Date;
};

export type Slot = {
  startsAt: Date;
  endsAt: Date;
};

export type GenerateSlotsInput = {
  rules: AvailabilityRule[];
  from: string; // 'YYYY-MM-DD' inclusive
  to: string; // 'YYYY-MM-DD' exclusivo
  timezone: string;
  /** Si falta, cada regla usa su `slotMinutes` como duracion. */
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  /** Override de granularidad; si falta se usa la de cada regla. */
  slotMinutes?: number;
  busy?: BusyInterval[];
  now?: Date;
};

/**
 * Genera slots en hora local del consultorio y los devuelve en UTC.
 *
 * Se avanza con `plus({ minutes })` sobre un DateTime zonal, no sumando
 * minutos al reloj de pared: en el cambio de horario eso evita duplicar
 * horarios inexistentes (primavera) y conserva las dos ocurrencias de la hora
 * repetida (otono).
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const zone = input.timezone;
  const startDay = DateTime.fromISO(input.from, { zone });
  const endDay = DateTime.fromISO(input.to, { zone });

  if (!startDay.isValid || !endDay.isValid) {
    throw new Error("invalid_date_range");
  }
  if (startDay >= endDay) return [];

  const nowMs = (input.now ?? new Date()).getTime();
  const busy = input.busy ?? [];
  const slots = new Map<number, Slot>();

  for (
    let day = startDay.startOf("day");
    day < endDay;
    day = day.plus({ days: 1 })
  ) {
    const isoDate = day.toISODate();
    if (!isoDate) continue;

    for (const rule of input.rules) {
      if (rule.weekday !== day.weekday) continue;
      if (isoDate < rule.validFrom) continue;
      if (rule.validTo && isoDate > rule.validTo) continue;

      const step = input.slotMinutes ?? rule.slotMinutes;
      const durationMinutes = input.durationMinutes ?? rule.slotMinutes;
      const start = day.set(parseTime(rule.startTime));
      const limit = day.set(parseTime(rule.endTime));
      const duration = { minutes: durationMinutes };
      const bufferBefore = input.bufferBeforeMinutes ?? 0;
      const bufferAfter = input.bufferAfterMinutes ?? 0;

      // El buffer previo tambien debe caber dentro de la regla.
      let cursor = start.plus({ minutes: bufferBefore });
      let guard = 0;

      while (cursor.plus({ minutes: durationMinutes + bufferAfter }) <= limit) {
        // Cota de seguridad: nunca iterar sin fin sobre una regla corrupta.
        if (++guard > 2000) break;

        const occupiedStart = cursor.minus({ minutes: bufferBefore }).toJSDate();
        const occupiedEnd = cursor
          .plus({ minutes: durationMinutes + bufferAfter })
          .toJSDate();
        const startsAt = cursor.toUTC().toJSDate();
        const endsAt = cursor.plus(duration).toUTC().toJSDate();

        if (
          startsAt.getTime() > nowMs &&
          !busy.some((interval) =>
            overlaps(occupiedStart, occupiedEnd, interval),
          )
        ) {
          slots.set(startsAt.getTime(), { startsAt, endsAt });
        }

        cursor = cursor.plus({ minutes: step });
      }
    }
  }

  return [...slots.values()].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

function overlaps(
  startsAt: Date,
  endsAt: Date,
  interval: BusyInterval,
): boolean {
  return (
    startsAt.getTime() < interval.endsAt.getTime() &&
    endsAt.getTime() > interval.startsAt.getTime()
  );
}

function parseTime(value: string): {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} {
  const [rawHour = "", rawMinute = "", rawSecond = ""] = value.split(":");
  return {
    hour: Number(rawHour),
    minute: Number(rawMinute),
    second: Number(rawSecond || 0),
    millisecond: 0,
  };
}
