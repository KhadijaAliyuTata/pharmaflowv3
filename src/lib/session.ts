import { useSyncExternalStore } from 'react';
import type { User } from '~/domain/types';
import type { ProfileRow } from './db.types';
import { getSupabase, isSupabaseConfigured } from './supabase';
// Imported from the module rather than the `./supabase` barrel above, so pulling in
// the redemption RPC does not pull the whole repository surface into this module.
// `staff.ts` depends only on `client` and `result`, so this is not a cycle.
import { redeemInvitation } from './supabase/staff';
import { deploymentMode, isDemoMode } from './build-mode';
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
 * The deployment mode and the demo gate now live in `~/lib/build-mode`.
 *
 * That module imports nothing from the app, so the store can read `isDemoMode()`
 * without closing an import cycle through this file — this file imports
 * `setPharmacyCurrentUser` from `~/store/pharmacy`. See `build-mode.ts` for why
 * demo mode is both opt-in *and* build-gated, and for the definition of the three
 * deployment modes. `isDemoMode` is re-exported below so existing callers keep
 * importing it from here.
 */

/**
 * What is wrong with the configuration, or null when it is fine.
 *
 * Reported by the login screen instead of being swallowed, because a deployment
 * that cannot authenticate should say which variable is missing rather than
 * rendering an app nobody can sign into.
 */
export function configProblem(): string | null {
  if (deploymentMode() !== 'broken') return null;

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

// Re-exported from `~/lib/build-mode` so this file stays the single import site for
// session state — every existing caller imports `isDemoMode` from `~/lib/session`.
// The definition, and the note on why it is `DEMO_ALLOWED && DEMO_MODE`, live there.
export { isDemoMode };

/**
 * True when authentication is impossible in this deployment.
 *
 * Distinct from "not signed in": this is a deployment fault, not a user state,
 * and the two must not be conflated or the UI will invite someone to sign in to an
 * app that has no backend.
 */
export function isAuthUnavailable(): boolean {
  return deploymentMode() === 'broken';
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
// `isDemoMode()`, not the raw `DEMO_ALLOWED`.
//
//   `DEMO_ALLOWED` is `IS_DEV_BUILD`, which is true on ANY development server. Using
//   it here meant a dev server with a real Supabase project configured still booted
//   'authenticated' as the seeded owner: the route guard passed, the owner dashboard
//   rendered, and Supabase was never consulted. That is the fail-open this whole
//   rewrite exists to remove, reintroduced through the side door of the
//   bundler-friendly gate.
//
//   `isDemoMode()` is `DEMO_ALLOWED && DEMO_MODE` — both correct and still foldable,
//   because both constants are module-level `const`s in `~/lib/build-mode`. In a
//   production build `DEMO_ALLOWED` is the literal `false`, so the expression folds to
//   `false`, this branch is eliminated, and the demo credentials are dropped from the
//   bundle with it.
const DEMO_SESSION = isDemoMode();

let current: Session = DEMO_SESSION
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
  if (DEMO_SESSION) {
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

/**
 * `code` distinguishes the failures a caller can act on differently from a plain
 * wrong password. `signUpWithInvitation` needs it: "you already have an account"
 * means "sign in instead", and "confirm your email first" means "go and check
 * your inbox", and neither should be rendered as a generic failure.
 */
export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; error: string; code?: string };

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
  if (DEMO_SESSION) {
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
 * Create an account from an invitation, then attach it to a branch.
 *
 * ## Why this exists rather than an admin-created user
 *
 * Creating an auth user normally means `supabase.auth.admin.createUser`, which
 * needs the `service_role` key. That key must never reach a browser bundle. So a
 * new staff member signs themselves up here and sets their own password — this
 * function never receives it, never stores it, and never sees it again.
 *
 * The password goes straight from the form field to Supabase over TLS. It is not
 * logged, not put in the store, and not in any `Result` on the way back.
 *
 * ## The two outcomes that are not errors
 *
 * Supabase reports two things that look like failures but are not, and each needs
 * its own message because the next step differs:
 *
 *   * `data.session === null` with a user means the deployment requires email
 *     confirmation. The account exists but cannot redeem the invitation until the
 *     address is confirmed. Saying "check your email" is the only useful answer.
 *   * "User already registered" means someone already has an account at this
 *     address. That is not a dead end — they should sign in instead, and the
 *     redemption still works.
 */
export async function signUpWithInvitation(
  email: string,
  password: string,
  inviteToken: string,
): Promise<AuthResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: 'Sign-in is not configured on this deployment.' };
  }

  const supabase = getSupabase();

  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
  });

  if (error) {
    // Already registered is a routing decision, not a wall.
    if (/already registered|already been registered/i.test(error.message)) {
      return { ok: false, error: 'ALREADY_REGISTERED', code: 'already_registered' };
    }
    return { ok: false, error: humanise(error) };
  }

  if (!data.user) {
    return { ok: false, error: 'That account could not be created. Try again.' };
  }

  // No session means the deployment wants the address confirmed first. Redemption
  // is impossible until then, so say so instead of failing later on the code.
  if (!data.session) {
    return {
      ok: false,
      error:
        'Check your email and confirm your address first. Your account is created, and the invitation is waiting for you.',
      code: 'needs_confirmation',
    };
  }

  // Signed in. Now the membership, which only `pf_redeem_invitation` may create.
  const redeemed = await redeemInvitation(inviteToken);
  if (!redeemed.ok) {
    return { ok: false, error: redeemed.error, code: redeemed.code };
  }

  const user = await loadProfile(data.user.id, data.user.email ?? '');
  if (!user) {
    // The membership exists, so the person does have a place; only the display
    // cache is missing. Sign-in will rebuild it.
    return {
      ok: false,
      error:
        'You have been added to this pharmacy. Sign in with your new password to finish setting up.',
      code: 'profile_pending',
    };
  }

  writeCache(user);
  setPharmacyCurrentUser(user);
  emit({ user, status: 'authenticated', offline: false });

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
  if (isDemoMode() || !isSupabaseConfigured()) return;

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
  if (!DEMO_SESSION) {
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