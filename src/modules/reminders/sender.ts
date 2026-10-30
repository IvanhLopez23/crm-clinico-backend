import type { ReminderChannel } from "./schedule.js";

export type OutboundMessage = {
  jobId: string;
  channel: ReminderChannel;
  to: string;
  subject?: string;
  body: string;
};

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; errorCode: string };

export interface MessageSender {
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Sender de desarrollo: no envia nada y no loguea PHI (solo id de job y canal).
 * Para produccion, implementar MessageSender con Meta Cloud API / Twilio /
 * Postmark y devolver los codigos de error del proveedor.
 */
export function createConsoleSender(): MessageSender {
  return {
    async send(message) {
      console.log(
        JSON.stringify({
          event: "reminder.sent",
          jobId: message.jobId,
          channel: message.channel,
        }),
      );
      return { ok: true, providerMessageId: `console:${message.jobId}` };
    },
  };
}
