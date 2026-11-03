import { and, asc, eq, isNull, or } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Database } from "../../db/client.js";
import { clinicSlugs } from "../../db/schema/clinic-slugs.js";
import { clinics } from "../../db/schema/clinics.js";
import { patients } from "../../db/schema/patients.js";
import { practitionerServices } from "../../db/schema/practitioner-services.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { services } from "../../db/schema/services.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { normalizeEmail, normalizePhone } from "../../lib/phi-crypto.js";
import { getAvailability } from "../availability/service.js";
import { bookAppointment } from "../appointments/service.js";
import { createPublicBookingNotifications } from "../notifications/service.js";
import { createPatient } from "../patients/service.js";
import { publishRealtime } from "../realtime/bus.js";
import type { PublicBookingBody } from "./schema.js";

export type PublicClinic = {
  clinic: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
  };
  services: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    priceCents: number;
    currency: string;
  }>;
  practitioners: Array<{ id: string; fullName: string; specialty: string | null }>;
  assignments: Array<{
    practitionerId: string;
    serviceId: string;
    durationMinutes: number;
    priceCents: number;
    currency: string;
  }>;
};

export async function resolveClinicBySlug(
  db: Database,
  slug: string,
): Promise<{ id: string; timezone: string; name: string }> {
  const [mapping] = await db
    .select({ clinicId: clinicSlugs.clinicId })
    .from(clinicSlugs)
    .where(eq(clinicSlugs.slug, slug.trim().toLowerCase()))
    .limit(1);

  if (!mapping) {
    throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
  }

  const clinic = await withTenant(db, mapping.clinicId, async (tx) => {
    const [row] = await tx
      .select({
        id: clinics.id,
        name: clinics.name,
        timezone: clinics.timezone,
        isActive: clinics.isActive,
      })
      .from(clinics)
      .where(eq(clinics.id, mapping.clinicId))
      .limit(1);
    return row ?? null;
  });

  if (!clinic || !clinic.isActive) {
    throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
  }
  return { id: clinic.id, timezone: clinic.timezone, name: clinic.name };
}

export async function getPublicClinic(
  db: Database,
  slug: string,
): Promise<PublicClinic> {
  const resolved = await resolveClinicBySlug(db, slug);

  return withTenant(db, resolved.id, async (tx) => {
    const [clinic] = await tx
      .select({
        id: clinics.id,
        name: clinics.name,
        slug: clinics.slug,
        timezone: clinics.timezone,
        currency: clinics.currency,
      })
      .from(clinics)
      .where(eq(clinics.id, resolved.id))
      .limit(1);

    if (!clinic) {
      throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
    }

    const [serviceRows, practitionerRows, assignmentRows] = await Promise.all([
      tx
        .select({
          id: services.id,
          name: services.name,
          durationMinutes: services.durationMinutes,
          priceCents: services.priceCents,
          currency: services.currency,
        })
        .from(services)
        .where(eq(services.isActive, true))
        .orderBy(asc(services.name)),
      tx
        .select({
          id: practitioners.id,
          fullName: practitioners.fullName,
          specialty: practitioners.specialty,
        })
        .from(practitioners)
        .where(
          and(
            eq(practitioners.isActive, true),
            isNull(practitioners.deletedAt),
          ),
        )
        .orderBy(asc(practitioners.fullName)),
      tx
        .select({
          practitionerId: practitionerServices.practitionerId,
          serviceId: practitionerServices.serviceId,
          durationMinutes: practitionerServices.durationMinutes,
          priceCents: practitionerServices.priceCents,
          currency: practitionerServices.currency,
        })
        .from(practitionerServices)
        .innerJoin(services, eq(services.id, practitionerServices.serviceId))
        .innerJoin(
          practitioners,
          eq(practitioners.id, practitionerServices.practitionerId),
        )
        .where(
          and(
            eq(practitionerServices.isActive, true),
            eq(services.isActive, true),
            eq(practitioners.isActive, true),
            isNull(practitioners.deletedAt),
          ),
        ),
    ]);

    // El catalogo publico solo muestra lo que realmente se puede reservar:
    // servicios activos con al menos una asignacion activa a un especialista
    // activo. Un servicio suelto en el catalogo, o una asignacion quitada,
    // no debe aparecer en el portal.
    const offeredServiceIds = new Set(
      assignmentRows.map((item) => item.serviceId),
    );
    const offeringPractitionerIds = new Set(
      assignmentRows.map((item) => item.practitionerId),
    );

    return {
      clinic: {
        id: clinic.id,
        name: clinic.name,
        slug: clinic.slug ?? slug,
        timezone: clinic.timezone,
        currency: clinic.currency,
      },
      services: serviceRows.filter((item) => offeredServiceIds.has(item.id)),
      practitioners: practitionerRows.filter((item) =>
        offeringPractitionerIds.has(item.id),
      ),
      assignments: assignmentRows,
    };
  });
}

