# Staging Validation — Preparation

Everything needed to validate the platform-admin work against a **staging**
Supabase project. Nothing in this document has been executed. Every command is
listed so it can be read, checked, and then run deliberately.

**Status: the staging project is `xnhsuifcbplnwtxnpedw`; the recorded CLI link
points at it; the configuration is verified locally. The staging database has not
been migrated or validated, and the first database action awaits approval.** See
§2 and §3.

---

## 1. Migration review

### 1.1 The full chain

There are 23 migrations in the staging chain. **None** has ever been applied to
a real Postgres server; all of them have only ever been verified against PGlite.
The offline-sale timestamp migration (`20261017120000_offline_sale_sold_at.sql`)
is deliberately outside this staging release, so the folder contains 24 files
but only 23 are expected by the gate.

| # | Migration | Lines | Applied anywhere? |
|---|---|---|---|
| 1 | `20261002160000_initial_schema.sql` | 1331 | no |
| 2 | `20261004090000_stock_ledger_and_fefo_foundation.sql` | 539 | no |
| 3 | `20261005120000_unit_hierarchy.sql` | 300 | no |
| 4 | `20261005160000_branch_registration.sql` | 68 | no |
| 5 | `20261005190000_function_execute_hardening.sql` | 227 | no |
| 6 | `20261005210000_role_and_destructive_authorization.sql` | 371 | no |
| 7 | `20261005230000_receipt_pricing_authority.sql` | 126 | no |
| 8 | `20261005250000_branch_membership_role_authority.sql` | 226 | no |
| 9 | `20261005260000_role_change_auditability.sql` | 240 | no |
| 10 | `20261006090000_staff_invitations.sql` | 313 | no |
| 11 | `20261006150000_staff_invitation_expiry.sql` | 258 | no |
| 12 | `20261007120000_staff_invitation_claim.sql` | 150 | no |
| 13 | `20261007130000_revoke_invitation_clears_claim.sql` | 72 | no |
| 14 | `20261007140000_revoke_invitation_active_claim_only.sql` | 133 | no |
| 15 | `20261012120000_authoritative_checkout.sql` | 675 | no |
| 16 | `20261012130000_void_sale_restores_stock.sql` | 412 | no |
| 17 | `20261012140000_platform_admin.sql` | 892 | no |
| 18 | `20261012150000_redeem_invitation_idempotent.sql` | 177 | no |
| 19 | `20261012160000_redeem_invitation_check_order.sql` | 162 | no |
| 20 | `20261012170000_receive_stock.sql` | 294 | no |
| 21 | `20261018120000_pos_payments_split.sql` | 830 | no |
| 22 | `20261019120000_medicine_knowledge_base.sql` | 2294 | no |
| 23 | `20261020120000_returns_and_price_updates.sql` | 1480 | no |

> The first 20 are tracked and committed. Rows 21–23 are currently
> uncommitted working-tree files; they must be reviewed and committed before any
> staging apply. The exact chain is pinned by
> `scripts/apply-staging-migrations.ps1` (an explicit ordered list) and asserted
> against `supabase/migrations/` by `scripts/selftest-dryrun-gate.mjs`, which
> excludes only the offline timestamp migration.

### 1.1.1 What the three newest staging migrations add

`20261018120000_pos_payments_split.sql` is the existing split-payment POS work.
It adds `sale_payments` and redefines the checkout and customer-payment
functions. It is included because the staging chain must match the code that is
about to be validated; it is not part of the medicine knowledge-base change.

`20261019120000_medicine_knowledge_base.sql` is Phase 1 of the medicine
catalogue. It adds:

- shared catalogue tables (`medicine_products` and its ingredient, source,
  clinical-section, dosage, alias, revision and audit children);
- tenant-scoped `medicine_submissions` and `pharmacy_medicine_aliases`, plus the
  nullable `medicines.catalogue_product_id` link;
- a branch-membership `can_review_clinical` capability, with owner-only grants;
- RLS separating the globally readable verified catalogue from tenant/reviewer
  drafts and submissions;
- reviewer RPCs for clinical status, registration status, archive/restore and
  submission acceptance;
- `pf_search_medicine_catalogue` and `pf_medicine_duplicate_candidates`;
- service-role-only import staging tables.

The migration itself does **not** add the importer or any catalogue rows.
Clinical and registration verification remain separate. No record may be
verified without a source and a named reviewer, and no verified product may be
overwritten by accepting a submission. Acceptance also refuses a submission
with no prescription class or no primary-source retrieval date, rather than
defaulting an unclassified product to OTC or back-filling today's date. These
rules are enforced in the database and covered by
`supabase/verify/verify-medicine-catalogue.mjs`.

Phase 2 is application code only and adds no migration: the `Medicine info`
screen now separates the shared `Reference catalogue` from the tenant-scoped
`My pharmacy` dossier, and owners can submit a missing product for review. In
demo mode the shared catalogue is explicitly unavailable rather than populated
with fictional clinical records. The pure UI rules are checked separately by
`bun run verify:medicine-ui`.

`20261020120000_returns_and_price_updates.sql` adds persistent customer returns
and the authoritative selling-price write path:

- linked `medicine_returns`, `medicine_return_items` and
  `medicine_return_allocations`, with an append-only `medicine_price_changes`
  audit ledger;
- `sales.returned_credit`, a separate accepted-return credit that never rewrites
  the original sale total, payment or lines;
- `pf_sale_returnable`, `pf_create_return` and `pf_review_return`, including
  owner completion, attendant pending review, idempotency, remaining-quantity
  checks, original-lot restoration and quarantine for damaged, expired, recalled
  or unprovenanced stock;
- `pf_update_medicine_price`, owner-only, unit-specific, stale-price-safe and
  cost/batch/expiry-preserving;
- a void guard that refuses a sale with any recorded return, preventing a second
  stock restoration.

The return/pricing rules are covered by
`supabase/verify/verify-returns-and-price-updates.mjs`, and the client-side
receipt, return and price rules by `bun run verify:returns-price-ui`.

Expected post-apply counts for the 23-migration chain are **37 public tables, 8
public views, 70 `pf_*` functions and 20 enums**. These counts were measured by
applying the staging chain (the full folder minus the offline migration) to a
fresh PGlite database; they are not estimates.

### 1.2 Ordering

Apply **all 23 in filename order**. Filename sort *is* the correct order. The
offline timestamp migration is not in this chain and must not be added to it.

Constraints inside that order:

- **`pf_record_stock_movement` is defined three times.** `04090000` defines it
  first, then `12120000` defines it again, then `12130000` defines it a third time
  with the `reference_id` fix. `12130000` supersedes the earlier two and **must**
  run last. Timestamp order handles this.
- **`pf_redeem_invitation` is defined five times**: `06090000`, then `06150000`,
  then `12140000`, then `12150000` and `12160000`. The last, `12160000`, is the
  effective version. Same rule.
- **`12170000` adds one new function**, `pf_receive_stock`, and redefines nothing.

The platform-admin batch, `12120000`–`12140000`, shares **no** redefined functions
across its three files:

| Redefined in `12140000` | Also in `12120000` / `12130000`? |
|---|---|
| `pf_is_platform_admin`, `pf_grant_platform_admin`, `pf_create_pharmacy`, `pf_set_pharmacy_status`, `pf_my_branch_status` | new |
| `pf_current_branch`, `pf_guard_profile_privileges`, `pf_set_active_branch`, `pf_redeem_invitation`, `pf_my_branches` | no |
| — | `12120000`: `pf_record_stock_movement`, `pf_check_credit_ledger_balance`, `pf_complete_sale` |
| — | `12130000`: `pf_record_stock_movement`, `pf_apply_sale_item_stock`, `pf_void_sale` |

