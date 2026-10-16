# PharmaFlow — Project Inventory

Generated for Google AI Studio migration preparation. Describes the **existing**
application. Nothing here changes runtime behaviour.

## 1. Repository state at time of writing

| Field | Value |
|---|---|
| Branch | `main` |
| HEAD | `922da67` — *feat(staff): let an owner add and remove staff by invitation* |
| HEAD date | 2026-10-08 |
| Remote | `https://github.com/KhadijaAliyuTata/pharmaflowv3.git` |
| Ahead / behind `origin/main` | **1 ahead, 0 behind** (the HEAD commit is unpushed) |
| Staged changes | **0** |
| Uncommitted | **30 files** — 15 modified, 15 untracked, 0 deleted |

Uncommitted work is **authoritative and must be preserved**. See
`MIGRATION_STATUS.md` for the full file list.

## 2. Stack

| Layer | Package | Version |
|---|---|---|
| UI runtime | `react` / `react-dom` | 19.3.0 |
| Framework | `@tanstack/react-start` | ^1.168.59 |
| Router | `@tanstack/react-router` | ^1.170.40 |
| Table | `@tanstack/react-table` | ^9.2.4 |
| Build | `vite` | ^8.3.1 |
| Edge platform | `@cloudflare/vite-plugin` / `wrangler` | ^1.61.0 / ^4.142.0 |
| Styling | `tailwindcss` / `@tailwindcss/vite` | ^4.3.3 (Tailwind v4) |
| Components | `@base-ui/react`, `shadcn`, `lucide-react` | ^1.8.0 / ^4.21.0 / ^1.48.0 |
| Charts | **`recharts` 3.8.0 (already installed)** | 3.8.0 |
| Backend | `@supabase/supabase-js` | 2.117.1 (pinned) |
| Validation | `zod` | ^4.6.5 |
| Forms | `react-hook-form`, `@hookform/resolvers` | ^7.89.0 / ^5.9.1 |
| Testing DB | `@electric-sql/pglite` (dev) | 0.5.8 (pinned) |
| Language | `typescript` ~5.9.0, `strict: true` | |
| Package manager | **Bun** — lockfile `bun.lock` (176 KB) | |

> `recharts` is **already a dependency**. A dashboard that needs charts does not
> require a new package.

## 3. Scripts

```
bun run dev         vite dev
bun run build       vite build          (emits dist/client + dist/server/wrangler.json)
bun run typecheck   tsc --noEmit
bun run verify:db   bun run supabase/verify/run-all.mjs
bun run check       typecheck + build
bun run deploy      build, then wrangler deploy -c dist/server/wrangler.json
bun run cf-typegen  wrangler types      (regenerates worker-configuration.d.ts)
```

## 4. Source layout

```
src/
  routes/                      33 files — file-based routes
    __root.tsx                 document shell, theme, toaster
    _app.tsx                   authenticated staff layout (pathless)
    _app/*.tsx                 19 staff screens
    _portal.tsx + _portal/portal/*  customer-facing portal (pathless)
    login.tsx  join.tsx        staff sign-in and invitation acceptance
    api.accept-invite.ts       Worker route (service-role, create confirmed user)
    api.send-invite.ts         Worker route (Resend email delivery)
    api.health.ts              Worker route (health probe)
    api/gemini.ts              Worker route (Gemini proxy — key stays server-side)
  components/                  60 files
    app/                       app shell pieces (owner-header, primitives, unit-editor)
    ui/                        44 shadcn/base-ui primitives
    brand-logo.tsx             BrandLogo / BrandMark  [uncommitted]
    chart-area-interactive.tsx Recharts wrapper (shadcn chart pattern)
    section-cards.tsx          dashboard card components
    prescription-dialog.tsx    uses the Gemini route
  domain/                      11 files — pure business logic, no I/O
    units.ts                   base-unit conversion (the canonical unit engine)
    operations.ts              every mutation: checkout, receive, void, adjust, price
    selectors.ts               derived reads (stock status, sellable, dashboard snapshot)
    dashboard.ts               dashboard/valuation/FEFO/team aggregations
    money.ts                   integer-cent arithmetic
    types.ts  state.ts  seed.ts  search.ts  audit-labels.ts  gemini.ts
  lib/
    session.ts                 auth/session, demo gate, signIn, invitation signup
    supabase.ts                client singleton (anon key only)
    supabase/                  repositories: catalog, sales, staff, parties, branches,
                               branch-context, realtime, tenant, result, client, index
    db.types.ts                hand-maintained generated-style Database types
    request-guard.ts           415/413/400 + size and token bounds
    accept-invite.ts  invite-email.ts  join-link.ts  catalogue-writes.ts
    gemini.ts  portal.ts  nav.ts  theme.tsx  use-hotkeys.ts
  store/pharmacy.ts            external store (useSyncExternalStore) + localStorage
  hooks/                       7 hooks — the data-source boundary
supabase/
  migrations/                  15 SQL migrations, timestamp-ordered
  verify/                      21 files: PGlite harness + 17 suites
docs/                          (this package)
```

## 5. Routes

**Public** — `/login`, `/join` (invitation acceptance)

**Staff console** (`/_app`, requires session):
`/` dashboard · `/pos` point of sale · `/inventory` · `/stock-receiving` ·
`/stock-value` · `/expiry` · `/pricing` · `/stock-intelligence` ·
`/demand-radar` · `/medicine-info` · `/sales` · `/reports` · `/orders` ·
`/customers` · `/credit-accounts` · `/suppliers` · `/staff` ·
`/notifications` · `/settings`

**Customer portal** (`/_portal/portal`):
`/portal` · `/portal/search` · `/portal/orders` · `/portal/reminders` ·
`/portal/profile`

**Server routes** — `POST /api/send-invite`, `POST /api/accept-invite`,
`/api/gemini`, `/api/health`

## 6. Data-source map — critical to preserve

| Hook | Reads from | Note |
|---|---|---|
| `use-medicines` | **Supabase** | catalogue + batches; no local fallback in live mode |
| `use-suppliers` | **Supabase** | falls back to store, reports `source` |
| `use-staff` | **Supabase** | [uncommitted changes] |
| `use-is-owner` | **Supabase** (`pf_is_owner()`) | UI gating only |
| `store/pharmacy.ts` | **localStorage** `pharmaflow:state:v3` | sales, customers, credit accounts, orders, receipts, notifications |

Only `checkout` has been moved to an authoritative database operation
(`pf_complete_sale`). **Everything else in `usePharmacyActions` still writes
localStorage.** See `MIGRATION_STATUS.md`.

## 7. Build output

`vite build` emits:
- `dist/client/**` — static assets served by the Worker
- `dist/server/wrangler.json` — deploy-ready Worker config
- `dist/server/index.js` — the Worker

Generated and gitignored: `src/routeTree.gen.ts`, `worker-configuration.d.ts`.
Both must be regenerated after import — see `GOOGLE_AI_STUDIO_MIGRATION.md`.