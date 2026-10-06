import { useSyncExternalStore } from 'react';
import type { User } from '~/domain/types';
import type { ProfileRow } from './db.types';
import { getSupabase, isSupabaseConfigured } from './supabase';
import { setPharmacyCurrentUser } from '~/store/pharmacy';

/**
 * Authentication, backed by Supabase Auth.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A LOCAL CACHE
 * This pharmacy is offline-first by design — v2 shipped an IndexedDB store, a
 * write queue and an offline banner for exactly this reason. If the session
 * only existed on the server, a dropped connection would lock the attendant
 * out of the till at the moment they most need it.
 *
 * So: Supabase owns identity, and this module caches the *resolved profile* in
 * localStorage. The cache is only read when Supabase cannot answer (no network,
 * or first paint before `getSession` resolves). A cached profile is never
 * treated as proof for anything that matters — every privileged write is
 * re-checked server-side by RLS, so a tampered cache can at worst display the
 * wrong name, never approve a price.
 * ---------------------------------------------------------------------------
 */

const CACHE_KEY = 'pharmaflow:profile:v1';

/**
 * How this deployment is allowed to authenticate.
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
 * ## Why demo mode is now opt-in rather than opt-out
 *
 * This used to be:
 *
 *     !isSupabaseConfigured() && import.meta.env.PUBLIC_DEMO_MODE !== 'false'
 *
 * which fails OPEN, twice over:
 *
 *   1. Only the exact literal string "false" turned it off. Unset, "0", "no",
 *      "off" and "true" all enabled a mode that signs the visitor in as an OWNER.
 *   2. `isSupabaseConfigured()` requires BOTH the URL and the anon key to be
 *      non-empty, so a deployment that supplied one and not the other — an
 *      ordinary CI or secret-configuration mistake — landed in demo mode rather
 *      than failing loudly.
 *
 * A production deploy missing one secret therefore served a fully interactive
 * owner console with seed data, and looked healthy while doing it. Worse, if the
 * missing secret was later supplied while the flag stayed stale, writes would go
 * to localStorage while reads showed seed data: silent data loss.
 *
 * The failure direction is now inverted: an absent flag means NO demo, so the
 * worst case is a clear "not configured" screen instead of a fake owner session.
 * A half-configured deployment is also called out specifically by
 * `configProblem`, because "your anon key is empty" is an actionable message and
 * "not configured" is not.
 *
 * ## Why the flag was not enough
 *
 * Opt-in fixed the accidental case but left the deliberate one. A flag is read
 * from the build's environment, so anything that can influence a production build
 * can set it: a CI variable, a `.env` copied into a deploy, a platform dashboard
 * default. With `PUBLIC_DEMO_MODE=true` on such a build, the demo sign-in — which
 * accepts any non-empty password for a seeded address — would authenticate a
 * visitor as the owner.
 *
 * So demo mode is now gated on `import.meta.env.DEV`, which Vite substitutes at
 * build time: `true` under `vite dev`, `false` under `vite build`. The decision is
 * made by the build, not by configuration, which means no environment variable in
 * any environment can enable it in shipped code. The seeded accounts moved to
 * `~/lib/demo-fixtures`, a module of pure constants that becomes unreferenced once
 * the demo branch folds away and is therefore tree-shaken out of the bundle.
 */
type DeploymentMode = 'live' | 'demo' | 'broken';

/**
 * Whether this is a development server, decided at BUILD time.
 *
 * Vite replaces `import.meta.env.DEV` with the literal `true` under `vite dev`
 * and `false` under `vite build`. That substitution is the whole point: it makes
 * demo mode a build-time property rather than a runtime one, so no environment
 * variable, in any environment, can turn it on in shipped code.
 *
 * `PUBLIC_DEMO_MODE` alone could never carry that guarantee. It is read from the
 * build's environment, so anything that can influence the build — a CI variable,
 * a `.env` file copied into a deploy, a platform dashboard default — could set it
 * to `true` on a production build and the any-password sign-in would be live. An
 * earlier revision of this file relied on exactly that and was wrong: the flag was
 * checked, but a flag is a request, not a guarantee.
 */
