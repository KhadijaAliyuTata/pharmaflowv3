-- ============================================================================
-- Medicine Knowledge Base: shared clinical catalogue + tenant-scoped records
-- ============================================================================
--
-- ## Why this is a new domain rather than more columns on `medicines`
--
-- `medicines` is a per-branch stock record. It holds identity, clinical text,
-- pricing, batches and a safety lock, and every row is scoped by
-- `branch_id = pf_current_branch()`. A shared medicine reference cannot live
-- there: two pharmacies must be able to read the same clinical record without
-- either of them owning it, and adding a medicine for one pharmacy must never
-- change another pharmacy's inventory.
--
-- So this migration adds two separate things:
--
--   * a GLOBAL, centrally managed catalogue (`medicine_products` and its
--     children) that contains identity, ingredients and clinical content;
--   * a TENANT-scoped submission/alias layer (`medicine_submissions`,
--     `pharmacy_medicine_aliases`) and a nullable link from the existing
--     `medicines` row to a shared product.
--
-- Stock, price, batches, expiry and POS stay exactly where they are. The link
-- is `medicines.catalogue_product_id`, nullable, and it is the only change to
-- the existing inventory table.
--
-- ## What this migration deliberately does NOT do
--
--   * It does not import any records. The importer and its data arrive in a
--     later phase; no invented medicine, NAFDAC number or clinical claim is
--     written here.
--   * It does not add a third `staff_role`. The smallest safe reviewer
--     extension is the `branch_memberships.can_review_clinical` capability,
--     with owners implicitly able to review. That avoids touching every
--     `role === 'assistant'` branch in the app while still giving a pharmacist
--     a real, database-enforced permission.
--   * It does not relax any existing grant or policy. Cost remains withheld;
--     the existing `medicines` policies are unchanged. The only new linkage
--     column is guarded so an attendant cannot relink a product.
--
-- ## Verification is two separate facts
--
-- `nafdac_registration_status` answers "is the product registration confirmed
-- against a regulator?" `clinical_review_status` answers "has an authorised
-- reviewer checked this record?" A product can be registration-verified while
-- its clinical sections are `not_verified`, and the UI must show both.
--
-- Every verified clinical section and dosage requires a source. Every verified
-- product requires at least one source and a named reviewer. Those are database
-- constraints, not UI conventions.
--
-- ## Idempotency
--
-- Every object is created with `if not exists` / `create or replace` / a
-- preceding `drop ... if exists`, so the migration is safe to re-run. The
-- verification chain applies every file twice and this file must survive that.
-- ============================================================================

-- ---------------------------------------------------------------- enum types

