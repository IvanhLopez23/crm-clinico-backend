export type ServiceTimingSource = {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
};

export type ServiceTiming = {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
};

/**
 * Resuelve la duracion y los buffers efectivos de una cita.
 *
 * - La duracion del override del especialista gana sobre la del servicio.
 * - Los buffers del especialista mandan: son los que el usuario configura en
 *   su perfil (Preparacion antes / Cierre despues) y los que definen el paso
 *   real de la agenda. Si no hay especialista, se usan los del servicio.
 *
 * Antes el servicio pisaba al especialista cuando tenia un buffer mayor que
 * cero. Eso hacia que un 0 explicito del perfil se ignorara y que una cita de
 * 30 min avanzara cada 35 (por ejemplo 10:20 en lugar de 10:30).
 */
export function resolveServiceTiming(input: {
  service: ServiceTimingSource;
  override?: { durationMinutes: number } | null;
  practitioner?: {
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
  } | null;
}): ServiceTiming {
  const practitioner = input.practitioner;

  return {
    durationMinutes:
      input.override?.durationMinutes ?? input.service.durationMinutes,
    bufferBeforeMinutes: practitioner
      ? practitioner.bufferBeforeMinutes
      : input.service.bufferBeforeMinutes,
    bufferAfterMinutes: practitioner
      ? practitioner.bufferAfterMinutes
      : input.service.bufferAfterMinutes,
  };
}
