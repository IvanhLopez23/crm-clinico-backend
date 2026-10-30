export type RealtimeTopic = "agenda" | "sala" | "patients";

export type RealtimeEvent = {
  clinicId: string;
  topic: RealtimeTopic;
  type: string;
  at: string;
  appointmentId?: string;
  patientId?: string;
};

type Listener = (event: RealtimeEvent) => void;

/**
 * Bus en proceso para el piloto de una sola instancia. La interfaz permite
 * sustituirlo por Redis pub/sub o LISTEN/NOTIFY sin tocar rutas ni SSE.
 * Los payloads no llevan PHI: solo IDs, topic y tipo de evento.
 */
class RealtimeBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(clinicId: string, listener: Listener): () => void {
    const set = this.listeners.get(clinicId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(clinicId, set);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(clinicId);
    };
  }

  publish(event: RealtimeEvent): void {
    for (const listener of this.listeners.get(event.clinicId) ?? []) {
      try {
        listener(event);
      } catch {
        // Un cliente roto no debe tumbar el publish.
      }
    }
  }
}

export const realtimeBus = new RealtimeBus();

export function publishRealtime(
  clinicId: string,
  topic: RealtimeTopic,
  type: string,
  meta: { appointmentId?: string; patientId?: string } = {},
): void {
  realtimeBus.publish({
    clinicId,
    topic,
    type,
    at: new Date().toISOString(),
    ...meta,
  });
}