do $$ begin
  create type medicine_verification_status as enum
    ('draft', 'pending_review', 'verified', 'rejected', 'outdated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type medicine_registration_status as enum
    ('unverified', 'pending', 'verified', 'mismatch', 'not_applicable');
exception when duplicate_object then null; end $$;

do $$ begin
  create type clinical_section_status as enum
    ('not_established', 'not_verified', 'verified', 'not_applicable');
exception when duplicate_object then null; end $$;

do $$ begin
  create type clinical_section as enum (
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
    'professional_assessment'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type medicine_source_type as enum
    ('product_label', 'regulator', 'guideline', 'reference', 'manufacturer', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type medicine_food_instruction as enum
    ('with_food', 'before_food', 'after_food', 'without_regard_to_food',
     'not_established', 'not_applicable');
exception when duplicate_object then null; end $$;

do $$ begin
  create type medicine_submission_status as enum
    ('draft', 'submitted', 'under_review', 'accepted', 'rejected', 'withdrawn');
exception when duplicate_object then null; end $$;

do $$ begin
  create type medicine_import_status as enum
    ('pending', 'valid', 'duplicate', 'rejected', 'imported', 'needs_review');
exception when duplicate_object then null; end $$;

do $$ begin
  create type medicine_alias_type as enum
    ('brand', 'synonym', 'common_name', 'misspelling');
exception when duplicate_object then null; end $$;

-- ============================================================ reviewer capability
--
-- Owners already review implicitly (`pf_is_owner()`). A non-owner pharmacist is
-- granted this capability per branch by an owner. The capability is read from
-- `branch_memberships`, the authoritative role table, never from `profiles.role`.

alter table branch_memberships
  add column if not exists can_review_clinical boolean not null default false;

comment on column branch_memberships.can_review_clinical is
  'Per-branch capability: may review and publish shared medicine clinical '
  'content. Owners are reviewers implicitly; this flag is for non-owner '
  'pharmacists. Only an owner may change it.';

create or replace function pf_can_review_clinical()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    pf_is_platform_admin()
    or pf_is_owner()
    or exists (
      select 1
      from branch_memberships bm
      where bm.user_id = auth.uid()
        and bm.branch_id = pf_current_branch()
        and bm.can_review_clinical
    ),
    false
  );
$$;

comment on function pf_can_review_clinical() is
  'True when the caller may review shared clinical content: a platform admin, '
  'an owner, or a member of the active branch with can_review_clinical.';

create or replace function pf_can_review_submission(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    pf_is_platform_admin()
    or (p_branch_id = pf_current_branch() and pf_can_review_clinical()),
    false
  );
$$;

comment on function pf_can_review_submission(uuid) is
  'True for a reviewer of the submitting branch, or a platform admin. A '
  'reviewer in another branch cannot review this branch''s submissions.';

-- Only an owner may grant or revoke the reviewer capability. The membership
-- policy already requires `pf_is_owner()` for writes; this trigger is the
-- column-level guard RLS cannot express.
create or replace function pf_guard_reviewer_capability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.can_review_clinical is distinct from old.can_review_clinical
     and auth.uid() is not null
     and not pf_is_owner() then
    raise exception 'Only an owner can grant or revoke clinical review permission'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists memberships_guard_reviewer_capability on branch_memberships;
create trigger memberships_guard_reviewer_capability
  before update on branch_memberships
  for each row execute function pf_guard_reviewer_capability();

-- ============================================================ shared catalogue

-- ---------------------------------------------------------------- products

create table if not exists medicine_products (
  id                             uuid primary key default gen_random_uuid(),

  -- Exact-duplicate guard. Reconciled by `pf_set_medicine_product_identity`.
  identity_key                   text not null,

  generic_name                   text not null,
  brand_name                     text,
  product_name                   text not null,
  strength_text                  text not null default '',
  dosage_form                    text not null default '',
  route                          text not null default '',
  pack_size                      text,

  manufacturer                   text,
  marketing_authorisation_holder text,

  -- Registration verification is independent of clinical review.
  nafdac_reg_number              text,
  nafdac_registration_status     medicine_registration_status not null default 'unverified',
  nafdac_verified_at             timestamptz,

  category                       text not null default '',
  -- No default. A shared clinical record must state its supply class explicitly;
  -- an importer or API caller must not inherit OTC by omission.
  prescription_class             prescription_class not null,
  is_combination                 boolean not null default false,

  -- Brand -> generic, or a combination's parent. Self-reference is deliberate.
  generic_product_id             uuid references medicine_products(id) on delete set null,

  clinical_review_status         medicine_verification_status not null default 'draft',
  clinical_reviewed_by           uuid references profiles(id) on delete set null,
  clinical_reviewed_at           timestamptz,
  last_clinical_review_date      date,
  version                        integer not null default 1 check (version > 0),

  archived_at                    timestamptz,
  archived_by                    uuid references profiles(id) on delete set null,
  archive_reason                 text,

  created_by                     uuid references profiles(id) on delete set null,
  updated_by                     uuid references profiles(id) on delete set null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),

  constraint medicine_products_identity_unique unique (identity_key),
  constraint medicine_products_generic_not_blank
    check (length(btrim(generic_name)) > 0),
  constraint medicine_products_name_not_blank
    check (length(btrim(product_name)) > 0)
);

create index if not exists medicine_products_generic_idx
  on medicine_products (lower(generic_name));
create index if not exists medicine_products_brand_idx
  on medicine_products (lower(brand_name)) where brand_name is not null;
create index if not exists medicine_products_nafdac_idx
  on medicine_products (nafdac_reg_number) where nafdac_reg_number is not null;
create index if not exists medicine_products_status_idx
  on medicine_products (clinical_review_status, archived_at);
create index if not exists medicine_products_registration_idx
  on medicine_products (nafdac_registration_status);
create index if not exists medicine_products_search_fts_idx
  on medicine_products using gin (
    to_tsvector(
      'english',
      coalesce(product_name, '') || ' ' ||
      coalesce(generic_name, '') || ' ' ||
      coalesce(brand_name, '')
    )
  );

-- ---------------------------------------------------------------- ingredients

create table if not exists medicine_ingredients (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references medicine_products(id) on delete cascade,
  ingredient_name text not null,
  strength_value  numeric(14,4),
  strength_unit   text,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);

create unique index if not exists medicine_ingredients_unique_idx
  on medicine_ingredients (
    product_id,
    lower(btrim(ingredient_name)),
    coalesce(strength_value, -1),
    coalesce(lower(btrim(strength_unit)), '')
  );
create index if not exists medicine_ingredients_product_idx
  on medicine_ingredients (product_id);
create index if not exists medicine_ingredients_name_idx
  on medicine_ingredients (lower(ingredient_name));

-- ---------------------------------------------------------------- sources

create table if not exists medicine_sources (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid references medicine_products(id) on delete cascade,
  section            clinical_section,
  source_type        medicine_source_type not null default 'other',
  title              text not null,
  publisher          text,
  url                text,
  document_reference text,
  retrieved_at       date not null,
  -- Client-local reference used to link sections/dosages in a submission.
  source_ref         text,
  notes              text,
  created_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint medicine_sources_title_not_blank
    check (length(btrim(title)) > 0),
  constraint medicine_sources_has_reference
    check (
      length(btrim(coalesce(url, ''))) > 0
      or length(btrim(coalesce(document_reference, ''))) > 0
    )
);

create unique index if not exists medicine_sources_product_ref_idx
  on medicine_sources (product_id, source_ref)
  where source_ref is not null;
create index if not exists medicine_sources_product_idx
  on medicine_sources (product_id);
create index if not exists medicine_sources_type_idx
  on medicine_sources (source_type);

-- ---------------------------------------------------------------- sections

create table if not exists medicine_clinical_sections (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references medicine_products(id) on delete cascade,
  section           clinical_section not null,
  content           text not null default '',
  status            clinical_section_status not null default 'not_verified',
  food_instruction  medicine_food_instruction,
  source_id         uuid references medicine_sources(id) on delete set null,
  retrieved_at      date,
  last_reviewed_at  date,
  reviewed_by       uuid references profiles(id) on delete set null,
  version           integer not null default 1 check (version > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint medicine_clinical_sections_unique unique (product_id, section),
  constraint medicine_clinical_sections_verified_has_content
    check (status <> 'verified' or length(btrim(content)) > 0),
  constraint medicine_clinical_sections_food_only
    check (section = 'food' or food_instruction is null)
);

create index if not exists medicine_clinical_sections_product_idx
  on medicine_clinical_sections (product_id);
create index if not exists medicine_clinical_sections_status_idx
  on medicine_clinical_sections (status);

-- ---------------------------------------------------------------- dosages

create table if not exists medicine_dosages (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references medicine_products(id) on delete cascade,
  population        text not null,
  indication        text,
  route             text,
  dose_text         text,
  frequency         text,
  duration          text,
  max_dose          text,
  notes             text,
  status            clinical_section_status not null default 'not_verified',
  source_id         uuid references medicine_sources(id) on delete set null,
  retrieved_at      date,
  last_reviewed_at  date,
  reviewed_by       uuid references profiles(id) on delete set null,
  version           integer not null default 1 check (version > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint medicine_dosages_population_check
    check (population in (
      'adult', 'paediatric', 'older_adult', 'pregnancy', 'breastfeeding',
      'renal_impairment', 'hepatic_impairment', 'other'
    )),
  constraint medicine_dosages_verified_has_dose
    check (status <> 'verified' or length(btrim(coalesce(dose_text, ''))) > 0)
);

create index if not exists medicine_dosages_product_idx
  on medicine_dosages (product_id);
create index if not exists medicine_dosages_population_idx
  on medicine_dosages (population);

-- ---------------------------------------------------------------- aliases

create table if not exists medicine_product_aliases (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references medicine_products(id) on delete cascade,
  alias      text not null,
  alias_type medicine_alias_type not null default 'synonym',
  source_id  uuid references medicine_sources(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint medicine_product_aliases_not_blank
    check (length(btrim(alias)) > 0)
);

create unique index if not exists medicine_product_aliases_unique_idx
  on medicine_product_aliases (product_id, lower(btrim(alias)));
create index if not exists medicine_product_aliases_alias_idx
  on medicine_product_aliases (lower(alias));

-- ------------------------------------------------- import source identity map
--
-- Idempotency across import runs. A `(source_name, external_id)` pair can point
-- at exactly one product; re-running an import cannot create a second one.

create table if not exists medicine_source_records (
  source_name  text not null,
  external_id  text not null,
  product_id   uuid not null references medicine_products(id) on delete restrict,
  source_hash  text not null,
  imported_at  timestamptz not null default now(),
  primary key (source_name, external_id)
);

create index if not exists medicine_source_records_product_idx
  on medicine_source_records (product_id);

-- ---------------------------------------------------------------- revisions

create table if not exists medicine_product_revisions (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references medicine_products(id) on delete restrict,
  version       integer not null check (version > 0),
  snapshot      jsonb not null,
  changed_by    uuid references profiles(id) on delete set null,
  changed_at    timestamptz not null default now(),
  change_reason text,

  constraint medicine_product_revisions_unique unique (product_id, version)
);

create index if not exists medicine_product_revisions_product_idx
  on medicine_product_revisions (product_id, version desc);

-- ---------------------------------------------------------------- submissions
--
-- Tenant-scoped. An owner (or reviewer) submits a missing product or a
-- correction. Nothing here is published to the shared catalogue until a
-- reviewer accepts it through `pf_accept_medicine_submission`.

create table if not exists medicine_submissions (
  id                          uuid primary key default gen_random_uuid(),
  branch_id                   uuid not null references branches(id) on delete cascade,
  submitted_by                uuid not null references profiles(id) on delete restrict,
  status                      medicine_submission_status not null default 'draft',

  -- Optional link to an existing product (a correction/suggestion) rather
  -- than a new product.
  product_id                  uuid references medicine_products(id) on delete set null,

  generic_name                text,
  brand_name                  text,
  product_name                text,
  strength_text               text,
  dosage_form                 text,
  route                        text,
  pack_size                   text,
  manufacturer                text,
  marketing_authorisation_holder text,
  nafdac_reg_number           text,
  category                    text,
  prescription_class          prescription_class,

  -- One top-level source plus any structured sources in `clinical_payload`.
  source_type                 medicine_source_type,
  source_title                text,
  source_url                  text,
  source_document_reference   text,
  source_retrieved_at         date,

  -- Optional clinical content supplied by the submitter. Shape:
  -- { ingredients: [...], sources: [...], sections: [...], dosages: [...] }
  clinical_payload            jsonb not null default '{}'::jsonb,
  notes                       text,

  submitted_at                timestamptz,
  reviewed_by                 uuid references profiles(id) on delete set null,
  reviewed_at                 timestamptz,
  review_reason               text,
  accepted_product_id         uuid references medicine_products(id) on delete set null,
  withdrawn_at                timestamptz,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- A draft may be incomplete. Anything submitted or decided must have the
  -- identity fields a shared product requires.
  constraint medicine_submissions_identity_when_submitted
    check (
      status = 'draft'
      or (
        length(btrim(coalesce(generic_name, ''))) > 0
        and length(btrim(coalesce(product_name, ''))) > 0
      )
    )
);

create index if not exists medicine_submissions_branch_idx
  on medicine_submissions (branch_id, status, created_at desc);
create index if not exists medicine_submissions_submitter_idx
  on medicine_submissions (submitted_by, created_at desc);
create index if not exists medicine_submissions_product_idx
  on medicine_submissions (product_id) where product_id is not null;

-- ---------------------------------------------------------------- catalogue audit
--
-- Global. `audit_events` cannot hold these rows: its `branch_id` is NOT NULL and
-- a shared catalogue record has no branch. Keeping the two trails separate also
-- means a branch owner can never read the global reviewer trail by accident.

create table if not exists medicine_catalogue_audit (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid references medicine_products(id) on delete set null,
  submission_id uuid references medicine_submissions(id) on delete set null,
  actor_id      uuid references profiles(id) on delete set null,
  action        text not null,
  from_status   text,
  to_status     text,
  description   text not null default '',
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists medicine_catalogue_audit_product_idx
  on medicine_catalogue_audit (product_id, created_at desc);
create index if not exists medicine_catalogue_audit_submission_idx
  on medicine_catalogue_audit (submission_id, created_at desc);
create index if not exists medicine_catalogue_audit_actor_idx
  on medicine_catalogue_audit (actor_id, created_at desc);

-- ---------------------------------------------------------------- import staging
--
-- Service-role only. The importer validates into these tables; no browser role
-- has a grant or policy on them.

create table if not exists medicine_import_batches (
  id                  uuid primary key default gen_random_uuid(),
  source_name         text not null,
  source_url          text,
  source_retrieved_at date,
  file_name           text,
  imported_by         uuid references profiles(id) on delete set null,
  status              text not null default 'pending'
                      check (status in ('pending', 'running', 'completed', 'failed')),
  total_rows          integer not null default 0,
  valid_rows          integer not null default 0,
  duplicate_rows      integer not null default 0,
  rejected_rows       integer not null default 0,
  imported_rows       integer not null default 0,
  -- Licensing is reviewable alongside the data. A batch that cannot name its
  -- terms is not importable, even if the rows themselves are well formed.
  source_license      text,
  source_terms_url    text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

-- Idempotent upgrade for databases that already created the staging table
-- before the licensing columns were added.
alter table medicine_import_batches
  add column if not exists source_license text;
alter table medicine_import_batches
  add column if not exists source_terms_url text;

create table if not exists medicine_import_rows (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references medicine_import_batches(id) on delete cascade,
  external_id text not null,
  source_hash text not null,
  raw         jsonb not null,
  normalized  jsonb,
  identity_key text,
  status      medicine_import_status not null default 'pending',
  reason      text,
  product_id  uuid references medicine_products(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint medicine_import_rows_unique unique (batch_id, external_id)
);

create index if not exists medicine_import_rows_batch_idx
  on medicine_import_rows (batch_id, status);
create index if not exists medicine_import_rows_identity_idx
  on medicine_import_rows (identity_key) where identity_key is not null;

-- ---------------------------------------------------------------- tenant aliases

create table if not exists pharmacy_medicine_aliases (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id) on delete cascade,
  medicine_id uuid not null references medicines(id) on delete cascade,
  alias      text not null,
  alias_type medicine_alias_type not null default 'synonym',
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint pharmacy_medicine_aliases_not_blank
    check (length(btrim(alias)) > 0)
);

create unique index if not exists pharmacy_medicine_aliases_unique_idx
  on pharmacy_medicine_aliases (branch_id, medicine_id, lower(btrim(alias)));
create index if not exists pharmacy_medicine_aliases_branch_idx
  on pharmacy_medicine_aliases (branch_id, medicine_id);

-- The only change to the existing inventory table: a nullable link to the
-- shared clinical record. Stock and price are untouched.
alter table medicines
  add column if not exists catalogue_product_id uuid
  references medicine_products(id) on delete set null;

create index if not exists medicines_catalogue_product_idx
  on medicines (catalogue_product_id)
  where catalogue_product_id is not null;

-- ============================================================ trigger functions

-- Normalise the identity fields into an exact-duplicate key. Fuzzy matching is
-- `pf_medicine_duplicate_candidates`; this is the hard unique constraint.
create or replace function pf_medicine_identity_key(
  p_generic_name text,
  p_strength     text,
  p_dosage_form  text,
  p_route        text,
  p_brand_name   text,
  p_manufacturer text,
  p_nafdac       text
)
returns text
language sql
stable
as $$
  select trim(both '-' from lower(
    regexp_replace(
      concat_ws(
        '|',
        coalesce(p_generic_name, ''),
        coalesce(p_strength, ''),
        coalesce(p_dosage_form, ''),
        coalesce(p_route, ''),
        coalesce(p_brand_name, ''),
        coalesce(p_manufacturer, ''),
        coalesce(p_nafdac, '')
      ),
      '[^a-zA-Z0-9]+',
      '-',
      'g'
    )
  ));
$$;

create or replace function pf_set_medicine_product_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.identity_key := pf_medicine_identity_key(
    new.generic_name,
    new.strength_text,
    new.dosage_form,
    new.route,
    new.brand_name,
    new.manufacturer,
    new.nafdac_reg_number
  );
  return new;
end;
$$;

create or replace function pf_bump_medicine_product_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  elsif tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end;
$$;

-- A product cannot claim clinical verification without a named reviewer and at
-- least one source. The acceptance RPC inserts the product as `pending_review`,
-- adds its sources, and only then moves it to `verified`.
create or replace function pf_guard_medicine_product_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.clinical_review_status = 'verified' then
    if new.clinical_reviewed_by is null then
      raise exception 'A verified medicine product needs a named reviewer'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from medicine_sources s where s.product_id = new.id
    ) then
      raise exception 'A verified medicine product needs at least one source'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Registration verification is a separate claim from clinical verification.
  -- A reviewer may not mark a product as registered without a registration
  -- number and a regulator source for that product. The review RPC performs the
  -- same check; this trigger closes the direct-update path.
  if new.nafdac_registration_status = 'verified' then
    if length(btrim(coalesce(new.nafdac_reg_number, ''))) = 0 then
      raise exception 'A verified NAFDAC registration needs a registration number'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from medicine_sources s
      where s.product_id = new.id and s.source_type = 'regulator'
    ) then
      raise exception 'A verified NAFDAC registration needs a regulator source'
        using errcode = 'check_violation';
    end if;
    new.nafdac_verified_at := coalesce(new.nafdac_verified_at, now());
  else
    new.nafdac_verified_at := null;
  end if;

  return new;
end;
$$;

-- Full snapshot used by the revision trail. It runs as definer so it can read
-- child rows regardless of the caller's SELECT policies.
create or replace function pf_medicine_product_snapshot(p_product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'product', to_jsonb(p),
    'ingredients', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.sort_order, i.ingredient_name)
      from medicine_ingredients i where i.product_id = p.id
    ), '[]'::jsonb),
    'sections', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.section)
      from medicine_clinical_sections s where s.product_id = p.id
    ), '[]'::jsonb),
    'dosages', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.population, d.indication)
      from medicine_dosages d where d.product_id = p.id
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(to_jsonb(src) order by src.retrieved_at desc, src.title)
      from medicine_sources src where src.product_id = p.id
    ), '[]'::jsonb),
    'aliases', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.alias)
      from medicine_product_aliases a where a.product_id = p.id
    ), '[]'::jsonb)
  )
  from medicine_products p
  where p.id = p_product_id;
