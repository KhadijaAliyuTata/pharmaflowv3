# PharmaFlow — Cloudflare Deployment

**AI Studio is a development environment. It does not replace this deployment.**

## 1. Current configuration — `wrangler.jsonc` (verified)

```jsonc
{
  "name": "pharmaflow",
  "compatibility_date": "2026-09-28",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/react-start/server-entry",
  "observability": { "enabled": true }
}
```

- **Worker name is `pharmaflow`** — confirmed still current.
- `nodejs_compat` is required; without it any dependency touching `node:crypto`,
  `buffer` or `path` fails at runtime.
- **No `routes` / custom domain in the config file.** If `pharmaflow.ng` is in
  use it is configured **in the Cloudflare dashboard**, not here. (Note:
  `pharmaflow.ng` previously resolved to an unrelated Netlify site — verify
  before relying on it.)
- **No active `vars`, no D1, no Hyperdrive.** All three appear only as a
  commented block marked "Not wired yet". Treat them as placeholders, not
  configuration.

### Bindings in use — none configured in this file

| Binding | How it is set | Read by |
|---|---|---|
| `RESEND_API_KEY` | `wrangler secret put` | `api.send-invite.ts` |
| `RESEND_FROM` | `wrangler secret put` | `api.send-invite.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put` | `api.accept-invite.ts` |
| `GEMINI_API_KEY` | `wrangler secret put` | `api/gemini.ts` |

They are declared as optional on `Env` and `Cloudflare.Env` in `src/env.d.ts` —
**not** in `wrangler.jsonc`, so that no secret value ever sits in a config file.
Each route reports its missing configuration instead of throwing at import time.

## 2. Build and deploy

```
bun run build     # emits dist/client/**, dist/server/index.js, dist/server/wrangler.json
bun run deploy    # build, then: wrangler deploy -c dist/server/wrangler.json
```

Deploy **from the built config**, never from `wrangler.jsonc` directly —
`@tanstack/react-start/server-entry` is only resolved by the Vite plugin, which
emits the deploy-ready config during `vite build`.

> Never run `bun run deploy` from a staging copy without copying `.env` into it.
> `.env` is gitignored; a tree built from `git` lacks it and the app boots with
> "Supabase is not configured".

## 3. Runtime relationship to Supabase

```
browser ──HTTPS──> Cloudflare Worker (pharmaflow)
                     │
                     ├─ serves dist/client static assets
                     ├─ SSR via TanStack Start
                     ├─ /api/gemini ──> Google Gemini   (key from Worker secret)
                     ├─ /api/send-invite ──> Resend    (key from Worker secret)
                     └─ /api/accept-invite ──> Supabase Auth admin (service role)

browser ──HTTPS──> Supabase (PostgREST + Auth + Realtime)
                     browser holds ONLY the anon key
```

The Worker is **not** a database proxy. Business logic lives in Postgres RPCs;
the Worker hosts SSR and the four server routes.

## 4. Google AI Studio vs. this deployment

| Capability | Cloudflare Worker | Google AI Studio |
|---|---|---|
| Full SSR + server routes | Yes | **Must be verified — see below** |
| `@cloudflare/vite-plugin` (`workerd` runtime) | Native | **Not available** |
| Worker secrets (`env.X`) | Yes | No |
| Real Supabase connection | Yes | Yes |
| Production deployment | Yes | **No** |

### The blocker

`vite.config.ts` puts `cloudflare({ viteEnvironment: { name: 'ssr' } })` **first**
in the plugin chain. That plugin compiles the SSR bundle for the `workerd`
runtime. If AI Studio runs Vite without a Cloudflare-compatible runtime, the
`ssr` environment cannot build or serve, and every `src/routes/api*` handler is
unavailable.

**Least-disruptive workflow if that happens:**

1. Keep AI Studio as an **editor and client-side preview**.
2. Run the app for real behaviour in a local `wrangler dev` (`bun run dev`,
   which the Cloudflare plugin already emulates) and against the deployed
   Worker.
3. Do **not** swap the Cloudflare plugin for a Node adapter in `main`. Keep it,
   and add any AI-Studio-only handling as a separate, clearly-marked dev config.

## 5. Safe to export vs. must be configured in the destination

**Safe to export (configuration names only, no values):**

| Item | Note |
|---|---|
| `wrangler.jsonc` | contains no secrets; `vars`/D1/Hyperdrive are commented out |
| `vite.config.ts` | no secrets |
| `src/env.d.ts` | type declarations only |
| `package.json`, `bun.lock` | — |
| `tsconfig.json`, `components.json` | — |

**Must be re-configured in the destination, never copied with values:**

| Item | How |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put` in the destination account |
| `RESEND_API_KEY` | `wrangler secret put` |
| `RESEND_FROM` | `wrangler secret put` |
| `GEMINI_API_KEY` | `wrangler secret put` |
| `PUBLIC_*` | build environment / `.env` |
| Worker custom domain + DNS | Cloudflare dashboard, per environment |
| `wrangler login` credentials | never exported |

## 6. Never

- Put a secret in `wrangler.jsonc` `vars` — those ship to the client bundle.
- Export `.dev.vars` or `.env` with real values.
- Replace Cloudflare hosting with Google hosting because the project will be
  opened in AI Studio.
- Expose `SUPABASE_SERVICE_ROLE_KEY` or `GEMINI_API_KEY` to browser code — the
  Gemini proxy route exists precisely so the browser never holds the key.