# PharmaFlow — build draft

Where the rebuild actually stands. Written so this can be picked up cold.

---

## Deploying the demo to Cloudflare

The client-facing goal: open a URL, land on the dashboard, click around.

### One-time, from your machine

```bash
cd ~/Documents/pharmaflow-v3
npx wrangler login
bun run deploy
```

That builds and deploys. Wrangler prints a `*.workers.dev` URL.

If you want a real domain, Cloudflare dashboard → Workers & Pages → `pharmaflow`
→ Settings → Domains & Routes → Custom Domain.

### Connect a GitHub repo (auto-deploy on push)

Workers and Pages are one product in the dashboard now, and Workers supports Git
integration directly — so there is no "Workers vs Pages" decision to make. This
app is server-rendered, so it deploys as a Worker.

**Workers & Pages → Create application → Get started → Import a repository**

Pick the repo, then under **Settings → Builds**:

| Field | Value |
| --- | --- |
| Build command | `bun install && bun run build` |
| Deploy command | `bunx wrangler deploy -c dist/server/wrangler.json` |
| Root directory | blank (repo root) |

Three things that will fail the build if you get them wrong:

1. **Build command must be `bun install`, not the default `npm install`** — this
   repo has `bun.lock`, no `package-lock.json`.
2. **Deploy from `dist/server/wrangler.json`, not the root `wrangler.jsonc`.**
   The Vite plugin generates the former during `bun run build`, and it is the
   only one carrying the correct `main` plus the `assets` binding to
   `../client`. The root file is for `name`, `compatibility_date` and secrets.
3. **The Worker name in the dashboard must match `name` in `wrangler.jsonc`**,
   which is `pharmaflow`. Cloudflare fails the build on a mismatch. Name the
   Worker `pharmaflow` when importing.

### Supabase environment variables (later, not needed for the demo)

Set under Settings → Environment Variables in the dashboard:

```
PUBLIC_SUPABASE_URL
PUBLIC_SUPABASE_ANON_KEY
PUBLIC_DEMO_MODE=false
```

Until those exist the app runs in **demo mode**: no login, auto-signed-in as the
owner, everything backed by seeded in-memory data. That is what you show the
client now. Flip `PUBLIC_DEMO_MODE` once Supabase is real.

---

## What is built and verified

Verified by running the dev server and inspecting server-rendered HTML, not by
inspection. `/` returns the dashboard with `Dashboard`, `Revenue today`,
`Needs attention`, `Reorder urgently` all present in the SSR response.

| Area | State |
| --- | --- |
| Stack | TanStack Start 1.168 on Cloudflare Workers, Vite 8, Tailwind v4, TS strict |
| UI | shadcn on **Base UI**, Nova preset, 38 primitives |
| Theming | Neutral greyscale, dark mode with no flash on load |
| Domain | Types, money math, selectors, 11 mutations — all pure and unit-testable |
| Staff screens | 16 routes: dashboard, POS, inventory, pricing, receiving, orders, expiry, intelligence, medicine info, customers, credit, suppliers, staff, reports, notifications, settings |
| Customer portal | 5 routes under `/portal`: home, search, orders, reminders, profile |
| Gemini proxy | `/api/gemini` on the Worker — 3 modes, validated, returns clean 503 with no key |
| Barcode | Camera scanner via native `BarcodeDetector`, manual-entry fallback |
| Auth | Supabase email/password + phone OTP, with an offline session cache |
| Database | `supabase/schema.sql` — 17 tables, RLS, column grants, triggers |
| Tests | **None.** No test runner is installed. |
| Lint | `tsc --noEmit` only. No ESLint, no Prettier. |

---

## What is demo, and what is real

This distinction matters more than the feature list.

**Real and enforced by the database**
- RLS scopes every table to the caller's branch
- Column grants hide `cost_per_base_unit` from assistants — RLS filters rows,
  grants filter columns, so this needed both