$$;

create or replace function pf_log_medicine_product_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into medicine_product_revisions (
    product_id, version, snapshot, changed_by, change_reason
  ) values (
    new.id,
    new.version,
    pf_medicine_product_snapshot(new.id),
    coalesce(auth.uid(), new.updated_by),
    nullif(current_setting('pf.medicine_change_reason', true), '')
  );
  return new;
end;
$$;

create or replace function pf_audit_medicine_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'product_created';
  elsif new.clinical_review_status is distinct from old.clinical_review_status then
    v_action := 'product_status_changed';
  else
    v_action := 'product_updated';
  end if;

  insert into medicine_catalogue_audit (
    product_id, actor_id, action, from_status, to_status, description, metadata
  ) values (
    new.id,
    auth.uid(),
    v_action,
    case when tg_op = 'UPDATE' then old.clinical_review_status::text else null end,
    new.clinical_review_status::text,
    v_action,
    jsonb_build_object('version', new.version)
  );
  return new;
end;
$$;

create or replace function pf_audit_medicine_child()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_action text;
  v_payload jsonb;
begin
  if tg_op = 'DELETE' then
    v_product_id := old.product_id;
    v_payload := to_jsonb(old);
  else
    v_product_id := new.product_id;
    v_payload := to_jsonb(new);
  end if;

  v_action := lower(tg_table_name) || '_' || lower(tg_op);

  insert into medicine_catalogue_audit (
    product_id, actor_id, action, description, metadata
  ) values (
    v_product_id,
    auth.uid(),
    v_action,
    v_action,
    jsonb_build_object('row', v_payload)
  );
  return coalesce(new, old);
end;
$$;

