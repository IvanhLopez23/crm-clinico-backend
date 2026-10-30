import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import { appointments } from "../../db/schema/appointments.js";
import { contactPoints } from "../../db/schema/contact-points.js";
import { households } from "../../db/schema/households.js";
import { patientAllergies } from "../../db/schema/patient-allergies.js";
import { patientGuardians } from "../../db/schema/patient-guardians.js";
import { patients } from "../../db/schema/patients.js";
import { patientTags, tags } from "../../db/schema/tags.js";
import { withTenant } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import type { AuthContext, Permission } from "../../lib/permissions.js";
import { can } from "../../lib/permissions.js";
import { pgConstraint, pgErrorCode } from "../../lib/pg-error.js";
import {
  decryptPhi,
  documentBlindIndex,
  emailBlindIndex,
  encryptPhi,
  maskDocument,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizePhone,
  phoneBlindIndex,
} from "../../lib/phi-crypto.js";
import type {
  AssignTagBody,
  CreateAllergyBody,
  CreateHouseholdBody,
  CreatePatientBody,
  CreateTagBody,
  GuardianBody,
  UpdateAllergyBody,
  UpdatePatientBody,
} from "./schema.js";

export type PatientActor = Pick<
  AuthContext,
  "userId" | "clinicId" | "role" | "practitionerId"
>;

export type ContactView = {
  id: string;
  ownerType: string;
  kind: string;
  valueMasked: string;
  isPrimary: boolean;
  isVerified: boolean;
  transactionalOptIn: boolean;
  marketingOptIn: boolean;
  optOutAt: Date | null;
};

export type AllergyView = {
  id: string;
  allergen: string;
  severity: string;
  isActive: boolean;
  verifiedAt: Date | null;
  reaction?: string | null;
  notes?: string | null;
};

export type TagView = {
  id: string;
  code: string;
  label: string;
  category: string;
  color: string | null;
  isAlert: boolean;
  severity: number;
  expiresAt: Date | null;
};

export type GuardianView = {
  id: string;
  guardianPatientId: string | null;
  name: string | null;
  phoneMasked: string | null;
  relationship: string;
  isLegalGuardian: boolean;
  validFrom: string;
  validTo: string | null;
};

export type PatientDetail = {
  id: string;
  clinicId: string;
  householdId: string | null;
  relationship: string;
  isAccountHolder: boolean;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  birthDate: string | null;
  documentType: string | null;
  documentMasked: string | null;
  sexAtBirth: string | null;
  genderIdentity: string | null;
  bloodType: string | null;
  preferredLanguage: string;
  status: string;
  reminderOptOut: boolean;
  marketingOptIn: boolean;
  source: string | null;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  household: { id: string; name: string; billingPatientId: string | null } | null;
  contacts: ContactView[];
  allergies: AllergyView[];
  tags: TagView[];
  guardians: GuardianView[];
};

export type PatientSearchResult = {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  birthDate: string | null;
  status: string;
  householdId: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
};

