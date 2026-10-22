import type {
  ClinicalSection,
  ClinicalSectionStatus,
  MedicineClinicalSectionRow,
  MedicineDosageRow,
  MedicineFoodInstruction,
  MedicineIngredientRow,
  MedicineProductAliasRow,
  MedicineProductRow,
  MedicineRegistrationStatus,
  MedicineSourceRow,
  MedicineSourceType,
  MedicineSubmissionRow,
  MedicineSubmissionStatus,
  MedicineVerificationStatus,
  PrescriptionClass,
} from '../db.types';
import {
  CATALOGUE_PAGE_SIZE,
  normaliseCatalogueFilters,
  submissionRowPayload,
  type CatalogueFilters,
  type DuplicateCandidate,
  type SubmissionDraft,
  type SubmissionIntent,
} from '~/domain/medicine-catalogue';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fail, fromList, ok, type Result } from './result';

/**
 * Shared medicine catalogue reads and the owner submission write path.
 *
 * ## What this module does *not* do
 *
 * It does not publish clinical content. Creating or editing a shared product is
 * reviewer-only in the database, and the only browser path to publication is
 * `pf_accept_medicine_submission`, which a reviewer calls with a reviewed
 * submission. This module holds no service-role key and does not try to bypass
 * any policy.
 *
 * ## Why search is server-side
 *
 * The shared catalogue is intended to hold at least a thousand products. The
 * browser must not download it whole: `pf_search_medicine_catalogue` filters and
 * pages in Postgres, and returns only the columns the list needs. The detail
 * query is by primary key and fetches one product's children.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

const PRODUCT_COLUMNS =
  'id,' +
  'generic_name,' +
  'brand_name,' +
  'product_name,' +
  'strength_text,' +
  'dosage_form,' +
  'route,' +
  'pack_size,' +
  'manufacturer,' +
  'marketing_authorisation_holder,' +
  'nafdac_reg_number,' +
  'nafdac_registration_status,' +
  'nafdac_verified_at,' +
  'category,' +
  'prescription_class,' +
  'is_combination,' +
  'clinical_review_status,' +
  'clinical_reviewed_at,' +
  'last_clinical_review_date,' +
  'version,' +
  'archived_at,' +
  'created_at,' +
  'updated_at';

const INGREDIENT_COLUMNS =
  'id, product_id, ingredient_name, strength_value, strength_unit, sort_order';

const SOURCE_COLUMNS =
  'id, product_id, section, source_type, title, publisher, url, ' +
  'document_reference, retrieved_at, source_ref, notes, created_at';

const SECTION_COLUMNS =
  'id, product_id, section, content, status, food_instruction, source_id, ' +
  'retrieved_at, last_reviewed_at, version, updated_at';

const DOSAGE_COLUMNS =
  'id, product_id, population, indication, route, dose_text, frequency, ' +
  'duration, max_dose, notes, status, source_id, retrieved_at, ' +
  'last_reviewed_at, version';

const ALIAS_COLUMNS = 'id, product_id, alias, alias_type, source_id, created_at';

const SUBMISSION_COLUMNS =
  'id, branch_id, submitted_by, status, product_id, generic_name, brand_name, ' +
  'product_name, strength_text, dosage_form, route, pack_size, manufacturer, ' +
  'marketing_authorisation_holder, nafdac_reg_number, category, ' +
  'prescription_class, source_type, source_title, source_url, ' +
  'source_document_reference, source_retrieved_at, notes, submitted_at, ' +
  'reviewed_at, review_reason, accepted_product_id, withdrawn_at, ' +
  'created_at, updated_at';

export interface CatalogueProductSummary {
  id: string;
  productName: string;
  genericName: string;
  brandName: string | null;
  strength: string;
  dosageForm: string;
  route: string;
  category: string;
  prescriptionClass: PrescriptionClass;
  nafdacRegNumber: string | null;
  registrationStatus: MedicineRegistrationStatus;
  verificationStatus: MedicineVerificationStatus;
  lastReviewDate: string | null;
}

export interface CatalogueSearchPage {
  items: CatalogueProductSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CatalogueDetail {
  product: MedicineProductRow;
  ingredients: MedicineIngredientRow[];
  sources: MedicineSourceRow[];
  sections: MedicineClinicalSectionRow[];
  dosages: MedicineDosageRow[];
  aliases: MedicineProductAliasRow[];
}

function asVerification(value: string): MedicineVerificationStatus {
  return value as MedicineVerificationStatus;
}

function asRegistration(value: string): MedicineRegistrationStatus {
  return value as MedicineRegistrationStatus;
}

function asPrescription(value: string): PrescriptionClass {
  return value as PrescriptionClass;
}

function asSectionStatus(value: string): ClinicalSectionStatus {
  return value as ClinicalSectionStatus;
}

function asSourceType(value: string | null): MedicineSourceType | null {
  return value as MedicineSourceType | null;
}

function asFoodInstruction(value: string | null): MedicineFoodInstruction | null {
  return value as MedicineFoodInstruction | null;
}

function asSection(value: string | null): ClinicalSection | null {
  return value as ClinicalSection | null;
}

/**
 * The RPC returns snake_case rows; the screen speaks camelCase. This is a
 * translation, not an interpretation: no value is defaulted to a more confident
 * state. Unknown enum text is surfaced as-is by the badge renderer rather than
 * silently becoming "verified".
 */