create or replace function pf_guard_clinical_section_source()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'verified'
     and (new.source_id is null
          or new.reviewed_by is null
          or new.last_reviewed_at is null) then
    raise exception 'A verified clinical section needs a source, a reviewer and a review date'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function pf_guard_dosage_source()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'verified'
     and (new.source_id is null
          or new.reviewed_by is null
          or new.last_reviewed_at is null) then
    raise exception 'A verified dosage needs a source, a reviewer and a review date'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function pf_guard_medicine_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null
       and not (pf_is_owner() or pf_can_review_clinical()) then
      raise exception 'Only an owner or clinical reviewer can add a medicine submission'
        using errcode = 'insufficient_privilege';
    end if;

    new.branch_id := coalesce(pf_current_branch(), new.branch_id);
    new.submitted_by := coalesce(auth.uid(), new.submitted_by);

    if new.status not in ('draft', 'submitted') then
      raise exception 'A new submission must be a draft or submitted for review'
        using errcode = 'check_violation';
    end if;
    if new.status = 'submitted' then
      new.submitted_at := coalesce(new.submitted_at, now());
    end if;
    return new;
  end if;

  -- Trusted server context (migrations, service_role, fixture bootstrap).
  if auth.uid() is null then
    return new;
  end if;

  -- The tenant and the author are immutable once a submission exists. A reviewer
  -- may change the workflow state and the reviewed payload; neither an owner nor
  -- a reviewer may rewrite who submitted it or move it to another pharmacy.
  new.branch_id := old.branch_id;
  new.submitted_by := old.submitted_by;

  -- A reviewer may record a decision. An owner is also a reviewer, so this
  -- branch must still stamp the ordinary submission/withdrawal timestamps when
  -- the owner is the person submitting their own draft.
  if pf_can_review_submission(old.branch_id) then
    if new.status in ('under_review', 'accepted', 'rejected')
       and old.reviewed_by is null then
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
    if new.status = 'submitted' and old.status in ('draft', 'withdrawn') then
      new.submitted_at := coalesce(new.submitted_at, now());
    end if;
    if new.status = 'withdrawn' and old.status <> 'withdrawn' then
      new.withdrawn_at := coalesce(new.withdrawn_at, now());
    end if;
    if new.status = 'accepted' and new.accepted_product_id is null then
      raise exception 'A submission must be accepted through pf_accept_medicine_submission so a reviewed product exists'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- A non-reviewer may only edit their own draft, or withdraw a submitted one.
  if old.submitted_by <> auth.uid() then
    raise exception 'Only the submitter or a clinical reviewer can edit this submission'
      using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'submitted' and new.status = 'withdrawn' then
    new.withdrawn_at := coalesce(new.withdrawn_at, now());
    return new;
  end if;

  if old.status = 'withdrawn' and new.status = 'draft' then
    return new;
  end if;

  if old.status <> 'draft' then
    raise exception 'Only a draft submission can be edited'
      using errcode = 'insufficient_privilege';
  end if;

  if new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.review_reason is distinct from old.review_reason
     or new.accepted_product_id is distinct from old.accepted_product_id then
    raise exception 'Only a clinical reviewer can record a review decision'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status not in ('draft', 'submitted', 'withdrawn') then
    raise exception 'A submitter cannot approve or reject a submission'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'submitted' then
    new.submitted_at := coalesce(new.submitted_at, now());
  end if;
  if new.status = 'withdrawn' then
    new.withdrawn_at := coalesce(new.withdrawn_at, now());
  end if;

  return new;
end;
$$;

create or replace function pf_audit_medicine_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'submission_created';
  elsif new.status is distinct from old.status then
    v_action := 'submission_status_changed';
  else
    v_action := 'submission_updated';
  end if;

  insert into medicine_catalogue_audit (
    product_id, submission_id, actor_id, action, from_status, to_status,
    description, metadata
  ) values (
    coalesce(new.accepted_product_id, new.product_id),
    new.id,
    auth.uid(),
    v_action,
    case when tg_op = 'UPDATE' then old.status::text else null end,
    new.status::text,
    v_action,
    jsonb_build_object('branch_id', new.branch_id)
  );
  return new;
end;
$$;

-- The existing `medicines` table is staff-writable. Linking a row to a shared
-- clinical product is a owner/reviewer action, not an attendant one.
create or replace function pf_guard_pharmacy_medicine_alias()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;

  if not exists (
    select 1
    from medicines m
    where m.id = new.medicine_id
      and m.branch_id = new.branch_id
  ) then
    raise exception 'A local alias must point at a medicine in the same branch'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create or replace function pf_guard_medicine_catalogue_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.catalogue_product_id is not null
       and auth.uid() is not null
       and not (pf_is_owner() or pf_can_review_clinical()) then
      raise exception 'Only an owner or clinical reviewer can link a product to the shared catalogue'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.catalogue_product_id is distinct from old.catalogue_product_id
        and auth.uid() is not null
        and not (pf_is_owner() or pf_can_review_clinical()) then
    raise exception 'Only an owner or clinical reviewer can link a product to the shared catalogue'
      using errcode = 'insufficient_privilege';
  end if;

  if new.catalogue_product_id is not null
     and not exists (
       select 1
       from medicine_products p
       where p.id = new.catalogue_product_id
         and (
           p.clinical_review_status in ('verified', 'outdated')
           or pf_can_review_clinical()
         )
     ) then
    raise exception 'The linked clinical product is not available to this pharmacy'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ============================================================ triggers

drop trigger if exists medicine_products_identity on medicine_products;
create trigger medicine_products_identity
  before insert or update of
    generic_name, strength_text, dosage_form, route, brand_name, manufacturer,
    nafdac_reg_number
  on medicine_products
  for each row execute function pf_set_medicine_product_identity();

drop trigger if exists medicine_products_version on medicine_products;
create trigger medicine_products_version
  before insert or update on medicine_products
  for each row execute function pf_bump_medicine_product_version();

drop trigger if exists medicine_products_verification_guard on medicine_products;
create trigger medicine_products_verification_guard
  before insert or update on medicine_products
  for each row execute function pf_guard_medicine_product_verification();

drop trigger if exists medicine_products_revision on medicine_products;
create trigger medicine_products_revision
  after insert or update on medicine_products
  for each row execute function pf_log_medicine_product_revision();

drop trigger if exists medicine_products_audit on medicine_products;
create trigger medicine_products_audit
  after insert or update on medicine_products
  for each row execute function pf_audit_medicine_product();

drop trigger if exists medicine_ingredients_audit on medicine_ingredients;
create trigger medicine_ingredients_audit
  after insert or update or delete on medicine_ingredients
  for each row execute function pf_audit_medicine_child();

drop trigger if exists medicine_clinical_sections_touch on medicine_clinical_sections;
create trigger medicine_clinical_sections_touch
  before update on medicine_clinical_sections
  for each row execute function pf_touch_updated_at();

drop trigger if exists medicine_clinical_sections_guard on medicine_clinical_sections;
create trigger medicine_clinical_sections_guard
  before insert or update on medicine_clinical_sections
  for each row execute function pf_guard_clinical_section_source();

drop trigger if exists medicine_clinical_sections_audit on medicine_clinical_sections;
create trigger medicine_clinical_sections_audit
  after insert or update or delete on medicine_clinical_sections
  for each row execute function pf_audit_medicine_child();

drop trigger if exists medicine_dosages_touch on medicine_dosages;
create trigger medicine_dosages_touch
  before update on medicine_dosages
  for each row execute function pf_touch_updated_at();

drop trigger if exists medicine_dosages_guard on medicine_dosages;
create trigger medicine_dosages_guard
  before insert or update on medicine_dosages
  for each row execute function pf_guard_dosage_source();

drop trigger if exists medicine_dosages_audit on medicine_dosages;
create trigger medicine_dosages_audit
  after insert or update or delete on medicine_dosages
  for each row execute function pf_audit_medicine_child();

drop trigger if exists medicine_sources_audit on medicine_sources;
create trigger medicine_sources_audit
  after insert or update or delete on medicine_sources
  for each row execute function pf_audit_medicine_child();

drop trigger if exists medicine_product_aliases_audit on medicine_product_aliases;
create trigger medicine_product_aliases_audit
  after insert or update or delete on medicine_product_aliases
  for each row execute function pf_audit_medicine_child();

drop trigger if exists medicine_submissions_touch on medicine_submissions;
create trigger medicine_submissions_touch
  before update on medicine_submissions
  for each row execute function pf_touch_updated_at();

drop trigger if exists medicine_submissions_guard on medicine_submissions;
create trigger medicine_submissions_guard
  before insert or update on medicine_submissions
  for each row execute function pf_guard_medicine_submission();

drop trigger if exists medicine_submissions_audit on medicine_submissions;
create trigger medicine_submissions_audit
  after insert or update on medicine_submissions
  for each row execute function pf_audit_medicine_submission();

drop trigger if exists medicines_guard_catalogue_link on medicines;
create trigger medicines_guard_catalogue_link
  before insert or update of catalogue_product_id on medicines
  for each row execute function pf_guard_medicine_catalogue_link();

drop trigger if exists pharmacy_medicine_aliases_guard on pharmacy_medicine_aliases;
create trigger pharmacy_medicine_aliases_guard
  before insert or update on pharmacy_medicine_aliases
  for each row execute function pf_guard_pharmacy_medicine_alias();

-- ============================================================ visibility helper

create or replace function pf_can_read_medicine_product(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    exists (
      select 1
      from medicine_products p
      where p.id = p_product_id
        and (
          pf_is_platform_admin()
          or pf_can_review_clinical()
          or (
            pf_is_staff()
            and p.clinical_review_status in ('verified', 'outdated')
            and p.archived_at is null
          )
        )
    ),
    false
  );
$$;

comment on function pf_can_read_medicine_product(uuid) is
  'Verified/outdated shared products are readable by staff. Drafts, rejected '
  'records, archived records and the global audit trail are reviewer-only.';

-- ============================================================ RLS

alter table medicine_products enable row level security;
alter table medicine_ingredients enable row level security;
alter table medicine_sources enable row level security;
alter table medicine_clinical_sections enable row level security;
alter table medicine_dosages enable row level security;
alter table medicine_product_aliases enable row level security;
alter table medicine_source_records enable row level security;
alter table medicine_product_revisions enable row level security;
alter table medicine_submissions enable row level security;
alter table medicine_catalogue_audit enable row level security;
alter table medicine_import_batches enable row level security;
alter table medicine_import_rows enable row level security;
alter table pharmacy_medicine_aliases enable row level security;