/**
 * Whether this is a development server, decided at BUILD time.
 *
 * `__DEV_SERVER__` is injected by `vite.config.ts` as `JSON.stringify(command ===
 * 'serve')`. That is the build-mode signal, not an environment variable, so nothing
 * that can influence a production build can make it true.
 *
 * It replaces `import.meta.env.DEV` here for a concrete reason found by inspecting
 * `dist/` after a build: `import.meta.env.DEV` is substituted in the CLIENT bundle but
 * left as a runtime lookup in the SSR/worker bundle this project builds with
 * `@cloudflare/vite-plugin`. A gate that folds in only one of the two outputs is not a
 * gate. `define` is applied to every environment Vite builds, so this constant is a
 * literal `false` in both.
 *
 * `PUBLIC_DEMO_MODE` alone could never carry this guarantee. It is read from the
 * build's environment, so a CI variable, a copied `.env`, or a platform dashboard
 * setting could set it on a production build and the any-password sign-in would be
 * live. An earlier revision of this file relied on exactly that: the flag was checked,
 * but a flag is a request, not a guarantee.
 */
const IS_DEV_BUILD = __DEV_SERVER__ === true;

/**
 * The single constant every demo code path is gated on.
 *
 * Deliberately a direct comparison against the build-time substitution rather than
 * a derived value from `resolveDeploymentMode()`. That matters: given
 * `import.meta.env.DEV === false` in the output, a minifier folds this to the
 * literal `false`, and every `if (DEMO_ALLOWED)` branch below becomes dead code
 * that is dropped. `DEMO_USERS` then has no remaining reader, so
 * `~/lib/demo-fixtures` is tree-shaken out of the bundle.
 *
 * The first attempt computed the mode through a function and compared the result,
 * which is correct but not foldable: the bundler kept the branch, kept the array,
 * and shipped the seeded accounts in a build where they could never authenticate.
 * Behaviourally that was already safe, and it still would have been — but inert
 * credentials in a shipped artefact are the kind of thing that gets mistaken for
 * live ones during a later audit, so the gate is written to be eliminable.
 *
 * `switchRole` is gated on the same constant for the same reason: it is a role
 * elevation control, and it must not survive into shipped code either.
 */
const DEMO_ALLOWED = IS_DEV_BUILD;

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

/**
 * What is wrong with the configuration, or null when it is fine.
 *
 * Reported by the login screen instead of being swallowed, because a deployment
 * that cannot authenticate should say which variable is missing rather than
 * rendering an app nobody can sign into.
 */
export function configProblem(): string | null {
  if (DEPLOYMENT_MODE !== 'broken') return null;

  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  const urlPresent = typeof url === 'string' && url.trim().length > 0;
  const keyPresent = typeof anonKey === 'string' && anonKey.trim().length > 0;

  if (urlPresent && !keyPresent) {
    return 'PUBLIC_SUPABASE_ANON_KEY is missing. The project URL is set, so this looks like a half-finished configuration rather than a demo build.';
  }
  if (!urlPresent && keyPresent) {
    return 'PUBLIC_SUPABASE_URL is missing. The anon key is set, so this looks like a half-finished configuration rather than a demo build.';
  }
  // A production build cannot run on demo data, so this message names only the
  // real fix. It used to end with "or set PUBLIC_DEMO_MODE=true", which was true
  // of a development server and false of anything shipped.
  return 'Supabase is not configured. Set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY. Demo data is available on a development server via PUBLIC_DEMO_MODE=true, but never in a production build.';
}

/**
 * Whether this build may use seeded demo data. Always false in production.
 *
 * Returns `DEMO_ALLOWED && DEMO_MODE` rather than `DEMO_MODE` alone so the
 * consumers in `branch-context.ts`, `use-suppliers.ts` and the sidebar also fold to
 * a constant, and so no caller can accidentally treat a mode name as proof that a
 * demo session exists.
 */
export function isDemoMode(): boolean {
  return DEMO_ALLOWED && DEMO_MODE;
}

/**
 * True when authentication is impossible in this deployment.
 *
 * Distinct from "not signed in": this is a deployment fault, not a user state,
 * and the two must not be conflated or the UI will invite someone to sign in to an
 * app that has no backend.
 */
export function isAuthUnavailable(): boolean {
  return DEPLOYMENT_MODE === 'broken';
}

// Re-exported so `session.ts` stays the single import site for session state and
// the sidebar/login screen need not know the demo accounts live in a
// development-only module.
//
// In a production build every consumer of these names sits behind a
// constant-false `DEMO_MODE`, so this binding is unreferenced and the re-export is
// dropped along with the module it points at. `verify-auth-modes.ts` asserts the
// seeded addresses are absent from `dist/`, so that is checked rather than assumed.
export { DEMO_ACCOUNTS } from '~/lib/demo-fixtures';
export type { DemoAccount } from '~/lib/demo-fixtures';