export async function searchPatients(
  db: Database,
  params: {
    actor: PatientActor;
    q: string;
    limit: number;
  },
): Promise<PatientSearchResult[]> {
  const q = params.q.trim();
  const practitionerId = requirePractitionerScope(params.actor);

  return withTenant(db, params.actor.clinicId, async (tx) => {
    const conditions = [
      ilike(patients.firstName, `%${q}%`),
      ilike(patients.lastName, `%${q}%`),
      eq(patients.documentNumberBidx, documentBlindIndex(q)),
    ];

    if (q.includes("@")) {
      conditions.push(
        existsContactBidx(patients.id, emailBlindIndex(q), "email"),
      );
    } else if (/^[+\d\s().-]+$/.test(q)) {
      const candidates = phoneSearchCandidates(q);
      conditions.push(
        or(
          ...candidates.map((bidx) =>
            existsContactBidx(patients.id, bidx, "phone"),
          ),
        )!,
      );
    }

    const scope = practitionerId
      ? sql`exists (
          select 1 from appointments ap
          where ap.patient_id = ${patients.id}
            and ap.practitioner_id = ${practitionerId}
            and ap.deleted_at is null
        )`
      : undefined;

    const rows = await tx
      .select({
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        preferredName: patients.preferredName,
        birthDate: patients.birthDate,
        status: patients.status,
        householdId: patients.householdId,
      })
      .from(patients)
      .where(
        and(
          eq(patients.clinicId, params.actor.clinicId),
          or(...conditions),
          scope,
        ),
      )
      .orderBy(asc(patients.lastName), asc(patients.firstName))
      .limit(params.limit);

    if (rows.length === 0) return [];

    const contacts = await tx
      .select({
        ownerId: contactPoints.ownerId,
        kind: contactPoints.kind,
        valueMasked: contactPoints.valueMasked,
        isPrimary: contactPoints.isPrimary,
      })
      .from(contactPoints)
      .where(
        and(
          eq(contactPoints.clinicId, params.actor.clinicId),
          eq(contactPoints.ownerType, "patient"),
          inArray(
            contactPoints.ownerId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(desc(contactPoints.isPrimary));

    return rows.map((row) => {
      const patientContacts = contacts.filter((c) => c.ownerId === row.id);
      return {
        ...row,
        phoneMasked:
          patientContacts.find((c) => c.kind === "phone")?.valueMasked ?? null,
        emailMasked:
          patientContacts.find((c) => c.kind === "email")?.valueMasked ?? null,
      };
    });
  });
}

export async function getPatient(
  db: Database,
  params: { actor: PatientActor; patientId: string },
): Promise<PatientDetail> {
  return withTenant(db, params.actor.clinicId, (tx) =>
    loadPatientDetailTx(tx, params.actor, params.patientId),
  );
}

export async function createPatient(
  db: Database,
  params: {
    actor: PatientActor;
    input: CreatePatientBody;
  },
): Promise<PatientDetail> {
  const input = params.input;
  const clinicId = params.actor.clinicId;

  if (isMinor(input.birthDate)) {
    if (!input.guardian || !input.guardian.isLegalGuardian) {
      throw new AppError(
        422,
        "GUARDIAN_REQUIRED",
        "Un paciente menor de 18 años requiere tutor legal",
      );
    }
  }

  let patientId: string;

  try {
    patientId = await withTenant(db, clinicId, async (tx) => {
      let householdId = input.householdId ?? null;
      let createdHousehold = false;

      if (householdId) {
        const [household] = await tx
          .select({ id: households.id })
          .from(households)
          .where(eq(households.id, householdId))
          .limit(1);
        if (!household) {
          throw new AppError(404, "HOUSEHOLD_NOT_FOUND", "Familia no encontrada");
        }
      } else {
        householdId = randomUUID();
        createdHousehold = true;
        await tx.insert(households).values({
          id: householdId,
          clinicId,
          name: `${input.firstName} ${input.lastName}`.trim(),
          preferredChannel: "whatsapp",
        });
      }

      const id = randomUUID();
      const phone = input.phone ? normalizePhone(input.phone) : null;
      const email = input.email ? normalizeEmail(input.email) : null;

      await tx.insert(patients).values({
        id,
        clinicId,
        householdId,
        relationship: input.relationship ?? (createdHousehold ? "self" : "other_dependent"),
        isAccountHolder: input.isAccountHolder ?? createdHousehold,
        firstName: input.firstName,
        lastName: input.lastName,
        preferredName: input.preferredName ?? null,
        birthDate: input.birthDate ?? null,
        phoneE164: phone,
        email,
        documentType: input.documentType ?? null,
        documentNumberEnc: input.documentNumber
          ? encryptPhi(input.documentNumber)
          : null,
        documentNumberBidx: input.documentNumber
          ? documentBlindIndex(input.documentNumber)
          : null,
        sexAtBirth: input.sexAtBirth ?? null,
        genderIdentity: input.genderIdentity ?? null,
        bloodType: input.bloodType ?? null,
        preferredLanguage: input.preferredLanguage,
        status: "active",
        source: input.source ?? "reception",
        marketingOptIn: input.marketingOptIn,
      });

      if (phone) {
        await upsertPrimaryContactTx(tx, {
          clinicId,
          patientId: id,
          kind: "phone",
          value: phone,
          transactionalOptIn: input.transactionalOptIn,
          marketingOptIn: input.marketingOptIn,
        });
      }
      if (email) {
        await upsertPrimaryContactTx(tx, {
          clinicId,
          patientId: id,
          kind: "email",
          value: email,
          transactionalOptIn: input.transactionalOptIn,
          marketingOptIn: input.marketingOptIn,
        });
      }

      if (input.guardian) {
        await insertGuardianTx(tx, clinicId, id, input.guardian);
      }

      if (createdHousehold) {
        await tx
          .update(households)
          .set({ billingPatientId: id })
          .where(eq(households.id, householdId));
      }

      return id;
    });
  } catch (err) {
    if (
      pgErrorCode(err) === "23505" &&
      pgConstraint(err) === "patients_document_bidx_uq"
    ) {
      throw new AppError(
        409,
        "PATIENT_DOCUMENT_EXISTS",
        "Ya existe un paciente con ese documento en la clinica",
      );
    }
    throw err;
  }

  return getPatient(db, { actor: params.actor, patientId });
}

export async function updatePatient(
  db: Database,
  params: {
    actor: PatientActor;
    patientId: string;
    input: UpdatePatientBody;
  },
): Promise<PatientDetail> {
  const { input } = params;

  try {
    await withTenant(db, params.actor.clinicId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(patients)
        .where(eq(patients.id, params.patientId))
        .limit(1);

      if (!existing) {
        throw new AppError(404, "PATIENT_NOT_FOUND", "Paciente no encontrado");
      }

      if (input.householdId !== undefined && input.householdId !== null) {
        const [household] = await tx
          .select({ id: households.id })
          .from(households)
          .where(eq(households.id, input.householdId))
          .limit(1);
        if (!household) {
          throw new AppError(404, "HOUSEHOLD_NOT_FOUND", "Familia no encontrada");
        }
      }

      const phone =
        input.phone !== undefined && input.phone !== null
          ? normalizePhone(input.phone)
          : undefined;
      const email =
        input.email !== undefined && input.email !== null
          ? normalizeEmail(input.email)
          : undefined;

      const patch: Partial<typeof patients.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.firstName !== undefined) patch.firstName = input.firstName;
      if (input.lastName !== undefined) patch.lastName = input.lastName;
      if (input.preferredName !== undefined) patch.preferredName = input.preferredName;
      if (input.birthDate !== undefined) patch.birthDate = input.birthDate;
      if (input.phone !== undefined) patch.phoneE164 = phone ?? null;
      if (input.email !== undefined) patch.email = email ?? null;
      if (input.sexAtBirth !== undefined) patch.sexAtBirth = input.sexAtBirth;
      if (input.genderIdentity !== undefined) patch.genderIdentity = input.genderIdentity;
      if (input.bloodType !== undefined) patch.bloodType = input.bloodType;
      if (input.preferredLanguage !== undefined) {
        patch.preferredLanguage = input.preferredLanguage;
      }
      if (input.householdId !== undefined) patch.householdId = input.householdId;
      if (input.relationship !== undefined) patch.relationship = input.relationship;
      if (input.isAccountHolder !== undefined) {
        patch.isAccountHolder = input.isAccountHolder;
      }
      if (input.source !== undefined) patch.source = input.source;
      if (input.marketingOptIn !== undefined) {
        patch.marketingOptIn = input.marketingOptIn;
      }
      if (input.documentType !== undefined) patch.documentType = input.documentType;
      if (input.documentNumber !== undefined) {
        patch.documentNumberEnc = input.documentNumber
          ? encryptPhi(input.documentNumber)
          : null;
        patch.documentNumberBidx = input.documentNumber
          ? documentBlindIndex(input.documentNumber)
          : null;
      }

      await tx.update(patients).set(patch).where(eq(patients.id, params.patientId));

      if (phone) {
        await upsertPrimaryContactTx(tx, {
          clinicId: params.actor.clinicId,
          patientId: params.patientId,
          kind: "phone",
          value: phone,
          transactionalOptIn: false,
          marketingOptIn: false,
        });
      }
      if (email) {
        await upsertPrimaryContactTx(tx, {
          clinicId: params.actor.clinicId,
          patientId: params.patientId,
          kind: "email",
          value: email,
          transactionalOptIn: false,
          marketingOptIn: false,
        });
      }
    });
  } catch (err) {
    if (
      pgErrorCode(err) === "23505" &&
      pgConstraint(err) === "patients_document_bidx_uq"
    ) {
      throw new AppError(
        409,
        "PATIENT_DOCUMENT_EXISTS",
        "Ya existe un paciente con ese documento en la clinica",
      );
    }
    throw err;
  }

  return getPatient(db, {
    actor: params.actor,
    patientId: params.patientId,
  });
}

export async function createHousehold(
  db: Database,
  params: { actor: PatientActor; input: CreateHouseholdBody },
): Promise<{ id: string; name: string; billingPatientId: string | null }> {
  return withTenant(db, params.actor.clinicId, async (tx) => {
    if (params.input.billingPatientId) {
      await assertPatientExistsTx(tx, params.input.billingPatientId);
    }

    const [created] = await tx
      .insert(households)
      .values({
        id: randomUUID(),
        clinicId: params.actor.clinicId,
        name: params.input.name,
        billingPatientId: params.input.billingPatientId ?? null,
        preferredChannel: params.input.preferredChannel,
        notes: params.input.notes ?? null,
      })
      .returning({
        id: households.id,
        name: households.name,
        billingPatientId: households.billingPatientId,
      });

    if (!created) {
      throw new AppError(500, "INSERT_FAILED", "No se pudo crear la familia");
    }
    return created;
  });
}

export async function getHousehold(
  db: Database,
  params: { actor: PatientActor; householdId: string },
): Promise<{
  id: string;
  name: string;
  billingPatientId: string | null;
  preferredChannel: string;
  members: PatientSearchResult[];
  contacts: ContactView[];
}> {
  return withTenant(db, params.actor.clinicId, async (tx) => {
    const [household] = await tx
      .select()
      .from(households)
      .where(eq(households.id, params.householdId))
      .limit(1);

    if (!household) {
      throw new AppError(404, "HOUSEHOLD_NOT_FOUND", "Familia no encontrada");
    }

    const members = await tx
      .select({
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        preferredName: patients.preferredName,
        birthDate: patients.birthDate,
        status: patients.status,
        householdId: patients.householdId,
      })
      .from(patients)
      .where(eq(patients.householdId, params.householdId))
      .orderBy(asc(patients.lastName), asc(patients.firstName));

    if (params.actor.role === "practitioner") {
      const practitionerId = requirePractitionerScope(params.actor);
      if (!practitionerId) {
        throw new AppError(
          403,
          "NO_PRACTITIONER_PROFILE",
          "El usuario no tiene especialista asociado",
        );
      }
      const ids = members.map((member) => member.id);
      if (ids.length === 0) {
        throw new AppError(404, "HOUSEHOLD_NOT_FOUND", "Familia no encontrada");
      }
      const rows = await tx
        .select({ patientId: appointments.patientId })
        .from(appointments)
        .where(
          and(
            inArray(appointments.patientId, ids),
            eq(appointments.practitionerId, practitionerId),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new AppError(404, "HOUSEHOLD_NOT_FOUND", "Familia no encontrada");
      }
    }

    const contacts = await tx
      .select({
        id: contactPoints.id,
        ownerType: contactPoints.ownerType,
        kind: contactPoints.kind,
        valueMasked: contactPoints.valueMasked,
        isPrimary: contactPoints.isPrimary,
        isVerified: contactPoints.isVerified,
        transactionalOptIn: contactPoints.transactionalOptIn,
        marketingOptIn: contactPoints.marketingOptIn,
        optOutAt: contactPoints.optOutAt,
      })
      .from(contactPoints)
      .where(
        and(
          eq(contactPoints.clinicId, params.actor.clinicId),
          eq(contactPoints.ownerType, "household"),
          eq(contactPoints.ownerId, params.householdId),
        ),
      )
      .orderBy(desc(contactPoints.isPrimary));

    return {
      id: household.id,
      name: household.name,
      billingPatientId: household.billingPatientId,
      preferredChannel: household.preferredChannel,
      members: members.map((member) => ({
        ...member,
        phoneMasked: null,
        emailMasked: null,
      })),
      contacts,
    };
  });
}

export async function addGuardian(
  db: Database,
  params: {
    actor: PatientActor;
    patientId: string;
    input: GuardianBody;
  },
): Promise<GuardianView> {
  return withTenant(db, params.actor.clinicId, async (tx) => {
    await assertPatientExistsTx(tx, params.patientId);
    return insertGuardianTx(
      tx,
      params.actor.clinicId,
      params.patientId,
      params.input,
    );
  });
}

export async function listAllergies(
  db: Database,
  params: { actor: PatientActor; patientId: string },
): Promise<AllergyView[]> {
  return withTenant(db, params.actor.clinicId, async (tx) => {
    await assertPatientAccessTx(tx, params.actor, params.patientId);
    const rows = await tx
      .select()
      .from(patientAllergies)
      .where(
        and(
          eq(patientAllergies.patientId, params.patientId),
          eq(patientAllergies.isActive, true),
        ),
      )
      .orderBy(desc(patientAllergies.severity), asc(patientAllergies.allergen));

    const includeClinical = can(params.actor.role, "clinical:write");
    return rows.map((row) => ({
      id: row.id,
      allergen: row.allergen,
      severity: row.severity,
      isActive: row.isActive,
      verifiedAt: row.verifiedAt,
      ...(includeClinical
        ? { reaction: row.reaction, notes: row.notes }
        : {}),
    }));
  });
}

export async function createAllergy(
  db: Database,
  params: {
    actor: PatientActor;
    patientId: string;
    input: CreateAllergyBody;
  },
): Promise<AllergyView> {
  try {
    return await withTenant(db, params.actor.clinicId, async (tx) => {
      await assertPatientAccessTx(tx, params.actor, params.patientId);
      const [created] = await tx
        .insert(patientAllergies)
        .values({
          clinicId: params.actor.clinicId,
          patientId: params.patientId,
          allergen: params.input.allergen,
          reaction: params.input.reaction ?? null,
          severity: params.input.severity,
          verifiedByUserId: params.actor.userId,
          verifiedAt: new Date(),
          notes: params.input.notes ?? null,
        })
        .returning();

      if (!created) {
        throw new AppError(500, "INSERT_FAILED", "No se pudo crear la alergia");
      }
      return {
        id: created.id,
        allergen: created.allergen,
        severity: created.severity,
        isActive: created.isActive,
        verifiedAt: created.verifiedAt,
        reaction: created.reaction,
        notes: created.notes,
      };
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      throw new AppError(
        409,
        "ALLERGY_EXISTS",
        "Ya existe una alergia activa con ese nombre",
      );
    }
    throw err;
  }
}

export async function updateAllergy(
  db: Database,
  params: {
    actor: PatientActor;
    allergyId: string;
    input: UpdateAllergyBody;
  },
): Promise<AllergyView> {
  return withTenant(db, params.actor.clinicId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(patientAllergies)
      .where(eq(patientAllergies.id, params.allergyId))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "ALLERGY_NOT_FOUND", "Alergia no encontrada");
    }
    await assertPatientAccessTx(tx, params.actor, existing.patientId);

    const [updated] = await tx
      .update(patientAllergies)
      .set({
        allergen: params.input.allergen ?? existing.allergen,
        reaction:
          params.input.reaction !== undefined
            ? params.input.reaction
            : existing.reaction,
        severity: params.input.severity ?? existing.severity,
        notes:
          params.input.notes !== undefined ? params.input.notes : existing.notes,
        isActive: params.input.isActive ?? existing.isActive,
      })
      .where(eq(patientAllergies.id, params.allergyId))
      .returning();

    if (!updated) {
      throw new AppError(500, "UPDATE_FAILED", "No se pudo actualizar la alergia");
    }
    return {
      id: updated.id,
      allergen: updated.allergen,
      severity: updated.severity,
      isActive: updated.isActive,
      verifiedAt: updated.verifiedAt,
      reaction: updated.reaction,
      notes: updated.notes,
    };
  });
}

