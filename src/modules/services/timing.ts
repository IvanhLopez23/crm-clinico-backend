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
 * - Los buffers del servicio mandan cuando son mayores que cero; si el
 *   servicio no define buffer, se hereda el del especialista. Asi el perfil
 *   del especialista sirve como valor por defecto sin pisar un servicio que
 *   ya define su propia preparacion/cierre.
 */
export function resolveServiceTiming(input: {
  service: ServiceTimingSource;
  override?: { durationMinutes: number } | null;
  practitioner?: {
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
  } | null;
}): ServiceTiming {
  return {
    durationMinutes:
      input.override?.durationMinutes ?? input.service.durationMinutes,
    bufferBeforeMinutes:
      input.service.bufferBeforeMinutes ||
      input.practitioner?.bufferBeforeMinutes ||
      0,
    bufferAfterMinutes:
      input.service.bufferAfterMinutes ||
      input.practitioner?.bufferAfterMinutes ||
      0,
  };
}
