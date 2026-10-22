import type {
  ClinicalSection,
  ClinicalSectionStatus,
  Json,
  MedicineFoodInstruction,
  MedicineRegistrationStatus,
  MedicineSourceType,
  MedicineSubmissionStatus,
  MedicineVerificationStatus,
  PrescriptionClass,
} from '~/lib/db.types';

/**
 * Shared medicine catalogue: display vocabulary, filters and submission rules.
 *
 * This module is deliberately framework-free. The catalogue screen, the owner
 * submission dialog and the verification script all use the same functions, so
 * a rule such as "a submitted record needs a source" cannot drift between the
 * UI and its tests.
 *
 * ## The safety boundary
 *
 * A catalogue record is a *professional reference*, not a prescription. Nothing
 * here calculates a patient-specific dose, and nothing treats unverified text
 * (including anything generated automatically) as verified. Verification is a
 * stored fact that only a named reviewer can set through the database RPCs.
 */

export const CATALOGUE_PAGE_SIZE = 25;
export const CATALOGUE_MAX_PAGE_SIZE = 100;

/** Core clinical sections shown on a dossier. */
export const CLINICAL_SECTION_ORDER: ClinicalSection[] = [
  'indications',
  'dosage',
  'administration',
  'food',
  'contraindications',
  'precautions',
  'common_adverse_effects',
  'serious_adverse_effects',
  'interactions',
  'pregnancy',
  'breastfeeding',
  'paediatric',
  'older_adult',
  'renal',
  'hepatic',
  'storage',
  'warnings',
  'professional_assessment',
];

/** Sections a reviewer must address before clinical content is usable. */
export const CORE_CLINICAL_SECTIONS: ClinicalSection[] = [
  'indications',
  'dosage',
  'contraindications',
  'interactions',
  'warnings',
];

export const CLINICAL_SECTION_LABEL: Record<ClinicalSection, string> = {
  indications: 'Indications',
  dosage: 'Dosage',
  administration: 'Administration',
  food: 'Food',
  contraindications: 'Contraindications',
  precautions: 'Precautions',
  common_adverse_effects: 'Common adverse effects',
  serious_adverse_effects: 'Serious adverse effects',
  interactions: 'Interactions',
  pregnancy: 'Pregnancy',
  breastfeeding: 'Breastfeeding',
  paediatric: 'Paediatric use',
  older_adult: 'Older adults',
  renal: 'Renal impairment',
  hepatic: 'Hepatic impairment',
  storage: 'Storage',
  warnings: 'Warnings',
  professional_assessment: 'Professional assessment',
};

export const CLINICAL_SECTION_STATUS_LABEL: Record<ClinicalSectionStatus, string> = {
  not_established: 'Not established',
  not_verified: 'Not verified',
  verified: 'Verified',
  not_applicable: 'Not applicable',
};

export const VERIFICATION_STATUS_LABEL: Record<MedicineVerificationStatus, string> = {
  draft: 'Draft',
  pending_review: 'Pending review',
  verified: 'Verified',
  rejected: 'Rejected',
  outdated: 'Outdated',
};

export const REGISTRATION_STATUS_LABEL: Record<MedicineRegistrationStatus, string> = {
  unverified: 'Unverified',
  pending: 'Pending verification',
  verified: 'Verified',
  mismatch: 'Mismatch',
  not_applicable: 'Not applicable',
};

export const SUBMISSION_STATUS_LABEL: Record<MedicineSubmissionStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const SOURCE_TYPE_LABEL: Record<MedicineSourceType, string> = {
  product_label: 'Product label',
  regulator: 'Regulator',
  guideline: 'Clinical guideline',
  reference: 'Reference work',
  manufacturer: 'Manufacturer',
  other: 'Other',
};

export const FOOD_INSTRUCTION_LABEL: Record<MedicineFoodInstruction, string> = {
  with_food: 'With food',
  before_food: 'Before food',
  after_food: 'After food',
  without_regard_to_food: 'Without regard to food',
  not_established: 'Not established',
  not_applicable: 'Not applicable',
};

