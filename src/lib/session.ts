import { useSyncExternalStore } from 'react';
import type { User } from '~/domain/types';
import type { ProfileRow } from './db.types';
import { getSupabase, isSupabaseConfigured } from './supabase';
// Imported from the module rather than the `./supabase` barrel above, so pulling in
// the redemption RPC does not pull the whole repository surface into this module.
// `staff.ts` depends only on `client` and `result`, so this is not a cycle.
import { redeemInvitation } from './supabase/staff';
import { deploymentMode, isDemoMode } from './build-mode';
import { clearBranchSnapshot } from '~/offline/branch-snapshot';
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



/* -------------------------------------------------------- demo session control */

/**
 * DEVELOPMENT-SERVER ONLY. Four investor demos need one-click entry into the
 * seeded owner and attendant experiences, and a clean exit that cannot disturb a
 * real session.
 *
 * ## The contract
 *
 *   * A demo entry NEVER writes the profile cache (`pharmaflow:profile:v1` is the
 *     REAL identity cache this module manages), never touches Supabase Auth, and
 *     can never run outside `isDemoMode()` — the same constant-false fold that
 *     makes `switchRole` safe. In a production build these functions throw
 *     unconditionally and the bundle keeps no demo users (verified the same way
 *     `verify-auth-modes.ts` verifies the gate).
 *   * The chosen demo role is kept under a NAMESPACE-CLEAN key, `pf-demo:role`, so a
 *     reload mid-demo restores the same role (the store already restores its
 *     seeded data). The key never grants anything: the demo session exists only
 *     because the build permits it, and its user is a seeded fixture
 *     (`usr-owner` / `usr-assistant`), never a real account or a tenant row.
 *   * `signOut` REPLACED by demo exit while a demo session is active: it does not
 *     call Supabase sign-out, so a tester signed into a real account in another
 *     tab is not silently logged out. On exit, a previously real Supabase
 *     session is re-adopted if present, otherwise the app returns to anonymous.
 */
const DEMO_ROLE_KEY = 'pf-demo:role';

function readDemoRoleKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(DEMO_ROLE_KEY);
  } catch {
    return null;
  }
}

function findDemoUser(role: string | null): User | null {
  if (!role) return null;
  return DEMO_USERS.find((candidate) => candidate.role === role) ?? null;
}

/** One-click entry into the seeded owner or attendant demo. Dev server only. */
export function enterDemoSession(role: User['role']): void {
  if (!isDemoMode()) {
    throw new Error('Demo sessions exist only in a development server with demo mode enabled.');
  }
  const user = findDemoUser(role) ?? DEMO_USERS[0]!;
  try {
    window.localStorage.setItem(DEMO_ROLE_KEY, role);
  } catch {
    /* private mode: the demo still starts; a reload restores the default owner */
  }
  setPharmacyCurrentUser(user);
  emit({ user, status: 'authenticated', offline: false });
}

/** Leaves the demo and restores the real session exactly as it was. */
export function exitDemoSession(): void {
  if (!isDemoMode()) return;
  try {
    window.localStorage.removeItem(DEMO_ROLE_KEY);
  } catch {
    /* ignore */
  }
  clearCache();
  if (!isSupabaseConfigured()) {
    emit({ user: null, status: 'anonymous', offline: false });
    return;
  }
  // Best-effort restore of a real session that existed before the demo. Nothing
  // is signed OUT: if a real session exists it is read and adopted as-is; if not,
  // the app simply becomes anonymous.
  void getSupabase()
    .auth.getSession()
    .then(({ data }) => {
      if (data.session) {
        void adoptSession(data.session.user.id, data.session.user.email ?? '');
      } else {
        emit({ user: null, status: 'anonymous', offline: false });
      }
    })
    .catch(() => {
      emit({ user: null, status: 'anonymous', offline: false });
    });
}