`12120000` and `12130000` reference `suspended` only as `credit_accounts.is_suspended`,
which is unrelated to `branches.status`. So the three could technically be applied
in any order among themselves — **except** for the `pf_record_stock_movement`
overlap above. Filename order is correct and is what should be used.

There are **no down migrations**. This is forward-only. A failed apply is
recovered by dropping and recreating the staging database, not by rolling back.

### 1.2.1 The two version strings that are not clock times

`20261005250000_branch_membership_role_authority.sql` and
`20261005260000_role_change_auditability.sql` decode as `2026-10-05 25:00:00`
and `2026-10-05 26:00:00`. Hours 25 and 26 do not exist.

They are **not timestamps and were never meant to be.** A migration version is
an **opaque sort key**: the CLI orders migrations by filename, and
`schema_migrations.version` is `text`, so ordering is lexicographic, not
chronological. `20261005250000` sorts after `20261005230000` and before
`20261006090000`, which is exactly where these two files have to run.

They are numbered this way on purpose. Both were written after
`20261005230000_receipt_pricing_authority.sql` already existed, and inserting a
migration between two committed ones without editing either of them means
choosing a key that sorts between their two keys. `…240000`/`…245000` would have
worked equally well; `…250000`/`…260000` were picked and are harmless. Nothing in
this repository parses a version as a date.

**Do not rename them.** Two structural reasons:

- The chain is forward-only. `20261005250000` is referred to by name in the
  header of `20261005260000` and in comments in `supabase/verify/verify-role-audit.mjs`,
  `verify-role-authority.mjs`, `verify-platform-admin.mjs` and
  `src/lib/supabase/tenant.ts`. A rename would make those references wrong.
- Renaming a migration that has already been applied creates a version the
  `schema_migrations` history has never seen, so the next `db push` would apply
  it a second time. Nothing has been applied anywhere yet, so this is currently a
  latent risk rather than an active one — which is exactly why it must not be
  "tidied up" before the first apply.

### 1.3 What `12140000` depends on

| Needs | From |
|---|---|
| `profiles`, `profiles.is_customer`, `audit_events(branch_id NOT NULL, actor_id NOT NULL)` | `initial_schema` |
| `branches`, `branch_memberships` | `04090000` |
| `pf_current_branch`, `pf_guard_profile_privileges` (current forms) | `04090000` |
| `pf_set_active_branch`, `pf_my_branches` | `04090000` |
| `customer_orders`, `order_items` | `initial_schema` |
| `staff_invitations` incl. `expires_at` | `06090000` + `06150000` |
| `pharmacy_status` enum, `branches.status` | introduced by `12140000` itself |

It cannot be applied alone. The full chain is required.

### 1.4 The five redefinitions — verified as strict supersets

`12140000` uses `create or replace` on five existing objects. Each was diffed
line-by-line against the migration that last defined it. **No existing behaviour
was dropped in any of them.**

| Redefined | Previous definition | Change | Verdict |
|---|---|---|---|
| `pf_current_branch` | `initial_schema:152` | added `and exists (select 1 from branches b where b.id = p.branch_id and b.status <> 'suspended')` | addition only |
| `pf_guard_profile_privileges` | `04090000:395` | new `is_platform_admin` block prepended; original body byte-identical below it | addition only |
| `pf_set_active_branch` | `04090000:351` | joins `branches` for `b.status`; refuses `'suspended'`; `pending` still allowed; NULL-`auth.uid()` bootstrap preserved | addition only |
| `pf_my_branches` | `04090000:487` | added `and b.status <> 'suspended'`; schema-qualified | addition only. `create or replace view` needs an identical column list, and both are `select b.*` |
| `pf_redeem_invitation` | `06150000:166` | added pharmacy activation + a `pharmacy_activated` audit row | addition only — see below |

**`pf_redeem_invitation` specifically.** A previous session dropped the expiry
clause from this copy and `verify-staff-invitations` caught it. The expiry check
is present and was re-verified: the `for update` lookup filters on
`i.accepted_at is null and i.revoked_at is null and (i.expires_at is null or
i.expires_at > now())`, and the `not found` branch still raises
`'That invitation has expired...'` distinctly from
`'That invite code is not valid, or has already been used'`.

The diff showed **no removed lines** other than `set search_path to 'public'`
(reflowed to `= 'public'`, equivalent) and comment reflow. One comment was lost —
`memberships_audit_role_change already records this insert` — but the trigger it
describes is untouched and still fires.

`20261007120000`, `130000` and `140000` mention `pf_redeem_invitation` **in
comments only**. None redefines it. Confirmed by a case-insensitive scan of all
`create or replace function|view` statements across every migration.

### 1.5 Effect on Endline Pharmacy

`Endline Pharmacy` is the pre-existing branch used as the regression fixture in
every suite. Its treatment by `12140000`:

| Change | Effect on Endline |
|---|---|
| `branches.status … not null default 'active'` | Endline becomes `'active'`. Untouched. A constant default is metadata-only in PG 11+, so there is no table rewrite and no lock beyond a brief one. |
| `branches.suspended_at / suspended_reason / activated_at` | all NULL. No trigger populates them for existing rows. |
| `profiles.is_platform_admin … default false` | every existing profile becomes `false`. |
| `pf_current_branch()` | Endline's status is `'active'`, so the new `exists` is true and the result is **identical** to before. |
| `pf_my_branches` | `status <> 'suspended'` is true; membership predicate unchanged. **Identical.** |
| `pf_set_active_branch()` | the refusal only fires on `'suspended'`. **Identical.** |
| `pf_guard_profile_privileges()` | the new block only fires when `is_platform_admin` changes. Endline's owner/assistant never trigger it. |
| `pf_redeem_invitation` activation | `where id = v_inv.branch_id and status = 'pending'`. Endline is `'active'`, so the `update … set status='active'` matches **zero rows**. It is a no-op, not a rewrite. |

**No statement in `12140000` writes to a pre-existing row.** Every insert targets
rows the migration itself creates; the only `update` on `branches` is inside
`pf_set_pharmacy_status` (operator-driven) or inside `pf_redeem_invitation` behind
`status = 'pending'`.

This is asserted, not assumed: §14 of `verify-platform-admin.mjs` checks that
Endline still exists, is `active`, keeps its city, keeps both memberships, keeps
its owner role, and that its owner can still resolve the branch.

### 1.6 Effect on the checkout and invitation functions

`12140000` does **not** redefine any checkout function. The effects are indirect,
through `pf_current_branch()`:

| Function | Direct change | Indirect effect |
|---|---|---|
| `pf_complete_sale` | none | A suspended pharmacy's call now fails with *"This account has no active pharmacy"*. Asserted in §11b, including that no sale header is written and no stock moves. |
| `pf_void_sale` | none | Same. Not separately asserted under suspension — **a gap**. |
| `pf_record_stock_movement`, `pf_apply_sale_item_stock` | none | none |
| `pf_create_invitation` | none | Refuses under suspension. Asserted in §11b. |
| `pf_revoke_invitation`, `pf_claim_invitation` | none | Untested under suspension — **a gap**. |
| `pf_redeem_invitation` | superset, above | Activates a `pending` pharmacy on acceptance |

