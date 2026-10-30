import { and, asc, desc, eq, gte, getTableColumns, isNull, lte, or } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Database, Transaction } from "../../db/client.js";
import { clinics } from "../../db/schema/clinics.js";
import { patients } from "../../db/schema/patients.js";
import { practitioners } from "../../db/schema/practitioners.js";
import { waitlistEntries } from "../../db/schema/waitlist-entries.js";
import { waitlistOffers } from "../../db/schema/waitlist-offers.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { computeSlots } from "../availability/service.js";
import {
  createAppointmentTx,
  mapBookingError,
  type Appointment,
} from "../appointments/tx.js";

export const OFFER_TTL_MINUTES = 20;

export type WaitlistEntry = typeof waitlistEntries.$inferSelect;
export type WaitlistOffer = typeof waitlistOffers.$inferSelect;

export type CreateWaitlistEntryInput = {
  clinicId: string;
  patientId: string;
  practitionerId?: string;
  earliestDate: string;
  latestDate: string;
  preferredTimeFrom?: string;
  preferredTimeTo?: string;
  priority: number;
  notes?: string;
};

export async function createWaitlistEntry(
  db: Database,
  input: CreateWaitlistEntryInput,
): Promise<WaitlistEntry> {
  if (input.latestDate < input.earliestDate) {
    throw new AppError(
      422,
      "INVALID_RANGE",
      "latestDate debe ser igual o posterior a earliestDate",
    );
  }

  if (
    input.preferredTimeFrom &&
    input.preferredTimeTo &&
    input.preferredTimeFrom >= input.preferredTimeTo
  ) {
    throw new AppError(
      422,
      "INVALID_TIME_RANGE",
      "preferredTimeFrom debe ser anterior a preferredTimeTo",
    );
  }

  return withTenant(db, input.clinicId, async (tx) => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(eq(patients.id, input.patientId), isNull(patients.deletedAt)),
      )
      .limit(1);

    if (!patient) {
      throw new AppError(
        404,
        "PATIENT_NOT_FOUND",
        "Paciente no encontrado en esta clinica",
      );
    }

    if (input.practitionerId) {
      const [practitioner] = await tx
        .select({ id: practitioners.id })
        .from(practitioners)
        .where(
          and(
            eq(practitioners.id, input.practitionerId),
            eq(practitioners.isActive, true),
          ),
        )
        .limit(1);

      if (!practitioner) {
        throw new AppError(
          404,
          "PRACTITIONER_NOT_FOUND",
          "Especialista no encontrado o inactivo",
        );
      }
    }

    const [entry] = await tx
      .insert(waitlistEntries)
      .values({
        clinicId: input.clinicId,
        patientId: input.patientId,
        practitionerId: input.practitionerId ?? null,
        earliestDate: input.earliestDate,
        latestDate: input.latestDate,
        preferredTimeFrom: input.preferredTimeFrom ?? null,
        preferredTimeTo: input.preferredTimeTo ?? null,
        priority: input.priority,
        notes: input.notes ?? null,
      })
      .returning();

    if (!entry) {
      throw new AppError(500, "INSERT_FAILED", "No se pudo crear la entrada");
    }

    return entry;
  });
}

