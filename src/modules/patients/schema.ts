import { z } from "zod";

const isoDate = z.iso.date();
const phone = z.string().min(7).max(32);
const email = z.email().max(320);
const documentNumber = z.string().min(3).max(64);

export const patientRelationship = z.enum([
  "self",
  "spouse",
  "child",
  "parent",
  "sibling",
  "other_dependent",
]);

export const patientDocumentType = z.enum([
  "ine",
  "passport",
  "curp",
  "ssn",
  "other",
]);

export const patientSexAtBirth = z.enum([
  "female",
  "male",
  "intersex",
  "unknown",
]);

export const guardianRelationship = z.enum([
  "parent",
  "legal_guardian",
  "caregiver",
  "spouse",
  "other",
]);

export const allergySeverity = z.enum([
  "mild",
  "moderate",
  "severe",
  "anaphylaxis",
]);

export const tagCategory = z.enum([
  "behavior",
  "risk",
  "vip",
  "operational",
  "clinical_alert",
]);

export const patientSearchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const patientParams = z.object({
  id: z.uuid(),
});

export const guardianParams = z.object({
  id: z.uuid(),
});

export const allergyParams = z.object({
  id: z.uuid(),
});

export const patientTagParams = z.object({
  id: z.uuid(),
  tagId: z.uuid(),
});

export const guardianBody = z
  .object({
    guardianPatientId: z.uuid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    documentNumber: documentNumber.optional(),
    phone: phone.optional(),
    relationship: guardianRelationship,
    isLegalGuardian: z.boolean().default(true),
    validFrom: isoDate.optional(),
    validTo: isoDate.optional(),
  })
  .refine((value) => Boolean(value.guardianPatientId || value.name), {
    message: "Indica guardianPatientId o name",
    path: ["name"],
  });

export const createPatientBody = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  preferredName: z.string().trim().max(120).optional(),
  birthDate: isoDate.optional(),
  phone: phone.optional(),
  email: email.optional(),
  documentType: patientDocumentType.optional(),
  documentNumber: documentNumber.optional(),
  sexAtBirth: patientSexAtBirth.optional(),
  genderIdentity: z.string().trim().max(80).optional(),
  bloodType: z.string().trim().max(8).optional(),
  preferredLanguage: z.string().trim().min(2).max(16).default("es"),
  householdId: z.uuid().optional(),
  relationship: patientRelationship.optional(),
  isAccountHolder: z.boolean().optional(),
  source: z.string().trim().max(80).optional(),
  transactionalOptIn: z.boolean().default(false),
  marketingOptIn: z.boolean().default(false),
  guardian: guardianBody.optional(),
});

export const updatePatientBody = z.object({
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  preferredName: z.string().trim().max(120).nullable().optional(),
  birthDate: isoDate.nullable().optional(),
  phone: phone.nullable().optional(),
  email: email.nullable().optional(),
  documentType: patientDocumentType.nullable().optional(),
  documentNumber: documentNumber.nullable().optional(),
  sexAtBirth: patientSexAtBirth.nullable().optional(),
  genderIdentity: z.string().trim().max(80).nullable().optional(),
  bloodType: z.string().trim().max(8).nullable().optional(),
  preferredLanguage: z.string().trim().min(2).max(16).optional(),
  householdId: z.uuid().nullable().optional(),
  relationship: patientRelationship.optional(),
  isAccountHolder: z.boolean().optional(),
  source: z.string().trim().max(80).nullable().optional(),
  marketingOptIn: z.boolean().optional(),
});

export const createHouseholdBody = z.object({
  name: z.string().trim().min(1).max(200),
  billingPatientId: z.uuid().optional(),
  preferredChannel: z.enum(["whatsapp", "sms", "email", "phone"]).default("whatsapp"),
  notes: z.string().trim().max(2000).optional(),
});

export const createAllergyBody = z.object({
  allergen: z.string().trim().min(1).max(120),
  reaction: z.string().trim().max(500).optional(),
  severity: allergySeverity,
  notes: z.string().trim().max(2000).optional(),
});

export const updateAllergyBody = z.object({
  allergen: z.string().trim().min(1).max(120).optional(),
  reaction: z.string().trim().max(500).nullable().optional(),
  severity: allergySeverity.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const createTagBody = z.object({
  code: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  category: tagCategory,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  isAlert: z.boolean().default(false),
});

export const assignTagBody = z.object({
  tagId: z.uuid(),
  severity: z.coerce.number().int().min(1).max(3).default(1),
  note: z.string().trim().max(500).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export type PatientSearchQuery = z.infer<typeof patientSearchQuery>;
export type CreatePatientBody = z.infer<typeof createPatientBody>;
export type UpdatePatientBody = z.infer<typeof updatePatientBody>;
export type CreateHouseholdBody = z.infer<typeof createHouseholdBody>;
export type GuardianBody = z.infer<typeof guardianBody>;
export type CreateAllergyBody = z.infer<typeof createAllergyBody>;
export type UpdateAllergyBody = z.infer<typeof updateAllergyBody>;
export type CreateTagBody = z.infer<typeof createTagBody>;
export type AssignTagBody = z.infer<typeof assignTagBody>;

