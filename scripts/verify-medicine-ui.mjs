/**
 * Offline checks for the medicine catalogue UI rules.
 *
 * The database verification suite already proves the policies and guards. This
 * file proves the parts that live only in the browser bundle:
 *
 *   * a submitted record cannot be saved without the identity and source fields
 *     the reviewer needs;
 *   * an owner cannot smuggle a verification state through the submission
 *     payload;
 *   * an unclassified product cannot be submitted and later default to OTC;
 *   * pagination and filter normalisation do not invent pages or results;
 *   * a `javascript:` URL is never treated as a source link.
 *
 * It imports the same TypeScript module the screen imports. `bun` strips the
 * type-only import, so no database, network or build step is involved.
 */

import {
  CATALOGUE_MAX_PAGE_SIZE,
  CLINICAL_SECTION_ORDER,
  CLINICAL_SECTION_STATUS_LABEL,
  CORE_CLINICAL_SECTIONS,
  EMPTY_CATALOGUE_FILTERS,
  REGISTRATION_STATUS_LABEL,
  SOURCE_TYPE_LABEL,
  SUBMISSION_STATUS_LABEL,
  VERIFICATION_STATUS_LABEL,
  blocksSubmission,
  cataloguePageBounds,
  displayOrNotEstablished,
  displayOrNotRecorded,
  duplicateMatchLabel,
  emptySubmissionDraft,
  emptyToNull,
  hasText,
  isIsoDate,
  missingClinicalSections,
  normaliseCatalogueFilters,
  safeExternalUrl,
  submissionRowPayload,
  todayIso,
  validateSubmissionDraft,
} from '../src/domain/medicine-catalogue.ts';

let failed = 0;
let passed = 0;