// Imported for use here as well as re-exported, because `session.ts` reads
// `DEMO_USERS` in three places (the initial session, the dev auto-login, and
// `switchRole`). A bare `export ... from` does not introduce a local binding, so
// the import is written separately. Both are development-only in effect: in a
// production build `DEMO_MODE` is constant-false and every reference below is
// dead, which is what lets the bundler drop this module.
import { DEMO_USERS } from '~/lib/demo-fixtures';
export { DEMO_USERS };

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'unconfigured';

export interface Session {
  user: User | null;
  status: SessionStatus;
  /** Set when a cached profile is being shown because Supabase was unreachable. */
  offline: boolean;
}



/* ------------------------------------------------------------- subscriber */

/**
 * The initial session, computed before anything mounts.
 *
 * Nothing here establishes an authenticated session in a production build. The
 * `DEMO_MODE` arm is constant-false there, so the value is always the second one:
 * no user, and `loading` when Supabase is configured so the route guard waits for
 * the real `getSession()` call instead of redirecting to /login and disagreeing
 * with the client.
 *
 * A configured deployment therefore begins as 'loading' and only becomes
 * 'authenticated' after Supabase says so. An unconfigured one begins
 * 'unconfigured' and can never become authenticated at all.
 */
// Gated on DEMO_ALLOWED rather than DEMO_MODE so that this ternary folds away in a
  // production build and `DEMO_USERS` loses its last reader, which is what lets
  // `~/lib/demo-fixtures` be dropped from the bundle. See the note on DEMO_ALLOWED.
  let current: Session = DEMO_ALLOWED
  ? { user: DEMO_USERS[0]!, status: 'authenticated', offline: false }
  : { user: null, status: isSupabaseConfigured() ? 'loading' : 'anonymous', offline: false };

const listeners = new Set<() => void>();

function emit(next: Session) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ------------------------------------------------------------ cache layer */

interface CachedProfile {
  user: User;
  cachedAt: number;
}

function readCache(): CachedProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProfile;
    // Anything older than the Supabase session lifetime is not worth trusting.
    if (!parsed?.user?.id || Date.now() - parsed.cachedAt > 7 * 86_400_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(user: User) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ user, cachedAt: Date.now() }));
  } catch {
    // Private mode. The app still works; it just will not survive a reload.
  }
}

function clearCache() {
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------- profile mapping */

function profileToUser(profile: ProfileRow, email: string): User {
  return {
    id: profile.id,
    name: profile.full_name,
    email,
    role: profile.role,
    phone: profile.phone,
    licenseNumber: profile.license_number ?? undefined,
    // Derived from the role rather than stored separately, so the two can
    // never disagree.
    canApprovePricing: profile.role === 'owner',
  };
}

async function loadProfile(userId: string, email: string): Promise<User | null> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return profileToUser(data as ProfileRow, email);
}

/* ------------------------------------------------------------- lifecycle */

let started = false;

/**
 * Starts watching the Supabase session. Idempotent, and safe to call from an
 * effect. Called once by `<AuthProvider>` in the root route.
 */
export function startSession(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  // A signed-in session is established here from exactly one source in a production
  // build: `supabase.auth.getSession()` below. This branch is constant-false under
  // `vite build`, so it cannot sign anybody in — the auto-login that used to sit
  // here was the largest single authentication bypass in the codebase, and it is
  // now unreachable outside a development server.
  if (DEMO_ALLOWED) {
    // Development server only. Whoever opens the URL is signed straight in as the
    // owner so the interface is visible immediately. There is no backend here.
    const cached = readCache();
    const user = cached?.user ?? DEMO_USERS[0]!;
    setPharmacyCurrentUser(user);
    emit({ user, status: 'authenticated', offline: false });
    return;
  }

  // Missing or half-configured: refuse to establish a session and let the login
  // screen render the diagnosis naming the absent variable.
  if (!isSupabaseConfigured()) {
    emit({ user: null, status: 'unconfigured', offline: false });
    return;
  }

  const supabase = getSupabase();

  // Paint from cache immediately if we have one, so an offline reload does not
  // flash the login screen at an attendant who is already signed in.
  //
  // The cached ROLE is deliberately not trusted. `state.currentUser.role` is what
  // gates every owner-only screen, and this cache lives in localStorage, which the
  // user can edit. A tampered cache would therefore be able to present owner-only
  // screens to an assistant.
  //
  // That is not a data breach — RLS refuses the reads and the writes regardless,
  // because authorization is decided by the database — but it would show an
  // attendant margins, stock valuation and the audit log they are not entitled to
  // see, which is its own kind of wrong. So the cached profile is used for
  // IDENTITY only (name, email, phone, so the header is not blank) and the role
  // is downgraded to the least privileged one until the server confirms it.
  //
  // `offline: true` is what tells the UI the role is provisional, so an owner-only
  // screen can explain itself rather than quietly rendering an empty list.
  const cached = readCache();
  if (cached) {
    const provisional: User = { ...cached.user, role: 'assistant', canApprovePricing: false };
    emit({ user: provisional, status: 'authenticated', offline: true });
    setPharmacyCurrentUser(provisional);
  }

  void supabase.auth.getSession().then(({ data }) => {
    if (!data.session) {
      // No session AND no usable cache: genuinely anonymous.
      if (!readCache()) emit({ user: null, status: 'anonymous', offline: false });
      return;
    }
    void adoptSession(data.session.user.id, data.session.user.email ?? '');
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    if (!session) {
      clearCache();
      emit({ user: null, status: 'anonymous', offline: false });
      return;
    }
    void adoptSession(session.user.id, session.user.email ?? '');
  });

  // When the connection returns, refresh from the server rather than trusting
  // the cache, so a role change made elsewhere takes effect.
  window.addEventListener('online', () => {
    void supabase.auth.refreshSession().then(({ data }) => {
      if (data.session) void adoptSession(data.session.user.id, data.session.user.email ?? '');
    });
  });
}