Two gaps worth closing on staging if time allows: **`pf_void_sale` and
`pf_revoke_invitation` under suspension are not covered by any assertion.**

> Both are now covered. `verify-platform-admin.mjs` §11d asserts them. See §9.

### 1.9 Fresh-project risk review — what could fail on an empty database

Every suite runs the chain against PGlite, where roles and schemas are
synthesised by `harness.mjs`. Real Supabase differs. Each difference was checked
mechanically rather than by eye.

#### Things the chain depends on, and whether they exist on a fresh project

| Dependency | Where | Fresh Supabase | Risk |
|---|---|---|---|
| roles `anon`, `authenticated`, `service_role` | 38 + 4 `grant`s | **exist** | **none** — the migrations never `create role`, so nothing can conflict |
| schema `auth` | 110 `auth.uid()` refs | **exists** | **none** |
| schema `storage` | 1 mention | exists | **none** — the only occurrence is the comment *"Nothing here touches Edge Functions or Storage"* |
| table `auth.users` | 5 FKs + 1 trigger | **exists** | **low** — only `id` and `email` are used, both present on real `auth.users` |
| extension `pgcrypto` | `initial_schema:45` | installable | **medium — see below** |
| publication `supabase_realtime` | `initial_schema:1303` | **exists** | **low** — creation is guarded by `if not exists`, and the `drop table` is wrapped in `exception when undefined_object` |

#### The one real risk: `create extension if not exists "pgcrypto"`

The harness **never runs this statement**. `harness.mjs` textually substitutes an
equivalent `gen_random_uuid()` function, because PGlite has no `pgcrypto`. So this
line has **never been executed anywhere**, and it is the first statement of the
first migration.

It should work: `pgcrypto` is a *trusted* extension, so the database owner may
install it, and the session pooler connects as `postgres`. But if Supabase has it
disabled or pre-installed elsewhere it will fail, and it will fail on migration
**1 of 23**.

**If it fails**, nothing is lost — `db push` runs each migration in its own
transaction, so the failure leaves an empty database. Fix it by installing the
extension in the Supabase dashboard (*Database → Extensions → Enable pgcrypto*)
and re-running.

#### A second, smaller risk: `search_path` and `extensions`

On Supabase, `pgcrypto` normally lands in the **`extensions`** schema, not
`public`. Every `SECURITY DEFINER` function here sets `search_path to 'public'`,
so a pgcrypto-only function would be **invisible to them**.

The codebase already knows this. `staff_invitations.sql:43` says so explicitly:

> Built from two `gen_random_uuid()` calls rather than pgcrypto's
> `gen_random_bytes`, and that is deliberate. On Supabase pgcrypto lives in
> `extensions`, which the SECURITY DEFINER functions below cannot see because
> they set `search_path to 'public'`.

Verified: of the pgcrypto surface, only `gen_random_uuid` appears in executable
SQL. `gen_random_bytes`, `crypt`, `digest` and `hmac` appear **in comments only**
(0 uses). `gen_random_uuid` is `pg_catalog` on PostgreSQL 13+, so it resolves
regardless of where pgcrypto installed. **No exposure.**

#### What the chain does *not* do

- **No `DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA` or `TRUNCATE`.** The only
  destructive statements are 7, all guarded `if exists`, and all internal to the
  chain: 3 `drop constraint` on constraints created in `initial_schema`, and 4
  `drop function` immediately followed by a `create or replace` of the same
  signature.
- **No writes to or triggers *on* `auth.users`.** It creates one trigger
  (`on_auth_user_created`) on it, which is standard Supabase practice and needs
  `postgres` to own `auth.users`.
- **No `add column ... not null` without a default**, so no migration can fail on
  a populated table.
- **No forward references.** Checked mechanically: no migration touches a table,
  view, enum or function created by a later one. The chain is strictly linear.
- **No seed data.** Nothing is inserted, so staging starts empty by design.

#### Ordering constraints inside the chain

Filename order is the correct order, and it is the order these run in. Four
functions are defined more than once, and the **last** definition wins:

| Function | Defined in | Effective version |
|---|---|---|
| `pf_record_stock_movement` | `04090000`, `12120000`, `12130000` | **`12130000`** |
| `pf_redeem_invitation` | `06090000`, `06150000`, `12140000`, `12150000`, `12160000` | **`12160000`** |
| `pf_revoke_invitation` | `06090000`, `07130000`, `07140000` | **`07140000`** |
| `pf_set_active_branch` | `04090000`, `12140000` | **`12140000`** |

`07130000` drops **and** recreates `pf_revoke_invitation` (L22 → L24) and re-grants
it (L72), so the chain is self-consistent at every point.

`pharmacy_status` is created in `12140000` and referenced only inside the
platform-admin work and the two migrations that supersede its
`pf_redeem_invitation` (`12150000`, `12160000`, which carry the same
`branches.status` writes forward) — nowhere else in the chain. The platform-admin
work is therefore self-contained: it cannot break anything earlier, and nothing
earlier can break it.

#### Completeness, verified mechanically

`scripts/audit-schema-completeness.mjs` cross-checks `src/lib/db.types.ts`
against the chain. `db.types.ts` is hand-maintained and every suite runs against
the migrations, so a disagreement between the two would only ever surface on
staging:

```
  TABLES (19 declared)    all present in the migration chain
  VIEWS (8 declared)      all present in the migration chain
  ENUMS (11 declared)     all present in the migration chain
  FUNCTIONS (15 declared) all present in the migration chain
  RESULT: the migration chain produces everything db.types.ts declares.
```

The chain contains the current PharmaFlow schema **and** the platform-admin
changes: `branches.status`, `profiles.is_platform_admin`, the `pharmacy_status`
enum, three `pf_platform_*` views, `pf_my_branch_status`, and the authoritative
checkout and void-sale work are all present as files `15`–`17`.

### 1.7 Grants review

| Object | anon | authenticated | service_role |
|---|---|---|---|
| `pf_grant_platform_admin` | revoked | revoked | **granted** |
| `pf_create_pharmacy` | revoked | revoked | **granted** |
| `pf_set_pharmacy_status` | revoked | revoked | **granted** |
| `pf_is_platform_admin` | revoked | granted | *not granted* |
| `pf_my_branch_status` | revoked | granted | *not granted* |
| `pf_set_active_branch` | revoked | granted | *not granted* |
| `pf_platform_pharmacies` / `_orders` / `_activity` | no grant exists | granted | — |
| `pf_my_branches` | no grant exists | granted | — |

Every `security definer` function sets `search_path`. Every new function revokes
from `PUBLIC` before granting anything. `anon` has no grants anywhere in
`initial_schema` and no default privileges are altered, so `anon` cannot reach the
platform views at all.

Two deliberate non-grants to `service_role`, both correct:

- `pf_is_platform_admin` — the Worker verifies the caller with the **anon** key
  and that user's JWT, so the service-role connection never needs it.
- `pf_my_branch_status`, `pf_set_active_branch` — browser-side only.

### 1.8 A real-Postgres uncertainty worth testing first

`pf_grant_platform_admin` refuses when `auth.uid() is not null`, on the reasoning
that a service-role connection carries no JWT. **This project appears to use
Supabase's newer API key format** (`sb_secret_…`) rather than a legacy
service-role JWT.

With a legacy JWT, PostgREST populates `request.jwt.claims` and `auth.uid()`
returns the `sub`. With the new opaque key format it may not, which would make
`auth.uid()` NULL — which is what the function wants, so onboarding would work.

