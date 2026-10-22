/**
 * Medicine Knowledge Base verification.
 *
 * These are database-level assertions, not UI assertions. They exist because the
 * dangerous failures in this feature are silent:
 *
 *   * a draft clinical record leaking into the shared catalogue;
 *   * an attendant changing a shared record through a policy nobody re-read;
 *   * a reviewer in branch A approving branch B's submission;
 *   * a "verified" product with no source;
 *   * a duplicate import quietly creating a second product;
 *   * a shared link changing another pharmacy's inventory.
 *
 * Every negative case re-reads the row as the trusted server role. A refused
 * write can return zero rows and still report success, so "did it throw?" is not
 * enough.
 *
 * The suite uses one fresh database for the whole file, the same as the existing
 * role and tenant suites. Objects are tracked by id so one section's fixtures do
 * not make a later count ambiguous.
 */

import {
  asActor,
  asAnon,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedMedicine,
  seedTenants,
} from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-medicine-catalogue');

const REVIEWER_A = 'aaaaaaaa-0000-0000-0000-000000000003';
const REVIEWER_B = 'bbbbbbbb-0000-0000-0000-000000000003';
const ASSISTANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const db = await freshDatabase();
const ids = await seedTenants(db);

/* --------------------------------------------------------------- helpers */

/** Run as a signed-in user (RLS applies). Returns { ok, value | err }. */
const as = (actorId, fn) => asActor(db, actorId, () => asAuthenticated(db, fn));

/** Run in trusted server context (no JWT; RLS bypassed by role). */
const trusted = (fn) => asActor(db, null, fn);

async function trustedQuery(sql, params) {
  return trusted(() => query(db, sql, params));
}

async function trustedRow(sql, params) {
  const rows = await trustedQuery(sql, params);
  return rows[0];
}

async function trustedCount(sql, params) {
  const row = await trustedRow(sql, params);
  return Number(row?.n ?? 0);
}

/** A trusted write that may legitimately fail (unique constraint, etc.). */
async function tryTrusted(sql, params) {
  try {
    return { ok: true, value: await trustedQuery(sql, params) };
  } catch (error) {
    return { ok: false, err: String(error?.message ?? error).split('\n')[0].slice(0, 200) };
  }
}

function expectOk(result, label) {
  check(label, result.ok === true, result.ok ? '' : result.err);
  return result.ok ? result.value : [];
}

/* --------------------------------------------------------------- setup */

await trusted(async () => {
  await query(
    db,
    `insert into auth.users (id, email) values
       ($1, 'reviewer-a@example.test'),
       ($2, 'reviewer-b@example.test'),
       ($3, 'assistant-b@example.test')`,
    [REVIEWER_A, REVIEWER_B, ASSISTANT_B],
  );
  await query(
    db,
    `update profiles set role = 'assistant', branch_id = $1 where id = $2`,
    [ids.BRANCH_A, REVIEWER_A],
  );
  await query(
    db,
    `update profiles set role = 'assistant', branch_id = $1 where id = $2`,
    [ids.BRANCH_B, REVIEWER_B],
  );
  await query(
    db,
    `update profiles set role = 'assistant', branch_id = $1 where id = $2`,
    [ids.BRANCH_B, ASSISTANT_B],
  );
  await query(
    db,
    `insert into branch_memberships
       (user_id, branch_id, role, can_review_clinical)
     values
       ($1, $2, 'assistant', true),
       ($3, $4, 'assistant', true),
       ($5, $4, 'assistant', false)
     on conflict (user_id, branch_id)
     do update set can_review_clinical = excluded.can_review_clinical`,
    [REVIEWER_A, ids.BRANCH_A, REVIEWER_B, ids.BRANCH_B, ASSISTANT_B],
  );
});

let productSeq = 0;
function nextNafdac() {
  productSeq += 1;
  return `NAFDAC-TEST-${String(productSeq).padStart(4, '0')}`;
}

const PRODUCT_COLUMNS = `
  generic_name, brand_name, product_name, strength_text, dosage_form, route,
  manufacturer, nafdac_reg_number, category, prescription_class,
  clinical_review_status
`;

async function createProduct(overrides = {}) {
  const fields = {
    genericName: 'Test Generic',
    brandName: 'Test Brand',
    productName: 'Test Product 500mg Tablets',
    strength: '500mg',
    form: 'Tablet',
    route: 'oral',
    manufacturer: 'Test Manufacturer',
    nafdac: nextNafdac(),
    category: 'Analgesic',
    prescriptionClass: 'otc',
    status: 'draft',
    ...overrides,
  };

  const [product] = await trustedQuery(
    `insert into medicine_products (${PRODUCT_COLUMNS})
     values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10::prescription_class, $11::medicine_verification_status
     )
     returning *`,
    [
      fields.genericName,
      fields.brandName,
      fields.productName,
      fields.strength,
      fields.form,
      fields.route,
      fields.manufacturer,
      fields.nafdac,
      fields.category,
      fields.prescriptionClass,
      fields.status,
    ],
  );
  return product;
}

async function addSource(productId, overrides = {}) {
  const fields = {
    type: 'regulator',
    title: 'Test regulator source',
    url: 'https://example.test/source',
    retrievedAt: '2026-10-19',
    ...overrides,
  };

  const [source] = await trustedQuery(
    `insert into medicine_sources
       (product_id, source_type, title, url, retrieved_at)
     values ($1, $2::medicine_source_type, $3, $4, $5::date)
     returning *`,
    [productId, fields.type, fields.title, fields.url, fields.retrievedAt],
  );
  return source;
}

async function addSection(productId, sourceId, overrides = {}) {
  const fields = {
    section: 'indications',
    content: 'Reference content used by the verification suite.',
    status: 'verified',
    foodInstruction: null,
    ...overrides,
  };

  const [row] = await trustedQuery(
    `insert into medicine_clinical_sections
       (product_id, section, content, status, food_instruction, source_id,
        retrieved_at, last_reviewed_at, reviewed_by)
     values (
       $1, $2::clinical_section, $3, $4::clinical_section_status,
       $5::medicine_food_instruction, $6, current_date, current_date, $7
     )
     returning *`,
    [
      productId,
      fields.section,
      fields.content,
      fields.status,
      fields.foodInstruction,
      sourceId,
      ids.OWNER_A,
    ],
  );
  return row;
}

async function verifyAsServer(productId, reviewerId = ids.OWNER_A) {
  await trustedQuery(
    `update medicine_products
     set clinical_review_status = 'verified',
         clinical_reviewed_by = $2,
         clinical_reviewed_at = now(),
         last_clinical_review_date = current_date
     where id = $1`,
    [productId, reviewerId],
  );
}

async function makeVerifiedProduct(overrides = {}) {
  const product = await createProduct(overrides);
  const source = await addSource(product.id);
  await addSection(product.id, source.id);
  await verifyAsServer(product.id);
  return product;
}

async function readProducts(actorId, ...productIds) {
  return as(actorId, () =>
    query(
      db,
      `select id from medicine_products
       where id in ($1::uuid, $2::uuid, $3::uuid)
       order by product_name`,
      productIds,
    ),
  );
}

async function search(actorId, params = {}) {
  return as(actorId, () =>
    query(
      db,
      `select *
       from pf_search_medicine_catalogue(
         $1, $2, $3, $4, $5, $6, $7, $8, $9
       )`,
      [
        params.query ?? null,
        params.form ?? null,
        params.strength ?? null,
        params.route ?? null,
        params.category ?? null,
        params.rx ?? null,
        params.verification ?? null,
        params.limit ?? 25,
        params.offset ?? 0,
      ],
    ),
  );
}

/* ================================================================ capability */