export async function listWaitlistEntries(
  db: Database,
  params: {
    clinicId: string;
    status?: string;
    practitionerId?: string;
  },
) {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select({
        ...getTableColumns(waitlistEntries),
        patientFirstName: patients.firstName,
        patientLastName: patients.lastName,
        practitionerName: practitioners.fullName,
      })
      .from(waitlistEntries)
      .innerJoin(patients, eq(patients.id, waitlistEntries.patientId))
      .leftJoin(
        practitioners,
        eq(practitioners.id, waitlistEntries.practitionerId),
      )
      .where(
        and(
          params.status
            ? eq(waitlistEntries.status, params.status)
            : undefined,
          params.practitionerId
            ? or(
                eq(waitlistEntries.practitionerId, params.practitionerId),
                isNull(waitlistEntries.practitionerId),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(waitlistEntries.priority),
        asc(waitlistEntries.createdAt),
      ),
  );
}

export async function cancelWaitlistEntry(
  db: Database,
  params: { clinicId: string; id: string },
): Promise<WaitlistEntry> {
  return withTenant(db, params.clinicId, async (tx) => {
    const [entry] = await tx
      .select()
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.id, params.id),
          eq(waitlistEntries.clinicId, params.clinicId),
        ),
      )
      .limit(1)
      .for("update");

    if (!entry) {
      throw new AppError(404, "ENTRY_NOT_FOUND", "Entrada no encontrada");
    }

    if (entry.status === "cancelled") return entry;

    if (entry.status === "booked") {
      throw new AppError(
        409,
        "ALREADY_BOOKED",
        "La entrada ya genero una cita",
      );
    }

    const now = new Date();

    const [pendingOffer] = await tx
      .select()
      .from(waitlistOffers)
      .where(
        and(
          eq(waitlistOffers.entryId, entry.id),
          eq(waitlistOffers.status, "pending"),
        ),
      )
      .limit(1);

    await tx
      .update(waitlistOffers)
      .set({ status: "superseded", respondedAt: now })
      .where(
        and(
          eq(waitlistOffers.entryId, entry.id),
          eq(waitlistOffers.status, "pending"),
        ),
      );

    const [updated] = await tx
      .update(waitlistEntries)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(waitlistEntries.id, entry.id))
      .returning();

    // Si tenia un hueco ofertado, ese hueco pasa al siguiente candidato.
    if (pendingOffer) {
      const [clinic] = await tx
        .select({ timezone: clinics.timezone })
        .from(clinics)
        .where(eq(clinics.id, entry.clinicId))
        .limit(1);

      if (clinic) {
        await offerNextForSlotTx(tx, {
          clinicId: entry.clinicId,
          practitionerId: pendingOffer.practitionerId,
          startsAt: pendingOffer.startsAt,
          endsAt: pendingOffer.endsAt,
          timezone: clinic.timezone,
          now,
        });
      }
    }

    if (!updated) {
      throw new AppError(500, "UPDATE_FAILED", "No se pudo cancelar la entrada");
    }

    return updated;
  });
}

export type OfferSlotInput = {
  clinicId: string;
  practitionerId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  now?: Date;
};

/**
 * Ofrece un hueco liberado al mejor candidato de la lista de espera.
 * Se ejecuta dentro de la transaccion que libera el hueco.
 */
