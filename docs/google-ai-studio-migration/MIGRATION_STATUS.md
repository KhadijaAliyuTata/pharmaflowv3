# PharmaFlow — Migration Status

Snapshot taken during the Google AI Studio preparation audit.

## 1. Inspected

| Area | Method | Result |
|---|---|---|
| Git branch, HEAD, remotes, history | `git` read-only | branch `main`, HEAD `922da67`, 1 ahead of `origin/main` |
| Working tree | `git status`, `git diff` | 15 modified, 15 untracked, 0 staged, 0 deleted |
| Source tree | directory walk | 33 routes, 60 components, 11 domain, 28 lib, 7 hooks, 1 store |
| Package manager | `package.json`, `bun.lock` | Bun, lockfile 176 KB |
| Build config | `vite.config.ts` | 4 plugins, `envPrefix ['VITE_','PUBLIC_']`, `__DEV_SERVER__` define |
| Deploy config | `wrangler.jsonc` | worker `pharmaflow`, no routes, no vars, no D1/Hyperdrive |
| Secrets | `.env`, `.dev.vars`, `wrangler.jsonc` | **names and shapes only**; no value printed |
| Migrations | all 20 files | chain ordered; none applied to a real database |
| Verification suites | 23 files | 19 runnable suites + 4 support files |
| Gemini integration | `api/gemini.ts`, `lib/gemini.ts`, `domain/gemini.ts` | present; key is server-side |
| AI Studio export ZIP | filesystem search of 4 roots | **not found** |

## 2. Verified

| Check | Command / method | Outcome |
|---|---|---|
| Database schema, RLS, checkout, invitations | `bun run verify:db` | **18 of 19 suites pass** (latest run); `verify-auth-modes.ts` fails, exit 1 |
| Checkout suite specifically | `bun supabase/verify/verify-authoritative-checkout.mjs` | **83 passed, 0 failed**, exit 0 |
| Types | `bun run typecheck` | exit 0 |
| Production build | `bun x vite build` | exit 0 |
| No service-role key in client bundle | scanned all `dist` artefacts | **0 occurrences** |
| `sb_secret_` classification | scanned 283 `dist` files + `node_modules` + `.env` | **false positive** — supabase-js key-format constant, suffix length 0 |
| Secret files not tracked | `git ls-files` | `.env` and `.dev.vars` both gitignored |
| `.env` contents | names + shape only | 4 `PUBLIC_*` vars, **no service-role key present** |
| `wrangler.jsonc` | read | no secrets in `vars` (block is commented out) |

## 3. Unresolved

### 3.1 Blockers for a production deploy

| # | Issue |
|---|---|
| 1 | `pf_complete_sale` migration has **never been applied to any real database**. Verified only against PGlite. |
| 2 | **Void does not restore stock.** No trigger; `sales_owner_void` only permits the UPDATE. Now materially worse because sales genuinely persist. |
| 3 | **Receipts never reach the database.** `receiveStock` writes localStorage, so received stock is invisible to every other device and to the POS. |
| 4 | **Part-paid and credit sales fail from the live POS.** Pickers send seed slugs (`cus-001`, `cred-001`) against `uuid` columns. |
| 5 | **No real concurrency testing.** PGlite is single-connection; `FOR UPDATE` behaviour is unexercised. |

### 3.2 Needs verification

| Item | Why |
|---|---|
| `PUBLIC_APP_URL` value | Present in `.env` *and* as a Worker secret; the two were **never compared**. A mismatch breaks invitation links. |
| `PUBLIC_DEMO_MODE` value | Present, not read. Confirm `"false"` before touching real accounts. |
| Custom domain | `pharmaflow.ng` is **not** in `wrangler.jsonc`; previously resolved to an unrelated Netlify site. Current binding unverified. |
| Live Worker secrets | Presence established in an earlier session; not re-queried in this audit. |
| Deployed Worker contents | Not fetched. Local build artefacts say "no secret"; the **deployed** build was not inspected. |
| Bun availability in AI Studio | Not verified. `bun.lock` is the only lockfile. |

### 3.3 Known defects carried forward

- No rate limiting on `/api/accept-invite`.
- `refundSale` does not exist in the domain; the Supabase `voidSale` repository
  would not restore stock and is called from nowhere.
- `adjustStock` accepts a fractional quantity (no integer guard, no `step="1"`).
- `MedicineRequest.quantityRequested` carries no unit.
- `hashtextextended()` is an undocumented internal function.
- **No unit-test runner**: `src/domain/units.ts` and `src/domain/operations.ts`
  have zero automated tests.

## 4. Uncommitted work (must be preserved)

`HEAD 922da67` is 1 ahead of `origin/main` and unpushed. On top of that:

