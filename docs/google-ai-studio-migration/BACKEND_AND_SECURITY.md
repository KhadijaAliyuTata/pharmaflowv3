# PharmaFlow — Backend, Security and Trust Boundaries

Describes the security architecture **as it exists**. Google AI Studio must not
weaken any of it.

## 1. Where code runs

| Tier | Where | Examples |
|---|---|---|
| Browser | React client | all `src/routes/_app/*`, `pos.tsx`, `login.tsx` |
| Worker (server) | Cloudflare, `src/routes/api*` | send-invite, accept-invite, gemini, health |
| Database | Supabase Postgres | all RLS, all `pf_*` functions, all triggers |

**Invariant: no privileged operation runs in the browser.** Moving one there to
satisfy a preview environment is prohibited.

## 2. Authentication

- Supabase Auth (`@supabase/supabase-js` 2.117.1), session persisted in
  localStorage so an attendant can open the app on a dropped connection.
- Client created in `src/lib/supabase.ts` with **only** `PUBLIC_SUPABASE_URL` and
  `PUBLIC_SUPABASE_ANON_KEY`. There is no service-role key anywhere in client code.
- `src/lib/session.ts` owns the session lifecycle: `useSession`, `signIn`,
  `signUpWithInvitation`, `requestCustomerOtp`, `verifyCustomerOtp`.

### The demo gate — do not weaken

```ts
const DEMO_ALLOWED = IS_DEV_SERVER;   // vite.config.ts `define: { __DEV_SERVER__ }`
export function isDemoMode() { return DEMO_ALLOWED && DEMO_MODE; }
```

`__DEV_SERVER__` is `command === 'serve'` — true only under `vite dev`. It is
deliberately **not** derived from an environment variable, so no CI variable,
copied `.env`, or platform dashboard setting can make it true in a production
build. `PUBLIC_DEMO_MODE` alone is explicitly documented as insufficient.

> **Risk if AI Studio runs in "build" mode:** the demo gate folds to `false` and
> the app requires real credentials. This is correct and safe — it will refuse to
> run rather than silently using seeded accounts. It does **not** disable RLS or
> validation.

## 3. Tenant and branch isolation

Multi-tenant: a pharmacy is a `branch`. Users hold `branch_memberships` rows.

| Function | Purpose |
|---|---|
| `pf_current_branch()` | resolves the caller's branch from `profiles.branch_id` |
| `pf_current_role()` | `owner` / `assistant` from the profile |
| `pf_is_owner()` | role check |
| `pf_is_staff()` | is a staff member with a branch |
| `pf_set_active_branch(uuid)` | **the only** RPC exposed to `authenticated` |

Every RLS policy reads through `pf_current_branch()`. Client code never filters
on `branch_id` — RLS is the only tenant boundary.

## 4. RLS

Enabled on every tenant table. Representative policies:
`sales_owner_void` (owner-only UPDATE), `sale_items_read` (visibility inherited
from the parent sale), `medicines_read` (branch-scoped), plus INSERT-only and
owner-only policies for destructive operations.

`sale_items` has **no UPDATE policy at all** — sale lines are immutable.
`medicines.total_quantity` cannot be set by a client; `pf_guard_total_quantity`
recomputes it from `medicine_batches` on every write.

## 5. Financial confidentiality

- `cost_per_base_unit` is **not selectable** by `authenticated`. It is published
  through owner-gated views: `pf_medicine_costs`, `pf_batch_costs`,
  `pf_sale_item_costs`.
- Consequently **every read in `src/lib/supabase/catalog.ts` names its columns
  explicitly.** Using `select('*')` fails with `42501 permission denied` — this is
  deliberate, not a bug to work around.
- `Medicine.costPerBaseUnit` is optional; `hasCost()` guards every cost-derived
  calculation. Missing cost renders `—`, never `₦0`.
- `MaybeMoney` in `src/components/app/primitives.tsx` renders `—` for absent cost.

> Any new dashboard chart **must** read costs only through those owner-gated
> views. A chart that queries a base table directly will fail rather than leak —
> but verify it, do not assume.

## 6. Function surface hardening

`20261005190000_function_execute_hardening.sql` revokes `EXECUTE` on every
`pf_*` function from `public` and `anon` (PostgreSQL grants it to `PUBLIC` by
default). Only `pf_set_active_branch` is granted to `authenticated`.
`verify-function-surface.mjs` fails loudly if that drifts.

Every `SECURITY DEFINER` function pins `set search_path = public`. This is
asserted by `verify-function-surface.mjs`.

## 7. Checkout and inventory integrity

### Base-unit model

Every quantity is an integer count of **base units**. Packaging is a conversion
layer, never a second source of truth. `src/domain/units.ts` is the only place
unit arithmetic happens; multipliers are flat (`box = 100`, not "10 cards of 10")
so they are integer-exact and cannot be circular.

`validateUnitHierarchy` enforces: at least one unit, unique keys, positive-integer
multipliers, exactly one unit with `multiplier = 1`, and that it comes first —
mirroring `pf_check_base_unit` in the database.