**This is unverified.** If Supabase instead populates a claim, the bootstrap
refuses and the operator is locked out. Run §3.3's probe before anything else.

The same reasoning is why `pf_create_pharmacy` and `pf_set_pharmacy_status` take
`p_actor` as an **argument** re-verified against `profiles`, rather than reading
`auth.uid()`.

---

## 2. Staging configuration

### 2.1 What was checked

| Check | Result |
|---|---|
| `supabase` CLI installed | **yes**, v2.119.0 |
| Supabase CLI **version** has `--workdir` and `db push --db-url` | **yes** |
| Supabase CLI has a `--config` flag | **no** — verified, see §2.4 |
| `supabase/.temp/project-ref` present | **yes** |
| `supabase/config.toml` has `project_id` | **yes** |
| `.temp/project-ref` matches `config.toml` | **no** — it points at the staging project; `config.toml` carries production |
| `.env` `PUBLIC_SUPABASE_URL` project ref matches the linked ref | **no** — `.env` names the deployed app's project; the two differ |
| `.env.staging`, `.env.local`, `.env.*.local` | **none exist** |
| Staging project reference supplied | `xnhsuifcbplnwtxnpedw` |
| That ref is distinct from production and from `config.toml`, and equal to the recorded CLI link | **yes** |

### 2.2 Conclusion

> **The recorded CLI link points at the staging project
> (`xnhsuifcbplnwtxnpedw`).** A bare `supabase db push` would therefore target
> **staging**, not production. The approved commands still pass the target
> explicitly (`--db-url` + `--workdir .`), so they never consult the link.
>
> The staging database has **not** been migrated or validated. This section proves
> the *configuration* only.

I have not printed the production project reference, the pooler URL, or anything
in `.env`.

`.env` holds only the four `PUBLIC_*` variables (plus `PUBLIC_DEMO_MODE`). There is
no service-role key locally — it lives only as a Worker secret. So local
`supabase db push` would need either a database password or an access token you
supply.

### 2.3 The staging project

| | |
|---|---|
| **Staging project ref** | `xnhsuifcbplnwtxnpedw` |
| Recorded in | `supabase/config.staging.toml` (`project_id`) |
| Distinguished from production | yes — verified locally, no network |
| CLI linked to it | **yes** — `supabase/.temp/project-ref` records this ref |

### 2.4 Why the CLI link points at staging

`supabase/.temp/project-ref` records the staging ref
(`xnhsuifcbplnwtxnpedw`). `supabase/config.toml` still carries the production
`project_id`; the approved commands never use it to choose a remote.

The link is shared state, so it cannot be right for a staging push and a
production push at the same time. It points at staging deliberately, because that
is the safer of the two mistakes: a bare `supabase db push` aimed at staging is
recoverable, while one aimed at production is not.
`scripts/verify-staging-target.mjs` enforces the choice — it **fails** unless the
recorded link equals the staging ref, so an absent link, a production link, or any
unexpected project stops the run. Isolation still comes from passing the target
explicitly (below).

**A `config.staging.toml` that the CLI reads.** It does not. Verified against
v2.119.0:

```
$ supabase --config supabase/config.staging.toml projects list
Unrecognized flag: --config in command supabase
  Hint: --config is available on `supabase postgres-config update` and
  `supabase postgres-config delete`. Pass it after the subcommand.
```

There is no `--config` on `db push` or `link`. The CLI always reads
`supabase/config.toml`. So `supabase/config.staging.toml` is a **record**, not a
switch — the staging ref written down somewhere reviewable and diffable.

**What is used instead: pass the target explicitly.** `--db-url` on `db push`
ignores the link entirely, so the target cannot be stale or ambiguous:

```powershell
supabase --workdir . db push --db-url "<staging session pooler uri>" --skip-vault
```

- `--workdir .` — uses this repository's `supabase/config.toml` and
  `supabase/migrations/` as given, with no ancestor search. The production
  `project_id` in that file is **only used for local container naming**, not for
  choosing a remote.
- `--db-url` — targets the staging database explicitly. The link is never read.
- `--skip-vault` — this project has no `[api.vault]` secrets, so nothing is
  written before the migrations run.

A dedicated workdir (`--workdir staging`, with its own `supabase/config.toml` and
its own `.temp`) is the alternative, and `config.staging.toml` carries the banner
describing how to build one. It is not recommended as the default because it
**copies `supabase/migrations/`**, and a copied directory can drift from the real
one — staging would then validate a migration nobody actually ships. Prefer
`--db-url` while there is a single workdir.

### 2.5 Manual steps still required

**These need you.** None is run by me.

1. **The staging database password.** From the Supabase dashboard →
   *Project Settings → Database*. Needed for any connection-based step.
2. **The staging connection URI.** *Project Settings → Database → Connection
   string → URI*. Use the **session** pooler form, not the transaction pooler —
   DDL in a transaction pooler fails. Store it in a password manager; do not
   commit it.
3. **The staging publishable/anon key.** *Project Settings → API*. Goes in
   `.env.staging`, not in a committed file.
4. **Staging Resend credentials**, if you want to test real email.
5. **CLI authentication** — `supabase login` — if you use any command that calls
   the Supabase management API rather than `--db-url`.

Nothing above has been created, guessed, or filled in. No placeholder key exists
anywhere in the repository.

**Staging auth setting.** *Authentication → Sign In / Providers → Email*. For the
checklist in §4 you want **Confirm email OFF**, because owner redemption in §5
needs the invited address verified as part of one flow and confirmation adds a
second inbox step. If you leave it ON, every owner redemption needs a click in
the owner's mailbox first.

**Staging Worker.** `wrangler.jsonc` now carries an `env.staging` block naming
the Worker `pharmaflow-staging`, with `main`, `compatibility_date` and
`compatibility_flags` repeated because those do not inherit. Nothing has been
deployed and no secret has been set. Production's top-level config is untouched.

```powershell
# vars first - these are PUBLIC and land in the client bundle, so publishable
# staging values only. Read from .env.staging via `vite build --mode staging`.
#   bun x vite build --mode staging

# then secrets, one at a time. --env staging, or you will write to PRODUCTION.
bunx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
bunx wrangler secret put RESEND_API_KEY           --env staging
bunx wrangler secret put RESEND_FROM             --env staging
bunx wrangler secret put PUBLIC_APP_URL          --env staging
```

`wrangler secret put` reads the value from stdin, so it does not land in shell
history.

Do **not** reuse the production Resend `from` address for staging if you can avoid
it — invitation mail then looks identical to real mail to a recipient.

---

## 3. Exact commands — **not run, awaiting approval**

> ### ⚠️ A bare `supabase db push` in this repository targets STAGING
>
> `supabase/.temp/project-ref` points at the staging project. Every command below
> still passes `--db-url` explicitly, so it never consults the link.
> `supabase db push` with **no flags** is the unpredictable command, not the safe
> one: it follows the link, whatever the link happens to be that day.

### 3.1 Pre-flight A — configuration only, no network, safe to run now

```powershell
bun scripts/verify-staging-target.mjs
```

Reads four local files and opens no connection. Exits `0` only if the staging ref
is well formed, matches `config.staging.toml`, differs from production in
`config.toml` and in `.env`, and **equals the recorded CLI link**. It prints the
bare-push hazard on every run. **Verified passing** (exit `0`; link = staging).

### 3.2 Pre-flight B — the connection, and the credential

#### Set the URI, in your own shell, without ever typing it into chat