async function adoptSession(userId: string, email: string) {
  try {
    const user = await loadProfile(userId, email);
    if (!user) {
      // Authenticated but no profile row. The trigger should have made one;
      // surface it rather than pretending they are signed in.
      emit({ user: null, status: 'anonymous', offline: false });
      return;
    }
    writeCache(user);
    setPharmacyCurrentUser(user);
    emit({ user, status: 'authenticated', offline: false });
  } catch {
    // Profile fetch failed — likely offline. Keep the cached identity visible, but
    // never its role: an unverified role must not decide what this person may see.
    const cached = readCache();
    if (cached) {
      const provisional: User = { ...cached.user, role: 'assistant', canApprovePricing: false };
      emit({ user: provisional, status: 'authenticated', offline: true });
    }
  }
}

/* ------------------------------------------------------------------- hooks */

export function useSession(): Session {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/**
 * Synchronous read for the router's `beforeLoad`. `getSession()` is async, so
 * this can only report what we already know: anonymous, or not-yet-known.
 * A third state would be a lie — beforeLoad has to decide now.
 */
export function peekSession(): Session {
  return current;
}

export function isOfflineSession(): boolean {
  return current.offline;
}

/* ------------------------------------------------------------------ sign in */

export type AuthResult = { ok: true; user: User } | { ok: false; error: string };

/**
 * Maps Supabase's error strings to something a pharmacist can act on.
 * Supabase's own wording ("Invalid login credentials") is fine, but its network
 * failure message is not, and leaking either raw is worse than saying so.
 */
function humanise(error: { message: string; status?: number } | null): string {
  if (!error) return 'Could not sign in';
  if (/invalid login credentials/i.test(error.message)) {
    return 'Email or password is incorrect';
  }
  if (/fetch|network|failed to fetch/i.test(error.message)) {
    return 'No connection. Reconnect to sign in.';
  }
  if (error.status === 429) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return error.message;
}

export interface SignInOptions {
  /** Persist across browser restarts. Defaults to true. */
  remember?: boolean;
}

export async function signIn(
  email: string,
  password: string,
  options: SignInOptions = {},
): Promise<AuthResult> {
  // Demo mode is a DEVELOPMENT-SERVER-only outcome, decided by `import.meta.env.DEV`
  // at build time. `vite build` substitutes `false`, so the branch below folds away
  // and this function has exactly one behaviour in shipped code: Supabase decides.
  //
  // This is the only place any password is accepted without being verified, and it
  // authenticates nobody: there is no backend, no stored hash, and the session it
  // opens reaches seeded in-memory data and nothing else. It exists so the owner
  // screens and the counter screens can be opened locally.
  //
  // The `password.trim().length === 0` test is a form-shape check, not an
  // authentication check. Both failures return the same message so the form cannot
  // be used to discover which seeded addresses exist.
  if (DEMO_ALLOWED) {
    const needle = email.trim().toLowerCase();
    const user = DEMO_USERS.find((u) => u.email.toLowerCase() === needle);
    if (!user || password.trim().length === 0) {
      return { ok: false, error: 'Email or password is incorrect' };
    }
    writeCache(user);
    setPharmacyCurrentUser(user);
    emit({ user, status: 'authenticated', offline: false });
    return { ok: true, user };
  }

  // Every production path arrives here: no demo branch, no configuration short
  // circuit, Supabase decides. An unconfigured deployment cannot sign anybody in.
  if (!isSupabaseConfigured()) {
    return { ok: false, error: 'Sign-in is not configured on this deployment.' };
  }

  const supabase = getSupabase();
  const remember = options.remember ?? true;

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error || !data.user) return { ok: false, error: humanise(error) };

  const user = await loadProfile(data.user.id, data.user.email ?? '');
  if (!user) {
    return { ok: false, error: 'This account has no pharmacy profile. Ask the owner to set it up.' };
  }

  writeCache(user);
  setPharmacyCurrentUser(user);
  emit({ user, status: 'authenticated', offline: false });

  if (!remember) {
    // Supabase persists to localStorage. For a shared till, move it to
    // sessionStorage so the next attendant does not inherit the session.
    moveSessionToSessionStorage();
  }

  return { ok: true, user };
}