/* ------------------------------------------------------------ subscriber */

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
    // Development server only. The demo ROLE chosen on /demo is preserved across
    // a reload; otherwise the seeded owner is what opens, exactly as before.
    // There is no backend here.
    const byRole = findDemoUser(readDemoRoleKey());
    const cached = readCache();
    const user = byRole ?? cached?.user ?? DEMO_USERS[0]!;
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
      clearBranchSnapshot();
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
 * means "sign in instead", and "this invitation was withdrawn" means "ask your
 * owner for a new one", and neither should be rendered as a generic failure.
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
 * ## Why this asks the server instead of calling `signUp` here
 *
 * `supabase.auth.signUp` was the original approach and it dead-ended. On a
 * deployment with email confirmation required, `signUp` returns a user but **no
 * session**, and then waits for a confirmation email sent by Supabase Auth. That
 * email was the thing this whole change set out to remove, so `/join` stopped at
 * "check your email" with an account created and no membership.
 *
 * `POST /api/accept-invite` creates the account with the address already confirmed,
 * because the invitation email was delivered to that address and that is the proof
 * — and it reads the address from the invitation row rather than from anything the
 * browser sends. So this function sends `{ token, password }` and nothing else.
 *
 * ## The password
 *
 * It goes from the form field, through this function, to the Worker's HTTPS endpoint,
 * to Supabase. It is not logged, not put in the store, and not carried in any
 * `Result` on the way back. The Worker holds it only for the duration of one
 * `createUser` call.
 *
 * ## The three outcomes that are not errors
 *
 *   * `already_registered` — someone already has an account at the invited address.
 *     Not a dead end: they sign in with the password they have and redeem the same
 *     code. Nothing is redeemed here either way.
 *   * `profile_pending` — the membership exists, so the person has a place; only the
 *     display cache is missing and sign-in will rebuild it.
 *   * the invitation was already redeemed by an earlier successful attempt — sign in
 *     and the membership is already there.
 */
export async function signUpWithInvitation(
  email: string,
  password: string,
  inviteToken: string,
): Promise<AuthResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: 'Sign-in is not configured on this deployment.' };
  }

  // ---------------------------------------------------------------- accept
  const accepted = await acceptInvitation(inviteToken, password);

  if (!accepted.ok) {
    // Already registered is a routing decision, not a wall: the caller offers
    // sign-in instead. Every other code is a refusal with one correct next step.
    //
    // The typed address is compared against the one the invitation names. They are
    // not negotiable — the account is created for the address the owner wrote on
    // the invitation — so a mismatch has to be reported rather than silently
    // resolved in either direction. Silently using the typed one would create an
    // account the invitee never asked for; silently using the server's one would
    // sign them into an account they cannot remember having made.
    if (accepted.code === 'already_registered') {
      const address = accepted.email || email.trim();
      if (accepted.email && accepted.email.toLowerCase() !== email.trim().toLowerCase()) {
        return {
          ok: false,
          error: `This invitation was sent to ${accepted.email}. Sign in with that address and your existing password.`,
          code: 'already_registered',
        };
      }
      return {
        ok: false,
        error: `You already have an account at ${address}. Sign in with your existing password to redeem this invitation.`,
        code: 'already_registered',
      };
    }
    return { ok: false, error: accepted.error, code: accepted.code };
  }

  // Same check on the success path. The account now exists for the invitation's
  // address; if that is not what was typed, signing in with the typed address would
  // fail with a confusing "wrong password" message instead of naming the real cause.
  if (accepted.email && accepted.email.toLowerCase() !== email.trim().toLowerCase()) {
    return {
      ok: false,
      error: `This invitation was sent to ${accepted.email}, not ${email.trim()}. Sign in with ${accepted.email} and the password you just chose.`,
      code: 'address_mismatch',
    };
  }

  // ---------------------------------------------------------------- sign in
  // The account exists and is confirmed, so this is an ordinary password sign-in
  // with an ordinary session. Nothing about it is privileged, which is the point:
  // the Worker created the account, it did not hand back a session.
  const signedIn = await signIn(accepted.email, password);
  if (!signedIn.ok) {
    return signedIn;
  }

  // ---------------------------------------------------------------- redeem
  // Now signed in as the invited address, so `pf_redeem_invitation` can verify the
  // binding against the caller's own JWT. This is unchanged, and it remains the only
  // thing that creates the membership.
  //
  // Ordering matters: the sign-in above happens BEFORE this, so a redemption failure
  // leaves the person signed in rather than holding an account they cannot use. The
  // caller turns `redeem_failed` into the redemption screen, and they get there
  // without re-entering the password they just chose.
  //
  // `pf_redeem_invitation` ignores any reservation on the invitation, so the claim
  // taken by `/api/accept-invite` never blocks this step.
  const redeemed = await redeemInvitation(inviteToken);
  if (!redeemed.ok) {
    return { ok: false, error: redeemed.error, code: 'redeem_failed' };
  }

  // The profile row was written by the signup trigger and the branch was just set by
  // redemption, so re-read it now that both exist.
  const session = await getSupabase().auth.getSession();
  const userId = session.data.session?.user.id;
  if (!userId) {
    return { ok: false, error: 'Your session expired. Sign in again to finish.', code: 'no_session' };
  }

  const user = await loadProfile(userId, accepted.email);
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
 * Ask the Worker to create a confirmed account for a live invitation.
 *
 * Deliberately not a Supabase call. Creating a confirmed user is
 * `auth.admin.createUser`, which needs the service-role key, and that key must not
 * exist in browser code — so it lives in the Worker environment and this sends only
 * `{ token, password }`. The address is decided server-side from the invitation row;
 * there is no field here for a caller to supply one.
 */