```powershell
# In YOUR PowerShell window. -AsSecureString keeps it out of shell history and
# masks it on screen. $env: is session-scoped: it dies when you close the shell.
$sec  = Read-Host "Staging session pooler URI" -AsSecureString
$env:PGURI = [System.Net.NetworkCredential]::new("", $sec).Password
```

Why this shape and not `$env:PGURI = 'postgresql://...'`:

- **Not in history.** A pasted URI is written to the PSReadLine history file by
  default, and that file outlives the shell.
- **Not on screen.** `-AsSecureString` echoes `*` characters.
- **Not on disk.** `$env:` is process memory only. Nothing is written anywhere.
- **Not in the repository.** No file holds it. `.env.staging` is an alternative
  and is gitignored, but the variable is the safer of the two.

Never paste the URI or the password into chat, and never pass it as a command
argument — arguments are visible to every process on the machine via the process
command line.

**Where the project ref is read from, and why that matters.** A session-pooler URI
does **not** carry the ref in its host:

```
postgresql://postgres.<PROJECT_REF>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
                    ^^^^^^^^^^^^^^^^ the ref is HERE
```

So the script reads it from the **username** for pooler connections and from the
**host** for direct ones. A naive "does the URI contain the ref" test would pass
on a production URI too and would fail confusingly on a correct staging one.

The production check runs **before** the staging match. A production URI is also
a mismatch, so checking mismatch first would print the least useful line and exit
before the sentence that matters:

```
  FAIL  #################### THIS IS PRODUCTION ####################
        Do not run any migration, deploy, or script against this URI.
```

#### Then verify it — before any migration

```powershell
bun scripts/verify-staging-target.mjs        # local config; no network, no DB
bun scripts/verify-staging-connection.mjs    # reads $env:PGURI; SELECT only
```

`verify-staging-connection.mjs` is built to be safe here:

- It **never prints the password.** A redactor replaces the password and the full
  URI in anything it prints, plus a final pass that strips anything still shaped
  like inline credentials. A self-test asserts the password never appears in
  output for any input.
- It runs **only SELECT, SET and SHOW**, and it makes that a **database
  guarantee** rather than an authoring convention. Audited mechanically rather
  than by eye: `scripts/audit-readonly.mjs` extracts every template-literal
  statement the file can execute, asserts each begins with one of those three,
  and **additionally requires the read-only guard to be present**:

```
  statements found: 6
    1. READ-ONLY  set statement_timeout =
    2. READ-ONLY  set default_transaction_read_only =
    3. READ-ONLY  show default_transaction_read_only
    4. READ-ONLY  select current_database() as
    5. READ-ONLY  select (select count(*)::int
    6. READ-ONLY  select count(*)::int as
  non-SELECT/SET statements: 0
  [ok]   read-only guard: set default_transaction_read_only = on
  [ok]   statement timeout retained
```

Statement order inside `main()`, which is the part that matters:

| | |
|---|---|
| L348 | `postgres(uri, ...)` - the connection opens here |
| L357 | `set statement_timeout` |
| L379 | `set default_transaction_read_only = on` |
| L384 | `show default_transaction_read_only` - **verified, fails closed** |
| L395 | first data read |
| L404 | first `information_schema` query |

The guard **cannot** precede the connection; a `SET` needs a session. What
matters, and what is asserted, is that it precedes *every read*.

**Why the guard is load-bearing, not decoration.** No migration in this
repository uses `FORCE ROW LEVEL SECURITY` - 0 occurrences, while every
application table enables RLS.
The session-pooler user `postgres.<ref>` maps to `postgres`, which **owns** these
tables and therefore **bypasses RLS outright**. RLS is not a backstop for this
connection; the session guard is.

**Limitation, stated not glossed:** a superuser can still set
`transaction_read_only = off` per transaction. This is a strong guard against
accident, not an adversary - appropriate here because the threat is a bug in
this script, not a hostile connection.

`scripts/selftest-readonly-audit.mjs` is the negative control: it strips the
guard, strips the timeout, injects an `INSERT`, injects a `DROP TABLE`, and
asserts the audit **fails** for each. An audit that cannot detect its own
regression is not an audit.

#### Exit codes - identity versus everything else

| Exit | Meaning | Correct when |
|---|---|---|
| `0` | identity verified, database **fresh/empty** | before a migration |
| `1` | identity verified, database **populated** | after a migration |
| `2` | unable to determine the target | - |
| `3` | target **refused** (production, mismatch, port 6543) | - |
| `4` | connection or verification failure | - |

Previously all of `1`-`4` collapsed onto exit 1, and the post-apply gate read
"any non-zero is fine". A URI that had **drifted to production** - refused at
L301 without opening a connection - was therefore reported as a successful
migration. That is what the split fixes, and
`scripts/selftest-postapply-gate.mjs` pins it.

The pre-apply gate is the deliberate inverse: only `0` passes there.

#### Why the second dry run checks its own exit code

The pre-apply dry run requires **the exact expected set of 23** pending
migrations, in order, so an errored command names nothing and is caught by that
comparison. The post-apply check is the inverse - it requires **zero** - and a
dry run that *fails* also names zero.

Counting names alone therefore reported success on a second dry run that never
ran, and printed "Identity and history checks passed." having verified nothing.
A dropped connection, an expired password or a pooler hiccup were all silent
successes. The exit code is now checked first.

The same reasoning was applied to the pre-apply dry run and the pre-migration
dump, where it is a diagnostic improvement rather than a safety one: the dump
also now rejects a zero-length file, because an interrupted dump can leave a
truncated file that looks like a successful one.

#### A fresh project has no `supabase_migrations` schema

This is the case that broke the first version of the script.

`supabase_migrations.schema_migrations` is **created by the first
`supabase db push`**. On a project that has never been migrated the schema is
simply absent, so querying it unconditionally raises `42P01 undefined_table` —
and the original catch-all reported the whole *successful* connection as a
connection failure.

So the script asks the **catalog** first, in one round trip, and only reads the
history table if the catalog says it is there:

| Catalog says | Reported as |
|---|---|
| no `supabase_migrations` schema | *history not initialized* — **fresh, not an error** |
| schema present, no `schema_migrations` table | *history not initialized* — **fresh** |
| both present, 0 records | *empty* — **fresh** |
| both present, > 0 records | **NOT FRESH**, with the count |

Three independent signals must all agree, so an odd half-state cannot slip past:

| Signal | On a failure |
|---|---|
| `public` base tables | any > 0 |
| `pf_*` functions in `public` | any > 0 — unambiguous proof the chain ran |
| migration records | any > 0 |

Views in `public` are **reported but never fail on their own**. The chain creates
~30 tables, so `publicTables > 0` already proves it ran; failing on views too
would risk a false positive from a default view whose existence has not been
observed on a real fresh project.

Error classification is separated too, because a wrong password and a missing
table need different sentences — one is your mistake, the other is the script's:

