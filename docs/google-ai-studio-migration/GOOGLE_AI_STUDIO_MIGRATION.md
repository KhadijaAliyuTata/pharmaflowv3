# PharmaFlow — Google AI Studio Migration Guide

Move the **existing** application into Google AI Studio for development while
keeping the existing Supabase database and the Cloudflare Worker deployment.

**Goal: same stack, same data, same production. Not a rebuild.**

---

## Part 1 — Import the project

### 1.1 Bring the source across, including uncommitted work

The repository has **30 uncommitted files** that are authoritative and are **not**
on GitHub (`origin/main` is 1 commit behind HEAD, and 30 files are uncommitted
locally). Cloning from GitHub would lose all of it.

Preferred — a full-fidelity copy including untracked files:

```powershell
# From the machine that holds the working tree
robocopy "C:\Users\LENOVO\OneDrive\Documents\Default Project\pharmaflowv3" `
        "<destination>\pharmaflowv3" /E /XD node_modules dist .wrangler .git
```

Then create a fresh `git init` in the destination (see §1.6).

### 1.2 Files that must arrive intact

| File | Why |
|---|---|
| `supabase/migrations/20261012120000_authoritative_checkout.sql` | **Untracked.** The `pf_complete_sale` RPC. Losing it breaks the POS. |
| `supabase/verify/verify-authoritative-checkout.mjs` | **Untracked.** Its test suite. |
| `src/lib/accept-invite.ts`, `invite-email.ts`, `request-guard.ts` | **Untracked** |
| `src/routes/api.accept-invite.ts`, `api.send-invite.ts` | **Untracked** |
| `src/components/brand-logo.tsx` | **Untracked** |
| 4 invitation migrations `20261006150000`…`20261007140000` | **Untracked** |
| 4 verify files (`accept-invite`, `invite-email`, `request-guard`) | **Untracked** |
| 15 modified tracked files | include `pos.tsx`, `sales.ts`, `db.types.ts`, `session.ts`, `login.tsx`, `_app/index.tsx` |

**Verify after copying** — `git status --short` must show **0 staged** and the
same 15 modified + 15 untracked entries.

### 1.3 What must NOT be copied

| Item | Reason |
|---|---|
| `.env` | Real values; gitignored |
| `.dev.vars` | Secret slot; gitignored |
| `node_modules/` | Reinstall |
| `dist/` | Stale build output |
| `.wrangler/`, `.output/`, `.vite/`, `.tanstack/` | Local caches |
| `worker-configuration.d.ts` | Generated (616 KB), gitignored |
| `src/routeTree.gen.ts` | Generated, gitignored |
| `src/lib/demo-fixtures.ts` **only if** it is untracked — verify | Demo fixtures |

### 1.4 Restore and verify

```
bun install                 # regenerates node_modules from bun.lock
bun run cf-typegen          # regenerates worker-configuration.d.ts
bun run dev                 # regenerates src/routeTree.gen.ts on first compile
```

If `cf-typegen` needs credentials, `bun run typecheck` will fail on
`cloudflare:workers` until it has run. Copy `worker-configuration.d.ts` across
as a fallback — it is a `.d.ts` and was verified to contain no secret values.

### 1.5 Configure development credentials

Create an **untracked `.env`** in the destination:

```
PUBLIC_SUPABASE_URL=<the EXISTING project's URL>
PUBLIC_SUPABASE_ANON_KEY=<the EXISTING anon/publishable key>
PUBLIC_DEMO_MODE=false
PUBLIC_APP_URL=<the public address staff should open>
```

Do **not** add `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` or `GEMINI_API_KEY`.
Those are Worker secrets and are only needed for local `wrangler dev` (via an
untracked `.dev.vars`) or on the deployed Worker.

### 1.6 Re-establish version control in the destination

The destination is a new folder without `.git`. Either point it at the existing
remote or start a new repository. Either way, **do not commit until you have
reviewed the diff** — the working tree is 1,600+ insertions ahead of HEAD and
represents a lot of unreviewed security work.

---

## Part 2 — Verify nothing was lost

Run these in order. All are safe and non-destructive.

| Command | Expected | Proves |
|---|---|---|
| `bun run typecheck` | exit 0 | types intact |
| `bun run verify:db` | **18 of 19 suites pass** (latest); `verify-auth-modes.ts` fails | schema, RLS, checkout, invitations |
| `bun x vite build` | exit 0 | production Worker builds |

Then confirm in the running app:

1. `/login` — no "demo" notice; sign in with a real existing account.
2. `/inventory` — the **real** catalogue, not the 15 seeded demo drugs.
3. `/pos` — add a product, switch units (tablet / strip / box), and confirm the
   base-unit total.
4. `/staff` — owner sees the roster and can create an invitation.
5. Sign in as an **assistant** — Stock Value, Reports and line margins must all
   be hidden or `—`. Purchase cost must be nowhere in the DOM or network tab.

Checklist:

- [ ] 19/19 verify suites pass
- [ ] `typecheck` and `build` clean
- [ ] real catalogue loads (not seed data)
- [ ] `/pos` prices and completes a sale
- [ ] invitations screen renders
- [ ] attendant sees **no** cost, margin or profit
- [ ] `pf_complete_sale` present in `supabase/migrations/`
- [ ] uncommitted file count matches §1.2

---

## Part 3 — Dashboard integration (Google AI Studio copy)

### 3.1 Current status: **the ZIP is not accessible**

No Google AI Studio export was found. Searched `Downloads`, `Desktop`, the
workspace and `%TEMP%`; the only PharmaFlow archives predate this work
(latest 2026-09-30) and none is an AI Studio export.

**File-level comparison cannot proceed until the ZIP is placed in the workspace**
— e.g. `C:\Users\LENOVO\Downloads\pharmaflow-ai-studio.zip` or anywhere under
`Default Project`. Once present, extract it to a **separate** directory
(`…\ai-studio-reference\`) and never over `pharmaflowv3`.

### 3.2 What already exists in the target project

The chart and dashboard infrastructure the AI Studio version needs is **already
present**:

| Existing | Path | Reuse for |
|---|---|---|
| `recharts@3.8.0` | `package.json` | all charts — **no new dependency** |
| shadcn chart wrapper | `src/components/ui/chart.tsx` | themed `ChartContainer`, tooltips, legends |
| Example chart | `src/components/chart-area-interactive.tsx` | pattern to copy |
| Stat tiles | `src/components/app/primitives.tsx` | KPI cards (`StatTile`, `MaybeMoney`, `SectionTitle`) |
| Section cards | `src/components/section-cards.tsx` | card composition |
| Dashboard | `src/routes/_app/index.tsx` | target for the new layout |
| Aggregations | `src/domain/dashboard.ts` | `stockValuationTotals`, `expiringStockSummary`, `demandRadarSummary`, `teamMembers`, `grossProfitToday` |
| Snapshot | `src/domain/selectors.ts` | `dashboardSnapshot(state, medicines)` |
| Tabs | `src/components/ui/tabs.tsx` | Overview / Inventory / Orders / Activity |

### 3.3 Integration plan

**Can be added as new files (no merge):**
- `src/components/dashboard/*.tsx` — one component per chart
- `src/components/dashboard/overview-tab.tsx`, `inventory-tab.tsx`,
  `orders-tab.tsx`, `activity-tab.tsx`
- New selectors appended to `src/domain/dashboard.ts`
- New columns appended to `src/lib/db.types.ts`

**Requires careful merge:**
- `src/routes/_app/index.tsx` — contains **uncommitted** work (the Total
  Products tile, duplicate-figure cleanup). Diff carefully.
- `src/components/app/primitives.tsx` — shared by every screen
- `src/domain/dashboard.ts` — shared aggregation module
- `src/lib/db.types.ts` — hand-maintained; must stay in sync with the schema
- `package.json` — only if the ZIP needs a package that is not installed

**Must remain unchanged:**
- `vite.config.ts`, `wrangler.jsonc`, `tsconfig.json`, `components.json`
- `supabase/migrations/**`, `supabase/verify/**`
- `src/lib/session.ts`, `src/lib/supabase.ts`, `src/lib/supabase/**`
- `src/domain/units.ts`, `src/domain/operations.ts`
- `src/routes/api.accept-invite.ts`, `api.send-invite.ts`, `api/gemini.ts`
- `src/routes/login.tsx` (holds separate branding work)

### 3.4 Mandatory rules for every KPI and chart

1. **No fabricated data.** Every figure derives from `dashboardSnapshot`,
   `medicines` from `useMedicines()`, or a Supabase read. If the AI Studio copy
   hard-codes arrays, constants or `Math.random()`, that code must be replaced
   before it ships.
2. **Branch-scoped.** Use `useMedicines()` / `useActiveBranch()`. Never filter by
   a client-supplied `branch_id` — RLS is the boundary.
3. **Empty states, not zeros.** Every chart needs an explicit empty state. A donut
   with no data must not render as "0 items" without a message.
4. **No cost leakage.** Gross profit, margin, stock value and purchase cost are
   **owner-only**. Gate with `useIsOwner()` **and** read costs only through the
   owner-gated views. Attendants see the tile with a lock, as the current
   dashboard already does.
5. **Unmet demand, overdue orders and activity feeds** must come from real
   `medicine_requests`, `customer_orders` and `audit_events` rows. If the source
   tables are still localStorage-backed (see `MIGRATION_STATUS.md` §3), the
   chart will read empty in production — that is a data-source problem to fix in
   `src/domain`, not something to paper over in the chart.

### 3.5 Known data-source reality (affects what the charts can show)

| Dashboard figure | Authoritative source today | Usable now? |
|---|---|---|
| Inventory KPIs, stock value, expiry | Supabase (medicines + batches) | ✅ |
| Owner profit / margin | Supabase + `pf_sale_item_costs` | ✅ owner only |
| Recent sales, revenue | **localStorage** (`state.sales`) | ⚠️ empty per device |
| Orders, fulfilment stages | **localStorage** (`customerOrders`) | ⚠️ empty per device |
| Activity feed | **localStorage** (`state.auditEvents`) | ⚠️ empty per device |
| Staff roster | Supabase | ✅ |

**Three of the four tabs in the AI Studio dashboard would render empty against
real data** until those tables are migrated. This is the single most important
input to your decision on ordering the work.

---

## Part 4 — Google AI Studio compatibility

| Requirement | Status |
|---|---|
| Bun | ⚠️ **verify.** The lockfile is `bun.lock`. If AI Studio only offers npm, use `npm install` — it will work but will produce `package-lock.json` and ignore `bun.lock`. Do not commit both. |
| Node version | ⚠️ Vite 8 requires a modern Node. Confirm the AI Studio runtime. |
| Vite dev server | ⚠️ `vite dev` is the only dev command; no alternative server is configured |
| **Cloudflare SSR** | 🔴 **Primary risk.** `cloudflare({ viteEnvironment: { name: 'ssr' } })` targets `workerd`. Without a Cloudflare-compatible runtime the `ssr` environment cannot build, and `src/routes/api*` cannot run. |
| Worker secrets | 🔴 Unavailable. `env.RESEND_API_KEY` etc. have no equivalent |
| Supabase Auth / PostgREST / Realtime | ✅ Should work from a browser, subject to network egress |
| Secrets stay server-side | ✅ Enforced by `envPrefix: ['VITE_','PUBLIC_']` — a `SUPABASE_*` name **cannot** be inlined |
| Production Worker build | ✅ `bun x vite build` still emits `dist/server/wrangler.json` |
| Preview weakening auth/RLS | ✅ `__DEV_SERVER__` folds to `false` in a build, so the demo gate cannot open. **A build-mode preview fails closed rather than running seed data** |

### Recommendation

Do **not** restructure for AI Studio. Keep Cloudflare as the production target and
use AI Studio for editing plus client-side preview. For anything needing the
server routes, run `bun run dev` (the Cloudflare plugin already emulates
`workerd` locally) or use the deployed Worker.

If AI Studio genuinely cannot build the `ssr` environment, add a **separate**
dev-only config rather than editing `vite.config.ts` in place — the plugin order
is load-bearing and documented as such in that file.

### If the `ssr` build fails in AI Studio

Fallback order, least disruptive first:

1. Run `bun run typecheck` + `bun x vite build` in a normal terminal (proves the
   code is sound) and preview only the client in AI Studio.
2. Add an AI-Studio-only `vite.config.ai-studio.ts` that omits the `cloudflare`
   plugin, purely for client preview. Keep the production config untouched.
3. Never option 4: do not replace the Cloudflare plugin in the shared config.

---

## Part 5 — Preserving production

1. Never run `bun run deploy` from AI Studio. Production deploys stay manual from
   a machine with Cloudflare credentials.
2. Never run `supabase db push` from AI Studio against the linked project.
3. Keep the AI Studio workspace on a **development** Supabase project if you want
   an isolated sandbox — but note the application targets **one** project by URL,
   so switching is a `.env` change, not a code change.
4. Re-run `bun run verify:db` after any change to `supabase/**`.