-- Products: verified/outdated to staff, everything to reviewers/platform admin.
drop policy if exists medicine_products_read on medicine_products;
create policy medicine_products_read on medicine_products
  for select to authenticated
  using (pf_can_read_medicine_product(id));

drop policy if exists medicine_products_reviewer_all on medicine_products;
create policy medicine_products_reviewer_all on medicine_products
  for all to authenticated
  using (pf_can_review_clinical())
  with check (pf_can_review_clinical());

-- Ingredients.
drop policy if exists medicine_ingredients_read on medicine_ingredients;
create policy medicine_ingredients_read on medicine_ingredients
  for select to authenticated
  using (pf_can_read_medicine_product(product_id));

drop policy if exists medicine_ingredients_reviewer_all on medicine_ingredients;
create policy medicine_ingredients_reviewer_all on medicine_ingredients
  for all to authenticated
  using (pf_can_review_clinical())
  with check (pf_can_review_clinical());

-- Sources. A source with a NULL product is a global reference and is
-- reviewer-only; the reviewer policy covers it.
drop policy if exists medicine_sources_read on medicine_sources;
create policy medicine_sources_read on medicine_sources
  for select to authenticated
  using (product_id is not null and pf_can_read_medicine_product(product_id));

drop policy if exists medicine_sources_reviewer_all on medicine_sources;
create policy medicine_sources_reviewer_all on medicine_sources
  for all to authenticated
  using (pf_can_review_clinical())
  with check (pf_can_review_clinical());

-- Clinical sections.
drop policy if exists medicine_clinical_sections_read on medicine_clinical_sections;
create policy medicine_clinical_sections_read on medicine_clinical_sections
  for select to authenticated
  using (pf_can_read_medicine_product(product_id));

drop policy if exists medicine_clinical_sections_reviewer_all on medicine_clinical_sections;
create policy medicine_clinical_sections_reviewer_all on medicine_clinical_sections
  for all to authenticated
  using (pf_can_review_clinical())
  with check (pf_can_review_clinical());

-- Dosages.
drop policy if exists medicine_dosages_read on medicine_dosages;
create policy medicine_dosages_read on medicine_dosages
  for select to authenticated
  using (pf_can_read_medicine_product(product_id));

drop policy if exists medicine_dosages_reviewer_all on medicine_dosages;
create policy medicine_dosages_reviewer_all on medicine_dosages
  for all to authenticated
  using (pf_can_review_clinical())
  with check (pf_can_review_clinical());

-- Product aliases.
drop policy if exists medicine_product_aliases_read on medicine_product_aliases;
create policy medicine_product_aliases_read on medicine_product_aliases
  for select to authenticated
  using (pf_can_read_medicine_product(product_id));

drop policy if exists medicine_product_aliases_reviewer_all on medicine_product_aliases;
create policy medicine_product_aliases_reviewer_all on medicine_product_aliases
  for all to authenticated
  using (pf_can_review_clinical())
  with check (pf_can_review_clinical());

-- Revisions and global audit are reviewer-only, read-only to clients.
drop policy if exists medicine_product_revisions_read on medicine_product_revisions;
create policy medicine_product_revisions_read on medicine_product_revisions
  for select to authenticated
  using (pf_can_review_clinical());

drop policy if exists medicine_catalogue_audit_read on medicine_catalogue_audit;
create policy medicine_catalogue_audit_read on medicine_catalogue_audit
  for select to authenticated
  using (pf_can_review_clinical());

-- Submissions: the submitter, their owner/reviewer, and platform admins.
drop policy if exists medicine_submissions_read on medicine_submissions;
create policy medicine_submissions_read on medicine_submissions
  for select to authenticated
  using (
    pf_is_platform_admin()
    or (
      branch_id = pf_current_branch()
      and (
        submitted_by = auth.uid()
        or pf_is_owner()
        or pf_can_review_clinical()
      )
    )
  );

drop policy if exists medicine_submissions_insert on medicine_submissions;
create policy medicine_submissions_insert on medicine_submissions
  for insert to authenticated
  with check (
    branch_id = pf_current_branch()
    and submitted_by = auth.uid()
    and (pf_is_owner() or pf_can_review_clinical())
  );

drop policy if exists medicine_submissions_update on medicine_submissions;
create policy medicine_submissions_update on medicine_submissions
  for update to authenticated
  using (
    branch_id = pf_current_branch()
    and (
      submitted_by = auth.uid()
      or pf_is_owner()
      or pf_can_review_clinical()
    )
  )
  with check (branch_id = pf_current_branch());

-- Local, tenant-scoped aliases. Attendants may read; only owners may write.
drop policy if exists pharmacy_medicine_aliases_read on pharmacy_medicine_aliases;
create policy pharmacy_medicine_aliases_read on pharmacy_medicine_aliases
  for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists pharmacy_medicine_aliases_owner_all on pharmacy_medicine_aliases;
create policy pharmacy_medicine_aliases_owner_all on pharmacy_medicine_aliases
  for all to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

-- Import staging and the source identity map are service-role only. RLS is on
-- and the client policies are explicitly deny-all, rather than relying on a
-- missing policy being interpreted as "closed". `service_role` bypasses RLS and
-- is granted the table privileges below.
drop policy if exists medicine_import_batches_service_only on medicine_import_batches;
create policy medicine_import_batches_service_only on medicine_import_batches
  for all to authenticated
  using (false)
  with check (false);

drop policy if exists medicine_import_rows_service_only on medicine_import_rows;
create policy medicine_import_rows_service_only on medicine_import_rows
  for all to authenticated
  using (false)
  with check (false);

drop policy if exists medicine_source_records_service_only on medicine_source_records;
create policy medicine_source_records_service_only on medicine_source_records
  for all to authenticated
  using (false)
  with check (false);

-- ============================================================ grants

revoke all on medicine_products, medicine_ingredients, medicine_sources,
  medicine_clinical_sections, medicine_dosages, medicine_product_aliases,
  medicine_source_records, medicine_product_revisions, medicine_submissions,
  medicine_catalogue_audit, medicine_import_batches, medicine_import_rows,
  pharmacy_medicine_aliases
  from anon;

grant select on
  medicine_products, medicine_ingredients, medicine_sources,
  medicine_clinical_sections, medicine_dosages, medicine_product_aliases
  to authenticated;

grant insert, update on
  medicine_products, medicine_ingredients, medicine_sources,
  medicine_clinical_sections, medicine_dosages, medicine_product_aliases
  to authenticated;

grant select on medicine_product_revisions, medicine_catalogue_audit
  to authenticated;

grant select, insert, update on medicine_submissions to authenticated;

grant select, insert, update, delete on pharmacy_medicine_aliases to authenticated;

-- The new link column is readable and writable by staff, but the trigger above
-- restricts changing it to owners/reviewers. The existing cost column remains
-- outside every grant.
grant select (catalogue_product_id) on medicines to authenticated;
grant insert (catalogue_product_id), update (catalogue_product_id) on medicines to authenticated;

-- Service role is the importer/administrator context. RLS is bypassed by the
-- role, but it still needs table privileges.
grant all on
  medicine_products, medicine_ingredients, medicine_sources,
  medicine_clinical_sections, medicine_dosages, medicine_product_aliases,
  medicine_source_records, medicine_product_revisions, medicine_submissions,
  medicine_catalogue_audit, medicine_import_batches, medicine_import_rows,
  pharmacy_medicine_aliases
  to service_role;

-- ============================================================ search RPC