| SQLSTATE | Reported as |
|---|---|
| `28P01`, `28000`, `42501` | authentication failed — your credentials |
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` | connection failed — network |
| `42P01` | **server error — "this is a bug in this script, not a problem with your URI"** |

#### What the script cannot tell you

It proves the **connection string** is right. It does not prove the password is
right — that surfaces only as an authentication failure, with nothing changed.

#### Self-test

`scripts/selftest-staging-connection.mjs` — **25 checks, no network**, all
fabricated inputs:

- **`assessFreshness`, fresh states (4):** no `supabase_migrations` schema ·
  schema without table · `schema_migrations` present and empty · views-only,
  which must stay fresh but be reported
- **`assessFreshness`, must-fail states (4):** 23 migrations recorded · records
  with no tables · stray `pf_*` functions · tables with no history
- **`classifyError` (7):** `42P01` is *catalog*, never auth or network
- **Wrong-target refusal, end to end (9):** production in a pooler username ·
  production in a direct host · unknown ref · transaction-pooler port · pooler
  host with no ref · unrecognised host · no password · `PGURI` unset · and that
  every refusal happens **without opening a connection**
- **Password never appears in any output**

### 3.3 Dry run — still changes nothing

```powershell
supabase --workdir . db push --dry-run --db-url $env:PGURI --skip-vault
```

Expected: the **23 migrations** listed as pending, resolved from
`supabase/migrations/` — which `--workdir .` pins explicitly, with no ancestor
search. Nothing is applied.

**Stop and read the output if any of these appear:**

| In the output | Meaning |
|---|---|
| fewer than 23 | some migration is not being picked up - investigate before applying |
| "remote migration versions not found in local migrations directory" | the target already has history this chain does not know about |
| any mention of the production project | the target is wrong — stop |
| a list of migrations *already applied* | you are pointed at a migrated database |

Do **not** add `--include-all` to make a discrepancy go away. It forces the push
to include migrations absent from the remote history table, which is exactly the
wrong move when the mismatch is telling you the target is not what you think.

### 3.4 Apply — **only after 3.1–3.3 and explicit approval**

```powershell
# G. re-run BOTH checks immediately before. Cheap, and the connection check is
#    the one thing that cannot be stale.
bun scripts/verify-staging-target.mjs
bun scripts/verify-staging-connection.mjs

# H. dump staging first, even though it is disposable and empty.
#    It is the only record of "empty" before it stops being empty.
supabase db dump --db-url $env:PGURI -f staging-before-migrations.sql

# I. apply
supabase --workdir . db push --db-url $env:PGURI --skip-vault

# J. confirm the history and that a second push is a no-op
supabase --workdir . db push --dry-run --db-url $env:PGURI --skip-vault
#    EXPECT: nothing to apply.
```

**Expected effects, precisely.**

*During:* each of the 23 migrations runs in its own transaction. If one fails,
that migration rolls back and the earlier 22 stand. Staging ends up partially
migrated, and the failure message names the statement.

*After a full success:*

| | |
|---|---|
| `supabase_migrations.schema_migrations` | created, **23 rows** |
| tables in `public` | **37** |
| views in `public` | **8** (4 cost, `pf_my_branches`, 3 `pf_platform_*`) |
| `pf_*` functions in `public` | **70** (before it was 0) |
| enums | **20**, including `pharmacy_status` and the medicine catalogue enums |
| data rows | **0** — no migration seeds anything |

*Verification without a migration command* — the Supabase SQL editor against
staging, or the read-only script:

```sql
select count(*) as migrations from supabase_migrations.schema_migrations;   -- 23
select count(*) as tables     from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE';             -- 37
select count(*) as views      from information_schema.views
  where table_schema = 'public';                                           -- 8
select count(*) as pf_fns     from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'pf\_%';                   -- 70
select status, count(*) from branches group by status;                     -- no rows
```

`select status, count(*) from branches group by status` returning **no rows** is
correct — `branches` exists but is empty, because no migration seeds a pharmacy.

> `--include-all` exists for pushing migrations missing from the remote history
> table. **Do not add it on the first run.** All 23 are new to staging, so the
> plain command should already list all of them; if it does not, that is a signal
> to stop and investigate, not a flag to reach for.

### 3.5 Post-apply smoke, before touching the app

```sql
-- in the Supabase SQL editor, against STAGING only

-- 1. the chain applied
select version, name from supabase_migrations.schema_migrations order by version desc limit 3;

-- 2. the new objects exist
select proname from pg_proc
 where proname in ('pf_is_platform_admin','pf_grant_platform_admin','pf_create_pharmacy',
                  'pf_set_pharmacy_status','pf_my_branch_status')
   and pronamespace = 'public'::regnamespace;

select table_name from information_schema.views where table_schema='public' and table_name like 'pf_platform%';

-- 3. the new columns exist and everything defaulted sanely
select status, count(*) from branches group by status;
--    EXPECT: one row, 'active', count = 1 (or more). Nothing suspended.
select count(*) from profiles where is_platform_admin;   -- EXPECT: 0

-- 4. THE bootstrap probe (see also docs/PLATFORM-ADMIN.md step 3a).
--    Run this BEFORE anything else. It grants NOTHING - the address does not
--    exist - and changes no data.
select public.pf_grant_platform_admin('nobody@example.test');
--    GOOD:    ERROR  No account exists for that email address
--             (proves auth.uid() is NULL on a service_role connection, so
--              step 3.6(a) will work)
--    PROBLEM: ERROR  Platform administration is granted only by the
--             platform operator
--             (the new API key format populates a claim; use step 3.6(b))
--    Do NOT relax the guard in the function to make this pass.
```

### 3.5b Why the guard is not relaxed

`pf_grant_platform_admin` refuses when `auth.uid()` is NOT NULL, so that even a
future widening of the EXECUTE grants could not turn it into a browser-callable
self-promotion route. If the probe above shows that guard blocking the operator,
the answer is the direct `UPDATE` as database owner — a strictly higher
privilege — and **not** editing the function. Editing it would remove the third
of the three independent barriers documented in `docs/PLATFORM-ADMIN.md` §1.

### 3.6 Grant the first administrator — **only after §3.5 step 4 passes**

`pf_grant_platform_admin` is a **Postgres** function, not an Edge Function, so
`supabase functions invoke` does **not** call it. Use one of:

```powershell
# (a) PostgREST. The body key must be the PARAMETER name, p_email -
#     {"email": ...} does not bind. Never run this against production.
curl -sS -X POST "https://<STAGING_REF>.supabase.co/rest/v1/rpc/pf_grant_platform_admin" `
  -H "apikey: $STAGING_SERVICE_ROLE_KEY" `
  -H "Authorization: Bearer $STAGING_SERVICE_ROLE_KEY" `
  -H "Content-Type: application/json" `
  -d '{"p_email":"you@example.com"}'
```

```sql
-- (b) SQL editor, as the database owner. Needs no key at all.
--     `returning` so you can see WHICH account was promoted.
update public.profiles set is_platform_admin = true
 where id = (select u.id from auth.users u where lower(u.email) = lower('you@example.com'))