**Modified (15):** `app-sidebar.tsx` · `env.d.ts` · `use-medicines.ts` ·
`use-staff.ts` · `db.types.ts` · `session.ts` · `supabase/index.ts` ·
`supabase/sales.ts` · `supabase/staff.ts` · `_app/index.tsx` · `_app/pos.tsx` ·
`_app/staff.tsx` · `join.tsx` · `login.tsx` · `verify-staff-invitations.mjs`

**Untracked (15):** `brand-logo.tsx` · `accept-invite.ts` · `invite-email.ts` ·
`request-guard.ts` · `api.accept-invite.ts` · `api.send-invite.ts` ·
4 invitation migrations · **`20261012120000_authoritative_checkout.sql`** ·
4 verify files · **`verify-authoritative-checkout.mjs`**

Diff volume: **15 files changed, 1,613 insertions, 137 deletions.**

The two files flagged by the previous session are **confirmed present**:
`20261012120000_authoritative_checkout.sql` (26,282 bytes) and
`verify-authoritative-checkout.mjs` (29,666 bytes).

## 5. Tests

Preparation-audit snapshot (HEAD `922da67`). The table records the 17 suites that
existed then; `verify-platform-admin` and `verify-void-sale` were added afterwards.
The current result is stated after the table.

| Suite | Result |
|---|---|
| `verify-accept-invite` | 53 passed, 0 failed |
| `verify-audit-integrity` | 20 passed, 0 failed |
| `verify-auth-modes` | 65 passed, 0 failed |
| `verify-authoritative-checkout` | **83 passed, 0 failed** |
| `verify-catalogue-read` | 61 passed, 0 failed |
| `verify-chain` | 36 passed, 0 failed |
| `verify-function-surface` | 25 passed, 0 failed |
| `verify-harness-isolation` | 11 passed, 0 failed |
| `verify-invite-email` | 51 passed, 0 failed |
| `verify-receipt-pricing` | 14 passed, 0 failed |
| `verify-request-guard` | 80 passed, 0 failed |
| `verify-role-audit` | 46 passed, 0 failed |
| `verify-role-authority` | 43 passed, 0 failed |
| `verify-role-integrity` | 18 passed, 0 failed |
| `verify-staff-invitations` | 132 passed, 0 failed |
| `verify-stock-authority` | 15 passed, 0 failed |
| `verify-tenant-isolation` | 20 passed, 0 failed |

At that snapshot no suite failed. In the latest `bun run verify:db` run (2026-10-17),
**18 of 19 suites pass** and `verify-auth-modes.ts` fails. `bun run typecheck` and
`bun x vite build` both exit 0.

**Not tested, and not claimed:** real concurrent transactions; browser behaviour;
any migration against a real database; the deployed Worker.

## 6. Before production deployment

1. Prepare a **staging** project with the **complete, verified 20-migration chain**
   in `supabase/migrations/`, applied in the documented filename order (see
   `docs/STAGING-VALIDATION.md`) — not by applying
   `20261012120000_authoritative_checkout.sql` on its own, since it is one link in
   a chain that depends on the migrations before it. Nothing in the chain has been
   applied to a real database, so staging has not been migrated or validated.
   Then re-run all 19 suites against real PostgreSQL, including a two-connection
   concurrency test for `pf_complete_sale`.
2. Fix void-does-not-restore-stock.
3. Migrate `receiveStock` to a database write, or accept that stock receipts are
   per-device.
4. Migrate the customer and credit-account pickers to Supabase.
5. Confirm `PUBLIC_APP_URL` matches between `.env` and the Worker secret.
6. Verify the assistant role sees no cost, margin or profit anywhere.
7. Commit and push the **12 modified files** (this documentation set plus the
   staging-safeguard scripts) — **with your explicit approval**. The repository
   root also holds two stray untracked files that are not part of this work;
   leave them out.

## 7. Files created by this audit

All new, all documentation, none affecting runtime:

```
docs/google-ai-studio-migration/PROJECT_INVENTORY.md
docs/google-ai-studio-migration/BACKEND_AND_SECURITY.md
docs/google-ai-studio-migration/SUPABASE_SETUP.md
docs/google-ai-studio-migration/CLOUDFLARE_DEPLOYMENT.md
docs/google-ai-studio-migration/ENVIRONMENT_VARIABLES.md
docs/google-ai-studio-migration/GOOGLE_AI_STUDIO_MIGRATION.md
docs/google-ai-studio-migration/MIGRATION_STATUS.md
docs/google-ai-studio-migration/architecture.json
```

**No source file, migration, configuration or secret was modified.** Nothing was
committed, pushed, deployed, or applied to any database.