section('clinical-review capability is database-authoritative');
{
  const canReview = async (actorId) => {
    const result = await as(actorId, () =>
      query(db, `select pf_can_review_clinical() as ok`),
    );
    return result.ok === true && result.value[0]?.ok === true;
  };

  check('owner A is a reviewer', await canReview(ids.OWNER_A));
  check('assistant A is not a reviewer', !(await canReview(ids.ASSISTANT_A)));
  check('non-owner reviewer A is a reviewer', await canReview(REVIEWER_A));
  check('owner B is a reviewer in branch B', await canReview(ids.OWNER_B));

  const canReviewBranch = async (actorId, branchId) => {
    const result = await as(actorId, () =>
      query(db, `select pf_can_review_submission($1::uuid) as ok`, [branchId]),
    );
    return result.ok === true && result.value[0]?.ok === true;
  };

  check('reviewer A reviews branch A submissions', await canReviewBranch(REVIEWER_A, ids.BRANCH_A));
  check('reviewer B cannot review branch A submissions', !(await canReviewBranch(REVIEWER_B, ids.BRANCH_A)));
  check('assistant A cannot review branch A submissions', !(await canReviewBranch(ids.ASSISTANT_A, ids.BRANCH_A)));

  // An owner may grant the capability; a reviewer and an assistant may not.
  await trustedQuery(
    `update branch_memberships
     set can_review_clinical = false
     where user_id = $1 and branch_id = $2`,
    [ids.ASSISTANT_A, ids.BRANCH_A],
  );

  const ownerGrant = await as(ids.OWNER_A, () =>
    query(
      db,
      `update branch_memberships
       set can_review_clinical = true
       where user_id = $1 and branch_id = $2`,
      [ids.ASSISTANT_A, ids.BRANCH_A],
    ),
  );
  const afterOwnerGrant = await trustedRow(
    `select can_review_clinical from branch_memberships
     where user_id = $1 and branch_id = $2`,
    [ids.ASSISTANT_A, ids.BRANCH_A],
  );
  check(
    'an owner can grant clinical review permission',
    ownerGrant.ok === true && afterOwnerGrant.can_review_clinical === true,
    ownerGrant.ok ? '' : ownerGrant.err,
  );

  await trustedQuery(
    `update branch_memberships
     set can_review_clinical = false
     where user_id = $1 and branch_id = $2`,
    [ids.ASSISTANT_A, ids.BRANCH_A],
  );

  const selfGrant = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `update branch_memberships
       set can_review_clinical = true
       where user_id = $1 and branch_id = $2`,
      [ids.ASSISTANT_A, ids.BRANCH_A],
    ),
  );
  const afterSelfGrant = await trustedRow(
    `select can_review_clinical from branch_memberships
     where user_id = $1 and branch_id = $2`,
    [ids.ASSISTANT_A, ids.BRANCH_A],
  );
  check(
    'an assistant cannot grant themselves clinical review permission',
    afterSelfGrant.can_review_clinical === false,
    selfGrant.ok ? 'write returned without changing the row' : selfGrant.err,
  );

  const reviewerGrant = await as(REVIEWER_A, () =>
    query(
      db,
      `update branch_memberships
       set can_review_clinical = true
       where user_id = $1 and branch_id = $2`,
      [ids.ASSISTANT_A, ids.BRANCH_A],
    ),
  );
  const afterReviewerGrant = await trustedRow(
    `select can_review_clinical from branch_memberships
     where user_id = $1 and branch_id = $2`,
    [ids.ASSISTANT_A, ids.BRANCH_A],
  );
  check(
    'a non-owner reviewer cannot grant the capability',
    afterReviewerGrant.can_review_clinical === false,
    reviewerGrant.ok ? 'write returned without changing the row' : reviewerGrant.err,
  );
}

/* ================================================================ read boundary */

section('shared catalogue visibility and draft isolation');
let verified;
let draft;
let archived;
{
  verified = await makeVerifiedProduct({
    genericName: 'Catalogue Alpha',
    brandName: 'Alpha Brand',
    productName: 'Catalogue Alpha 500mg Tablets',
    strength: '500mg',
    nafdac: 'NAFDAC-ALPHA-1',
    category: 'Analgesic',
  });

  draft = await createProduct({
    genericName: 'Catalogue Beta',
    brandName: 'Beta Brand',
    productName: 'Catalogue Beta 250mg Tablets',
    strength: '250mg',
    nafdac: 'NAFDAC-BETA-1',
    category: 'Antibiotic',
  });

  archived = await makeVerifiedProduct({
    genericName: 'Catalogue Gamma',
    brandName: 'Gamma Brand',
    productName: 'Catalogue Gamma 100mg Tablets',
    strength: '100mg',
    nafdac: 'NAFDAC-GAMMA-1',
    category: 'Cardiovascular',
  });

  const archive = await as(REVIEWER_A, () =>
    query(db, `select pf_archive_medicine_product($1::uuid, $2)`, [
      archived.id,
      'Superseded in the verification fixture',
    ]),
  );
  expectOk(archive, 'reviewer can soft-archive a product');
}

{
  const assistant = await readProducts(ids.ASSISTANT_A, verified.id, draft.id, archived.id);
  check(
    'an attendant sees verified shared products across branches',
    assistant.ok === true && assistant.value.length === 1 && assistant.value[0].id === verified.id,
    assistant.ok ? `${assistant.value.length} visible` : assistant.err,
  );

  const assistantB = await readProducts(ASSISTANT_B, verified.id, draft.id, archived.id);
  check(
    'another branch’s attendant sees the shared verified product but not the draft or archive',
    assistantB.ok === true && assistantB.value.length === 1 && assistantB.value[0].id === verified.id,
    assistantB.ok ? `${assistantB.value.length} visible` : assistantB.err,
  );

  const reviewer = await readProducts(REVIEWER_A, verified.id, draft.id, archived.id);
  check(
    'a reviewer sees drafts and archived products as well',
    reviewer.ok === true && reviewer.value.length === 3,
    reviewer.ok ? `${reviewer.value.length} visible` : reviewer.err,
  );

  const draftSections = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `select count(*)::int as n from medicine_clinical_sections where product_id = $1`,
      [draft.id],
    ),
  );
  check(
    'an attendant cannot read a draft product’s clinical sections',
    draftSections.ok === true && draftSections.value[0].n === 0,
    draftSections.ok ? '' : draftSections.err,
  );

  const draftVisibility = await as(ids.ASSISTANT_A, () =>
    query(db, `select pf_can_read_medicine_product($1::uuid) as ok`, [draft.id]),
  );
  check(
    'the visibility helper agrees that a draft is hidden',
    draftVisibility.ok === true && draftVisibility.value[0].ok === false,
  );

  const draftVisibilityReviewer = await as(REVIEWER_A, () =>
    query(db, `select pf_can_read_medicine_product($1::uuid) as ok`, [draft.id]),
  );
  check(
    'the visibility helper shows the draft to a reviewer',
    draftVisibilityReviewer.ok === true && draftVisibilityReviewer.value[0].ok === true,
  );

  const anonRead = await asAnon(db, () => query(db, `select count(*) from medicine_products`));
  check('anonymous callers cannot read the shared catalogue', anonRead.ok === false, anonRead.err);

  const assistantSearch = await search(ids.ASSISTANT_A, { query: 'Catalogue Alpha' });
  check(
    'public search returns the verified product',
    assistantSearch.ok === true && assistantSearch.value.length === 1,
    assistantSearch.ok ? `${assistantSearch.value.length} rows` : assistantSearch.err,
  );

  const draftSearch = await search(ids.ASSISTANT_A, { query: 'Catalogue Beta' });
  check(
    'public search never returns a draft',
    draftSearch.ok === true && draftSearch.value.length === 0,
    draftSearch.ok ? '' : draftSearch.err,
  );

  const archivedSearch = await search(ids.ASSISTANT_A, { query: 'Catalogue Gamma' });
  check(
    'public search never returns an archived product',
    archivedSearch.ok === true && archivedSearch.value.length === 0,
    archivedSearch.ok ? '' : archivedSearch.err,
  );

  const filtered = await search(ids.ASSISTANT_A, {
    query: 'Catalogue Alpha',
    form: 'Tablet',
    route: 'oral',
    verification: 'verified',
  });
  check(
    'search filters compose (form + route + verification)',
    filtered.ok === true && filtered.value.length === 1,
    filtered.ok ? `${filtered.value.length} rows` : filtered.err,
  );

  const page = await search(ids.ASSISTANT_A, { limit: 1, offset: 0 });
  check(
    'search paginates and reports a total count',
    page.ok === true &&
      page.value.length === 1 &&
      Number(page.value[0].total_count) >= 1,
    page.ok ? `total_count=${page.value[0]?.total_count}` : page.err,
  );
}