export async function listTags(
  db: Database,
  params: { actor: PatientActor },
): Promise<
  Array<{
    id: string;
    code: string;
    label: string;
    category: string;
    color: string | null;
    isAlert: boolean;
    isSystem: boolean;
  }>
> {
  return withTenant(db, params.actor.clinicId, (tx) =>
    tx
      .select({
        id: tags.id,
        code: tags.code,
        label: tags.label,
        category: tags.category,
        color: tags.color,
        isAlert: tags.isAlert,
        isSystem: tags.isSystem,
      })
      .from(tags)
      .orderBy(asc(tags.label)),
  );
}

export async function createTag(
  db: Database,
  params: { actor: PatientActor; input: CreateTagBody },
): Promise<{ id: string; code: string; label: string }> {
  try {
    return await withTenant(db, params.actor.clinicId, async (tx) => {
      const [created] = await tx
        .insert(tags)
        .values({
          clinicId: params.actor.clinicId,
          code: params.input.code,
          label: params.input.label,
          category: params.input.category,
          color: params.input.color ?? null,
          isAlert: params.input.isAlert,
          isSystem: false,
        })
        .returning({ id: tags.id, code: tags.code, label: tags.label });

      if (!created) {
        throw new AppError(500, "INSERT_FAILED", "No se pudo crear la etiqueta");
      }
      return created;
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      throw new AppError(409, "TAG_EXISTS", "Ya existe una etiqueta con ese codigo");
    }
    throw err;
  }
}

export async function assignTag(
  db: Database,
  params: {
    actor: PatientActor;
    patientId: string;
    input: AssignTagBody;
  },
): Promise<TagView> {
  return withTenant(db, params.actor.clinicId, async (tx) => {
    await assertPatientAccessTx(tx, params.actor, params.patientId);

    const [tag] = await tx
      .select()
      .from(tags)
      .where(eq(tags.id, params.input.tagId))
      .limit(1);
    if (!tag) {
      throw new AppError(404, "TAG_NOT_FOUND", "Etiqueta no encontrada");
    }

    await tx
      .insert(patientTags)
      .values({
        clinicId: params.actor.clinicId,
        patientId: params.patientId,
        tagId: params.input.tagId,
        severity: params.input.severity,
        note: params.input.note ?? null,
        expiresAt: params.input.expiresAt ? new Date(params.input.expiresAt) : null,
        createdByUserId: params.actor.userId,
      })
      .onConflictDoUpdate({
        target: [patientTags.patientId, patientTags.tagId],
        set: {
          severity: params.input.severity,
          note: params.input.note ?? null,
          expiresAt: params.input.expiresAt ? new Date(params.input.expiresAt) : null,
          createdByUserId: params.actor.userId,
        },
      });

    return {
      id: tag.id,
      code: tag.code,
      label: tag.label,
      category: tag.category,
      color: tag.color,
      isAlert: tag.isAlert,
      severity: params.input.severity,
      expiresAt: params.input.expiresAt ? new Date(params.input.expiresAt) : null,
    };
  });
}

export async function removeTag(
  db: Database,
  params: { actor: PatientActor; patientId: string; tagId: string },
): Promise<void> {
  await withTenant(db, params.actor.clinicId, async (tx) => {
    await assertPatientAccessTx(tx, params.actor, params.patientId);
    await tx
      .delete(patientTags)
      .where(
        and(
          eq(patientTags.patientId, params.patientId),
          eq(patientTags.tagId, params.tagId),
        ),
      );
  });
}

async function loadPatientDetailTx(
  tx: Transaction,
  actor: PatientActor,
  patientId: string,
): Promise<PatientDetail> {
  const [patient] = await tx
    .select()
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);

  if (!patient) {
    throw new AppError(404, "PATIENT_NOT_FOUND", "Paciente no encontrado");
  }
  await assertPatientAccessTx(tx, actor, patientId);

  const contacts = await tx
    .select({
      id: contactPoints.id,
      ownerType: contactPoints.ownerType,
      kind: contactPoints.kind,
      valueMasked: contactPoints.valueMasked,
      isPrimary: contactPoints.isPrimary,
      isVerified: contactPoints.isVerified,
      transactionalOptIn: contactPoints.transactionalOptIn,
      marketingOptIn: contactPoints.marketingOptIn,
      optOutAt: contactPoints.optOutAt,
    })
    .from(contactPoints)
    .where(
      and(
        eq(contactPoints.clinicId, actor.clinicId),
        or(
          and(
            eq(contactPoints.ownerType, "patient"),
            eq(contactPoints.ownerId, patientId),
          ),
          patient.householdId
            ? and(
                eq(contactPoints.ownerType, "household"),
                eq(contactPoints.ownerId, patient.householdId),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(desc(contactPoints.isPrimary));

  const [household] = patient.householdId
    ? await tx
        .select({
          id: households.id,
          name: households.name,
          billingPatientId: households.billingPatientId,
        })
        .from(households)
        .where(eq(households.id, patient.householdId))
        .limit(1)
    : [];

  const allergies = await listAllergiesTx(tx, actor, patientId);
  const patientTagRows = await tx
    .select({
      id: tags.id,
      code: tags.code,
      label: tags.label,
      category: tags.category,
      color: tags.color,
      isAlert: tags.isAlert,
      severity: patientTags.severity,
      expiresAt: patientTags.expiresAt,
    })
    .from(patientTags)
    .innerJoin(tags, eq(tags.id, patientTags.tagId))
    .where(eq(patientTags.patientId, patientId))
    .orderBy(desc(patientTags.severity), asc(tags.label));

  const guardians = await loadGuardiansTx(tx, patientId);

  let documentMasked: string | null = null;
  if (patient.documentNumberEnc) {
    try {
      documentMasked = maskDocument(decryptPhi(patient.documentNumberEnc));
    } catch {
      documentMasked = null;
    }
  }

  return {
    id: patient.id,
    clinicId: patient.clinicId,
    householdId: patient.householdId,
    relationship: patient.relationship,
    isAccountHolder: patient.isAccountHolder,
    firstName: patient.firstName,
    lastName: patient.lastName,
    preferredName: patient.preferredName,
    birthDate: patient.birthDate,
    documentType: patient.documentType,
    documentMasked,
    sexAtBirth: patient.sexAtBirth,
    genderIdentity: patient.genderIdentity,
    bloodType: patient.bloodType,
    preferredLanguage: patient.preferredLanguage,
    status: patient.status,
    reminderOptOut: patient.reminderOptOut,
    marketingOptIn: patient.marketingOptIn,
    source: patient.source,
    firstVisitAt: patient.firstVisitAt,
    lastVisitAt: patient.lastVisitAt,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
    household: household ?? null,
    contacts,
    allergies,
    tags: patientTagRows,
    guardians,
  };
}

async function listAllergiesTx(
  tx: Transaction,
  actor: PatientActor,
  patientId: string,
): Promise<AllergyView[]> {
  const rows = await tx
    .select()
    .from(patientAllergies)
    .where(
      and(
        eq(patientAllergies.patientId, patientId),
        eq(patientAllergies.isActive, true),
      ),
    )
    .orderBy(desc(patientAllergies.severity), asc(patientAllergies.allergen));

  const includeClinical = can(actor.role, "clinical:write");
  return rows.map((row) => ({
    id: row.id,
    allergen: row.allergen,
    severity: row.severity,
    isActive: row.isActive,
    verifiedAt: row.verifiedAt,
    ...(includeClinical ? { reaction: row.reaction, notes: row.notes } : {}),
  }));
}

async function loadGuardiansTx(
  tx: Transaction,
  patientId: string,
): Promise<GuardianView[]> {
  const rows = await tx
    .select()
    .from(patientGuardians)
    .where(eq(patientGuardians.patientId, patientId))
    .orderBy(desc(patientGuardians.isLegalGuardian));

  const guardianIds = rows
    .map((row) => row.guardianPatientId)
    .filter((id): id is string => Boolean(id));

  const guardianPatients =
    guardianIds.length > 0
      ? await tx
          .select({
            id: patients.id,
            firstName: patients.firstName,
            lastName: patients.lastName,
          })
          .from(patients)
          .where(inArray(patients.id, guardianIds))
      : [];

  return rows.map((row) => {
    const guardianPatient = guardianPatients.find(
      (patient) => patient.id === row.guardianPatientId,
    );
    return {
      id: row.id,
      guardianPatientId: row.guardianPatientId,
      name:
        row.guardianName ??
        (guardianPatient
          ? `${guardianPatient.firstName} ${guardianPatient.lastName}`
          : null),
      phoneMasked: row.guardianPhoneE164
        ? maskPhone(row.guardianPhoneE164)
        : null,
      relationship: row.relationship,
      isLegalGuardian: row.isLegalGuardian,
      validFrom: row.validFrom,
      validTo: row.validTo,
    };
  });
}

async function insertGuardianTx(
  tx: Transaction,
  clinicId: string,
  patientId: string,
  input: GuardianBody,
): Promise<GuardianView> {
  if (input.guardianPatientId) {
    if (input.guardianPatientId === patientId) {
      throw new AppError(422, "INVALID_GUARDIAN", "Un paciente no puede ser su propio tutor");
    }
    await assertPatientExistsTx(tx, input.guardianPatientId);
  }

  const [created] = await tx
    .insert(patientGuardians)
    .values({
      clinicId,
      patientId,
      guardianPatientId: input.guardianPatientId ?? null,
      guardianName: input.name ?? null,
      guardianDocumentEnc: input.documentNumber
        ? encryptPhi(input.documentNumber)
        : null,
      guardianDocumentBidx: input.documentNumber
        ? documentBlindIndex(input.documentNumber)
        : null,
      guardianPhoneE164: input.phone ? normalizePhone(input.phone) : null,
      relationship: input.relationship,
      isLegalGuardian: input.isLegalGuardian,
      validFrom: input.validFrom ?? new Date().toISOString().slice(0, 10),
      validTo: input.validTo ?? null,
    })
    .returning();

  if (!created) {
    throw new AppError(500, "INSERT_FAILED", "No se pudo crear el tutor");
  }

  return {
    id: created.id,
    guardianPatientId: created.guardianPatientId,
    name: created.guardianName,
    phoneMasked: created.guardianPhoneE164
      ? maskPhone(created.guardianPhoneE164)
      : null,
    relationship: created.relationship,
    isLegalGuardian: created.isLegalGuardian,
    validFrom: created.validFrom,
    validTo: created.validTo,
  };
}

async function upsertPrimaryContactTx(
  tx: Transaction,
  params: {
    clinicId: string;
    patientId: string;
    kind: "phone" | "email";
    value: string;
    transactionalOptIn: boolean;
    marketingOptIn: boolean;
  },
): Promise<void> {
  const [existing] = await tx
    .select({ id: contactPoints.id })
    .from(contactPoints)
    .where(
      and(
        eq(contactPoints.clinicId, params.clinicId),
        eq(contactPoints.ownerType, "patient"),
        eq(contactPoints.ownerId, params.patientId),
        eq(contactPoints.kind, params.kind),
        eq(contactPoints.isPrimary, true),
      ),
    )
    .limit(1);

  const valueEnc = encryptPhi(params.value);
  const valueBidx =
    params.kind === "phone"
      ? phoneBlindIndex(params.value)
      : emailBlindIndex(params.value);
  const valueMasked =
    params.kind === "phone"
      ? maskPhone(params.value)
      : maskEmail(params.value);

  if (existing) {
    await tx
      .update(contactPoints)
      .set({
        valueEnc,
        valueBidx,
        valueMasked,
        isVerified: false,
        verifiedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(contactPoints.id, existing.id));
    return;
  }

  const now = new Date();
  await tx.insert(contactPoints).values({
    clinicId: params.clinicId,
    ownerType: "patient",
    ownerId: params.patientId,
    kind: params.kind,
    valueEnc,
    valueBidx,
    valueMasked,
    isPrimary: true,
    transactionalOptIn: params.transactionalOptIn,
    transactionalOptInAt: params.transactionalOptIn ? now : null,
    marketingOptIn: params.marketingOptIn,
    marketingOptInAt: params.marketingOptIn ? now : null,
    source: "reception",
  });
}

async function assertPatientExistsTx(
  tx: Transaction,
  patientId: string,
): Promise<void> {
  const [patient] = await tx
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (!patient) {
    throw new AppError(404, "PATIENT_NOT_FOUND", "Paciente no encontrado");
  }
}

async function assertPatientAccessTx(
  tx: Transaction,
  actor: PatientActor,
  patientId: string,
): Promise<void> {
  if (actor.role !== "practitioner") return;
  const practitionerId = requirePractitionerScope(actor);

  const result = await tx.execute(sql`
    select 1
    from appointments
    where patient_id = ${patientId}
      and practitioner_id = ${practitionerId}
      and deleted_at is null
    limit 1
  `);

  if ((result.rowCount ?? 0) === 0) {
    throw new AppError(404, "PATIENT_NOT_FOUND", "Paciente no encontrado");
  }
}

function requirePractitionerScope(actor: PatientActor): string | null {
  if (actor.role !== "practitioner") return null;
  if (!actor.practitionerId) {
    throw new AppError(
      403,
      "NO_PRACTITIONER_PROFILE",
      "El usuario no tiene especialista asociado",
    );
  }
  return actor.practitionerId;
}

function existsContactBidx(
  patientId: typeof patients.id,
  bidx: string,
  kind: "phone" | "email",
) {
  return sql`exists (
    select 1 from contact_points cp
    where cp.owner_type = 'patient'
      and cp.owner_id = ${patientId}
      and cp.kind = ${kind}
      and cp.value_bidx = ${bidx}
  )`;
}

function isMinor(birthDate: string | null | undefined): boolean {
  if (!birthDate) return false;
  const birth = DateTime.fromISO(birthDate, { zone: "utc" });
  if (!birth.isValid) return false;
  return DateTime.utc().diff(birth, "years").years < 18;
}

/**
 * Un paciente puede buscar con 10 digitos locales, con lada 52 o con el
 * prefijo movil 521. Se prueban las variantes para no depender de como se
 * capturo originalmente el telefono.
 */
function phoneSearchCandidates(value: string): string[] {
  const normalized = normalizePhone(value);
  const digits = normalized.replace(/\D/g, "");
  const values = new Set<string>([normalized]);

  if (digits.length === 10) {
    values.add(`+52${digits}`);
    values.add(`+521${digits}`);
    values.add(`52${digits}`);
  } else if (digits.length === 12 && digits.startsWith("52")) {
    values.add(`+${digits}`);
    values.add(`+521${digits.slice(2)}`);
  } else if (digits.length === 13 && digits.startsWith("521")) {
    values.add(`+${digits}`);
    values.add(`+52${digits.slice(3)}`);
  }

  return [...new Set([...values].map((item) => phoneBlindIndex(item)))];
}
