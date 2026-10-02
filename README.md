# PharmaFlow v3 — TanStack Start on Cloudflare Workers

Parallel rebuild. The v2 codebase (`../pharmaflow-version-2`) is untouched and
stays runnable; screens are ported here one at a time.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | TanStack Start 1.168 (SSR, server functions, file-based routes) |
| Runtime | Cloudflare Workers via `@cloudflare/vite-plugin` |
| Build | Vite 8 |
| UI | shadcn/ui on **Base UI** (shadcn's default base since July 2026) |
| Styling | Tailwind CSS v4, CSS-variable theming |
| Language | TypeScript 5.9, `strict` + `noUncheckedIndexedAccess` |

Theme is shadcn's **Nova** preset, which is fully greyscale — every colour is
`oklch(x 0 0)`, zero chroma, so black and white is literally all there is.
Retheming means editing the token blocks in `src/index.css`; no component
changes. Font is Geist, self-hosted via `@fontsource-variable` (no Google Fonts
request at runtime — matters for an offline-first pharmacy app).

## Setup

```bash
cd ../pharmaflow-v3
bun install
bun run cf-typegen        # writes worker-configuration.d.ts
```

The shadcn components are already installed. To re-sync or add more:

```bash
bunx shadcn@latest add <component>...
```

`components.json` pins `"style": "base-nova"` — Base UI primitives + the Nova
style. If you ever run `shadcn init` again, pass `--base base --preset nova` or
it will switch you to Radix and rewrite the theme.

## Verified

```bash
bun run typecheck   # clean, strict + noUncheckedIndexedAccess
bun run build       # client + ssr both green
bun run dev         # http://localhost:5173
```

Smoke tests, all confirmed passing:

- `curl localhost:5173/api/health` → `{"ok":true,"runtime":"cloudflare-worker",...}`.
  Proves the Worker executes; a working client bundle would not.
- `curl localhost:5173 | grep PharmaFlow` → the `<h1>` is in the server HTML.
- Theme script is inline in `<head>`, so dark mode has no flash on load.
- `/does-not-exist` → HTTP 404 rendered through the app's own boundary.
- No `googleapis`/`gstatic` reference in the output.

Note: dev runs on **5173**, not 3000. v2's Express server may still hold 3000.

## API notes

Version-pinned facts that differ from older TanStack Start / shadcn docs, and
that cost time during setup:

| Thing | Correct here | Not this |
| --- | --- | --- |
| Router factory | `export function getRouter()` in `src/router.tsx` | `createRouter` |
| Server/API routes | `createFileRoute(p)({ server: { handlers: { GET } } })` | `createServerFileRoute` |
| Error handling | `errorComponent` + `notFoundComponent` on the root route | `defaultCatchBoundary` on the router |
| Document | root route renders `<html><head><HeadContent/></head><body>` | omitting it — **production ships unstyled** |
| Slot merging | Base UI `render={<X />}` | `asChild` (Radix) |
| `cn` alias | points at `src/lib/cn.ts` | `src/lib/utils.ts`, which re-exports it — circular |
| Env access | `import { env } from 'cloudflare:workers'` | `process.env`, undefined at module scope |

## App shell

Built from the shadcn registry, not hand-assembled:

| Piece | Source |
| --- | --- |
| `ui/sidebar` | shadcn primitive — collapse, mobile sheet, tooltips, ⌘B |
| `app-sidebar` | `sidebar-01` block, demo data replaced by `~/lib/nav` |
| `app-header` | `sidebar-01` block header + breadcrumb, plus ⌘K and theme |
| `command-menu` | `command` + `dialog` primitives, `cmdk` underneath |
| `routes/_app/*` | TanStack pathless layout, 16 routes from the v2 screen list |

`src/lib/nav.ts` is the single source of truth. The sidebar, the ⌘K palette and
the breadcrumb all read from it, so they cannot drift. v2 kept this in three
places — a nav array, a 22-entry `breadcrumbMap`, and a separate route union.

`_app` is a **pathless** layout: it renders no URL segment, so the route is
`/pos`, not `/_app/pos`. Routes placed outside it (login, onboarding) will not
get the shell.

`role` is hardcoded to `owner` until auth exists. It is threaded through the
sidebar and ⌘K from one place, so wiring a session in is a single change.

## Conventions

- `import { cn } from '~/lib/utils'` is the only way to build a className.
- Components come from `~/components/ui`. Never hand-roll a `<button>`; if a
  variant is missing, add it to the primitive rather than at the call site.
- Base UI uses `render`, not `asChild`. See `src/components/NotFound.tsx`.
- Server-only values (secrets, bindings) are read via `import { env } from
  'cloudflare:workers'`.
- `@cloudflare/vite-plugin` must be registered **before** `tanstackStart()`.

## Status

- [x] Stack: TanStack Start + Workers, routing, SSR, Worker round-trip
- [x] shadcn Base UI (Nova) — 27 components + `sidebar-01` and `dashboard-01` blocks
- [x] Theming, dark mode with no FOUC, error + not-found boundaries
- [x] App shell: sidebar, header, breadcrumb, ⌘K, theme, 16 routes
- [ ] Auth / login (login blocks are in the registry: `login-01` … `login-05`)
- [ ] Port v2 screens, one at a time
      - `data-table.tsx` and `chart.tsx` from `dashboard-01` are already
        installed and are the intended base for Products, Reports and POS.

## Component sizing caveat

shadcn's `Button` defaults to `h-8` (32px) and `sm` is `h-7` (28px). That is
correct for a dense desktop dashboard but below the 44px touch target floor.
POS runs on tablets, so touch-critical controls use `size="lg"` or a taller
local class rather than the default. Decide this explicitly when the POS is
ported — do not let it be inherited by accident.