/* ================================================================ attendant */

section('attendants cannot mutate shared clinical records');
{
  const insert = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `insert into medicine_products (${PRODUCT_COLUMNS})
       values (
         'Assistant Forbidden', 'Forbidden Brand', 'Assistant Forbidden 1mg Tablets',
         '1mg', 'Tablet', 'oral', 'Forbidden Manufacturer', $1, 'Analgesic',
         'otc'::prescription_class, 'draft'::medicine_verification_status
       )
       returning id`,
      [nextNafdac()],
    ),
  );
  const forbiddenCount = await trustedCount(
    `select count(*)::int as n from medicine_products where generic_name = 'Assistant Forbidden'`,
  );
  check(
    'an attendant cannot insert a shared product',
    forbiddenCount === 0,
    insert.ok ? 'RLS returned no row' : insert.err,
  );

  const before = await trustedRow(
    `select clinical_review_status from medicine_products where id = $1`,
    [verified.id],
  );
  const change = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `update medicine_products
       set clinical_review_status = 'rejected'
       where id = $1`,
      [verified.id],
    ),
  );
  const after = await trustedRow(
    `select clinical_review_status from medicine_products where id = $1`,
    [verified.id],
  );
  check(
    'an attendant cannot change a shared product status',
    before.clinical_review_status === after.clinical_review_status,
    change.ok ? 'RLS returned no row' : change.err,
  );

  const submission = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `insert into medicine_submissions
         (branch_id, submitted_by, status, generic_name, product_name)
       values ($1, $2, 'draft', 'Assistant Submission', 'Assistant Submission 1mg')
       returning id`,
      [ids.BRANCH_A, ids.ASSISTANT_A],
    ),
  );
  const submissionCount = await trustedCount(
    `select count(*)::int as n from medicine_submissions where generic_name = 'Assistant Submission'`,
  );
  check(
    'an attendant cannot create a medicine submission',
    submissionCount === 0,
    submission.ok ? 'RLS returned no row' : submission.err,
  );

  const linkTarget = await trusted(() =>
    seedMedicine(db, { branchId: ids.BRANCH_A }),
  );
  const linkAttempt = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `update medicines set catalogue_product_id = $1 where id = $2`,
      [verified.id, linkTarget.medicineId],
    ),
  );
  const linkAfterAttempt = await trustedRow(
    `select catalogue_product_id from medicines where id = $1`,
    [linkTarget.medicineId],
  );
  check(
    'an attendant cannot link stock to a shared clinical product',
    linkAfterAttempt.catalogue_product_id === null,
    linkAttempt.ok ? 'RLS returned no row' : linkAttempt.err,
  );

  const ownerLink = await as(ids.OWNER_A, () =>
    query(
      db,
      `update medicines set catalogue_product_id = $1 where id = $2`,
      [verified.id, linkTarget.medicineId],
    ),
  );
  const linkAfterOwner = await trustedRow(
    `select catalogue_product_id from medicines where id = $1`,
    [linkTarget.medicineId],
  );
  check(
    'an owner can link stock to a shared clinical product',
    ownerLink.ok === true && linkAfterOwner.catalogue_product_id === verified.id,
    ownerLink.ok ? '' : ownerLink.err,
  );

  const otherBranchLink = await as(ids.OWNER_B, () =>
    query(
      db,
      `update medicines set catalogue_product_id = null where id = $1`,
      [linkTarget.medicineId],
    ),
  );
  const linkAfterOtherBranch = await trustedRow(
    `select catalogue_product_id from medicines where id = $1`,
    [linkTarget.medicineId],
  );
  check(
    'another branch cannot change the pharmacy-to-catalogue link',
    linkAfterOtherBranch.catalogue_product_id === verified.id,
    otherBranchLink.ok ? 'RLS returned no row' : otherBranchLink.err,
  );
}

/* ================================================================ submission */