export async function offerNextForSlotTx(
  tx: Transaction,
  input: OfferSlotInput,
): Promise<WaitlistOffer | null> {
  const now = input.now ?? new Date();
  const localStart = DateTime.fromJSDate(input.startsAt, {
    zone: input.timezone,
  });
  const from = localStart.toISODate();
  const to = localStart.plus({ days: 1 }).toISODate();

  if (!from || !to) return null;

  // Solo se ofrecen huecos que el motor de disponibilidad considera libres.
  const durationMinutes = Math.round(
    (input.endsAt.getTime() - input.startsAt.getTime()) / 60_000,
  );
  const slots = await computeSlots(tx, {
    clinicId: input.clinicId,
    practitionerId: input.practitionerId,
    timezone: input.timezone,
    from,
    to,
    durationMinutes,
  });

  if (
    !slots.some(
      (slot) => slot.startsAt.getTime() === input.startsAt.getTime(),
    )
  ) {
    return null;
  }

  const localDate = localStart.toISODate();
  const localTime = localStart.toFormat("HH:mm:ss");
  if (!localDate) return null;

  const candidates = await tx
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.clinicId, input.clinicId),
        eq(waitlistEntries.status, "waiting"),
        lte(waitlistEntries.earliestDate, localDate),
        gte(waitlistEntries.latestDate, localDate),
        or(
          isNull(waitlistEntries.practitionerId),
          eq(waitlistEntries.practitionerId, input.practitionerId),
        ),
      ),
    )
    .orderBy(
      desc(waitlistEntries.priority),
      asc(waitlistEntries.createdAt),
    );

  const withinWindow = candidates.filter(
    (entry) =>
      (!entry.preferredTimeFrom || localTime >= entry.preferredTimeFrom) &&
      (!entry.preferredTimeTo || localTime < entry.preferredTimeTo),
  );

  if (withinWindow.length === 0) return null;

  // No repetir la oferta a quien ya la recibio (y expiro o rechazo).
  const previous = await tx
    .select({ entryId: waitlistOffers.entryId })
    .from(waitlistOffers)
    .where(
      and(
        eq(waitlistOffers.clinicId, input.clinicId),
        eq(waitlistOffers.startsAt, input.startsAt),
        eq(waitlistOffers.endsAt, input.endsAt),
      ),
    );

  const alreadyOffered = new Set(previous.map((row) => row.entryId));

  const candidate = withinWindow.find(
    (entry) => !alreadyOffered.has(entry.id),
  );

  if (!candidate) return null;

  const expiresAt = new Date(
    now.getTime() + OFFER_TTL_MINUTES * 60_000,
  );

  const [offer] = await tx
    .insert(waitlistOffers)
    .values({
      clinicId: input.clinicId,
      entryId: candidate.id,
      practitionerId: input.practitionerId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: "pending",
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();

  if (!offer) return null;

  await tx
    .update(waitlistEntries)
    .set({ status: "offered", updatedAt: now })
    .where(eq(waitlistEntries.id, candidate.id));

  return offer;
}

export async function acceptWaitlistOffer(
  db: Database,
  input: { clinicId: string; offerId: string; bookedVia?: "waitlist" | "staff" },
): Promise<Appointment> {
  try {
    return await withTenant(db, input.clinicId, async (tx) => {
      const [offer] = await tx
        .select()
        .from(waitlistOffers)
        .where(
          and(
            eq(waitlistOffers.id, input.offerId),
            eq(waitlistOffers.clinicId, input.clinicId),
          ),
        )
        .limit(1)
        .for("update");

      if (!offer) {
        throw new AppError(404, "OFFER_NOT_FOUND", "Oferta no encontrada");
      }

      if (offer.status !== "pending") {
        throw new AppError(
          409,
          "OFFER_NOT_PENDING",
          `La oferta esta en estado ${offer.status}`,
        );
      }

      const now = new Date();

      if (offer.expiresAt.getTime() <= now.getTime()) {
        // El worker la marcara expirada y ofrecera el hueco al siguiente.
        throw new AppError(409, "OFFER_EXPIRED", "La oferta expiro");
      }

      const [entry] = await tx
        .select()
        .from(waitlistEntries)
        .where(eq(waitlistEntries.id, offer.entryId))
        .limit(1);

      if (!entry) {
        throw new AppError(404, "ENTRY_NOT_FOUND", "Entrada no encontrada");
      }

      const [clinic] = await tx
        .select({ timezone: clinics.timezone })
        .from(clinics)
        .where(eq(clinics.id, input.clinicId))
        .limit(1);

      if (!clinic) {
        throw new AppError(404, "CLINIC_NOT_FOUND", "Clinica no encontrada");
      }

      const appointment = await createAppointmentTx(tx, {
        clinicId: input.clinicId,
        patientId: entry.patientId,
        practitionerId: offer.practitionerId,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        timezone: clinic.timezone,
        bookedVia: input.bookedVia ?? "waitlist",
      });

      await tx
        .update(waitlistOffers)
        .set({
          status: "accepted",
          respondedAt: now,
          appointmentId: appointment.id,
        })
        .where(eq(waitlistOffers.id, offer.id));

      await tx
        .update(waitlistEntries)
        .set({ status: "booked", updatedAt: now })
        .where(eq(waitlistEntries.id, entry.id));

      return appointment;
    });
  } catch (err) {
    throw mapBookingError(err);
  }
}

export type DeclineOfferResult = {
  declined: WaitlistOffer;
  nextOffer: WaitlistOffer | null;
};

export async function declineWaitlistOffer(
  db: Database,
  input: { clinicId: string; offerId: string },
): Promise<DeclineOfferResult> {
  return withTenant(db, input.clinicId, async (tx) => {
    const [offer] = await tx
      .select()
      .from(waitlistOffers)
      .where(
        and(
          eq(waitlistOffers.id, input.offerId),
          eq(waitlistOffers.clinicId, input.clinicId),
        ),
      )
      .limit(1)
      .for("update");

    if (!offer) {
      throw new AppError(404, "OFFER_NOT_FOUND", "Oferta no encontrada");
    }

    if (offer.status !== "pending") {
      throw new AppError(
        409,
        "OFFER_NOT_PENDING",
        `La oferta esta en estado ${offer.status}`,
      );
    }

    const now = new Date();

    const [declined] = await tx
      .update(waitlistOffers)
      .set({ status: "declined", respondedAt: now })
      .where(eq(waitlistOffers.id, offer.id))
      .returning();

    await tx
      .update(waitlistEntries)
      .set({ status: "waiting", updatedAt: now })
      .where(eq(waitlistEntries.id, offer.entryId));

    const [clinic] = await tx
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, input.clinicId))
      .limit(1);

    const nextOffer = clinic
      ? await offerNextForSlotTx(tx, {
          clinicId: input.clinicId,
          practitionerId: offer.practitionerId,
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
          timezone: clinic.timezone,
          now,
        })
      : null;

    if (!declined) {
      throw new AppError(500, "UPDATE_FAILED", "No se pudo rechazar la oferta");
    }

    return { declined, nextOffer };
  });
}