create or replace function pf_search_medicine_catalogue(
  p_query              text default null,
  p_dosage_form        text default null,
  p_strength           text default null,
  p_route              text default null,
  p_category           text default null,
  p_prescription_class text default null,
  p_verification       text default null,
  p_limit              integer default 25,
  p_offset             integer default 0
)
returns table (
  id                         uuid,
  product_name               text,
  generic_name               text,
  brand_name                 text,
  strength_text              text,
  dosage_form                text,
  route                      text,
  category                   text,
  prescription_class         text,
  nafdac_reg_number          text,
  nafdac_registration_status text,
  clinical_review_status     text,
  last_clinical_review_date  date,
  total_count                bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      coalesce(nullif(btrim(p_query), ''), '') as q,
      nullif(btrim(p_dosage_form), '') as form,
      nullif(btrim(p_strength), '') as strength,
      nullif(btrim(p_route), '') as route,
      nullif(btrim(p_category), '') as category,
      nullif(btrim(p_prescription_class), '') as rx,
      nullif(btrim(p_verification), '') as verification,
      least(greatest(coalesce(p_limit, 25), 1), 100) as lim,
      greatest(coalesce(p_offset, 0), 0) as off
  ),
  matched as (
    select p.*
    from medicine_products p
    cross join params x
    where p.archived_at is null
      and p.clinical_review_status in ('verified', 'outdated')
      and (
        x.verification is null
        or p.clinical_review_status::text = x.verification
      )
      and (x.form is null or lower(p.dosage_form) = lower(x.form))
      and (x.strength is null or strpos(lower(p.strength_text), lower(x.strength)) > 0)
      and (x.route is null or lower(p.route) = lower(x.route))
      and (x.category is null or lower(p.category) = lower(x.category))
      and (x.rx is null or p.prescription_class::text = x.rx)
      and (
        x.q = ''
        or strpos(lower(p.product_name), lower(x.q)) > 0
        or strpos(lower(p.generic_name), lower(x.q)) > 0
        or strpos(lower(coalesce(p.brand_name, '')), lower(x.q)) > 0
        or strpos(lower(coalesce(p.nafdac_reg_number, '')), lower(x.q)) > 0
        or exists (
          select 1 from medicine_ingredients i
          where i.product_id = p.id
            and strpos(lower(i.ingredient_name), lower(x.q)) > 0
        )
        or exists (
          select 1 from medicine_product_aliases a
          where a.product_id = p.id
            and strpos(lower(a.alias), lower(x.q)) > 0
        )
        or to_tsvector(
             'english',
             coalesce(p.product_name, '') || ' ' ||
             coalesce(p.generic_name, '') || ' ' ||
             coalesce(p.brand_name, '')
           ) @@ websearch_to_tsquery('english', x.q)
      )
  )
  select
    m.id,
    m.product_name,
    m.generic_name,
    m.brand_name,
    m.strength_text,
    m.dosage_form,
    m.route,
    m.category,
    m.prescription_class::text,
    m.nafdac_reg_number,
    m.nafdac_registration_status::text,
    m.clinical_review_status::text,
    m.last_clinical_review_date,
    count(*) over() as total_count
  from matched m
  cross join params x
  order by m.product_name, m.id
  limit (select lim from params)
  offset (select off from params);
$$;

comment on function pf_search_medicine_catalogue(
  text, text, text, text, text, text, text, integer, integer
) is
  'Paginated, RLS-scoped search over verified/outdated shared products. The '
  'browser must not fetch the whole catalogue.';

-- ============================================================ duplicate RPC