export type CatalogueVerificationFilter = '' | 'verified' | 'outdated';

export interface CatalogueFilters {
  query: string;
  dosageForm: string;
  strength: string;
  route: string;
  category: string;
  prescriptionClass: '' | PrescriptionClass;
  verification: CatalogueVerificationFilter;
  page: number;
}

export const EMPTY_CATALOGUE_FILTERS: CatalogueFilters = {
  query: '',
  dosageForm: '',
  strength: '',
  route: '',
  category: '',
  prescriptionClass: '',
  verification: '',
  page: 1,
};

export function normaliseCatalogueFilters(
  input: Partial<CatalogueFilters>,
): CatalogueFilters {
  const page = Number.isFinite(input.page) ? Math.floor(input.page as number) : 1;
  return {
    query: (input.query ?? '').trim(),
    dosageForm: (input.dosageForm ?? '').trim(),
    strength: (input.strength ?? '').trim(),
    route: (input.route ?? '').trim(),
    category: (input.category ?? '').trim(),
    prescriptionClass: input.prescriptionClass ?? '',
    verification: input.verification ?? '',
    page: Math.max(1, page),
  };
}

export interface CataloguePageBounds {
  page: number;
  pageSize: number;
  from: number;
  to: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/**
 * Human-facing 1-based range for a page of results.
 *
 * `from`/`to` are inclusive. An empty page reports 0–0 rather than 1–0, which
 * keeps a pagination footer from claiming a result that does not exist.
 */
export function cataloguePageBounds(
  page: number,
  total: number,
  pageSize: number = CATALOGUE_PAGE_SIZE,
): CataloguePageBounds {
  const safeSize = Math.min(Math.max(Math.floor(pageSize), 1), CATALOGUE_MAX_PAGE_SIZE);
  const safeTotal = Math.max(0, Math.floor(total));
  const safePage = Math.max(1, Math.floor(page));
  const from = safeTotal === 0 ? 0 : (safePage - 1) * safeSize + 1;
  const to = safeTotal === 0 ? 0 : Math.min(safePage * safeSize, safeTotal);
  return {
    page: safePage,
    pageSize: safeSize,
    from,
    to,
    total: safeTotal,
    hasPrevious: safePage > 1 && safeTotal > 0,
    hasNext: safePage * safeSize < safeTotal,
  };
}

/* ------------------------------------------------------------- statuses */

export function isVerifiedStatus(status: MedicineVerificationStatus): boolean {
  return status === 'verified';
}

export function isUsableClinicalStatus(status: ClinicalSectionStatus): boolean {
  return status === 'verified';
}

/**
 * Is a registration confirmation a statement about this product's regulator
 * record? `unverified`, `pending` and `mismatch` are not.
 */
export function isRegistrationVerified(status: MedicineRegistrationStatus): boolean {
  return status === 'verified';
}

/* ------------------------------------------------------------ submissions */

export type SubmissionIntent = 'draft' | 'submitted';

export interface SubmissionDraft {
  genericName: string;
  brandName: string;
  productName: string;
  strength: string;
  dosageForm: string;
  route: string;
  packSize: string;
  manufacturer: string;
  marketingAuthorisationHolder: string;
  nafdacRegNumber: string;
  category: string;
  prescriptionClass: '' | PrescriptionClass;
  sourceType: '' | MedicineSourceType;
  sourceTitle: string;
  sourceUrl: string;
  sourceDocumentReference: string;
  sourceRetrievedAt: string;
  notes: string;
}

export type SubmissionField =
  | 'identity'
  | 'genericName'
  | 'productName'
  | 'strength'
  | 'dosageForm'
  | 'route'
  | 'prescriptionClass'
  | 'sourceType'
  | 'sourceTitle'
  | 'sourceReference'
  | 'sourceRetrievedAt'
  | 'sourceUrl';

export type SubmissionErrors = Partial<Record<SubmissionField, string>>;

export interface SubmissionValidation {
  errors: SubmissionErrors;
  /** Clinical areas the submitter has not supplied. Always labelled, never hidden. */
  missingClinical: ClinicalSection[];
  valid: boolean;
}

export function emptySubmissionDraft(): SubmissionDraft {
  return {
    genericName: '',
    brandName: '',
    productName: '',
    strength: '',
    dosageForm: '',
    route: '',
    packSize: '',
    manufacturer: '',
    marketingAuthorisationHolder: '',
    nafdacRegNumber: '',
    category: '',
    prescriptionClass: '',
    // The source type and retrieval date are not guessed. A default of today
    // would assert that the submitter checked the source on this date, which is
    // exactly the kind of invented provenance the catalogue must not contain.
    sourceType: '',
    sourceTitle: '',
    sourceUrl: '',
    sourceDocumentReference: '',
    sourceRetrievedAt: '',
    notes: '',
  };
}

export function todayIso(now: Date = new Date()): string {
  // A source is retrieved on a local calendar day, and a date input's `max`
  // must not block "today" for a user east of UTC between midnight and 01:00.
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A source needs a title and either a URL or a document reference. The URL, if
 * present, must be a normal web URL — a `javascript:` link in a professional
 * reference is not a source, and rendering it as one would be an injection.
 */
export function safeExternalUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Validate an owner submission.
 *
 * A draft only has to be identifiable enough to find again. A submitted record
 * needs the identity fields used by duplicate matching, a prescription class
 * (the reviewer must not let an unclassified product fall through as OTC), and
 * a source that another person can check.
 *
 * Clinical content is intentionally not required: the requirement is to allow a
 * submission with *clearly flagged* gaps, not to force an owner to invent
 * clinical claims. `missingClinical` carries those gaps to the UI.
 */
export function validateSubmissionDraft(
  draft: SubmissionDraft,
  intent: SubmissionIntent,
): SubmissionValidation {
  const errors: SubmissionErrors = {};

  const hasIdentity = hasText(draft.genericName) || hasText(draft.productName);
  if (!hasIdentity) {
    errors.identity = 'Enter at least a generic or product name before saving.';
  }

  if (intent === 'submitted') {
    if (!hasText(draft.genericName)) errors.genericName = 'Generic name is required.';
    if (!hasText(draft.productName)) errors.productName = 'Product name is required.';
    if (!hasText(draft.strength)) {
      errors.strength = 'Enter a strength, or “Not applicable” if the product has none.';
    }
    if (!hasText(draft.dosageForm)) {
      errors.dosageForm = 'Enter a dosage form, or “Not applicable” where appropriate.';
    }
    if (!hasText(draft.route)) {
      errors.route = 'Enter a route, or “Not applicable” where appropriate.';
    }
    if (!draft.prescriptionClass) {
      errors.prescriptionClass =
        'Choose a prescription class. An unclassified product must not default to OTC.';
    }
    if (!draft.sourceType) {
      errors.sourceType = 'Choose what kind of source this is.';
    }
    if (!hasText(draft.sourceTitle)) {
      errors.sourceTitle = 'A source title is required.';
    }
    if (!hasText(draft.sourceUrl) && !hasText(draft.sourceDocumentReference)) {
      errors.sourceReference = 'Add a source URL or a document reference.';
    }
    if (!hasText(draft.sourceRetrievedAt)) {
      errors.sourceRetrievedAt = 'Record when the source was retrieved.';
    } else if (!isIsoDate(draft.sourceRetrievedAt)) {
      errors.sourceRetrievedAt = 'Use a real calendar date in YYYY-MM-DD form.';
    }
  }

  const url = draft.sourceUrl.trim();
  if (url && !safeExternalUrl(url)) {
    errors.sourceUrl = 'Use a valid http(s) URL, or leave it blank and use a document reference.';
  }

  return {
    errors,
    missingClinical: missingClinicalSections(draft),
    valid: Object.keys(errors).length === 0,
  };
}

/**
 * A submission form has no clinical authoring fields in Phase 2. Every core
 * clinical section is therefore still missing and is shown to the submitter and
 * to the reviewer. A reviewer adds and verifies those sections before publication.
 */
export function missingClinicalSections(_draft: SubmissionDraft): ClinicalSection[] {
  return [...CORE_CLINICAL_SECTIONS];
}

export interface SubmissionRowPayload {
  generic_name: string | null;
  brand_name: string | null;
  product_name: string | null;
  strength_text: string | null;
  dosage_form: string | null;
  route: string | null;
  pack_size: string | null;
  manufacturer: string | null;
  marketing_authorisation_holder: string | null;
  nafdac_reg_number: string | null;
  category: string | null;
  prescription_class: PrescriptionClass | null;
  source_type: MedicineSourceType | null;
  source_title: string | null;
  source_url: string | null;
  source_document_reference: string | null;
  source_retrieved_at: string | null;
  clinical_payload: Json;
  notes: string | null;
}

/**
 * Map the form to database columns.
 *
 * Empty text becomes NULL rather than an empty string: "not recorded" and
 * "recorded as blank" are different facts, and the catalogue uses NULL for the
 * former. `clinical_payload` is empty by construction — no clinical text is
 * generated by this flow.
 */
export function submissionRowPayload(draft: SubmissionDraft): SubmissionRowPayload {
  return {
    generic_name: emptyToNull(draft.genericName),
    brand_name: emptyToNull(draft.brandName),
    product_name: emptyToNull(draft.productName),
    strength_text: emptyToNull(draft.strength),
    dosage_form: emptyToNull(draft.dosageForm),
    route: emptyToNull(draft.route),
    pack_size: emptyToNull(draft.packSize),
    manufacturer: emptyToNull(draft.manufacturer),
    marketing_authorisation_holder: emptyToNull(draft.marketingAuthorisationHolder),
    nafdac_reg_number: emptyToNull(draft.nafdacRegNumber),
    category: emptyToNull(draft.category),
    prescription_class: draft.prescriptionClass || null,
    source_type: draft.sourceType || null,
    source_title: emptyToNull(draft.sourceTitle),
    source_url: emptyToNull(draft.sourceUrl),
    source_document_reference: emptyToNull(draft.sourceDocumentReference),
    source_retrieved_at: emptyToNull(draft.sourceRetrievedAt),
    clinical_payload: {
      ingredients: [],
      sources: [],
      sections: [],
      dosages: [],
    },
    notes: emptyToNull(draft.notes),
  };
}

/* ----------------------------------------------------------- duplicates */

export interface DuplicateCandidate {
  id: string;
  productName: string;
  genericName: string;
  brandName: string | null;
  strength: string;
  dosageForm: string;
  route: string;
  manufacturer: string | null;
  nafdacRegNumber: string | null;
  verificationStatus: MedicineVerificationStatus;
  matchScore: number;
}

/**
 * What a duplicate score means, in words a submitter can act on.
 *
 * The database owns the score. This only describes it; it does not invent a
 * match or decide that two records are the same beyond the exact case.
 */
export function duplicateMatchLabel(score: number): string {
  if (score >= 100) return 'Exact identity match';
  if (score >= 90) return 'Same NAFDAC registration number';
  if (score >= 80) return 'Same ingredient, strength, form and route';
  if (score >= 60) return 'Same ingredient and strength';
  if (score >= 40) return 'Same active ingredient';
  return 'Possible match';
}

export function blocksSubmission(score: number): boolean {
  return score >= 100;
}

/* --------------------------------------------------------------- helpers */

export function hasText(value: string): boolean {
  return value.trim().length > 0;
}

export function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function displayOrNotRecorded(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : 'Not recorded';
}

export function displayOrNotEstablished(value: string | null | undefined): string {
  return value && value.trim().length > 0 ? value : 'Not established';
}

/**
 * A source row's date is a PostgreSQL `date` (YYYY-MM-DD). Formatting is kept
 * out of this module so the caller can use the app's one date formatter.
 */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
