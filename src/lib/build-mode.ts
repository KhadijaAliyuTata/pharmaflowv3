/**
 * Build-time deployment mode — the leaf module every demo gate reads.
 *
 * ## Why this is separate from `session.ts`
 *
 * `session.ts` imports `setPharmacyCurrentUser` from `~/store/pharmacy`, so any
 * module the store imports that reaches back into `session.ts` closes an import
 * cycle. The store needs the demo flag to decide between the seeded and the empty
 * state, and the honest fix is to move the flag — not to duplicate it, and not to
 * introduce the cycle. This module imports nothing from the app, so both
 * `session.ts` (which re-exports `isDemoMode`) and `store/pharmacy.ts` may depend
 * on it directly.
 *
 * ## How this deployment is allowed to authenticate
 *
 * Three outcomes, and the distinction between the last two is the whole point of
 * this rewrite.
 *
 *   'live'  Supabase is configured. Real authentication, no demo path at all.
 *   'demo'  A DEVELOPMENT SERVER build, Supabase absent, and demo mode requested
 *           explicitly. Seeded accounts, no real data, banner on screen. This
 *           outcome does not exist in a production build.
 *   'broken' Everything else. Authentication is impossible and the app says so.
 *
 * ## Why demo mode is opt-in AND build-gated
 *
 * The flag used to fail OPEN: `!isSupabaseConfigured() && PUBLIC_DEMO_MODE !==
 * 'false'` meant unset, "0", "no", "off" and "true" all enabled a mode that signs
 * the visitor in as an OWNER. Opting in fixed the accidental case but left the
 * deliberate one: a flag is read from the build's environment, so anything that can
 * influence a production build — a CI variable, a copied `.env`, a platform
 * dashboard default — could set it.
 *
 * So demo mode is gated on `__DEV_SERVER__`, injected by `vite.config.ts` as
 * `JSON.stringify(command === 'serve')`. That is a build-mode signal, not an
 * environment variable, so nothing that can influence a production build can make
 * it true. `define` is applied to every environment Vite builds, so it is a literal
 * `false` in both the client and the SSR/worker bundle — unlike `import.meta.env.DEV`,
 * which is left as a runtime lookup in the SSR bundle.
 */

export type DeploymentMode = 'live' | 'demo' | 'broken';

/**
 * Whether this is a development server, decided at BUILD time.
 *
 * Deliberately a direct comparison against the build-time substitution rather than
 * a derived value, so a minifier folds it to a literal and every branch gated on it
 * becomes dead code that is dropped. That is what lets `~/lib/demo-fixtures` be
 * tree-shaken out of a production bundle.
 */
const IS_DEV_BUILD = __DEV_SERVER__ === true;

/**
 * The single constant every demo code path is gated on.
 *
 * Read as a necessary condition, never a sufficient one: it says "this bundle came
 * from a development server", not "demo mode is on". The two come apart on a dev
 * server that also has a real Supabase project configured, which is why callers use
 * `isDemoMode()` (this AND the resolved mode) rather than this constant alone.
 */
export const DEMO_ALLOWED = IS_DEV_BUILD;

function resolveDeploymentMode(): DeploymentMode {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

  const urlPresent = typeof url === 'string' && url.trim().length > 0;
  const keyPresent = typeof anonKey === 'string' && anonKey.trim().length > 0;

  // Configured means BOTH halves. One without the other is a broken deployment,
  // not an absent one, and it is the case that used to slip into demo mode.
  if (urlPresent && keyPresent) return 'live';

  // A production build has no demo mode at all. Not "disabled", not "requires a
  // flag" — the branch does not exist, so there is nothing to set.
  if (!IS_DEV_BUILD) return 'broken';

  // Development server only, and opt-in on top of that. `true` is the single
  // accepted affirmative value, so a typo disables demo rather than enabling a
  // fake owner session.
  const requested = String(import.meta.env.PUBLIC_DEMO_MODE ?? '').trim().toLowerCase();
  if (requested === 'true') return 'demo';

  return 'broken';
}

const DEPLOYMENT_MODE = resolveDeploymentMode();

const DEMO_MODE = DEPLOYMENT_MODE === 'demo';

/** The resolved mode. `session.ts` reads this for `configProblem`/`isAuthUnavailable`. */
export function deploymentMode(): DeploymentMode {
  return DEPLOYMENT_MODE;
}

/**
 * Whether this build may use seeded demo data. Always false in production.
 *
 * Returns `DEMO_ALLOWED && DEMO_MODE` rather than `DEMO_MODE` alone so the
 * consumers in `branch-context.ts`, `use-suppliers.ts`, `use-medicines.ts`, the
 * sidebar and the store also fold to a constant, and so no caller can accidentally
 * treat a mode name as proof that a demo session exists.
 */
export function isDemoMode(): boolean {
  return DEMO_ALLOWED && DEMO_MODE;
}