async function acceptInvitation(
  token: string,
  password: string,
): Promise<
  | { ok: true; email: string }
  | { ok: false; error: string; code?: string; email?: string }
> {
  let response: Response;
  try {
    response = await fetch('/api/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
  } catch {
    // A network-level failure, not a refusal.
    return { ok: false, error: 'Could not reach the server. Check your connection.' };
  }

  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string; code?: string; email?: string }
    | null;

  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      error: payload?.error ?? `Could not create your account (HTTP ${response.status}).`,
      code: payload?.code,
      // Present on the `already_registered` refusal so the caller can name the
      // address the invitation was issued to. Absent on every other refusal, which
      // is deliberate: nothing about a withdrawn or expired code is echoed back.
      email: payload?.code === 'already_registered' ? payload.email : undefined,
    };
  }

  return { ok: true, email: payload.email ?? '' };
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
  // A demo session never came from Supabase, so "sign out" must not sign out of
  // Supabase: a tester signed into a real account in a dev browser would lose
  // their real session to a demo's exit button. Demo exit restores instead.
  //
  // In demo mode, we always use exitDemoSession (which clears cache and emits
  // anonymous) regardless of whether a demo role key was set. The demo role key
  // is only set when entering via the /demo page; signing in via the login form
  // with a demo account does not set it. Without this, logout would fall through
  // to the non-demo path which tries to call getSupabase().auth.signOut() and
  // emits anonymous directly, causing a synchronous redirect during render that
  // freezes the UI.
  if (isDemoMode()) {
    exitDemoSession();
    return;
  }
  clearCache();
  // The saved branch is identity-scoped evidence, not an independent login. It
  // must not survive a sign-out on a shared till.
  clearBranchSnapshot();
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
  // The role key is what `startSession` reads on reload. Writing only the
  // profile cache would leave the previous role in the key, so a tester who
  // switched to Assistant and refreshed would silently become the Owner again.
  try {
    window.localStorage.setItem(DEMO_ROLE_KEY, role);
  } catch {
    /* private mode: the in-memory switch still works for this page */
  }
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