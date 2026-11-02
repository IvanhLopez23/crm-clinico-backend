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
  /**
   * Inicio concreto que debe evaluarse ademas de la malla. Lo usa la lista
   * de espera para revalidar el hueco liberado aunque no caiga en un multiplo
   * de `slotMinutes`.
   */
  anchorStart?: Date;
  /**
   * Si es true, el paso nunca es menor que el bloque ocupado
   * (duracion + buffers). Evita ofrecer inicios que se solapan entre si
   * cuando el servicio dura mas que la granularidad de la regla.
   */
  occupancyStep?: boolean;
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

      const durationMinutes = input.durationMinutes ?? rule.slotMinutes;
      const bufferBefore = input.bufferBeforeMinutes ?? 0;
      const bufferAfter = input.bufferAfterMinutes ?? 0;
      const baseStep = input.slotMinutes ?? rule.slotMinutes;
      const step = input.occupancyStep
        ? durationMinutes + bufferBefore + bufferAfter
        : baseStep;
      const start = day.set(parseTime(rule.startTime));
      const limit = day.set(parseTime(rule.endTime));
      const duration = { minutes: durationMinutes };

      // El buffer previo tambien debe caber dentro de la regla.
      let cursor = start.plus({ minutes: bufferBefore });
      let guard = 0;

      if (input.anchorStart) {
        const anchor = DateTime.fromJSDate(input.anchorStart, { zone });
        if (
          anchor.isValid &&
          anchor.hasSame(day, "day") &&
          anchor >= cursor &&
          anchor.plus({ minutes: durationMinutes + bufferAfter }) <= limit
        ) {
          const occupiedStart = anchor
            .minus({ minutes: bufferBefore })
            .toJSDate();
          const occupiedEnd = anchor
            .plus({ minutes: durationMinutes + bufferAfter })
            .toJSDate();
          const startsAt = anchor.toUTC().toJSDate();

          if (
            startsAt.getTime() > nowMs &&
            !overlappingEnd(occupiedStart, occupiedEnd, busy)
          ) {
            slots.set(startsAt.getTime(), {
              startsAt,
              endsAt: anchor.plus(duration).toUTC().toJSDate(),
            });
          }
        }
      }

      while (cursor.plus({ minutes: durationMinutes + bufferAfter }) <= limit) {
        // Cota de seguridad: nunca iterar sin fin sobre una regla corrupta.
        if (++guard > 2000) break;

        const occupiedStart = cursor.minus({ minutes: bufferBefore }).toJSDate();
        const occupiedEnd = cursor
          .plus({ minutes: durationMinutes + bufferAfter })
          .toJSDate();

        // Si el candidato choca con una cita/bloqueo, saltamos al primer
        // inicio que deja libre el bloque ocupado completo. Sin esto, un
        // servicio de 20 min con 5+5 de buffers solo encontraria el siguiente
        // hueco 40 min despues (el candidato intermedio queda tapado por el
        // buffer y el siguiente multiplo de slot_minutes ya es 40).
        const conflictEnd = overlappingEnd(occupiedStart, occupiedEnd, busy);
        if (conflictEnd) {
          const next = DateTime.fromJSDate(conflictEnd, { zone }).plus({
            minutes: bufferBefore,
          });
          cursor =
            next.isValid && next > cursor
              ? (next as typeof cursor)
              : cursor.plus({ minutes: step });
          continue;
        }

        const startsAt = cursor.toUTC().toJSDate();
        const endsAt = cursor.plus(duration).toUTC().toJSDate();

        if (startsAt.getTime() > nowMs) {
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

function overlappingEnd(
  startsAt: Date,
  endsAt: Date,
  busy: BusyInterval[],
): Date | null {
  let latest: Date | null = null;
  for (const interval of busy) {
    if (!overlaps(startsAt, endsAt, interval)) continue;
    if (!latest || interval.endsAt.getTime() > latest.getTime()) {
      latest = interval.endsAt;
    }
  }
  return latest;
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