- A trigger recomputes `total_quantity` from live batches, so stock cannot drift
- A trigger rejects an assistant approving pricing
- A trigger rejects a credit-ledger row whose balance disagrees with the account

**Real but unverified**
- Gemini happy path — no valid API key, so only the 503 and 502 paths were run
- Barcode camera — needs a physical device and a secure origin

**Demo / not built**
- All domain data is seeded in `localStorage`. Nothing is in Supabase yet.
- No order creation, no prescription upload, no supplier or staff editing
- NAFDAC "verification" is model knowledge, not a database lookup — do not
  present it to a pharmacist as a clearance
- Sync layer is not written. The local store is the only store.

---

## Known gaps, in priority order

1. **No sync.** `src/store/pharmacy.ts` writes to `localStorage` and stops.
   The write-through queue and conflict resolution described in the plan do not
   exist. This is the biggest single piece of missing work.
2. **No tests.** `bun run typecheck` is the only gate. The domain layer
   (`checkout`, `voidSale`, `receiveStock`) is pure and written to be testable,
   so a Vitest suite here would be cheap and would catch money bugs.
3. **Supabase migration not started.** `src/lib/session.ts` and
   `src/lib/supabase.ts` are written and typecheck, but no query in the app
   reads from Supabase yet. The schema has never been applied to a database.
4. **Drizzle not adopted.** Tables are hand-written in `schema.sql` and mirrored
   in a hand-written `src/lib/db.types.ts`. Two sources that can drift. Should
   become `src/db/schema.ts` with RSQL reduced to just the policies, grants and
   triggers that no ORM can express. `drizzle-orm`, `drizzle-kit` and `postgres`
   are installed.
5. **Offline-first is half-built.** Auth caches a session so the app opens
   offline. The data layer has no equivalent — a reload while offline loses
   nothing yet only because nothing is persisted to a server.

---

## Things worth knowing before you change anything

**Base UI, not Radix.** `render={<Link to="/x" />}` — never `asChild`. Most
shadcn examples online are Radix-era and will look right and be wrong.

**Money never gets arithmetic inline.** Use `~/domain/money`. Every figure
renders through `<Money value={n} />` so digits align. `schema.sql` uses
`numeric(14,2)`; the JS layer rounds on every operation.

**`~/lib/nav.ts` is the only place navigation is declared.** The sidebar, the ⌘K
palette and the breadcrumb all read from it. Adding a screen is one entry.

**Touch targets.** POS runs on tablets. shadcn's `Button` default is `h-8`
(32px) and `sm` is 28px — both below the 44px floor. POS uses explicit `h-11`.

**Server routes** use `createFileRoute(p)({ server: { handlers } })`. There is
no `createServerFileRoute` in this version.

**`getRouter`** must stay a named export in `src/router.tsx`; the build resolves
it through a virtual module and hard-requires that name.

**`HeadContent` must be rendered** in the root route, or every `head()` entry is
dropped — including the stylesheet. Dev hides this because Vite injects CSS via
JS; production ships unstyled.

---

## Where things are

```
src/domain/        types, money, selectors, operations, seed  — pure, no React
src/store/         pharmacy.ts — external store with selectors
src/lib/           supabase.ts, db.types.ts, session.ts, nav.ts, portal.ts
src/components/ui/ 38 shadcn primitives (Base UI)
src/components/app/ app-wide primitives: PageHeader, StatTile, Money, badges
src/routes/_app/   16 staff screens
src/routes/_portal/ 5 customer screens
src/routes/api/    health, gemini
supabase/schema.sql  17 tables + RLS + grants + triggers
```

---

## Local commands

```bash
bun install
bun run dev          # http://localhost:5173
bun run typecheck
bun run check        # typecheck + build
bun run deploy       # build + wrangler deploy
bun run cf-typegen   # regenerate worker-configuration.d.ts after binding changes
```