returning id, full_name, is_platform_admin;
```

The account must already exist (sign in through the staging app once first).
Both return the user id, or `No account exists for that email address`.

**Never run either against production.**

---

## 4. Authenticated browser checklist

Run against the **staging** Worker. Requires: the migration applied, one platform
admin granted, and at least one pharmacy with an owner.

### 4.1 Accounts needed

| Label | How to create |
|---|---|
| **Admin** | sign in once on staging, then §3.6 |
| **Owner** | onboard a pharmacy via §4.5, redeem the emailed invitation |
| **Attendant** | as Owner, `/staff` → invite → redeem from a second inbox |

Every account is invitation-only (`signUpWithInvitation`); there is no public
sign-up, which makes the accounts deterministic.

### 4.2 Anonymous — the baseline

| # | Action | Expect |
|---|---|---|
| A1 | Visit `/platform` | "Not available" card. No pharmacy data. |
| A2 | Visit `/platform/pharmacies`, `/platform/orders`, `/platform/activity` | same refusal |
| A3 | `curl -X POST <staging>/api/platform/onboard-pharmacy -H 'content-type: application/json' -d '{"pharmacyName":"X","ownerName":"Y","ownerEmail":"z@example.com"}'` | **401**, no pharmacy created |
| A4 | Same with a garbage bearer | **401** |
| A5 | `select * from pf_platform_pharmacies` with the anon key | permission error or 0 rows — either is fine, **data must not appear** |

### 4.3 Owner — must be refused

| # | Action | Expect |
|---|---|---|
| O1 | Visit `/platform` | "Not available" |
| O2 | Call `POST /api/platform/onboard-pharmacy` directly with a valid owner JWT | **403** "This area is for platform administrators only." |
| O3 | Call `PATCH /api/platform/pharmacy-status` on any branch | **403** |
| O4 | `select * from pf_platform_pharmacies` with the owner's anon key + JWT | **0 rows**, no error |
| O5 | Own pharmacy at `/` | fully working, unchanged |
| O6 | Try to set `is_platform_admin` via any client call | refused — grant revoked from `authenticated` |

### 4.4 Attendant — must be refused

| # | Action | Expect |
|---|---|---|
| T1 | `/platform` | "Not available" |
| T2 | Both platform APIs | **403** |
| T3 | Platform views | **0 rows** |
| T4 | `/pricing` | unchanged; **no** purchase cost, as today |
| T5 | Complete an ordinary sale at `/pos` | succeeds, stock moves |

### 4.5 Platform admin — the dashboard

| # | Screen | Check |
|---|---|---|
| P1 | `/platform` | counts match `select status, count(*) from branches group by status`. **No order count tile.** |
| P2 | `/platform` recent activity | rows carry a pharmacy name and a relative time |
| P3 | `/platform/pharmacies` | every branch listed; status badges; owner name + invitation state |
| P4 | Search box | filters the current page by name, city, owner, email |
| P5 | Status dropdown | filters pending / active / suspended |
| P6 | Pagination | "Page 1 of N"; only shown when total > 25 |
| P7 | **Add Pharmacy** — blank submit | button disabled until name, owner and a valid email are present |
| P8 | **Add Pharmacy** — duplicate name | Worker's sentence surfaces; **no row created** |
| P9 | **Add Pharmacy** — success | toast; row appears with status `pending`; invitation shows *outstanding* |
| P10 | Suspend | confirmation dialog names the pharmacy; a **reason is required**; button disabled without one |
| P11 | Suspend — confirmed | status becomes `suspended`; toast confirms |
| P12 | Reactivate | confirmation; status returns to `active` |
| P13 | Repeat a suspend on an already-suspended pharmacy | toast says "was already suspended", **not** an error |
| P14 | `/platform/activity` | read-only; rows from more than one pharmacy |
| P15 | `/platform/orders` | the unavailability notice is visible; table is empty; **no "0 orders" claim** |
| P16 | Browser devtools → Network | **no** `SUPABASE_SERVICE_ROLE_KEY`, no `sb_secret_`, no invitation token in any response body |
| P17 | Browser devtools → Application | no service-role value in localStorage/sessionStorage |

### 4.6 Suspension, seen from the pharmacy

Suspend a pharmacy, then sign in as its **Owner**:

| # | Action | Expect |
|---|---|---|
| S1 | `/` | "This pharmacy is suspended" notice, **not** "No branch assigned" |
| S2 | Notice text | says nothing was deleted and names the platform operator |
| S3 | "Check again" after reactivation from a second browser | pharmacy returns |
| S4 | Attempt a sale at `/pos` | refused — *"This account has no active pharmacy"* |
| S5 | Attempt an invitation | refused |
| S6 | Branch switcher | the suspended pharmacy is **absent** from the list |
| S7 | Direct `pf_set_active_branch(suspendedId)` call | *"This pharmacy is suspended. Contact the platform operator."* |
| S8 | Direct `select * from medicines` | **0 rows** |
| S9 | While a **platform admin** views `/platform/pharmacies` | the suspended pharmacy is visible and manageable |

### 4.7 Tenant isolation must not have moved

| # | Action | Expect |
|---|---|---|
| X1 | Owner A invites; hand the token to Owner B | B is refused, invitation untouched |
| X2 | Owner A tries to read Owner B's branch via any view | 0 rows |
| X3 | Attendant reads `cost_per_base_unit` | refused |
| X4 | Owner reads it through `/pricing` | allowed, unchanged |
| X5 | Redeem an expired invitation | *"That invitation has expired."* |
| X6 | Redeem a revoked invitation | refused |
| X7 | Redeem the same token twice | second attempt refused |

---

## 5. Staging email test

Covers the invitation URL, expiry, single-use, and owner redemption.

### 5.1 Delivery

| # | Action | Expect |
|---|---|---|
| E1 | Onboard a pharmacy with a real inbox you control | email arrives |
| E2 | Inspect the link | host matches the **staging** `PUBLIC_APP_URL`, not production |
| E3 | Inspect the code in the link | 256-bit, single-use |
| E4 | Check the response of `POST /api/platform/onboard-pharmacy` in devtools | `emailSent: true`, and **no token anywhere in the body** |
| E5 | Set `RESEND_API_KEY` blank, onboard another pharmacy | `emailSent: false` + a reason; UI shows a **warning**, not a success toast; the pharmacy and invitation **both exist** |

E2 is the one that closes the open `PUBLIC_APP_URL` question. The mismatch has
never been ruled out, because `wrangler secret list` shows names only.

### 5.2 Redemption

| # | Action | Expect |
|---|---|---|
| E6 | Open the link as the invited owner, set a password | account created; redirect into the pharmacy |
| E7 | Pharmacy status after acceptance | `pending` → **`active`** |
| E8 | `/` as the new owner | the pharmacy is empty but working; stock screen reachable |
| E9 | `/platform/pharmacies` as admin | invitation now reads *accepted* |
| E10 | `/platform/activity` | a `pharmacy_activated` row, attributed to the new pharmacy |
| E11 | Reuse the same link in a different browser | refused — *"That invite was issued to a different email address"* or *"not valid, or has already been used"* |
| E12 | Try to redeem as a **third** account | refused |

### 5.3 Expiry

Platform invitations are created with `expires_at = NULL`, which
`pf_redeem_invitation` treats as *no expiry*. To test the expiry path:

```sql
-- STAGING only
update staff_invitations set expires_at = now() - interval '1 hour'
 where email = 'expiry-probe@example.com';