export async function listWaitlistOffers(
  db: Database,
  params: { clinicId: string; status?: string },
) {
  return withTenant(db, params.clinicId, (tx) =>
    tx
      .select({
        ...getTableColumns(waitlistOffers),
        patientId: waitlistEntries.patientId,
        patientFirstName: patients.firstName,
        patientLastName: patients.lastName,
        practitionerName: practitioners.fullName,
      })
      .from(waitlistOffers)
      .innerJoin(waitlistEntries, eq(waitlistEntries.id, waitlistOffers.entryId))
      .innerJoin(patients, eq(patients.id, waitlistEntries.patientId))
      .innerJoin(
        practitioners,
        eq(practitioners.id, waitlistOffers.practitionerId),
      )
      .where(
        and(
          params.status
            ? eq(waitlistOffers.status, params.status)
            : undefined,
        ),
      )
      .orderBy(asc(waitlistOffers.createdAt)),
  );
}

export type ExpireOffersSummary = {
  expired: number;
  reoffered: number;
};

/**
 * Worker: expira ofertas vencidas y encadena el hueco al siguiente candidato.
 * Corre con el rol de sistema (BYPASSRLS) porque atraviesa clinicas.
 */
export async function expireWaitlistOffers(
  db: Database,
  opts: { now?: Date; limit?: number } = {},
): Promise<ExpireOffersSummary> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;

  const due = await db
    .select({ id: waitlistOffers.id })
    .from(waitlistOffers)
    .where(
      and(
        eq(waitlistOffers.status, "pending"),
        lte(waitlistOffers.expiresAt, now),
      ),
    )
    .orderBy(asc(waitlistOffers.expiresAt))
    .limit(limit);

  let expired = 0;
  let reoffered = 0;

  for (const candidate of due) {
    const result = await db.transaction(async (tx) => {
      const [offer] = await tx
        .select()
        .from(waitlistOffers)
        .where(eq(waitlistOffers.id, candidate.id))
        .limit(1)
        .for("update");

      if (
        !offer ||
        offer.status !== "pending" ||
        offer.expiresAt.getTime() > now.getTime()
      ) {
        return { expired: 0, reoffered: 0 };
      }

      await tx
        .update(waitlistOffers)
        .set({ status: "expired", respondedAt: now })
        .where(eq(waitlistOffers.id, offer.id));

      await tx
        .update(waitlistEntries)
        .set({ status: "waiting", updatedAt: now })
        .where(eq(waitlistEntries.id, offer.entryId));

      const [clinic] = await tx
        .select({ timezone: clinics.timezone })
        .from(clinics)
        .where(eq(clinics.id, offer.clinicId))
        .limit(1);

      let offered = 0;

      if (clinic) {
        const next = await offerNextForSlotTx(tx, {
          clinicId: offer.clinicId,
          practitionerId: offer.practitionerId,
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
          timezone: clinic.timezone,
          now,
        });
        offered = next ? 1 : 0;
      }

      return { expired: 1, reoffered: offered };
    });

    expired += result.expired;
    reoffered += result.reoffered;
  }

  return { expired, reoffered };
}