function check(ok, label, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

function completeDraft(overrides = {}) {
  return {
    ...emptySubmissionDraft(),
    genericName: 'Paracetamol',
    productName: 'Example Paracetamol',
    strength: '500 mg',
    dosageForm: 'tablet',
    route: 'oral',
    prescriptionClass: 'otc',
    sourceType: 'regulator',
    sourceTitle: 'Example regulator record',
    sourceUrl: 'https://example.test/medicine/1',
    sourceRetrievedAt: '2026-10-20',
    ...overrides,
  };
}

console.log('');
console.log('  Medicine catalogue UI rules (offline)');
console.log('  ' + '='.repeat(58));

/* ------------------------------------------------------------ filters/pages */

const normalised = normaliseCatalogueFilters({
  query: '  paracetamol  ',
  dosageForm: ' tablet ',
  strength: ' 500 mg ',
  route: ' oral ',
  category: ' analgesic ',
  prescriptionClass: 'otc',
  verification: 'verified',
  page: 2.9,
});
check(normalised.query === 'paracetamol', 'query is trimmed');
check(normalised.dosageForm === 'tablet', 'dosage form is trimmed');
check(normalised.strength === '500 mg', 'strength is trimmed');
check(normalised.route === 'oral', 'route is trimmed');
check(normalised.category === 'analgesic', 'category is trimmed');
check(normalised.page === 2, 'page is floored, not rounded up');
check(
  normaliseCatalogueFilters({ page: -4 }).page === 1,
  'a negative page becomes page 1',
);
check(
  normaliseCatalogueFilters({ page: Number.NaN }).page === 1,
  'a non-finite page becomes page 1',
);
check(
  normaliseCatalogueFilters({}).prescriptionClass === '',
  'missing prescription class stays empty, not OTC',
);
check(
  normaliseCatalogueFilters({ verification: 'rejected' }).verification === 'rejected',
  'normalisation does not silently rewrite an unexpected verification filter',
);

const emptyBounds = cataloguePageBounds(1, 0);
check(emptyBounds.from === 0 && emptyBounds.to === 0, 'empty result reports 0–0');
check(!emptyBounds.hasNext && !emptyBounds.hasPrevious, 'empty result has no pages');

const firstBounds = cataloguePageBounds(1, 51, 25);
check(firstBounds.from === 1 && firstBounds.to === 25, 'first page range is 1–25');
check(firstBounds.hasNext && !firstBounds.hasPrevious, 'first page has next, no previous');

const lastBounds = cataloguePageBounds(3, 51, 25);
check(lastBounds.from === 51 && lastBounds.to === 51, 'last page range is 51–51');
check(!lastBounds.hasNext && lastBounds.hasPrevious, 'last page has previous, no next');

const clampedSize = cataloguePageBounds(1, 500, 10_000);
check(
  clampedSize.pageSize === CATALOGUE_MAX_PAGE_SIZE,
  'page size is clamped to the server maximum',
);

/* ---------------------------------------------------------------- statuses */

check(Object.keys(VERIFICATION_STATUS_LABEL).length === 5, 'all five verification states are labelled');
check(Object.keys(REGISTRATION_STATUS_LABEL).length === 5, 'all five registration states are labelled');
check(Object.keys(CLINICAL_SECTION_STATUS_LABEL).length === 4, 'all four section states are labelled');
check(Object.keys(SUBMISSION_STATUS_LABEL).length === 6, 'all six submission states are labelled');
check(Object.keys(SOURCE_TYPE_LABEL).length === 6, 'all six source types are labelled');
check(
  VERIFICATION_STATUS_LABEL.pending_review === 'Pending review',
  'pending review is not displayed as verified',
);
check(
  CLINICAL_SECTION_STATUS_LABEL.not_verified === 'Not verified',
  'unverified clinical text is labelled as unverified',
);
check(
  CLINICAL_SECTION_STATUS_LABEL.not_established === 'Not established',
  'missing clinical text is labelled as not established',
);
check(
  REGISTRATION_STATUS_LABEL.unverified === 'Unverified',
  'an unverified registration is not displayed as verified',
);
check(
  CLINICAL_SECTION_ORDER.length === 18 &&
    new Set(CLINICAL_SECTION_ORDER).size === CLINICAL_SECTION_ORDER.length,
  'clinical section order contains 18 unique sections',
);
check(
  CORE_CLINICAL_SECTIONS.every((section) => CLINICAL_SECTION_ORDER.includes(section)),
  'every core clinical section is in the display order',
);

/* --------------------------------------------------------------- validation */

const empty = emptySubmissionDraft();
check(empty.prescriptionClass === '', 'a new draft is unclassified, not OTC');
check(empty.sourceType === '', 'a new source has no assumed source type');
check(empty.sourceRetrievedAt === '', 'a new source has no invented retrieval date');
check(
  todayIso(new Date(2026, 9, 20, 23, 59, 59)) === '2026-10-20',
  'todayIso uses the local calendar day so “today” is selectable',
);

const emptyValidation = validateSubmissionDraft(empty, 'draft');
check(!emptyValidation.valid, 'an entirely empty draft is not valid');
check(Boolean(emptyValidation.errors.identity), 'an empty draft asks for an identity');
check(
  emptyValidation.missingClinical.length === CORE_CLINICAL_SECTIONS.length,
  'an empty submission flags every core clinical gap',
);

const identifiableDraft = {
  ...empty,
  genericName: 'Paracetamol',
};
check(
  validateSubmissionDraft(identifiableDraft, 'draft').valid,
  'a draft with a generic name can be saved for later',
);

const incomplete = validateSubmissionDraft(identifiableDraft, 'submitted');
check(!incomplete.valid, 'a submitted record cannot use the draft-only rule');
check(Boolean(incomplete.errors.productName), 'submission requires a product name');
check(Boolean(incomplete.errors.strength), 'submission requires a strength or explicit not applicable');
check(Boolean(incomplete.errors.dosageForm), 'submission requires a dosage form');
check(Boolean(incomplete.errors.route), 'submission requires a route');
check(
  Boolean(incomplete.errors.prescriptionClass),
  'submission requires a prescription class so it cannot default to OTC',
);
check(Boolean(incomplete.errors.sourceType), 'submission requires a source type');
check(Boolean(incomplete.errors.sourceTitle), 'submission requires a source title');
check(Boolean(incomplete.errors.sourceReference), 'submission requires a URL or document reference');
check(
  Boolean(incomplete.errors.sourceRetrievedAt),
  'submission requires the submitter to record when the source was retrieved',
);

const complete = validateSubmissionDraft(completeDraft(), 'submitted');
check(complete.valid, 'a complete submission passes validation', JSON.stringify(complete.errors));
check(
  complete.missingClinical.includes('interactions') &&
    complete.missingClinical.includes('warnings'),
  'complete identity plus source still flags the clinical gaps',
);
check(
  missingClinicalSections(completeDraft()).length === CORE_CLINICAL_SECTIONS.length,
  'missing clinical sections are always reported',
);

const documentSource = validateSubmissionDraft(
  completeDraft({ sourceUrl: '', sourceDocumentReference: 'label batch 24A, section 3' }),
  'submitted',
);
check(documentSource.valid, 'a document reference can replace a URL');

const badUrl = validateSubmissionDraft(
  completeDraft({ sourceUrl: 'javascript:alert(1)' }),
  'submitted',
);
check(!badUrl.valid && Boolean(badUrl.errors.sourceUrl), 'a javascript: source URL is rejected');

const noUrlOrReference = validateSubmissionDraft(
  completeDraft({ sourceUrl: '', sourceDocumentReference: '' }),
  'submitted',
);
check(
  !noUrlOrReference.valid && Boolean(noUrlOrReference.errors.sourceReference),
  'submission cannot proceed without any source reference',
);

const impossibleDate = validateSubmissionDraft(
  completeDraft({ sourceRetrievedAt: '2026-02-30' }),
  'submitted',
);
check(
  !impossibleDate.valid && Boolean(impossibleDate.errors.sourceRetrievedAt),
  'an impossible calendar date is rejected, not sent to PostgreSQL',
);

const notApplicable = validateSubmissionDraft(
  completeDraft({ strength: 'Not applicable', dosageForm: 'Not applicable', route: 'Not applicable' }),
  'submitted',
);
check(notApplicable.valid, 'explicit “Not applicable” values are accepted, not treated as blank');

/* --------------------------------------------------------------- payload map */

const payload = submissionRowPayload(
  completeDraft({
    genericName: '  Paracetamol  ',
    brandName: '   ',
    sourceUrl: 'https://example.test/medicine/1',
    notes: '  check the label  ',
  }),
);
check(payload.generic_name === 'Paracetamol', 'payload trims text');
check(payload.brand_name === null, 'payload stores blank optional text as NULL');
check(payload.notes === 'check the label', 'payload trims notes');
check(payload.prescription_class === 'otc', 'payload preserves the chosen prescription class');
check(
  !('clinical_review_status' in payload),
  'payload cannot set a clinical verification state',
);
check(
  !('nafdac_registration_status' in payload),
  'payload cannot set a registration verification state',
);
check(
  payload.clinical_payload.ingredients.length === 0 &&
    payload.clinical_payload.sections.length === 0 &&
    payload.clinical_payload.dosages.length === 0,
  'payload carries no generated clinical content',
);

const unclassifiedPayload = submissionRowPayload(
  completeDraft({ prescriptionClass: '' }),
);
check(
  unclassifiedPayload.prescription_class === null,
  'an unclassified draft is stored as NULL, never silently as OTC',
);

const untypedSourcePayload = submissionRowPayload(
  completeDraft({ sourceType: '', sourceRetrievedAt: '' }),
);
check(
  untypedSourcePayload.source_type === null && untypedSourcePayload.source_retrieved_at === null,
  'missing source metadata is stored as NULL, not guessed',
);

/* ------------------------------------------------------------ sources/helpers */

check(safeExternalUrl('https://example.test/a') === 'https://example.test/a', 'https URL is allowed');
check(safeExternalUrl('http://example.test/a') === 'http://example.test/a', 'http URL is allowed');
check(safeExternalUrl('javascript:alert(1)') === null, 'javascript URL is rejected');
check(safeExternalUrl('data:text/html,hi') === null, 'data URL is rejected');
check(safeExternalUrl('/relative/path') === null, 'relative URL is rejected');
check(safeExternalUrl('   ') === null, 'blank URL is not a source');
check(hasText(' a ') && !hasText('   '), 'hasText ignores whitespace');
check(emptyToNull('  ') === null && emptyToNull(' x ') === 'x', 'emptyToNull trims');
check(displayOrNotRecorded(null) === 'Not recorded', 'missing identity reads Not recorded');
check(
  displayOrNotEstablished('') === 'Not established',
  'missing clinical text reads Not established',
);
check(
  isIsoDate('2026-10-20') &&
    isIsoDate('2024-02-29') &&
    !isIsoDate('2026-02-29') &&
    !isIsoDate('20/10/2026'),
  'only real calendar dates in ISO form pass the date check',
);

/* --------------------------------------------------------------- duplicates */

check(duplicateMatchLabel(100) === 'Exact identity match', '100 is an exact identity match');
check(duplicateMatchLabel(90) === 'Same NAFDAC registration number', '90 is a NAFDAC match');
check(
  duplicateMatchLabel(80) === 'Same ingredient, strength, form and route',
  '80 is an ingredient/strength/form/route match',
);
check(duplicateMatchLabel(60) === 'Same ingredient and strength', '60 is an ingredient/strength match');
check(duplicateMatchLabel(40) === 'Same active ingredient', '40 is an ingredient match');
check(duplicateMatchLabel(0) === 'Possible match', 'unexpected scores remain a possible match');
check(blocksSubmission(100), 'an exact duplicate blocks submission');
check(!blocksSubmission(90), 'a probable duplicate warns but does not block');

/* ------------------------------------------------------------------- report */

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');
if (failed > 0) process.exitCode = 1;