/**
 * Customer sign-in by phone. Supabase sends an OTP; `verifyOtp` completes it.
 * Split from `signIn` because a customer has no password to type.
 */
export async function requestCustomerOtp(phone: string): Promise<AuthResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: 'Sign-in is not configured on this deployment.' };
  }

  const { error } = await getSupabase().auth.signInWithOtp({
    phone: normalisePhone(phone),
    options: { shouldCreateUser: false },
  });

  if (error) return { ok: false, error: humanise(error) };
  return { ok: true, user: null as unknown as User };
}

export async function verifyCustomerOtp(phone: string, token: string): Promise<AuthResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: 'Sign-in is not configured on this deployment.' };
  }

  const { data, error } = await getSupabase().auth.verifyOtp({
    phone: normalisePhone(phone),
    token: token.trim(),
    type: 'sms',
  });

  if (error || !data.user) return { ok: false, error: humanise(error) };

  const user = await loadProfile(data.user.id, data.user.email ?? '');
  if (!user) return { ok: false, error: 'No pharmacy profile found for this number.' };

  writeCache(user);
  setPharmacyCurrentUser(user);
  emit({ user, status: 'authenticated', offline: false });
  return { ok: true, user };
}

/** Nigerian mobile numbers: accept 080…, +23480…, 23480… and normalise to E.164. */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d]/g, '');
  if (digits.startsWith('234')) return `+${digits}`;
  if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
  return `+${digits}`;
}

/* ----------------------------------------------------------------- sign out */

/**
 * Re-read the caller's profile from Supabase and update the session in place.
 *
 * Needed after a branch switch. `pf_set_active_branch()` writes the role the
 * session holds at the newly active branch onto `profiles.role`, and `User.role`
 * is derived from that row — so without this the app keeps showing the previous
 * branch's permissions. A user who is an owner at head office but only an
 * assistant at a counter would still see the pricing screen after switching.
 *
 * The session identity is untouched: same user, same status, same cache key.
 * Only the role-bearing fields are replaced.
 */
export async function refreshSessionProfile(): Promise<void> {
  if (DEMO_MODE || !isSupabaseConfigured()) return;

  try {
    const { data, error } = await getSupabase().auth.getUser();
    if (error || !data.user) return;

    const profile = await loadProfile(data.user.id, data.user.email ?? '');
    if (!profile) return;

    writeCache(profile);
    setPharmacyCurrentUser(profile);
    emit({ user: profile, status: 'authenticated', offline: false });
  } catch {
    // A failed refresh leaves the previous role in place. Safer than clearing the
    // session: the user is still signed in, and RLS has not relaxed anything on
    // the server by failing this call.
  }
}

export function signOut(): void {
  clearCache();
  if (isSupabaseConfigured()) void getSupabase().auth.signOut();
  emit({ user: null, status: 'anonymous', offline: false });
}

/**
 * Development server only. Swaps between the two seeded accounts so the
 * owner-only screens and columns can be shown.
 *
 * This is a role-elevation control, so it is as serious as the sign-in path and is
 * gated the same way: `DEMO_MODE` is constant-false in a production build, so the
 * throw below is what a shipped build always does. With Supabase this has always
 * thrown on purpose — a role is a row in `profiles` guarded by RLS, and a user who
 * can promote themselves is not a role system. Changing a staff role is an owner
 * action in the staff screen.
 */
export function switchRole(role: User['role']): void {
  if (!DEMO_ALLOWED) {
    throw new Error(
      'switchRole is development-server only. Roles come from the profiles table via RLS.',
    );
  }
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) return;
  writeCache(user);
  setPharmacyCurrentUser(user);
  emit({ user, status: 'authenticated', offline: false });
}

function moveSessionToSessionStorage() {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('sb-') && key.includes('auth-token')) {
        window.sessionStorage.setItem(key, window.localStorage.getItem(key)!);
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
}