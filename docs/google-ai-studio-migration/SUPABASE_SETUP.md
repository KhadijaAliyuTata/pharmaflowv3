# PharmaFlow — Supabase Setup

**Goal: connect the existing application to the existing database. Do not create
a replacement Supabase project and do not substitute a schema.**

## 1. How the project URL is configured

There is no hard-coded URL in source. `src/lib/supabase.ts` reads:

```ts
const url         = import.meta.env.PUBLIC_SUPABASE_URL;
const anonKey     = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
```

and throws only if `getSupabase()` is called while they are absent.
`isSupabaseConfigured()` answers "are both halves present" — it deliberately does
**not** decide whether the app may proceed. That judgement belongs to
`~/lib/session`.

Vite only substitutes `PUBLIC_*` / `VITE_*` (`envPrefix` in `vite.config.ts`), so
a missing variable does not silently break the build — the app reports a
configuration problem instead.

## 2. Required variable NAMES (no values)

| Name | Where it lives | Classification |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | `.env` / build env | **public** — inlined into the client bundle |
| `PUBLIC_SUPABASE_ANON_KEY` | `.env` / build env | **public** — safe in the browser; protected by RLS, not by secrecy |
| `PUBLIC_DEMO_MODE` | `.env` | **public** — must be `"false"` once real credentials exist |
| `PUBLIC_APP_URL` | `.env` + Worker secret | **public** — builds the invitation join link |
| `SUPABASE_SERVICE_ROLE_KEY` | **Worker secret only** | **server-only** — `api.accept-invite.ts` |
| `RESEND_API_KEY` | **Worker secret only** | **server-only** — `api.send-invite.ts` |
| `RESEND_FROM` | **Worker secret** | not a secret, kept server-side with the others |
| `GEMINI_API_KEY` | **Worker secret only** | **server-only** — `api/gemini.ts` |

`.env` and `.dev.vars` are both gitignored. **Never copy a populated `.env` or
`.dev.vars` into AI Studio, the repository, or generated documentation.**

## 3. Migration order

`supabase/migrations/` — 20 files, applied in filename order. Ordering is
lexicographic, not chronological (a version is an opaque sort key). Never edit an
applied migration; add a new one.

```
20261002160000_initial_schema.sql                     ← full schema, enums, RLS
20261004090000_stock_ledger_and_fefo_foundation.sql   ← stock ledger, batch link
20261005120000_unit_hierarchy.sql                     ← packaging units
20261005160000_branch_registration.sql                ← branch_memberships
20261005190000_function_execute_hardening.sql         ← revoke EXECUTE from anon
20261005210000_role_and_destructive_authorization.sql ← owner-only destructives
20261005230000_receipt_pricing_authority.sql          ← receipt pricing guard
20261005250000_branch_membership_role_authority.sql   ← membership role authority
20261005260000_role_change_auditability.sql           ← audited role changes
20261006090000_staff_invitations.sql                  ← staff invitations
20261006150000_staff_invitation_expiry.sql            ← invitation expiry
20261007120000_staff_invitation_claim.sql             ← invitation claim
20261007130000_revoke_invitation_clears_claim.sql     ← revoke clears claim
20261007140000_revoke_invitation_active_claim_only.sql ← revocation scope
20261012120000_authoritative_checkout.sql             ← authoritative checkout
20261012130000_void_sale_restores_stock.sql           ← void sale restores stock
20261012140000_platform_admin.sql                     ← platform admin surface
20261012150000_redeem_invitation_idempotent.sql       ← redeem is idempotent
20261012160000_redeem_invitation_check_order.sql      ← redeem checks order
20261012170000_receive_stock.sql                      ← receiving write path
```

**None of these has ever been applied to any database.** They are verified only
against PGlite. Apply them to a staging project first, never straight to
production.

> Two filenames, `20261005250000_branch_membership_role_authority.sql` and
> `20261005260000_role_change_auditability.sql`, encode the impossible times
> 25:00 and 26:00. They are lexicographic sort keys, not timestamps — see
> `docs/STAGING-VALIDATION.md` §1.2.1. **Do not rename them.**

Read-only inspection (safe):
```
supabase migration list --linked
```

## 4. Connecting the existing project

1. In AI Studio, create a **`.env` file** (untracked) containing only the four
   `PUBLIC_*` variables above. Do not add the service-role key.
2. Set `PUBLIC_DEMO_MODE=false`.
3. Restart the dev server — Vite reads `.env` at startup.
4. Sign in with a real account that already exists in the **existing** project.

There is nothing to migrate. The application talks to Supabase over HTTPS using
the anon key; RLS decides what that key can see. A Supabase project is not
"copied" — pointing the app at the existing URL/key is the entire integration.

## 5. Verifying RLS

Run the suites (they apply the real migration chain to a throwaway in-memory
Postgres and never touch the live database):

```
bun run verify:db
```

Expected when everything is green: `ALL SUITES PASSED — 19 suites`.

**Latest known result (2026-10-17): 18 of 19 suites pass.** `verify-auth-modes.ts`
fails; all other suites pass.

(19 verification suites in `supabase/verify/` — a separate count from the 20 SQL
migrations in `supabase/migrations/`.)

Individual suites of interest:

| Suite | Proves |
|---|---|
| `verify-tenant-isolation.mjs` | one branch cannot read another branch's rows |
| `verify-role-authority.mjs` | a demoted owner immediately loses cost visibility |
| `verify-stock-authority.mjs` | no role can mutate stock without authority; no negative lots |
| `verify-function-surface.mjs` | every `SECURITY DEFINER` pins `search_path`; `anon` can execute nothing |
| `verify-catalogue-read.mjs` | no `select('*')` survives; no service-role key in the client path |
| `verify-authoritative-checkout.mjs` | checkout allocates, deducts once, and refuses bad input |
| `verify-chain.mjs` | the migration chain applies cleanly from empty |

The harness applies migrations to a **fresh in-memory PGlite database per suite**,
so running them cannot modify the production database.

## 6. Manual connectivity check

After configuring `.env`, confirm the app reaches the real database:

1. Sign in — the login screen must not say "demo".
2. Open `/inventory` — products listed must be the real catalogue, not the 15
   seeded demo drugs.
3. Check the network tab: `*.supabase.co/rest/v1/*` requests should return 200.
4. Confirm RLS is doing work: an assistant account must **not** see purchase cost
   anywhere (Stock Value, Reports, line margins).

If step 2 shows demo medicines, the catalogue read fell back — check that
`PUBLIC_DEMO_MODE` is `"false"` and that both `PUBLIC_SUPABASE_*` values are set.

## 7. Do not

- Create a new Supabase project.
- Run `supabase db push` against production.
- Add `SUPABASE_SERVICE_ROLE_KEY` to any `PUBLIC_*` variable or any client bundle.
- Replace `pf_complete_sale` with a client-side computation.
- Disable RLS, or widen `cost_per_base_unit` SELECT, to make a screen work.