/**
 * Valida que la combinacion servicio + especialista sea reservable en la
 * clinica. Se usa en disponibilidad y reserva publicas para que un cliente
 * no pueda saltarse el catalogo enviando ids arbitrarios.
 */
async function assertPublicOffering(
  db: Database,
  params: { clinicId: string; practitionerId: string; serviceId: string },
): Promise<void> {
  const available = await withTenant(db, params.clinicId, async (tx) => {
    const [row] = await tx
      .select({ id: practitionerServices.id })
      .from(practitionerServices)
      .innerJoin(services, eq(services.id, practitionerServices.serviceId))
      .innerJoin(
        practitioners,
        eq(practitioners.id, practitionerServices.practitionerId),
      )
      .where(
        and(
          eq(practitionerServices.practitionerId, params.practitionerId),
          eq(practitionerServices.serviceId, params.serviceId),
          eq(practitionerServices.isActive, true),
          eq(services.isActive, true),
          eq(practitioners.isActive, true),
          isNull(practitioners.deletedAt),
        ),
      )
      .limit(1);

    return Boolean(row);
  });

  if (!available) {
    throw new AppError(
      404,
      "SERVICE_NOT_AVAILABLE",
      "Ese servicio no esta disponible para el especialista seleccionado",
    );
  }
}

export async function getPublicAvailability(
  db: Database,
  params: {
    slug: string;
    serviceId: string;
    practitionerId: string;
    date: string;
  },
) {
  const clinic = await resolveClinicBySlug(db, params.slug);

  await assertPublicOffering(db, {
    clinicId: clinic.id,
    practitionerId: params.practitionerId,
    serviceId: params.serviceId,
  });

  const to = DateTime.fromISO(params.date, { zone: clinic.timezone })
    .plus({ days: 1 })
    .toISODate();

  if (!to) {
    throw new AppError(422, "INVALID_DATE", "Fecha invalida");
  }

  return getAvailability(db, {
    clinicId: clinic.id,
    practitionerId: params.practitionerId,
    serviceId: params.serviceId,
    from: params.date,
    to,
    durationMinutes: 30,
  });
}

export async function bookPublicAppointment(
  db: Database,
  params: { slug: string; input: PublicBookingBody },
) {
  const clinic = await resolveClinicBySlug(db, params.slug);

  await assertPublicOffering(db, {
    clinicId: clinic.id,
    practitionerId: params.input.practitionerId,
    serviceId: params.input.serviceId,
  });

  const phone = normalizePhone(params.input.patient.phone);
  const email = params.input.patient.email
    ? normalizeEmail(params.input.patient.email)
    : null;

  const existing = await withTenant(db, clinic.id, (tx) =>
    tx
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(
          isNull(patients.deletedAt),
          or(
            eq(patients.phoneE164, phone),
            email ? eq(patients.email, email) : undefined,
          ),
        ),
      )
      .limit(1),
  );

  let patientId = existing[0]?.id;

  if (!patientId) {
    const created = await createPatient(db, {
      actor: {
        userId: "public",
        clinicId: clinic.id,
        role: "receptionist",
        practitionerId: null,
      },
      input: {
        firstName: params.input.patient.firstName,
        lastName: params.input.patient.lastName,
        phone: params.input.patient.phone,
        ...(params.input.patient.email
          ? { email: params.input.patient.email }
          : {}),
        source: "public",
        preferredLanguage: "es",
        transactionalOptIn: true,
        marketingOptIn: false,
      },
    });
    patientId = created.id;
  }

  const appointment = await bookAppointment(db, {
    clinicId: clinic.id,
    patientId,
    practitionerId: params.input.practitionerId,
    serviceId: params.input.serviceId,
    startsAt: new Date(params.input.startsAt),
    endsAt: new Date(params.input.endsAt),
    timezone: clinic.timezone,
    bookedVia: "public",
    confirm: false,
  });

  // La notificacion es un efecto secundario de la reserva: si falla, la cita
  // ya quedo creada y el paciente no debe recibir un error.
  try {
    await createPublicBookingNotifications(db, {
      clinicId: clinic.id,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      patientName: `${params.input.patient.firstName} ${params.input.patient.lastName}`.trim(),
      serviceName: appointment.serviceNameSnapshot ?? "Consulta",
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    });
  } catch (error) {
    console.error("public_booking_notification_failed", error);
  }

  publishRealtime(clinic.id, "agenda", "appointment.requested", {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
  });
  publishRealtime(clinic.id, "notifications", "notification.created", {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
  });

  return {
    id: appointment.id,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    status: appointment.status,
    serviceName: appointment.serviceNameSnapshot,
    clinicName: clinic.name,
    timezone: clinic.timezone,
  };
}