section('owner submission and branch-scoped clinical review');
let submissionId;
let acceptedProductId;
{
  const payload = {
    ingredients: [
      {
        ingredient_name: 'Paracetamol',
        strength_value: 500,
        strength_unit: 'mg',
        sort_order: 0,
      },
    ],
    sources: [
      {
        source_ref: 'src-1',
        source_type: 'regulator',
        title: 'NAFDAC register entry for the submitted product',
        url: 'https://example.test/nafdac/submitted-1',
        retrieved_at: '2026-10-19',
      },
    ],
    sections: [
      {
        section: 'indications',
        content:
          'Short-term relief of mild to moderate pain and fever. Reference content only.',
        status: 'verified',
        source_ref: 'src-1',
        retrieved_at: '2026-10-19',
        last_reviewed_at: '2026-10-19',
      },
      {
        section: 'food',
        content: 'Can be taken without regard to food.',
        status: 'verified',
        food_instruction: 'without_regard_to_food',
        source_ref: 'src-1',
        retrieved_at: '2026-10-19',
        last_reviewed_at: '2026-10-19',
      },
    ],
    dosages: [
      {
        population: 'adult',
        indication: 'Mild to moderate pain',
        route: 'oral',
        dose_text: '500 mg to 1 g',
        frequency: 'every 4 to 6 hours as needed',
        duration: 'Short-term use',
        max_dose: '4 g in 24 hours',
        notes: 'Reference only; not a patient-specific prescription.',
        status: 'verified',
        source_ref: 'src-1',
        retrieved_at: '2026-10-19',
        last_reviewed_at: '2026-10-19',
      },
    ],
  };

  const created = await as(ids.OWNER_A, () =>
    query(
      db,
      `insert into medicine_submissions (
         branch_id, submitted_by, status,
         generic_name, brand_name, product_name, strength_text, dosage_form, route,
         manufacturer, nafdac_reg_number, category, prescription_class,
         source_type, source_title, source_url, source_retrieved_at,
         clinical_payload, notes
       ) values (
         $1, $2, 'draft'::medicine_submission_status,
         'Submitted Paracetamol', 'Submitted Brand', 'Submitted Paracetamol 500mg Tablets',
         '500mg', 'Tablet', 'oral',
         'Submitted Manufacturer', 'NAFDAC-SUBMITTED-1', 'Analgesic',
         'otc'::prescription_class,
         'regulator'::medicine_source_type,
         'NAFDAC register entry',
         'https://example.test/nafdac/submitted-1',
         '2026-10-19'::date,
         $3::jsonb, 'Verification suite submission'
       )
       returning *`,
      [ids.BRANCH_A, ids.OWNER_A, JSON.stringify(payload)],
    ),
  );

  const createdRows = expectOk(created, 'an owner can save a draft submission');
  submissionId = createdRows[0]?.id;
  check('the draft is stored with the owner as submitter', createdRows[0]?.submitted_by === ids.OWNER_A);
  check('the draft is stored in the owner’s branch', createdRows[0]?.branch_id === ids.BRANCH_A);

  // Authorship and tenancy are not editable, even by a reviewer. Re-read as the
  // server so a silently filtered UPDATE cannot be mistaken for a successful one.
  const rewrite = await as(ids.OWNER_A, () =>
    query(
      db,
      `update medicine_submissions
       set submitted_by = $2, branch_id = $3
       where id = $1
       returning *`,
      [submissionId, ASSISTANT_B, ids.BRANCH_B],
    ),
  );
  const immutable = await trustedRow(
    `select submitted_by, branch_id from medicine_submissions where id = $1`,
    [submissionId],
  );
  check(
    'a submission’s author and branch are immutable',
    immutable.submitted_by === ids.OWNER_A && immutable.branch_id === ids.BRANCH_A,
    rewrite.ok ? 'the guard kept the original values' : rewrite.err,
  );

  const submitted = await as(ids.OWNER_A, () =>
    query(
      db,
      `update medicine_submissions set status = 'submitted' where id = $1 returning *`,
      [submissionId],
    ),
  );
  const submittedRows = expectOk(submitted, 'the owner can submit the draft for review');
  check(
    'submission records when it was submitted',
    submittedRows[0]?.status === 'submitted' && submittedRows[0]?.submitted_at != null,
  );

  const assistantRead = await as(ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from medicine_submissions where id = $1`, [submissionId]),
  );
  check(
    'an attendant cannot read the owner’s submission',
    assistantRead.ok === true && assistantRead.value[0].n === 0,
    assistantRead.ok ? '' : assistantRead.err,
  );

  const reviewerBRead = await as(REVIEWER_B, () =>
    query(db, `select count(*)::int as n from medicine_submissions where id = $1`, [submissionId]),
  );
  check(
    'a reviewer in another branch cannot read the submission',
    reviewerBRead.ok === true && reviewerBRead.value[0].n === 0,
    reviewerBRead.ok ? '' : reviewerBRead.err,
  );

  const ownerBRead = await as(ids.OWNER_B, () =>
    query(db, `select count(*)::int as n from medicine_submissions where id = $1`, [submissionId]),
  );
  check(
    'another branch owner cannot read the submission',
    ownerBRead.ok === true && ownerBRead.value[0].n === 0,
    ownerBRead.ok ? '' : ownerBRead.err,
  );

  const reviewerARead = await as(REVIEWER_A, () =>
    query(db, `select count(*)::int as n from medicine_submissions where id = $1`, [submissionId]),
  );
  check(
    'the branch reviewer can read the submission',
    reviewerARead.ok === true && reviewerARead.value[0].n === 1,
    reviewerARead.ok ? '' : reviewerARead.err,
  );

  const crossBranchAccept = await as(REVIEWER_B, () =>
    query(db, `select pf_accept_medicine_submission($1::uuid, $2) as product_id`, [
      submissionId,
      'Cross-branch attempt',
    ]),
  );
  check(
    'a reviewer in another branch cannot accept the submission',
    crossBranchAccept.ok === false,
    crossBranchAccept.ok ? 'accepted without error' : crossBranchAccept.err,
  );

  const assistantAccept = await as(ids.ASSISTANT_A, () =>
    query(db, `select pf_accept_medicine_submission($1::uuid, $2) as product_id`, [
      submissionId,
      'Attendant attempt',
    ]),
  );
  check(
    'an attendant cannot accept a submission',
    assistantAccept.ok === false,
    assistantAccept.ok ? 'accepted without error' : assistantAccept.err,
  );

  const stillPending = await trustedRow(
    `select status, accepted_product_id from medicine_submissions where id = $1`,
    [submissionId],
  );
  check(
    'failed acceptance attempts leave the submission pending',
    stillPending.status === 'submitted' && stillPending.accepted_product_id === null,
  );

  const accepted = await as(REVIEWER_A, () =>
    query(db, `select pf_accept_medicine_submission($1::uuid, $2) as product_id`, [
      submissionId,
      'Reviewed against the submitted regulator source',
    ]),
  );
  const acceptedRows = expectOk(accepted, 'the branch reviewer can accept the submission');
  acceptedProductId = acceptedRows[0]?.product_id;
  check('acceptance returns the shared product id', Boolean(acceptedProductId));

  if (acceptedProductId) {
    const submission = await trustedRow(
      `select status, accepted_product_id, reviewed_by, reviewed_at
       from medicine_submissions where id = $1`,
      [submissionId],
    );
    check(
      'the submission is recorded as accepted by the reviewer',
      submission.status === 'accepted' &&
        submission.accepted_product_id === acceptedProductId &&
        submission.reviewed_by === REVIEWER_A &&
        submission.reviewed_at != null,
    );

    const product = await trustedRow(
      `select * from medicine_products where id = $1`,
      [acceptedProductId],
    );
    check(
      'the accepted product is clinically verified with a named reviewer',
      product.clinical_review_status === 'verified' &&
        product.clinical_reviewed_by === REVIEWER_A &&
        product.last_clinical_review_date != null,
    );
    check(
      'registration verification remains separate from clinical verification',
      product.nafdac_registration_status === 'pending',
      `registration=${product.nafdac_registration_status}`,
    );

    const ingredients = await trustedCount(
      `select count(*)::int as n from medicine_ingredients where product_id = $1`,
      [acceptedProductId],
    );
    const sections = await trustedCount(
      `select count(*)::int as n from medicine_clinical_sections where product_id = $1`,
      [acceptedProductId],
    );
    const dosages = await trustedCount(
      `select count(*)::int as n from medicine_dosages where product_id = $1`,
      [acceptedProductId],
    );
    const sources = await trustedCount(
      `select count(*)::int as n from medicine_sources where product_id = $1`,
      [acceptedProductId],
    );

    check('the accepted product has its active ingredient', ingredients === 1);
    check('the accepted product has both submitted clinical sections', sections === 2);
    check('the accepted product has its population/indication dosage', dosages === 1);
    check('the accepted product has its source records', sources === 2, `${sources} sources`);

    const auditAccepted = await trustedCount(
      `select count(*)::int as n from medicine_catalogue_audit
       where product_id = $1 and action = 'submission_accepted'`,
      [acceptedProductId],
    );
    const auditStatus = await trustedCount(
      `select count(*)::int as n from medicine_catalogue_audit
       where product_id = $1 and action = 'product_status_changed'`,
      [acceptedProductId],
    );
    check('acceptance is written to the global audit trail', auditAccepted === 1);
    check('the verification status transition is audited', auditStatus >= 1);

    const revisions = await trustedCount(
      `select count(*)::int as n from medicine_product_revisions where product_id = $1`,
      [acceptedProductId],
    );
    check('the accepted product has version history', revisions >= 2, `${revisions} revisions`);

    const assistantAcceptedRead = await as(ids.ASSISTANT_A, () =>
      query(db, `select count(*)::int as n from medicine_products where id = $1`, [
        acceptedProductId,
      ]),
    );
    check(
      'attendants can read the newly verified shared product',
      assistantAcceptedRead.ok === true && assistantAcceptedRead.value[0].n === 1,
      assistantAcceptedRead.ok ? '' : assistantAcceptedRead.err,
    );

    const ownerBAcceptedRead = await as(ids.OWNER_B, () =>
      query(db, `select count(*)::int as n from medicine_products where id = $1`, [
        acceptedProductId,
      ]),
    );
    check(
      'other branches can read the newly verified shared product',
      ownerBAcceptedRead.ok === true && ownerBAcceptedRead.value[0].n === 1,
      ownerBAcceptedRead.ok ? '' : ownerBAcceptedRead.err,
    );
  } else {
    check('accepted product assertions ran', false, 'no accepted product id');
  }

  // A verified product is not a submission target. Allowing acceptance to
  // replace its reviewed content would be the "lower-quality data overwrote a
  // verified record" failure the import rules forbid, just through a different
  // door. Corrections to a verified product must use its own revision trail.
  const protectedProduct = await makeVerifiedProduct({
    genericName: 'Protected Product',
    brandName: 'Protected Brand',
    productName: 'Protected Product 500mg Tablets',
    strength: '500mg',
    nafdac: 'NAFDAC-PROTECTED-1',
  });
  const protectedBefore = await trustedRow(
    `select product_name, version, clinical_review_status
     from medicine_products where id = $1`,
    [protectedProduct.id],
  );

  const protectedSubmission = await as(ids.OWNER_A, () =>
    query(
      db,
      `insert into medicine_submissions (
         branch_id, submitted_by, status, product_id,
         generic_name, brand_name, product_name, strength_text, dosage_form, route,
         manufacturer, nafdac_reg_number, category, prescription_class,
         source_type, source_title, source_url, source_retrieved_at,
         clinical_payload
       ) values (
         $1, $2, 'submitted'::medicine_submission_status, $3,
         'Protected Product', 'Protected Brand', 'Protected Product 500mg Tablets',
         '500mg', 'Tablet', 'oral',
         'Protected Manufacturer', 'NAFDAC-PROTECTED-1', 'Analgesic',
         'otc'::prescription_class,
         'regulator'::medicine_source_type,
         'NAFDAC register entry', 'https://example.test/nafdac/protected-1',
         '2026-10-19'::date,
         '{"sources":[],"ingredients":[],"sections":[],"dosages":[]}'::jsonb
       )
       returning *`,
      [ids.BRANCH_A, ids.OWNER_A, protectedProduct.id],
    ),
  );
  const protectedRows = expectOk(
    protectedSubmission,
    'an owner can submit a correction against a known product',
  );
  const protectedSubmissionId = protectedRows[0]?.id;

  const overwrite = await as(REVIEWER_A, () =>
    query(db, `select pf_accept_medicine_submission($1::uuid, $2)`, [
      protectedSubmissionId,
      'Attempt to overwrite verified content',
    ]),
  );
  const protectedAfter = await trustedRow(
    `select product_name, version, clinical_review_status
     from medicine_products where id = $1`,
    [protectedProduct.id],
  );
  const protectedSubmissionAfter = await trustedRow(
    `select status, accepted_product_id from medicine_submissions where id = $1`,
    [protectedSubmissionId],
  );
  check(
    'acceptance refuses to overwrite an already verified product',
    overwrite.ok === false &&
      protectedAfter.product_name === protectedBefore.product_name &&
      protectedAfter.version === protectedBefore.version &&
      protectedAfter.clinical_review_status === 'verified' &&
      protectedSubmissionAfter.status === 'submitted' &&
      protectedSubmissionAfter.accepted_product_id === null,
    overwrite.ok ? 'verified product was overwritten' : overwrite.err,
  );

  const directAccept = await as(REVIEWER_A, () =>
    query(
      db,
      `update medicine_submissions set status = 'accepted' where id = $1`,
      [protectedSubmissionId],
    ),
  );
  const directAcceptRow = await trustedRow(
    `select status, accepted_product_id from medicine_submissions where id = $1`,
    [protectedSubmissionId],
  );
  check(
    'a reviewer cannot mark a submission accepted without a reviewed product',
    directAccept.ok === false &&
      directAcceptRow.status === 'submitted' &&
      directAcceptRow.accepted_product_id === null,
    directAccept.ok ? 'status changed without a product' : directAccept.err,
  );

  // The submission form requires a prescription class, but the database is the
  // authority. Accepting an unclassified submission would silently publish it
  // as OTC via the old coalesce default.
  const unclassified = await as(ids.OWNER_A, () =>
    query(
      db,
      `insert into medicine_submissions (
         branch_id, submitted_by, status,
         generic_name, brand_name, product_name, strength_text, dosage_form, route,
         manufacturer, category, prescription_class,
         source_type, source_title, source_url, source_retrieved_at,
         clinical_payload
       ) values (
         $1, $2, 'submitted'::medicine_submission_status,
         'Unclassified Product', 'Unclassified Brand',
         'Unclassified Product 250mg Capsules',
         '250mg', 'Capsule', 'oral',
         'Unclassified Manufacturer', 'Analgesic', null,
         'regulator'::medicine_source_type,
         'NAFDAC register entry', 'https://example.test/nafdac/unclassified-1',
         '2026-10-19'::date,
         '{"sources":[],"ingredients":[],"sections":[],"dosages":[]}'::jsonb
       )
       returning *`,
      [ids.BRANCH_A, ids.OWNER_A],
    ),
  );
  const unclassifiedRows = expectOk(
    unclassified,
    'an owner can submit a record with an unclassified prescription field',
  );
  const unclassifiedSubmissionId = unclassifiedRows[0]?.id;

  const unclassifiedAccept = await as(REVIEWER_A, () =>
    query(db, `select pf_accept_medicine_submission($1::uuid, $2)`, [
      unclassifiedSubmissionId,
      'Attempt to accept an unclassified product',
    ]),
  );
  const unclassifiedAfter = await trustedRow(
    `select status, accepted_product_id from medicine_submissions where id = $1`,
    [unclassifiedSubmissionId],
  );
  const unclassifiedProducts = await trustedCount(
    `select count(*)::int as n from medicine_products where product_name = $1`,
    ['Unclassified Product 250mg Capsules'],
  );
  check(
    'acceptance refuses an unclassified submission rather than defaulting it to OTC',
    unclassifiedAccept.ok === false &&
      unclassifiedAfter.status === 'submitted' &&
      unclassifiedAfter.accepted_product_id === null &&
      unclassifiedProducts === 0,
    unclassifiedAccept.ok ? 'unclassified product was published' : unclassifiedAccept.err,
  );

  // A primary source without a retrieval date must not be accepted with today's
  // date back-filled. The reviewer would then be relying on a date nobody
  // recorded.
  const undated = await as(ids.OWNER_A, () =>
    query(
      db,
      `insert into medicine_submissions (
         branch_id, submitted_by, status,
         generic_name, brand_name, product_name, strength_text, dosage_form, route,
         manufacturer, category, prescription_class,
         source_type, source_title, source_url, source_retrieved_at,
         clinical_payload
       ) values (
         $1, $2, 'submitted'::medicine_submission_status,
         'Undated Source Product', 'Undated Brand',
         'Undated Source Product 100mg Tablets',
         '100mg', 'Tablet', 'oral',
         'Undated Manufacturer', 'Analgesic', 'otc'::prescription_class,
         'regulator'::medicine_source_type,
         'NAFDAC register entry', 'https://example.test/nafdac/undated-1', null,
         '{"sources":[],"ingredients":[],"sections":[],"dosages":[]}'::jsonb
       )
       returning *`,
      [ids.BRANCH_A, ids.OWNER_A],
    ),
  );
  const undatedRows = expectOk(
    undated,
    'an owner can submit a record whose primary source has no retrieval date',
  );
  const undatedSubmissionId = undatedRows[0]?.id;
  const undatedAccept = await as(REVIEWER_A, () =>
    query(db, `select pf_accept_medicine_submission($1::uuid, $2)`, [
      undatedSubmissionId,
      'Attempt to accept an undated source',
    ]),
  );
  const undatedAfter = await trustedRow(
    `select status, accepted_product_id from medicine_submissions where id = $1`,
    [undatedSubmissionId],
  );
  const undatedProducts = await trustedCount(
    `select count(*)::int as n from medicine_products where product_name = $1`,
    ['Undated Source Product 100mg Tablets'],
  );
  check(
    'acceptance refuses an undated primary source rather than back-filling today',
    undatedAccept.ok === false &&
      undatedAfter.status === 'submitted' &&
      undatedAfter.accepted_product_id === null &&
      undatedProducts === 0,
    undatedAccept.ok ? 'undated source was published' : undatedAccept.err,
  );
}

/* ================================================================ verification gates */

section('verification cannot be claimed without evidence');
{
  const sourceGate = await createProduct({
    genericName: 'Source Gate',
    brandName: 'Source Gate Brand',
    productName: 'Source Gate 20mg Tablets',
    strength: '20mg',
    nafdac: 'NAFDAC-SOURCE-GATE-1',
  });

  const noSource = await as(REVIEWER_A, () =>
    query(db, `select pf_set_medicine_product_status($1::uuid, $2::medicine_verification_status, $3)`, [
      sourceGate.id,
      'verified',
      null,
    ]),
  );
  check(
    'a product cannot be verified without a source',
    noSource.ok === false,
    noSource.ok ? 'verified without a source' : noSource.err,
  );

  const stillDraft = await trustedRow(
    `select clinical_review_status from medicine_products where id = $1`,
    [sourceGate.id],
  );
  check('the failed verification left the status unchanged', stillDraft.clinical_review_status === 'draft');

  await addSource(sourceGate.id);
  const withSource = await as(REVIEWER_A, () =>
    query(db, `select pf_set_medicine_product_status($1::uuid, $2::medicine_verification_status, $3)`, [
      sourceGate.id,
      'verified',
      'Source present',
    ]),
  );
  const verifiedRow = await trustedRow(
    `select clinical_review_status, clinical_reviewed_by
     from medicine_products where id = $1`,
    [sourceGate.id],
  );
  check(
    'a reviewer can verify once a source exists',
    withSource.ok === true && verifiedRow.clinical_review_status === 'verified',
    withSource.ok ? '' : withSource.err,
  );
  check(
    'the verification names the reviewer',
    verifiedRow.clinical_reviewed_by === REVIEWER_A,
  );

  const sectionGate = await createProduct({
    genericName: 'Section Gate',
    brandName: 'Section Gate Brand',
    productName: 'Section Gate 10mg Tablets',
    strength: '10mg',
    nafdac: 'NAFDAC-SECTION-GATE-1',
  });
  const sectionSource = await addSource(sectionGate.id);

  const unsourced = await as(REVIEWER_A, () =>
    query(
      db,
      `insert into medicine_clinical_sections
         (product_id, section, content, status, reviewed_by)
       values (
         $1, 'indications'::clinical_section, 'Unsourced claim',
         'verified'::clinical_section_status, $2
       )
       returning id`,
      [sectionGate.id, REVIEWER_A],
    ),
  );
  const unsourcedCount = await trustedCount(
    `select count(*)::int as n from medicine_clinical_sections where product_id = $1`,
    [sectionGate.id],
  );
  check(
    'a verified section without a source is refused',
    unsourced.ok === false && unsourcedCount === 0,
    unsourced.ok ? 'section was written' : unsourced.err,
  );

  const unverified = await as(REVIEWER_A, () =>
    query(
      db,
      `insert into medicine_clinical_sections
         (product_id, section, content, status, reviewed_by)
       values (
         $1, 'precautions'::clinical_section, 'Not checked yet',
         'not_verified'::clinical_section_status, $2
       )
       returning *`,
      [sectionGate.id, REVIEWER_A],
    ),
  );
  const unverifiedRows = expectOk(unverified, 'an unverified section can exist without a source');
  check(
    'the unverified section is explicitly marked, not silently empty',
    unverifiedRows[0]?.status === 'not_verified',
  );

  const promote = await as(REVIEWER_A, () =>
    query(
      db,
      `update medicine_clinical_sections
       set status = 'verified'
       where product_id = $1 and section = 'precautions'`,
      [sectionGate.id],
    ),
  );
  const stillUnverified = await trustedRow(
    `select status from medicine_clinical_sections
     where product_id = $1 and section = 'precautions'`,
    [sectionGate.id],
  );
  check(
    'an existing section cannot be promoted to verified without a source',
    promote.ok === false && stillUnverified.status === 'not_verified',
    promote.ok ? 'promotion succeeded' : promote.err,
  );

  const sourcedPromote = await as(REVIEWER_A, () =>
    query(
      db,
      `update medicine_clinical_sections
       set status = 'verified', source_id = $2, reviewed_by = $3,
           last_reviewed_at = current_date
       where product_id = $1 and section = 'precautions'`,
      [sectionGate.id, sectionSource.id, REVIEWER_A],
    ),
  );
  check('a sourced section can be promoted to verified', sourcedPromote.ok === true, sourcedPromote.ok ? '' : sourcedPromote.err);

  // A source and a named reviewer are not enough if nobody recorded when the
  // review happened. The catalogue must not claim a fresh verification without
  // a review date.
  const noReviewDate = await as(REVIEWER_A, () =>
    query(
      db,
      `insert into medicine_clinical_sections
         (product_id, section, content, status, source_id, reviewed_by)
       values (
         $1, 'warnings'::clinical_section, 'No review date',
         'verified'::clinical_section_status, $2, $3
       )
       returning id`,
      [sectionGate.id, sectionSource.id, REVIEWER_A],
    ),
  );
  const noReviewDateCount = await trustedCount(
    `select count(*)::int as n from medicine_clinical_sections
     where product_id = $1 and section = 'warnings'`,
    [sectionGate.id],
  );
  check(
    'a verified clinical section needs a review date',
    noReviewDate.ok === false && noReviewDateCount === 0,
    noReviewDate.ok ? 'section was accepted without a review date' : noReviewDate.err,
  );

  const registrationGate = await createProduct({
    genericName: 'Registration Gate',
    brandName: 'Registration Gate Brand',
    productName: 'Registration Gate 5mg Tablets',
    strength: '5mg',
    nafdac: 'NAFDAC-REGISTRATION-GATE-1',
  });

  const directRegistration = await as(REVIEWER_A, () =>
    query(
      db,
      `update medicine_products
       set nafdac_registration_status = 'verified'
       where id = $1`,
      [registrationGate.id],
    ),
  );
  const directRegistrationRow = await trustedRow(
    `select nafdac_registration_status, nafdac_verified_at
     from medicine_products where id = $1`,
    [registrationGate.id],
  );
  check(
    'a direct update cannot verify registration without a regulator source',
    directRegistration.ok === false &&
      directRegistrationRow.nafdac_registration_status === 'unverified' &&
      directRegistrationRow.nafdac_verified_at === null,
    directRegistration.ok ? 'direct update succeeded' : directRegistration.err,
  );

  const noRegulator = await as(REVIEWER_A, () =>
    query(db, `select pf_set_medicine_registration_status($1::uuid, $2::medicine_registration_status, $3, $4)`, [
      registrationGate.id,
      'verified',
      null,
      null,
    ]),
  );
  const unverifiedRegistration = await trustedRow(
    `select nafdac_registration_status, clinical_review_status
     from medicine_products where id = $1`,
    [registrationGate.id],
  );
  check(
    'registration cannot be verified without a regulator source',
    noRegulator.ok === false &&
      unverifiedRegistration.nafdac_registration_status === 'unverified',
    noRegulator.ok ? 'registration verified without a source' : noRegulator.err,
  );

  const regulatorSource = await addSource(registrationGate.id, {
    type: 'regulator',
    title: 'NAFDAC register entry',
    url: 'https://example.test/nafdac/registration-gate-1',
  });

  const registrationVerified = await as(REVIEWER_A, () =>
    query(db, `select pf_set_medicine_registration_status($1::uuid, $2::medicine_registration_status, $3, $4)`, [
      registrationGate.id,
      'verified',
      regulatorSource.id,
      'Register checked',
    ]),
  );
  const separated = await trustedRow(
    `select nafdac_registration_status, clinical_review_status
     from medicine_products where id = $1`,
    [registrationGate.id],
  );
  check(
    'registration can be verified independently of clinical review',
    registrationVerified.ok === true &&
      separated.nafdac_registration_status === 'verified' &&
      separated.clinical_review_status === 'draft',
    registrationVerified.ok ? `clinical=${separated.clinical_review_status}` : registrationVerified.err,
  );

  const mismatch = await as(REVIEWER_A, () =>
    query(db, `select pf_set_medicine_registration_status($1::uuid, $2::medicine_registration_status, $3, $4)`, [
      registrationGate.id,
      'mismatch',
      null,
      'Register shows a different marketing authorisation holder',
    ]),
  );
  const mismatchRow = await trustedRow(
    `select nafdac_registration_status, clinical_review_status
     from medicine_products where id = $1`,
    [registrationGate.id],
  );
  check(
    'registration mismatch is recorded without changing clinical status',
    mismatch.ok === true &&
      mismatchRow.nafdac_registration_status === 'mismatch' &&
      mismatchRow.clinical_review_status === 'draft',
    mismatch.ok ? '' : mismatch.err,
  );

  const noNumberProduct = await createProduct({
    genericName: 'No Number',
    brandName: 'No Number Brand',
    productName: 'No Number 1mg Tablets',
    strength: '1mg',
    nafdac: null,
  });
  await addSource(noNumberProduct.id, { type: 'regulator' });
  const noNumberVerify = await as(REVIEWER_A, () =>
    query(
      db,
      `select pf_set_medicine_registration_status($1::uuid, $2::medicine_registration_status, $3, $4)`,
      [
        noNumberProduct.id,
        'verified',
        null,
        'Attempt without a registration number',
      ],
    ),
  );
  const noNumberRow = await trustedRow(
    `select nafdac_registration_status from medicine_products where id = $1`,
    [noNumberProduct.id],
  );
  check(
    'registration cannot be verified without a registration number',
    noNumberVerify.ok === false && noNumberRow.nafdac_registration_status === 'unverified',
    noNumberVerify.ok ? 'verified without a number' : noNumberVerify.err,
  );
}

/* ================================================================ archive */

section('correction and deactivation preserve history');
{
  const archiveGate = await makeVerifiedProduct({
    genericName: 'Archive Gate',
    brandName: 'Archive Gate Brand',
    productName: 'Archive Gate 30mg Tablets',
    strength: '30mg',
    nafdac: 'NAFDAC-ARCHIVE-GATE-1',
  });

  const noReason = await as(REVIEWER_A, () =>
    query(db, `select pf_archive_medicine_product($1::uuid, $2)`, [
      archiveGate.id,
      '   ',
    ]),
  );
  const stillActive = await trustedRow(
    `select archived_at from medicine_products where id = $1`,
    [archiveGate.id],
  );
  check(
    'archiving requires a reason',
    noReason.ok === false && stillActive.archived_at === null,
    noReason.ok ? 'archived without a reason' : noReason.err,
  );

  const archive = await as(REVIEWER_A, () =>
    query(db, `select pf_archive_medicine_product($1::uuid, $2)`, [
      archiveGate.id,
      'Withdrawn from the reference catalogue',
    ]),
  );
  expectOk(archive, 'a reviewer can archive a shared product');

  const archivedRow = await trustedRow(
    `select archived_at, archive_reason from medicine_products where id = $1`,
    [archiveGate.id],
  );
  check(
    'archiving is a soft deactivation with a reason',
    archivedRow.archived_at != null &&
      archivedRow.archive_reason === 'Withdrawn from the reference catalogue',
  );

  const hidden = await as(ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from medicine_products where id = $1`, [archiveGate.id]),
  );
  check(
    'an archived product is hidden from attendants',
    hidden.ok === true && hidden.value[0].n === 0,
    hidden.ok ? '' : hidden.err,
  );

  const reviewerVisible = await as(REVIEWER_A, () =>
    query(db, `select count(*)::int as n from medicine_products where id = $1`, [archiveGate.id]),
  );
  check(
    'a reviewer can still inspect an archived product',
    reviewerVisible.ok === true && reviewerVisible.value[0].n === 1,
    reviewerVisible.ok ? '' : reviewerVisible.err,
  );

  const audit = await trustedCount(
    `select count(*)::int as n from medicine_catalogue_audit
     where product_id = $1 and action = 'product_archived'`,
    [archiveGate.id],
  );
  const revisions = await trustedCount(
    `select count(*)::int as n from medicine_product_revisions where product_id = $1`,
    [archiveGate.id],
  );
  check('the archive action is audited', audit === 1);
  check('archiving does not destroy version history', revisions >= 2, `${revisions} revisions`);

  const assistantArchive = await as(ids.ASSISTANT_A, () =>
    query(db, `select pf_archive_medicine_product($1::uuid, $2)`, [
      archiveGate.id,
      'Attendant attempt',
    ]),
  );
  check(
    'an attendant cannot archive a shared product',
    assistantArchive.ok === false,
    assistantArchive.ok ? 'archived without error' : assistantArchive.err,
  );

  const restore = await as(REVIEWER_A, () =>
    query(db, `select pf_restore_medicine_product($1::uuid, $2)`, [
      archiveGate.id,
      'Restored after review',
    ]),
  );
  const restoredRow = await trustedRow(
    `select archived_at, archive_reason from medicine_products where id = $1`,
    [archiveGate.id],
  );
  check(
    'a reviewer can restore a deactivated product',
    restore.ok === true &&
      restoredRow.archived_at === null &&
      restoredRow.archive_reason === null,
    restore.ok ? '' : restore.err,
  );

  const visibleAgain = await as(ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from medicine_products where id = $1`, [archiveGate.id]),
  );
  check(
    'a restored product is visible to attendants again',
    visibleAgain.ok === true && visibleAgain.value[0].n === 1,
    visibleAgain.ok ? '' : visibleAgain.err,
  );
}

/* ================================================================ duplicates + import */

section('duplicate and import identity are enforced');
{
  const duplicateFields = {
    genericName: 'Duplicate One',
    brandName: 'Duplicate Brand',
    productName: 'Duplicate One 500mg Tablets',
    strength: '500mg',
    form: 'Tablet',
    route: 'oral',
    manufacturer: 'Duplicate Manufacturer',
    nafdac: 'NAFDAC-DUPLICATE-1',
    category: 'Analgesic',
  };

  const first = await createProduct(duplicateFields);
  const second = await tryTrusted(
    `insert into medicine_products (${PRODUCT_COLUMNS})
     values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       'otc'::prescription_class, 'draft'::medicine_verification_status
     )
     returning id`,
    [
      duplicateFields.genericName,
      duplicateFields.brandName,
      duplicateFields.productName,
      duplicateFields.strength,
      duplicateFields.form,
      duplicateFields.route,
      duplicateFields.manufacturer,
      duplicateFields.nafdac,
      duplicateFields.category,
    ],
  );
  const duplicateCount = await trustedCount(
    `select count(*)::int as n from medicine_products where generic_name = 'Duplicate One'`,
  );
  check(
    'an exact identity duplicate is refused by the database',
    first.id != null && second.ok === false && duplicateCount === 1,
    second.ok ? 'second row inserted' : second.err,
  );

  const candidatesOwner = await as(ids.OWNER_A, () =>
    query(
      db,
      `select * from pf_medicine_duplicate_candidates(
         $1, $2, $3, $4, $5, $6, $7, $8::uuid
       )`,
      [
        duplicateFields.genericName,
        duplicateFields.strength,
        duplicateFields.form,
        duplicateFields.route,
        duplicateFields.brandName,
        duplicateFields.manufacturer,
        duplicateFields.nafdac,
        null,
      ],
    ),
  );
  check(
    'duplicate candidates returns the exact match for a reviewer',
    candidatesOwner.ok === true &&
      candidatesOwner.value.length >= 1 &&
      Number(candidatesOwner.value[0].match_score) === 100,
    candidatesOwner.ok ? `${candidatesOwner.value.length} candidates` : candidatesOwner.err,
  );

  const candidatesAssistant = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `select * from pf_medicine_duplicate_candidates(
         $1, $2, $3, $4, $5, $6, $7, $8::uuid
       )`,
      [
        duplicateFields.genericName,
        duplicateFields.strength,
        duplicateFields.form,
        duplicateFields.route,
        duplicateFields.brandName,
        duplicateFields.manufacturer,
        duplicateFields.nafdac,
        null,
      ],
    ),
  );
  check(
    'an attendant cannot use duplicate search to enumerate drafts',
    candidatesAssistant.ok === true && candidatesAssistant.value.length === 0,
    candidatesAssistant.ok ? '' : candidatesAssistant.err,
  );

  const archivedCandidateAssistant = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `select * from pf_medicine_duplicate_candidates(
         $1, $2, $3, $4, $5, $6, $7, $8::uuid
       )`,
      [
        'Catalogue Gamma',
        '100mg',
        'Tablet',
        'oral',
        'Gamma Brand',
        'Test Manufacturer',
        'NAFDAC-GAMMA-1',
        null,
      ],
    ),
  );
  check(
    'an attendant cannot use duplicate search to enumerate archived products',
    archivedCandidateAssistant.ok === true && archivedCandidateAssistant.value.length === 0,
    archivedCandidateAssistant.ok ? '' : archivedCandidateAssistant.err,
  );

  const archivedCandidateReviewer = await as(REVIEWER_A, () =>
    query(
      db,
      `select * from pf_medicine_duplicate_candidates(
         $1, $2, $3, $4, $5, $6, $7, $8::uuid
       )`,
      [
        'Catalogue Gamma',
        '100mg',
        'Tablet',
        'oral',
        'Gamma Brand',
        'Test Manufacturer',
        'NAFDAC-GAMMA-1',
        null,
      ],
    ),
  );
  check(
    'a reviewer can still find archived products in duplicate search',
    archivedCandidateReviewer.ok === true && archivedCandidateReviewer.value.length >= 1,
    archivedCandidateReviewer.ok
      ? `${archivedCandidateReviewer.value.length} candidates`
      : archivedCandidateReviewer.err,
  );

  const batch = await tryTrusted(
    `insert into medicine_import_batches (source_name, status)
     values ('verification-source', 'pending')
     returning id`,
  );
  const batchId = batch.value?.[0]?.id;
  check('trusted server can create an import batch', batch.ok === true && Boolean(batchId));

  const rowOne = await tryTrusted(
    `insert into medicine_import_rows (batch_id, external_id, source_hash, raw)
     values ($1, 'external-1', 'hash-1', '{}'::jsonb)
     returning id`,
    [batchId],
  );
  const rowTwo = await tryTrusted(
    `insert into medicine_import_rows (batch_id, external_id, source_hash, raw)
     values ($1, 'external-1', 'hash-1', '{}'::jsonb)
     returning id`,
    [batchId],
  );
  check(
    'import staging is idempotent by batch and external id',
    rowOne.ok === true && rowTwo.ok === false,
    rowTwo.ok ? 'second row inserted' : rowTwo.err,
  );

  const sourceRecordOne = await tryTrusted(
    `insert into medicine_source_records (source_name, external_id, product_id, source_hash)
     values ('verification-source', 'external-1', $1, 'hash-1')
     returning *`,
    [first.id],
  );
  const sourceRecordTwo = await tryTrusted(
    `insert into medicine_source_records (source_name, external_id, product_id, source_hash)
     values ('verification-source', 'external-1', $1, 'hash-2')
     returning *`,
    [first.id],
  );
  check(
    'the import source identity map is idempotent across runs',
    sourceRecordOne.ok === true && sourceRecordTwo.ok === false,
    sourceRecordTwo.ok ? 'second source record inserted' : sourceRecordTwo.err,
  );

  const importReadOwner = await as(ids.OWNER_A, () =>
    query(db, `select count(*) from medicine_import_batches`),
  );
  const importReadReviewer = await as(REVIEWER_A, () =>
    query(db, `select count(*) from medicine_import_batches`),
  );
  check(
    'import staging is not readable by an owner',
    importReadOwner.ok === false,
    importReadOwner.ok ? 'owner read import rows' : importReadOwner.err,
  );
  check(
    'import staging is not readable by a reviewer',
    importReadReviewer.ok === false,
    importReadReviewer.ok ? 'reviewer read import rows' : importReadReviewer.err,
  );
}

/* ================================================================ tenant + regression */

section('local records stay tenant-scoped and existing inventory still behaves');
{
  const medicineA = await trusted(() => seedMedicine(db, { branchId: ids.BRANCH_A }));
  const medicineB = await trusted(() => seedMedicine(db, { branchId: ids.BRANCH_B }));

  const alias = await as(ids.OWNER_A, () =>
    query(
      db,
      `insert into pharmacy_medicine_aliases (branch_id, medicine_id, alias)
       values ($1, $2, 'Local Paracetamol')
       returning *`,
      [ids.BRANCH_A, medicineA.medicineId],
    ),
  );
  expectOk(alias, 'an owner can add a tenant-local alias');

  const crossBranchAlias = await as(ids.OWNER_A, () =>
    query(
      db,
      `insert into pharmacy_medicine_aliases (branch_id, medicine_id, alias)
       values ($1, $2, 'Cross-branch alias')
       returning *`,
      [ids.BRANCH_A, medicineB.medicineId],
    ),
  );
  const crossBranchAliasCount = await trustedCount(
    `select count(*)::int as n from pharmacy_medicine_aliases
     where branch_id = $1 and alias = 'Cross-branch alias'`,
    [ids.BRANCH_A],
  );
  check(
    'a local alias cannot point at another branch’s medicine',
    crossBranchAlias.ok === false && crossBranchAliasCount === 0,
    crossBranchAlias.ok ? 'cross-branch alias inserted' : crossBranchAlias.err,
  );

  const assistantAlias = await as(ids.ASSISTANT_A, () =>
    query(
      db,
      `insert into pharmacy_medicine_aliases (branch_id, medicine_id, alias)
       values ($1, $2, 'Attendant Alias')
       returning *`,
      [ids.BRANCH_A, medicineA.medicineId],
    ),
  );
  const aliasCount = await trustedCount(
    `select count(*)::int as n from pharmacy_medicine_aliases where branch_id = $1`,
    [ids.BRANCH_A],
  );
  check(
    'an attendant cannot add a tenant-local alias',
    assistantAlias.ok === false && aliasCount === 1,
    assistantAlias.ok ? 'alias inserted' : assistantAlias.err,
  );

  const aliasReadB = await as(ids.OWNER_B, () =>
    query(
      db,
      `select count(*)::int as n from pharmacy_medicine_aliases where branch_id = $1`,
      [ids.BRANCH_A],
    ),
  );
  check(
    'local aliases are not readable across branches',
    aliasReadB.ok === true && aliasReadB.value[0].n === 0,
    aliasReadB.ok ? '' : aliasReadB.err,
  );

  const medicineBAfter = await trustedRow(
    `select catalogue_product_id from medicines where id = $1`,
    [medicineB.medicineId],
  );
  check(
    'linking branch A’s medicine did not change branch B’s record',
    medicineBAfter.catalogue_product_id === null,
  );

  const costRead = await as(ids.ASSISTANT_A, () =>
    query(db, `select cost_per_base_unit from medicines where id = $1`, [medicineA.medicineId]),
  );
  check(
    'the new link did not widen the withheld cost column',
    costRead.ok === false,
    costRead.ok ? 'assistant read cost' : costRead.err,
  );

  const starRead = await as(ids.ASSISTANT_A, () =>
    query(db, `select * from medicines where id = $1`, [medicineA.medicineId]),
  );
  check(
    'select * still fails for an attendant because cost is withheld',
    starRead.ok === false,
    starRead.ok ? 'assistant read every column' : starRead.err,
  );

  const linkRead = await as(ids.ASSISTANT_A, () =>
    query(db, `select catalogue_product_id from medicines where id = $1`, [medicineA.medicineId]),
  );
  check(
    'the new link column is readable by staff',
    linkRead.ok === true && linkRead.value.length === 1,
    linkRead.ok ? '' : linkRead.err,
  );

  const batches = await trustedCount(
    `select count(*)::int as n from medicine_batches where medicine_id = $1`,
    [medicineA.medicineId],
  );
  check('linking a clinical product leaves the stock batch intact', batches === 1);
}

note('Shared verified records are global by design; drafts, archives and the');
note('reviewer trail are branch/reviewer scoped. Local aliases and stock links');
note('remain tenant-scoped. Registration verification is separate from clinical review.');

process.exit(await finish(db));
