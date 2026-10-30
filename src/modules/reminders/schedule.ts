import { DateTime } from "luxon";
import type { REMINDER_CHANNELS } from "../../db/schema/reminder-jobs.js";

export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export type ReminderRule = {
  code: string;
  /** Minutos antes de la cita (negativo). */
  offsetMinutes: number;
  channel: ReminderChannel;
};

export const DEFAULT_REMINDER_RULES: readonly ReminderRule[] = [
  { code: "reminder_48h", offsetMinutes: -48 * 60, channel: "whatsapp" },
  { code: "reminder_24h", offsetMinutes: -24 * 60, channel: "whatsapp" },
  { code: "reminder_2h", offsetMinutes: -2 * 60, channel: "whatsapp" },
];

export const QUIET_HOURS = { start: 21, end: 8 };

export type ScheduledReminder = {
  code: string;
  channel: ReminderChannel;
  scheduledFor: Date;
};

/**
 * Calcula cuando materializar los recordatorios. Puro y testeable.
 *
 * - Se resta el offset en la zona del consultorio (DST-safe).
 * - Si cae en horario de silencio (21:00-08:00) se mueve a las 08:00.
 * - Nunca se programa en el pasado ni despues de la propia cita.
 */
export function computeReminderSchedules(params: {
  startsAt: Date;
  timezone: string;
  now: Date;
  rules?: readonly ReminderRule[];
  quietHours?: { start: number; end: number };
}): ScheduledReminder[] {
  const rules = params.rules ?? DEFAULT_REMINDER_RULES;
  const quiet = params.quietHours ?? QUIET_HOURS;

  const start = DateTime.fromJSDate(params.startsAt, {
    zone: params.timezone,
  });
  const now = DateTime.fromJSDate(params.now, { zone: params.timezone });

  if (!start.isValid) return [];

  const result: ScheduledReminder[] = [];

  for (const rule of rules) {
    let at: DateTime = start.minus({ minutes: Math.abs(rule.offsetMinutes) });

    if (isQuietHour(at, quiet)) {
      at = nextAllowedTime(at, quiet);
    }

    if (!at.isValid) continue;
    if (at.toMillis() <= now.toMillis()) continue;
    if (at.toMillis() >= start.toMillis()) continue;

    result.push({
      code: rule.code,
      channel: rule.channel,
      scheduledFor: at.toUTC().toJSDate(),
    });
  }

  return result.sort(
    (a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime(),
  );
}

function isQuietHour(
  at: DateTime,
  quiet: { start: number; end: number },
): boolean {
  return at.hour >= quiet.start || at.hour < quiet.end;
}

function nextAllowedTime(
  at: DateTime,
  quiet: { start: number; end: number },
): DateTime {
  const base = at.hour >= quiet.start ? at.plus({ days: 1 }) : at;
  return base.set({ hour: quiet.end, minute: 0, second: 0, millisecond: 0 });
}