create or replace function pf_medicine_duplicate_candidates(
  p_generic_name   text,
  p_strength       text default null,
  p_dosage_form    text default null,
  p_route          text default null,
  p_brand_name     text default null,
  p_manufacturer   text default null,
  p_nafdac         text default null,
  p_exclude_id     uuid default null
)
returns table (
  id                         uuid,
  product_name               text,
  generic_name               text,
  brand_name                 text,
  strength_text              text,
  dosage_form                text,
  route                      text,
  manufacturer               text,
  nafdac_reg_number          text,
  clinical_review_status     text,
  match_score                integer
)
language sql
stable
security definer
set search_path = public
as $$
  with needle as (
    select
      pf_medicine_identity_key(
        p_generic_name, p_strength, p_dosage_form, p_route,
        p_brand_name, p_manufacturer, p_nafdac
      ) as identity_key,
      lower(btrim(coalesce(p_generic_name, ''))) as generic,
      lower(btrim(coalesce(p_strength, ''))) as strength,
      lower(btrim(coalesce(p_dosage_form, ''))) as form,
      lower(btrim(coalesce(p_route, ''))) as route,
      lower(btrim(coalesce(p_nafdac, ''))) as nafdac
  )
  select
    p.id,
    p.product_name,
    p.generic_name,
    p.brand_name,
    p.strength_text,
    p.dosage_form,
    p.route,
    p.manufacturer,
    p.nafdac_reg_number,
    p.clinical_review_status::text,
    case
      when p.identity_key = n.identity_key then 100
      when n.nafdac <> ''
       and lower(coalesce(p.nafdac_reg_number, '')) = n.nafdac then 90
      when lower(p.generic_name) = n.generic
       and lower(p.strength_text) = n.strength
       and lower(p.dosage_form) = n.form
       and lower(p.route) = n.route then 80
      when lower(p.generic_name) = n.generic
       and lower(p.strength_text) = n.strength then 60
      when lower(p.generic_name) = n.generic then 40
      else 0
    end as match_score
  from medicine_products p
  cross join needle n
  where p.id <> coalesce(p_exclude_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and (
      p.clinical_review_status in ('verified', 'outdated')
      or pf_can_review_clinical()
    )
    and (
      p.archived_at is null
      or pf_can_review_clinical()
    )
    and (
      p.identity_key = n.identity_key
      or (n.nafdac <> '' and lower(coalesce(p.nafdac_reg_number, '')) = n.nafdac)
      or lower(p.generic_name) = n.generic
    )
  order by match_score desc, p.product_name
  limit 20;
$$;

-- ============================================================ review RPCs

create or replace function pf_set_medicine_product_status(
  p_product_id uuid,
  p_status     medicine_verification_status,
  p_reason     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pf_can_review_clinical() then
    raise exception 'Only an authorised clinical reviewer can change a shared product status'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from medicine_products where id = p_product_id) then
    raise exception 'Product not found' using errcode = 'no_data_found';
  end if;

  if p_status = 'verified' then
    if not exists (select 1 from medicine_sources where product_id = p_product_id) then
      raise exception 'A verified product needs at least one source'
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from medicine_clinical_sections
      where product_id = p_product_id
        and status = 'verified'
        and source_id is null
    ) then
      raise exception 'Every verified clinical section needs a source'
        using errcode = 'check_violation';
    end if;
  end if;

  if p_status in ('rejected', 'outdated')
     and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A rejected or outdated product needs a reason'
      using errcode = 'check_violation';
  end if;

  perform set_config(
    'pf.medicine_change_reason',
    coalesce(nullif(btrim(p_reason), ''), 'Status changed'),
    true
  );

  update medicine_products set
    clinical_review_status = p_status,
    clinical_reviewed_by = case
      when p_status in ('verified', 'rejected', 'outdated') then auth.uid()
      else clinical_reviewed_by
    end,
    clinical_reviewed_at = case
      when p_status in ('verified', 'rejected', 'outdated') then now()
      else clinical_reviewed_at
    end,
    last_clinical_review_date = case
      when p_status = 'verified' then current_date
      else last_clinical_review_date
    end,
    updated_by = auth.uid()
  where id = p_product_id;

  insert into medicine_catalogue_audit (
    product_id, actor_id, action, to_status, description, metadata
  ) values (
    p_product_id,
    auth.uid(),
    'review_status_changed',
    p_status::text,
    'Shared product review status changed',
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

create or replace function pf_set_medicine_registration_status(
  p_product_id uuid,
  p_status     medicine_registration_status,
  p_source_id  uuid default null,
  p_note       text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pf_can_review_clinical() then
    raise exception 'Only an authorised clinical reviewer can change registration status'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from medicine_products where id = p_product_id) then
    raise exception 'Product not found' using errcode = 'no_data_found';
  end if;

  if p_status = 'verified' then
    if not exists (
      select 1 from medicine_products
      where id = p_product_id
        and length(btrim(coalesce(nafdac_reg_number, ''))) > 0
    ) then
      raise exception 'Registration verification needs a NAFDAC registration number'
        using errcode = 'check_violation';
    end if;

    if p_source_id is not null then
      if not exists (
        select 1 from medicine_sources
        where id = p_source_id
          and product_id = p_product_id
          and source_type = 'regulator'
      ) then
        raise exception 'Registration verification needs a regulator source for this product'
          using errcode = 'check_violation';
      end if;
    elsif not exists (
      select 1 from medicine_sources
      where product_id = p_product_id and source_type = 'regulator'
    ) then
      raise exception 'Registration verification needs a regulator source'
        using errcode = 'check_violation';
    end if;
  end if;

  update medicine_products set
    nafdac_registration_status = p_status,
    nafdac_verified_at = case
      when p_status = 'verified' then now()
      else null
    end,
    updated_by = auth.uid()
  where id = p_product_id;

  insert into medicine_catalogue_audit (
    product_id, actor_id, action, description, metadata
  ) values (
    p_product_id,
    auth.uid(),
    'registration_status_changed',
    'NAFDAC registration status changed; clinical review status is separate',
    jsonb_build_object(
      'registration_status', p_status::text,
      'source_id', p_source_id,
      'note', p_note
    )
  );
end;
$$;

create or replace function pf_archive_medicine_product(
  p_product_id uuid,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pf_can_review_clinical() then
    raise exception 'Only an authorised clinical reviewer can archive a shared product'
      using errcode = 'insufficient_privilege';
  end if;

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'An archive reason is required' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from medicine_products where id = p_product_id) then
    raise exception 'Product not found' using errcode = 'no_data_found';
  end if;

  perform set_config('pf.medicine_change_reason', p_reason, true);

  update medicine_products set
    archived_at = coalesce(archived_at, now()),
    archived_by = auth.uid(),
    archive_reason = p_reason,
    updated_by = auth.uid()
  where id = p_product_id;

  insert into medicine_catalogue_audit (
    product_id, actor_id, action, description, metadata
  ) values (
    p_product_id, auth.uid(), 'product_archived', 'Shared product archived',
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

create or replace function pf_restore_medicine_product(
  p_product_id uuid,
  p_reason     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pf_can_review_clinical() then
    raise exception 'Only an authorised clinical reviewer can restore a shared product'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from medicine_products where id = p_product_id) then
    raise exception 'Product not found' using errcode = 'no_data_found';
  end if;

  perform set_config(
    'pf.medicine_change_reason',
    coalesce(nullif(btrim(p_reason), ''), 'Product restored'),
    true
  );

  update medicine_products set
    archived_at = null,
    archived_by = null,
    archive_reason = null,
    updated_by = auth.uid()
  where id = p_product_id;

  insert into medicine_catalogue_audit (
    product_id, actor_id, action, description, metadata
  ) values (
    p_product_id, auth.uid(), 'product_restored', 'Shared product restored',
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

-- Accept a reviewed submission into the shared catalogue.
--
-- The product is created/updated as `pending_review`, its sources and clinical
-- children are written, and only then is it moved to `verified`. That ordering
-- is what lets the verification trigger prove a source exists.
create or replace function pf_accept_medicine_submission(
  p_submission_id uuid,
  p_reason        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s              medicine_submissions;
  v_product_id   uuid;
  v_payload      jsonb;
  v_sources      jsonb;
  v_ingredients  jsonb;
  v_sections     jsonb;
  v_dosages      jsonb;
  v_source_count integer;
begin
  select * into s
  from medicine_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Submission not found' using errcode = 'no_data_found';
  end if;

  if not pf_can_review_submission(s.branch_id) then
    raise exception 'Only a clinical reviewer for this branch can accept this submission'
      using errcode = 'insufficient_privilege';
  end if;

  if s.status not in ('submitted', 'under_review') then
    raise exception 'Submission is not awaiting review' using errcode = 'check_violation';
  end if;

  if length(btrim(coalesce(s.generic_name, ''))) = 0
     or length(btrim(coalesce(s.product_name, ''))) = 0 then
    raise exception 'A submission needs a generic and product name before acceptance'
      using errcode = 'check_violation';
  end if;

  -- An unclassified product must not fall through as OTC. The submission UI
  -- requires the class, but the database is the authority: a direct API call
  -- could otherwise publish a product with a default supply category nobody
  -- reviewed.
  if s.prescription_class is null then
    raise exception 'A submission needs a prescription class before acceptance'
      using errcode = 'check_violation';
  end if;

  v_payload := coalesce(s.clinical_payload, '{}'::jsonb);
  v_sources := coalesce(v_payload -> 'sources', '[]'::jsonb);
  v_ingredients := coalesce(v_payload -> 'ingredients', '[]'::jsonb);
  v_sections := coalesce(v_payload -> 'sections', '[]'::jsonb);
  v_dosages := coalesce(v_payload -> 'dosages', '[]'::jsonb);

  if jsonb_typeof(v_sources) <> 'array'
     or jsonb_typeof(v_ingredients) <> 'array'
     or jsonb_typeof(v_sections) <> 'array'
     or jsonb_typeof(v_dosages) <> 'array' then
    raise exception 'The clinical payload has an invalid shape'
      using errcode = 'check_violation';
  end if;

  if coalesce(s.source_title, '') = ''
     and jsonb_array_length(v_sources) = 0 then
    raise exception 'At least one source is required before a submission can be accepted'
      using errcode = 'check_violation';
  end if;

  if coalesce(s.source_title, '') <> ''
     and coalesce(s.source_url, '') = ''
     and coalesce(s.source_document_reference, '') = '' then
    raise exception 'The primary source needs a URL or document reference'
      using errcode = 'check_violation';
  end if;

  -- Never back-fill a retrieval date at acceptance: today's date is not when
  -- the submitter read the label, and a reviewer cannot verify a date that was
  -- invented by the database.
  if coalesce(s.source_title, '') <> ''
     and s.source_retrieved_at is null then
    raise exception 'The primary source needs the date it was retrieved'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_sources) as x(
      title text, url text, document_reference text, retrieved_at date
    )
    where coalesce(x.title, '') = ''
       or (coalesce(x.url, '') = '' and coalesce(x.document_reference, '') = '')
       or x.retrieved_at is null
  ) then
    raise exception 'Every source needs a title, a retrieval date, and a URL or document reference'
      using errcode = 'check_violation';
  end if;

  if s.product_id is not null then
    if exists (
      select 1 from medicine_products
      where id = s.product_id
        and (
          archived_at is not null
          or clinical_review_status in ('verified', 'outdated')
        )
    ) then
      raise exception 'The linked product is archived or already verified; use the correction workflow instead of a submission'
        using errcode = 'check_violation';
    end if;

    update medicine_products set
      generic_name = s.generic_name,
      brand_name = s.brand_name,
      product_name = s.product_name,
      strength_text = coalesce(s.strength_text, ''),
      dosage_form = coalesce(s.dosage_form, ''),
      route = coalesce(s.route, ''),
      pack_size = s.pack_size,
      manufacturer = s.manufacturer,
      marketing_authorisation_holder = s.marketing_authorisation_holder,
      nafdac_reg_number = s.nafdac_reg_number,
      nafdac_registration_status = case
        when s.nafdac_reg_number is not null then 'pending'::medicine_registration_status
        else 'unverified'::medicine_registration_status
      end,
      category = coalesce(s.category, ''),
      prescription_class = s.prescription_class,
      clinical_review_status = 'pending_review',
      updated_by = auth.uid()
    where id = s.product_id
    returning id into v_product_id;

    if v_product_id is null then
      raise exception 'The linked product no longer exists' using errcode = 'check_violation';
    end if;

    -- The reviewed payload replaces the clinical children. The revision trail
    -- and the child audit trail preserve the prior values.
    delete from medicine_clinical_sections where product_id = v_product_id;
    delete from medicine_dosages where product_id = v_product_id;
    delete from medicine_ingredients where product_id = v_product_id;
    delete from medicine_product_aliases where product_id = v_product_id;
    delete from medicine_sources where product_id = v_product_id;
  else
    -- Reject an exact duplicate with a workflow-level message instead of relying
    -- on the unique constraint to surface a raw 23505. The submitter should link
    -- the submission to the existing product, or a reviewer should correct that
    -- product directly with its revision trail.
    if exists (
      select 1
      from medicine_products p
      where p.identity_key = pf_medicine_identity_key(
        s.generic_name,
        s.strength_text,
        s.dosage_form,
        s.route,
        s.brand_name,
        s.manufacturer,
        s.nafdac_reg_number
      )
    ) then
      raise exception 'A product with this identity already exists; link the submission to it instead'
        using errcode = 'unique_violation';
    end if;

    insert into medicine_products (
      generic_name, brand_name, product_name, strength_text, dosage_form, route,
      pack_size, manufacturer, marketing_authorisation_holder, nafdac_reg_number,
      nafdac_registration_status, category, prescription_class,
      clinical_review_status, created_by, updated_by
    ) values (
      s.generic_name,
      s.brand_name,
      s.product_name,
      coalesce(s.strength_text, ''),
      coalesce(s.dosage_form, ''),
      coalesce(s.route, ''),
      s.pack_size,
      s.manufacturer,
      s.marketing_authorisation_holder,
      s.nafdac_reg_number,
      case
        when s.nafdac_reg_number is not null then 'pending'::medicine_registration_status
        else 'unverified'::medicine_registration_status
      end,
      coalesce(s.category, ''),
      s.prescription_class,
      'pending_review',
      auth.uid(),
      auth.uid()
    )
    returning id into v_product_id;
  end if;

  -- Ingredients.
  insert into medicine_ingredients (
    product_id, ingredient_name, strength_value, strength_unit, sort_order
  )
  select
    v_product_id, x.ingredient_name, x.strength_value, x.strength_unit,
    coalesce(x.sort_order, 0)
  from jsonb_to_recordset(v_ingredients) as x(
    ingredient_name text, strength_value numeric, strength_unit text,
    sort_order integer
  )
  where length(btrim(coalesce(x.ingredient_name, ''))) > 0;

  -- Primary source, if supplied on the submission itself.
  if coalesce(s.source_title, '') <> '' then
    insert into medicine_sources (
      product_id, section, source_type, title, publisher, url,
      document_reference, retrieved_at, source_ref, notes, created_by
    ) values (
      v_product_id,
      null,
      coalesce(s.source_type, 'other'),
      s.source_title,
      null,
      s.source_url,
      s.source_document_reference,
      s.source_retrieved_at,
      'submission-primary',
      s.notes,
      auth.uid()
    );
  end if;

  -- Structured sources from the payload.
  insert into medicine_sources (
    product_id, section, source_type, title, publisher, url,
    document_reference, retrieved_at, source_ref, notes, created_by
  )
  select
    v_product_id,
    x.section::clinical_section,
    coalesce(x.source_type, 'other'::medicine_source_type),
    x.title,
    x.publisher,
    x.url,
    x.document_reference,
    x.retrieved_at,
    x.source_ref,
    x.notes,
    auth.uid()
  from jsonb_to_recordset(v_sources) as x(
    section text, source_type medicine_source_type, title text, publisher text,
    url text, document_reference text, retrieved_at date, source_ref text,
    notes text
  );

  -- Clinical sections.
  insert into medicine_clinical_sections (
    product_id, section, content, status, food_instruction, source_id,
    retrieved_at, last_reviewed_at, reviewed_by
  )
  select
    v_product_id,
    x.section::clinical_section,
    coalesce(x.content, ''),
    coalesce(x.status, 'not_verified'::clinical_section_status),
    x.food_instruction::medicine_food_instruction,
    (
      select src.id
      from medicine_sources src
      where src.product_id = v_product_id
        and src.source_ref = x.source_ref
      limit 1
    ),
    x.retrieved_at,
    coalesce(x.last_reviewed_at, current_date),
    auth.uid()
  from jsonb_to_recordset(v_sections) as x(
    section text, content text, status clinical_section_status,
    food_instruction text, source_ref text, retrieved_at date,
    last_reviewed_at date
  )
  on conflict (product_id, section) do update set
    content = excluded.content,
    status = excluded.status,
    food_instruction = excluded.food_instruction,
    source_id = excluded.source_id,
    retrieved_at = excluded.retrieved_at,
    last_reviewed_at = excluded.last_reviewed_at,
    reviewed_by = excluded.reviewed_by,
    version = medicine_clinical_sections.version + 1,
    updated_at = now();

  -- Dosages.
  insert into medicine_dosages (
    product_id, population, indication, route, dose_text, frequency,
    duration, max_dose, notes, status, source_id, retrieved_at,
    last_reviewed_at, reviewed_by
  )
  select
    v_product_id,
    x.population,
    x.indication,
    x.route,
    x.dose_text,
    x.frequency,
    x.duration,
    x.max_dose,
    x.notes,
    coalesce(x.status, 'not_verified'::clinical_section_status),
    (
      select src.id
      from medicine_sources src
      where src.product_id = v_product_id
        and src.source_ref = x.source_ref
      limit 1
    ),
    x.retrieved_at,
    coalesce(x.last_reviewed_at, current_date),
    auth.uid()
  from jsonb_to_recordset(v_dosages) as x(
    population text, indication text, route text, dose_text text,
    frequency text, duration text, max_dose text, notes text,
    status clinical_section_status, source_ref text, retrieved_at date,
    last_reviewed_at date
  )
  where length(btrim(coalesce(x.population, ''))) > 0;

  select count(*) into v_source_count
  from medicine_sources
  where product_id = v_product_id;

  if v_source_count = 0 then
    raise exception 'At least one source is required before a product can be verified'
      using errcode = 'check_violation';
  end if;

  perform set_config(
    'pf.medicine_change_reason',
    coalesce(nullif(btrim(p_reason), ''), 'Submission accepted'),
    true
  );

  update medicine_products set
    clinical_review_status = 'verified',
    clinical_reviewed_by = auth.uid(),
    clinical_reviewed_at = now(),
    last_clinical_review_date = current_date,
    updated_by = auth.uid()
  where id = v_product_id;

  update medicine_submissions set
    status = 'accepted',
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_reason = p_reason,
    accepted_product_id = v_product_id
  where id = p_submission_id;

  insert into medicine_catalogue_audit (
    product_id, submission_id, actor_id, action, from_status, to_status,
    description, metadata
  ) values (
    v_product_id,
    p_submission_id,
    auth.uid(),
    'submission_accepted',
    s.status::text,
    'accepted',
    'Submission accepted into the shared catalogue',
    jsonb_build_object('reason', p_reason)
  );

  return v_product_id;
end;
$$;

-- ============================================================ function privileges

revoke execute on function pf_can_review_clinical() from public;
revoke execute on function pf_can_review_submission(uuid) from public;
revoke execute on function pf_can_read_medicine_product(uuid) from public;
revoke execute on function pf_medicine_identity_key(text, text, text, text, text, text, text) from public;
revoke execute on function pf_medicine_product_snapshot(uuid) from public;
revoke execute on function pf_search_medicine_catalogue(text, text, text, text, text, text, text, integer, integer) from public;
revoke execute on function pf_medicine_duplicate_candidates(text, text, text, text, text, text, text, uuid) from public;
revoke execute on function pf_set_medicine_product_status(uuid, medicine_verification_status, text) from public;
revoke execute on function pf_set_medicine_registration_status(uuid, medicine_registration_status, uuid, text) from public;
revoke execute on function pf_archive_medicine_product(uuid, text) from public;
revoke execute on function pf_restore_medicine_product(uuid, text) from public;
revoke execute on function pf_accept_medicine_submission(uuid, text) from public;

revoke execute on function pf_can_review_clinical() from anon;
revoke execute on function pf_can_review_submission(uuid) from anon;
revoke execute on function pf_can_read_medicine_product(uuid) from anon;
revoke execute on function pf_medicine_identity_key(text, text, text, text, text, text, text) from anon;
revoke execute on function pf_medicine_product_snapshot(uuid) from anon;
revoke execute on function pf_search_medicine_catalogue(text, text, text, text, text, text, text, integer, integer) from anon;
revoke execute on function pf_medicine_duplicate_candidates(text, text, text, text, text, text, text, uuid) from anon;
revoke execute on function pf_set_medicine_product_status(uuid, medicine_verification_status, text) from anon;
revoke execute on function pf_set_medicine_registration_status(uuid, medicine_registration_status, uuid, text) from anon;
revoke execute on function pf_archive_medicine_product(uuid, text) from anon;
revoke execute on function pf_restore_medicine_product(uuid, text) from anon;
revoke execute on function pf_accept_medicine_submission(uuid, text) from anon;

-- The trigger functions are unreachable as RPCs (PostgreSQL refuses to call a
-- trigger function directly), but PostgreSQL still grants EXECUTE on every new
-- function to PUBLIC by default. Close that default for every function in this
-- migration, including triggers, rather than depending on a future author to
-- remember each new name. This mirrors the Phase 0b hardening at
-- 20261005190000_function_execute_hardening.sql, which ran before these
-- functions existed and could not cover them.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'pf\_%'
  loop
    execute format('revoke execute on function %s from public', fn.sig);
    execute format('revoke execute on function %s from anon', fn.sig);
  end loop;
end $$;

grant execute on function pf_can_review_clinical() to authenticated;
grant execute on function pf_can_review_submission(uuid) to authenticated;
grant execute on function pf_can_read_medicine_product(uuid) to authenticated;
grant execute on function pf_medicine_identity_key(text, text, text, text, text, text, text) to authenticated;
grant execute on function pf_search_medicine_catalogue(text, text, text, text, text, text, text, integer, integer) to authenticated;
grant execute on function pf_medicine_duplicate_candidates(text, text, text, text, text, text, text, uuid) to authenticated;
grant execute on function pf_set_medicine_product_status(uuid, medicine_verification_status, text) to authenticated;
grant execute on function pf_set_medicine_registration_status(uuid, medicine_registration_status, uuid, text) to authenticated;
grant execute on function pf_archive_medicine_product(uuid, text) to authenticated;
grant execute on function pf_restore_medicine_product(uuid, text) to authenticated;
grant execute on function pf_accept_medicine_submission(uuid, text) to authenticated;

grant execute on function pf_can_review_clinical() to service_role;
grant execute on function pf_can_review_submission(uuid) to service_role;
grant execute on function pf_can_read_medicine_product(uuid) to service_role;
grant execute on function pf_medicine_identity_key(text, text, text, text, text, text, text) to service_role;
grant execute on function pf_medicine_product_snapshot(uuid) to service_role;
grant execute on function pf_search_medicine_catalogue(text, text, text, text, text, text, text, integer, integer) to service_role;
grant execute on function pf_medicine_duplicate_candidates(text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function pf_set_medicine_product_status(uuid, medicine_verification_status, text) to service_role;
grant execute on function pf_set_medicine_registration_status(uuid, medicine_registration_status, uuid, text) to service_role;
grant execute on function pf_archive_medicine_product(uuid, text) to service_role;
grant execute on function pf_restore_medicine_product(uuid, text) to service_role;
grant execute on function pf_accept_medicine_submission(uuid, text) to service_role;
