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
 * Demo mode.
 *
 * A deployment with no Supabase credentials would otherwise land on a
 * "not configured" screen, which tells a client nothing. With this on, the app
 * runs against the seeded demo accounts so the product is visible and
 * clickable; the login screen labels it clearly so nobody mistakes it for real
 * security.
 *
 * Set `PUBLIC_DEMO_MODE=false` the moment real credentials exist. It is a
 * presentation fallback, never an auth mode.
 */
const DEMO_MODE =
  !isSupabaseConfigured() &&
  import.meta.env.PUBLIC_DEMO_MODE !== 'false';

export function isDemoMode(): boolean {
  return DEMO_MODE;
}

const DEMO_USERS: User[] = [
  { id: 'usr-owner', name: 'Khadija Bello', email: 'khadija@pharmaflow.ng',
    role: 'owner', phone: '+2348030000001', licenseNumber: 'PCN/NG/22341', canApprovePricing: true },
  { id: 'usr-assistant', name: 'Aisha Yusuf', email: 'aisha@pharmaflow.ng',
    role: 'assistant', phone: '+2348030000002', canApprovePricing: false },
];

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'unconfigured';

export interface Session {
  user: User | null;
  status: SessionStatus;
  /** Set when a cached profile is being shown because Supabase was unreachable. */
  offline: boolean;
}

export interface DemoAccount {
  name: string;
  email: string;
  role: 'owner' | 'assistant';
  blurb: string;
}

/** Seeded staff, for the one-click fill on the login screen. */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { name: 'Khadija Bello', email: 'khadija@pharmaflow.ng', role: 'owner', blurb: 'Pricing, margins, credit, staff' },
  { name: 'Aisha Yusuf', email: 'aisha@pharmaflow.ng', role: 'assistant', blurb: 'Counter only' },
];

/* ------------------------------------------------------------- subscriber */

/**
 * Demo mode must be authenticated from the very first render, not from an
 * effect. `beforeLoad` on the route runs before anything mounts, and the
 * server has no session — so if the initial value were 'anonymous' the guard
 * would redirect to /login before `startSession()` ever ran, and SSR and the
 * client would disagree. Setting it synchronously keeps both sides identical.
 */
let current: Session = DEMO_MODE
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

  if (DEMO_MODE) {
    // Demo mode has no login. Whoever opens the URL is signed straight in as
    // the owner so the product is visible immediately. Deliberate: this build
    // is for showing the interface, not for protecting anything.
    const cached = readCache();
    const user = cached?.user ?? DEMO_USERS[0]!;
    setPharmacyCurrentUser(user);
    emit({ user, status: 'authenticated', offline: false });
    return;
  }

  if (!isSupabaseConfigured()) {
    emit({ user: null, status: 'unconfigured', offline: false });
    return;
  }

  const supabase = getSupabase();

  // Paint from cache immediately if we have one, so an offline reload does not
  // flash the login screen at an attendant who is already signed in.
  const cached = readCache();
  if (cached) {
    emit({ user: cached.user, status: 'authenticated', offline: true });
    setPharmacyCurrentUser(cached.user);
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
    // Profile fetch failed — likely offline. Keep the cached profile visible.
    const cached = readCache();
    if (cached) emit({ user: cached.user, status: 'authenticated', offline: true });
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
  if (DEMO_MODE) {
    const needle = email.trim().toLowerCase();
    const user = DEMO_USERS.find((u) => u.email.toLowerCase() === needle);
    // One message for both cases, so the form cannot be used to discover which
    // addresses exist.
    if (!user || password.trim().length === 0) {
      return { ok: false, error: 'Email or password is incorrect' };
    }
    writeCache(user);
    setPharmacyCurrentUser(user);
    emit({ user, status: 'authenticated', offline: false });
    return { ok: true, user };
  }

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
 * Demo mode only. Swaps between the two seeded accounts so the owner-only
 * screens and columns can be shown.
 *
 * With Supabase this throws on purpose: a role is a row in `profiles` guarded
 * by RLS, and a user who can promote themselves is not a role system. Changing
 * a staff role is an owner action in the staff screen.
 */
export function switchRole(role: User['role']): void {
  if (!DEMO_MODE) {
    throw new Error(
      'switchRole is demo-mode only. Roles come from the profiles table via RLS.',
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