import { DateTime } from "luxon";
import type { ReminderChannel } from "./schedule.js";

export type TemplateContext = {
  firstName: string;
  practitionerName: string;
  clinicName: string;
  startsAt: Date;
  timezone: string;
};

export type RenderedMessage = {
  subject?: string;
  body: string;
};

/**
 * Plantillas de recordatorio. En produccion con WhatsApp estas cadenas deben
 * corresponder a plantillas aprobadas por Meta (utility); aqui se renderizan
 * en el worker para no guardar el cuerpo en la base.
 */
export function renderReminder(
  templateCode: string,
  channel: ReminderChannel,
  ctx: TemplateContext,
): RenderedMessage {
  const startsAt = DateTime.fromJSDate(ctx.startsAt, {
    zone: ctx.timezone,
  }).setLocale("es");

  const date = startsAt.toLocaleString({
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const time = startsAt.toFormat("HH:mm");

  let body: string;

  switch (templateCode) {
    case "reminder_2h":
      body = `Hola ${ctx.firstName}, tu cita con ${ctx.practitionerName} es hoy a las ${time}. Te esperamos en ${ctx.clinicName}.`;
      break;
    case "reminder_24h":
      body = `Hola ${ctx.firstName}, manana tienes cita con ${ctx.practitionerName} a las ${time} en ${ctx.clinicName}. Responde CONFIRMAR o CANCELAR.`;
      break;
    case "reminder_48h":
    default:
      body = `Hola ${ctx.firstName}, te recordamos tu cita con ${ctx.practitionerName} el ${date} a las ${time} en ${ctx.clinicName}. Responde CONFIRMAR o CANCELAR.`;
      break;
  }

  if (channel === "email") {
    return { subject: `Recordatorio de cita - ${ctx.clinicName}`, body };
  }

  return { body };
}
