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
import { createPatient } from "../patients/service.js";
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
        .where(eq(practitionerServices.isActive, true)),
    ]);

    return {
      clinic: {
        id: clinic.id,
        name: clinic.name,
        slug: clinic.slug ?? slug,
        timezone: clinic.timezone,
        currency: clinic.currency,
      },
      services: serviceRows,
      practitioners: practitionerRows,
      assignments: assignmentRows,
    };
  });
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