### Authoritative checkout — `pf_complete_sale`

Added in the **uncommitted** migration `20261012120000_authoritative_checkout.sql`.

| Property | How |
|---|---|
| Authentication | `auth.uid()`; refuses when null |
| Tenant | `pf_current_branch()` — never a client-supplied branch |
| Staff-only | `pf_is_staff()` |
| Server-derived pricing | multiplier and `sellingPrice` read from the product's own `units` jsonb |
| Server-derived totals | `base_units_total`, subtotal, discount, total, outstanding all recomputed |
| FEFO | lots ordered `expiry_date, received_date, id`, excluding recalled and expired |
| Concurrency | `medicines … FOR UPDATE` per line, then eligible batches `FOR UPDATE`; consistent lock order prevents deadlock |
| No double deduction | single-lot lines set `batch_id` so the existing trigger deducts; split lines leave it null and the function deducts. Mutually exclusive |
| Atomicity | one transaction; any `raise` rolls back header, lines, allocations, movements |
| Idempotency | partial unique index on `(branch_id, idempotency_key)` |
| Cost leakage | return carries no cost value |

**Why this exists.** The POS priced from the Supabase catalogue but validated
against `state.medicines` — the seeded prototype copy in localStorage whose ids
are slugs (`med-paracetamol`) against database `uuid`s. The lookup could not
match, so a real sale failed with "Unknown product". `src/lib/catalogue-writes.ts`
documents the same mismatch and disables catalogue edits because of it.

## 8. Staff invitations

| Migration | Purpose |
|---|---|
| `20261006090000_staff_invitations` | table + create/revoke/redeem RPCs |
| `20261006150000_staff_invitation_expiry` | expiry enforcement |
| `20261007120000_staff_invitation_claim` | claim-with-lease |
| `20261007130000` / `20261007140000` | revoke clears claim; fix an `IS DISTINCT FROM` defect |

Flow: owner creates an invitation (service-role only) → `POST /api/send-invite`
sends via Resend → invitee opens `/join?token=…` → `POST /api/accept-invite`
claims for a **4-minute lease**, creates a confirmed auth user
(`email_confirm: true` — the invitation email already proved the address), signs
in, then `pf_redeem_invitation()` grants the membership.

- The address is **always** read from the invitation row; no `email` field exists
  in the request body.
- `pf_claim_invitation` is `service_role` only and unreachable as an RPC.
- `src/lib/request-guard.ts` enforces 415 / 413 / 400, an 8 KiB body limit and
  `MAX_TOKEN_LENGTH = 64`.

## 9. Gemini integration

`src/routes/api/gemini.ts` is a **Worker route**. The browser posts to `/api/gemini`;
the Worker reads `GEMINI_API_KEY` from its secret binding and calls
`gemini-2.5-flash`. **The key never reaches the browser.** This is the pattern to
preserve — see `CLOUDFLARE_DEPLOYMENT.md`.

## 10. Unresolved security findings

| # | Severity | Finding |
|---|---|---|
| 1 | **High** | **Void does not restore stock.** No trigger returns stock when `sales.state` becomes `voided`/`refunded`; `sales_owner_void` only permits the UPDATE. Previously unreachable because sales never persisted — now that they do, voiding a real sale loses that stock permanently. |
| 2 | **High** | **`receiveStock`, `adjustStock`, `approvePricing`, `updateUnits`, `setSafetyLock`, `setBatchRecall`, `recordCreditPayment` all still write localStorage.** Receipts never reach the database, so received stock is invisible to the POS. |
| 3 | **Medium** | POS customer and credit-account pickers read `state.customers` / `state.creditAccounts` (seed slugs `cus-001`, `cred-001`) against database `uuid`s. **Part-paid and credit sales from the live POS are refused.** Cash sales work. |
| 4 | **Medium** | No rate limiting on the unauthenticated `/api/accept-invite`. |
| 5 | **Medium** | `refundSale` does not exist in the domain. The Supabase `voidSale` repository would not restore stock and is called from nowhere. |
| 6 | **Low** | `adjustStock` accepts a fractional `newQuantity` (no `Number.isSafeInteger`; input lacks `step="1"`). The database would reject it, the local store would not. |
| 7 | **Low** | `MedicineRequest.quantityRequested` carries no unit, so an order for "3" is uninterpretable. |
| 8 | **Low** | `hashtextextended()` in the checkout receipt lock is an undocumented internal function. |

## 11. Verification

`bun run verify:db` runs **17 PGlite suites** (~700 assertions) against the real
migration chain. Suites of note: `verify-tenant-isolation`,
`verify-role-authority`, `verify-stock-authority`, `verify-function-surface`,
`verify-catalogue-read`, `verify-staff-invitations`,
`verify-authoritative-checkout`, `verify-chain`, `verify-audit-integrity`.

**Limitation:** PGlite is single-connection. Row-lock contention in
`pf_complete_sale` is **not** exercised. There is no unit-test runner, so
`src/domain/units.ts` and `src/domain/operations.ts` have **zero** automated
tests.