function toSummary(row: {
  id: string;
  product_name: string;
  generic_name: string;
  brand_name: string | null;
  strength_text: string;
  dosage_form: string;
  route: string;
  category: string;
  prescription_class: string;
  nafdac_reg_number: string | null;
  nafdac_registration_status: string;
  clinical_review_status: string;
  last_clinical_review_date: string | null;
}): CatalogueProductSummary {
  return {
    id: row.id,
    productName: row.product_name,
    genericName: row.generic_name,
    brandName: row.brand_name,
    strength: row.strength_text,
    dosageForm: row.dosage_form,
    route: row.route,
    category: row.category,
    prescriptionClass: asPrescription(row.prescription_class),
    nafdacRegNumber: row.nafdac_reg_number,
    registrationStatus: asRegistration(row.nafdac_registration_status),
    verificationStatus: asVerification(row.clinical_review_status),
    lastReviewDate: row.last_clinical_review_date,
  };
}

/* ------------------------------------------------------------------ search */

export async function searchMedicineCatalogue(
  input: Partial<CatalogueFilters>,
  pageSize: number = CATALOGUE_PAGE_SIZE,
): Promise<Result<CatalogueSearchPage>> {
  if (!isSupabaseConfigured()) return fail(OFFLINE);
  if (!(await hasSession())) return fail(NO_SESSION);

  const filters = normaliseCatalogueFilters(input);
  const limit = Math.min(Math.max(Math.floor(pageSize), 1), 100);
  const offset = (filters.page - 1) * limit;

  const { data, error } = await client().rpc('pf_search_medicine_catalogue', {
    p_query: filters.query || null,
    p_dosage_form: filters.dosageForm || null,
    p_strength: filters.strength || null,
    p_route: filters.route || null,
    p_category: filters.category || null,
    p_prescription_class: filters.prescriptionClass || null,
    p_verification: filters.verification || null,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) return fail(error.message, error.code);

  const rows = data ?? [];
  const first = rows[0];
  return ok({
    items: rows.map((row) => toSummary(row)),
    total: Number(first?.total_count ?? 0),
    page: filters.page,
    pageSize: limit,
  });
}

/* ------------------------------------------------------------------ detail */

export async function getMedicineProduct(id: string): Promise<Result<CatalogueDetail>> {
  if (!isSupabaseConfigured()) return fail(OFFLINE);
  if (!(await hasSession())) return fail(NO_SESSION);

  const productQuery = await client()
    .from('medicine_products')
    .select(PRODUCT_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (productQuery.error) {
    return fail(productQuery.error.message, productQuery.error.code);
  }
  if (!productQuery.data) return fail('Product not found');

  const [ingredients, sources, sections, dosages, aliases] = await Promise.all([
    client()
      .from('medicine_ingredients')
      .select(INGREDIENT_COLUMNS)
      .eq('product_id', id)
      .order('sort_order', { ascending: true }),
    client()
      .from('medicine_sources')
      .select(SOURCE_COLUMNS)
      .eq('product_id', id)
      .order('created_at', { ascending: true }),
    client()
      .from('medicine_clinical_sections')
      .select(SECTION_COLUMNS)
      .eq('product_id', id)
      .order('section', { ascending: true }),
    client()
      .from('medicine_dosages')
      .select(DOSAGE_COLUMNS)
      .eq('product_id', id)
      .order('population', { ascending: true }),
    client()
      .from('medicine_product_aliases')
      .select(ALIAS_COLUMNS)
      .eq('product_id', id)
      .order('alias', { ascending: true }),
  ]);

  for (const child of [ingredients, sources, sections, dosages, aliases]) {
    if (child.error) return fail(child.error.message, child.error.code);
  }

  return ok({
    product: productQuery.data as unknown as MedicineProductRow,
    ingredients: (ingredients.data ?? []) as unknown as MedicineIngredientRow[],
    sources: (sources.data ?? []) as unknown as MedicineSourceRow[],
    sections: (sections.data ?? []) as unknown as MedicineClinicalSectionRow[],
    dosages: (dosages.data ?? []) as unknown as MedicineDosageRow[],
    aliases: (aliases.data ?? []) as unknown as MedicineProductAliasRow[],
  });
}

/* ------------------------------------------------------------- submissions */

export interface SaveSubmissionInput {
  submissionId?: string | null;
  branchId: string;
  userId: string;
  draft: SubmissionDraft;
  intent: SubmissionIntent;
}

export interface SavedSubmission {
  id: string;
  status: MedicineSubmissionStatus;
}

export async function saveMedicineSubmission(
  input: SaveSubmissionInput,
): Promise<Result<SavedSubmission>> {
  if (!isSupabaseConfigured()) return fail(OFFLINE);
  if (!(await hasSession())) return fail(NO_SESSION);

  const payload = submissionRowPayload(input.draft);
  const status: MedicineSubmissionStatus =
    input.intent === 'submitted' ? 'submitted' : 'draft';

  if (input.submissionId) {
    // The edit form does not render clinical payload. Sending the empty array
    // shape on update would silently erase clinical work a reviewer had already
    // added to this draft, so the update keeps the stored payload untouched.
    const { clinical_payload: _clinicalPayload, ...editable } = payload;
    const { data, error } = await client()
      .from('medicine_submissions')
      .update({ ...editable, status })
      .eq('id', input.submissionId)
      .select('id,status')
      .single();

    if (error) return fail(error.message, error.code);
    return ok({ id: data.id, status: data.status });
  }

  const { data, error } = await client()
    .from('medicine_submissions')
    .insert({
      ...payload,
      branch_id: input.branchId,
      submitted_by: input.userId,
      status,
    })
    .select('id,status')
    .single();

  if (error) return fail(error.message, error.code);
  return ok({ id: data.id, status: data.status });
}

export async function listMedicineSubmissions(): Promise<Result<MedicineSubmissionRow[]>> {
  if (!isSupabaseConfigured()) return fail(OFFLINE);
  if (!(await hasSession())) return fail(NO_SESSION);

  const query = await client()
    .from('medicine_submissions')
    .select(SUBMISSION_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(50);

  return fromList({
    data: (query.data ?? null) as unknown as MedicineSubmissionRow[] | null,
    error: query.error,
  });
}

export async function withdrawMedicineSubmission(id: string): Promise<Result<SavedSubmission>> {
  if (!isSupabaseConfigured()) return fail(OFFLINE);
  if (!(await hasSession())) return fail(NO_SESSION);

  const { data, error } = await client()
    .from('medicine_submissions')
    .update({ status: 'withdrawn' })
    .eq('id', id)
    .select('id,status')
    .single();

  if (error) return fail(error.message, error.code);
  return ok({ id: data.id, status: data.status });
}

/* ------------------------------------------------------------- duplicates */

/**
 * Ask the database for possible duplicates of the identity being submitted.
 *
 * The score is deliberately not computed in the browser: the same function is
 * used by the importer, and a second implementation here would eventually
 * disagree with it.
 */
export async function findMedicineDuplicates(
  draft: SubmissionDraft,
  excludeId?: string | null,
): Promise<Result<DuplicateCandidate[]>> {
  if (!isSupabaseConfigured()) return fail(OFFLINE);
  if (!(await hasSession())) return fail(NO_SESSION);
  if (!draft.genericName.trim()) return ok([]);

  const { data, error } = await client().rpc('pf_medicine_duplicate_candidates', {
    p_generic_name: draft.genericName.trim(),
    p_strength: draft.strength.trim() || null,
    p_dosage_form: draft.dosageForm.trim() || null,
    p_route: draft.route.trim() || null,
    p_brand_name: draft.brandName.trim() || null,
    p_manufacturer: draft.manufacturer.trim() || null,
    p_nafdac: draft.nafdacRegNumber.trim() || null,
    p_exclude_id: excludeId ?? null,
  });

  if (error) return fail(error.message, error.code);

  return ok(
    (data ?? []).map((row) => ({
      id: row.id,
      productName: row.product_name,
      genericName: row.generic_name,
      brandName: row.brand_name,
      strength: row.strength_text,
      dosageForm: row.dosage_form,
      route: row.route,
      manufacturer: row.manufacturer,
      nafdacRegNumber: row.nafdac_reg_number,
      verificationStatus: asVerification(row.clinical_review_status),
      matchScore: Number(row.match_score),
    })),
  );
}

/* ---------------------------------------------------------------- exports */

/**
 * These helpers exist only to normalise loose database text at the boundary.
 * They are exported so the detail renderer can use the same interpretation for
 * joined child rows without re-implementing casts in JSX.
 */
export const catalogueCasts = {
  sectionStatus: asSectionStatus,
  sourceType: asSourceType,
  section: asSection,
  foodInstruction: asFoodInstruction,
};
