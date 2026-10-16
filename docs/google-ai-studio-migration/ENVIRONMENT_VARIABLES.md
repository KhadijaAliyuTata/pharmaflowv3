# PharmaFlow — Environment Variables

**Names, purposes and classification only. No values appear in this document, and
none may be added to it.**

Classification:

- **PUBLIC** — carries the `PUBLIC_` prefix; Vite inlines it into the client
  bundle by design (`envPrefix: ['VITE_', 'PUBLIC_']`). Safe in a browser.
- **SERVER-ONLY** — a Cloudflare Worker secret or local dev secret. Must never
  appear in `.env`, in a bundle, in AI Studio settings, or in documentation.

## 1. Public variables (build-time, `.env`)

| Name | Purpose | Required where | Configured? | Notes |
|---|---|---|---|---|
| `PUBLIC_SUPABASE_URL` | Supabase project URL | local dev, AI Studio, production build | ✅ present in `.env` | Not a secret |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/publishable key | local dev, AI Studio, production build | ✅ present in `.env` | Designed for browsers; RLS is the protection. Value is `sb_publishable_…` shaped (46 chars) — **that is expected, not a leak** |
| `PUBLIC_DEMO_MODE` | `"false"` once real credentials exist | all environments | ⚠️ present; **must be `"false"` for real data** | Never a way to relax a production build — see §3 |
| `PUBLIC_APP_URL` | Base address used to build the invitation join link | deployments | ✅ present in `.env` **and** as a Worker secret | Must be the real public address; `localhost` produces dead links on a phone |

## 2. Server-only secrets

| Name | Purpose | Read by | Configuration site | Configured? |
|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Create a confirmed auth user for an invitation address | `src/routes/api.accept-invite.ts` | `wrangler secret put` | ✅ present on the Worker |
| `RESEND_API_KEY` | Send invitation email | `src/routes/api.send-invite.ts` | `wrangler secret put` | ✅ present on the Worker |
| `RESEND_FROM` | Verified sender address | `src/routes/api.send-invite.ts` | `wrangler secret put` | ✅ present on the Worker |
| `GEMINI_API_KEY` | Gemini: NAFDAC verification, AI chat, prescription OCR | `src/routes/api/gemini.ts` | `wrangler secret put` | ⚠️ `.dev.vars` present but **empty**; local Gemini features are unavailable until filled |

All four are declared optional on `Env` and `Cloudflare.Env` in `src/env.d.ts`.
Each route reports its missing configuration rather than throwing at import.

> **The service-role key is the only privileged key in the project.** It exists
> solely because creating a confirmed auth user requires the admin API. It is
> never bundled — verified: 0 occurrences across all 135 client build artefacts.

## 3. `PUBLIC_DEMO_MODE` — the one that needs care

`isDemoMode()` is:

```ts
DEMO_ALLOWED = __DEV_SERVER__          // vite.config.ts define, true only under `vite dev`
isDemoMode() = DEMO_ALLOWED && DEMO_MODE
```

`__DEV_SERVER__` is `command === 'serve'`, **not** an environment variable. So
no CI variable, copied `.env`, or platform setting can make it true in a
production build. Setting `PUBLIC_DEMO_MODE=true` in a **production build** has
no effect; the app still demands real credentials.

**Therefore `PUBLIC_DEMO_MODE=true` is not a way to make AI Studio "work" with
real data** — and it must never be used to demo against real pharmacy accounts.
It only takes effect under `vite dev`, and demo mode reads seeded fixtures with
no database connection at all.

## 4. Environment requirements by context

| Context | Needs |
|---|---|
| Local development | `.env` (4 `PUBLIC_*`), `.dev.vars` (`GEMINI_API_KEY`, optional) |
| Google AI Studio development | `.env` (4 `PUBLIC_*`) only |
| Local `wrangler dev` | `.dev.vars` for Worker secrets |
| Production build | `PUBLIC_*` at build time; Worker secrets at runtime |
| Supabase access | `PUBLIC_SUPABASE_URL` + `PUBLIC_SUPABASE_ANON_KEY` |
| Email delivery | `RESEND_API_KEY` + `RESEND_FROM` (Worker) |
| Gemini features | `GEMINI_API_KEY` (Worker) — **currently unset locally** |
| Invitation acceptance | `SUPABASE_SERVICE_ROLE_KEY` (Worker) |

## 5. Marked as needing verification

| Item | Why |
|---|---|
| `PUBLIC_APP_URL` value | Present in `.env` and as a Worker secret. Both were reported as present; the **values were never compared**, and it is not verified that they match. A mismatch produces broken invitation links. |
| `PUBLIC_DEMO_MODE` value | Present; not read as a value. Treat as **unverified** — confirm it is `"false"` before touching real accounts. |
| Cloudflare custom domain | `pharmaflow.ng` is **not** in `wrangler.jsonc`. `pharmaflow.ng` previously resolved to an unrelated Netlify site. Whether a custom domain is currently bound is **unverified**. |
| Live `wrangler secret list` | Not re-queried during this audit. Presence was established in an earlier session and may have drifted. |

## 6. Handling rules

1. `.env` and `.dev.vars` are gitignored (`.gitignore` lines for both, with
   `.example` variants explicitly allowed). Verify they stay that way.
2. Never add a `SUPABASE_`/`RESEND_`/`GEMINI_` variable to `wrangler.jsonc`
   `vars` — those ship to the browser.
3. Never commit a populated `.env`, `.dev.vars`, or a bundle.
4. Before importing into AI Studio, copy **only** the four `PUBLIC_*` names with
   real values, into an untracked `.env`. Nothing else.
5. If a secret is ever committed or exposed, treat it as compromised: rotate it
   in the issuing dashboard, then update the Worker with `wrangler secret put`.