```

| # | Action | Expect |
|---|---|---|
| E13 | Redeem the expired code | *"That invitation has expired. Ask your owner to send a new one."* |
| E14 | Confirm no membership was created | `select count(*) from branch_memberships where user_id = <the user>` is 0 |
| E15 | Owner re-invites; new code works | normal redemption |

E14 is the one that matters: a refused redemption must leave the database exactly
as it was.

### 5.4 Single-use under concurrency

| # | Action | Expect |
|---|---|---|
| E16 | Two browsers redeem the same token simultaneously | **exactly one** membership created; the other gets *"not valid, or has already been used"* |
| E17 | Two admins onboard the **same pharmacy name** simultaneously | **one** succeeds, one gets *"A pharmacy with that name already exists"*; one branch row |

**E16 and E17 cannot be tested on PGlite** — it is single-connection, so the
`for update` locks never contend. Staging is the only place this can be answered.
This is the highest-value test in the whole document.

---

## 6. Running the 27 suites against real Postgres

### 6.1 The current state, stated plainly

**There is no way to run the suites against real Postgres today.**

`supabase/verify/harness.mjs` hard-codes PGlite:

```js
const db = new PGlite();      // harness.mjs:135
```

There is no `DATABASE_URL` branch, no connection-string option and no adapter.
Running them against a staging server requires **writing one** — a change to the
implementation, which is out of scope for this task.

> **PGlite results are not equivalent to real Postgres and must never be
> reported as such.** Specific known divergences, taken from the harness itself:
>
> - **No `pgcrypto`.** `create extension` is textually replaced by a shim
>   `gen_random_uuid()` built from `md5(random() || clock_timestamp())`. Token
>   entropy on staging comes from real `pgcrypto`.
> - **No transactions.** `asRole`'s ROLLBACK half is a no-op; PGlite runs in
>   autocommit, so a failed statement does not poison a later one. Real Postgres
>   *would* poison it. A suite that passes here may fail there for that reason.
> - **Single connection.** No concurrency. Every `for update` lock is untested.
> - **Roles are synthesised.** `anon`, `authenticated`, `service_role` are created
>   by `bootstrapRoles`. Real Supabase grants differ in ways the harness can only
>   approximate — it explicitly adds `grant usage on schema auth` because real
>   Supabase has it and PGlite does not.
> - **Extensions, publication membership and `pg_publication_tables`** behave
>   differently; the realtime `do $$` blocks in `04090000` are untested.

### 6.2 Split by kind

27 suites total: **23 database**, **4 pure logic**.

| Suite | Kind |
|---|---|
| `verify-audit-integrity` | database |
| `verify-authoritative-checkout` | database |
| `verify-catalogue-read` | database |
| `verify-chain` | database |
| `verify-function-surface` | database |
| `verify-harness-isolation` | database |
| `verify-platform-admin` | database |
| `verify-receipt-pricing` | database |
| `verify-role-audit` | database |
| `verify-role-authority` | database |
| `verify-role-integrity` | database |
| `verify-staff-invitations` | database |
| `verify-stock-authority` | database |
| `verify-tenant-isolation` | database |
| `verify-void-sale` | database |
| `verify-medicine-catalogue` | database |
| `verify-offline-local-db` | database |
| `verify-offline-pos` | database |
| `verify-offline-probe` | database |
| `verify-offline-sale-timestamps` | database |
| `verify-offline-sync` | database |
| `verify-pos-sale-payments` | database |
| `verify-returns-and-price-updates` | database |
| `verify-accept-invite` | **logic** |
| `verify-auth-modes` | **logic** |
| `verify-invite-email` | **logic** |
| `verify-request-guard` | **logic** |

The four logic suites never import `harness.mjs`. They exercise request parsing,
validation and email templates with no database at all, so they are **already
Postgres-independent** and need no staging configuration.

The Phase 2 medicine UI has a separate offline check, not counted above:
`bun run verify:medicine-ui` imports the same domain functions as the screen and
covers source/date validation, safe source URLs, submission payloads,
pagination and duplicate blocking. The Phase 3 return and price screens have a
parallel check, `bun run verify:returns-price-ui`, covering return state,
partial/full handling, credit/refund presentation, offline refusal and the
single authoritative price path.

`audit-phase0-final.mjs` is in the directory but is not named `verify-*`, so
`run-all.mjs` does not pick it up. It is not one of the 27.

### 6.3 What a real-Postgres adapter would need

Roughly, so the cost is known before committing to it:

1. A connection path in `harness.mjs` taking `DATABASE_URL`, defaulting to PGlite.
2. `service_role` is currently `nologin`. On staging it is a real role; the
   adapter must connect as the admin/`postgres` user and `set role`.
3. `asActor` / `asRole` currently rely on autocommit for isolation. Against a real
   connection they need a real transaction with ROLLBACK — which is a **behaviour
   change** in the harness and may surface genuine new failures.
4. `gen_random_uuid()` would come from real `pgcrypto`; the substitution must be
   disabled on that path, or tokens are not what they would be in production.
5. Suites must target a **disposable** database. Applying the full 23-migration
   chain per suite group needs 16 clean databases, or a reset function between
   them.

Item 3 is the one to watch: the harness's current isolation is *weaker* than real
Postgres, so making it real can only find more problems, not fewer.

### 6.4 Interim alternative — worth doing before the adapter

The behaviour most at risk from PGlite is expressible as **manual SQL against
staging**, with no code changes:

- §5.4 E16/E17, concurrency on redeem and duplicate onboarding.
- The §3.5 step 4 `auth.uid()` bootstrap probe.
- `pf_platform_*` view behaviour with real `security_invoker = false` semantics.
- Whether any RLS policy behaves differently once a real `pgcrypto` and real role
  grants are present.

That covers most of the gap at near-zero cost.

### 6.5 Suites needing staging-specific fixtures

| Suite | Needs |
|---|---|
| `verify-platform-admin` | a real database, plus a real `pgcrypto`. Its 88 assertions are otherwise portable as-is |
| `verify-staff-invitations` | real database; expiry and single-use benefit most from real concurrency |
| `verify-function-surface` | real database; **most likely to change**, since it asserts the exact grant set and real Supabase grants more than PGlite does |
| `verify-authoritative-checkout`, `verify-void-sale` | real database; real `pgcrypto` token/receipt-number generation |
| `verify-tenant-isolation`, `verify-role-*` | real database |
| all 4 logic suites | nothing |

---

## 7. Out of scope: customer-order persistence

Explicitly **not** part of this task, and not to be started here.

`customer_orders` exists in Postgres and `pf_platform_orders` reads it correctly.
**The application still writes orders to `localStorage`, so the table is empty.**

`/platform/orders` states this permanently above the table and shows no order
count tile on the Overview. This limitation is deliberate and must survive into
staging. If staging order counts appear non-zero, that means something wrote
orders that should not have — investigate rather than celebrate.

Tracked as separate follow-up work.

---

## 8. Blockers

| # | Blocker | Severity | Who |
|---|---|---|---|
| 1 | ~~No staging Supabase project exists~~ **resolved** — staging is `xnhsuifcbplnwtxnpedw`, the CLI link points at it, and `config.staging.toml` records it. The database itself is still unmigrated and unvalidated | none | §2, §3 |
| 2 | No staging Worker / Worker environment | **hard stop** | you — §2.3 step 6 |
| 3 | No harness adapter for real Postgres | high | separate task — §6.3 |
| 4 | `PUBLIC_APP_URL` match between `.env` and the Worker secret unverified | medium | staging only — E2 |
| 5 | `pf_grant_platform_admin` under the new API key format unverified | medium | staging first - §3.5 step 4 |
| 6 | `pf_void_sale` and `pf_revoke_invitation` under suspension have no assertion | low | optional on staging |
| 7 | ~~Migrations 15–17 are untracked~~ **resolved** — the first 20 files are tracked and committed | none | done |
| 8 | Concurrency (`for update`) never exercised | medium | staging only — §5.4 |
| 9 | The three newest staging migrations (`pos_payments_split`, `medicine_knowledge_base`, `returns_and_price_updates`) are uncommitted working-tree files | **hard stop for staging** | review and commit before §3.4 |

**Nothing here was executed.** No migration applied, no deploy, no commit, no
push, no secret touched, no platform-admin role granted. The 23-migration staging
chain has still never been applied to any Postgres server.