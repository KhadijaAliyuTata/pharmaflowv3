import { useCallback, useSyncExternalStore } from 'react';
import type { PharmacyStatus, StaffRole } from '../db.types';
import { SEED_BRANCH } from '~/domain/seed';
import type { Branch } from '~/domain/state';
import { isDemoMode, peekSession, refreshSessionProfile } from '~/lib/session';
import { switchBranch, listAvailableBranches, type AvailableBranch } from './branches';
import { fail, ok, type Result } from './result';
import { client, hasSession, isSupabaseConfigured } from './client';
import {
  clearBranchSnapshot,
  isOfflineBranchFailure,
  readBranchSnapshot,
  savedBranchForOffline,
  writeBranchSnapshot,
  type BranchSnapshotBranch,
} from '~/offline/branch-snapshot';
import { effectiveRole } from '~/offline/effective-role';

/**
 * The active branch.
 *
 * PharmaFlow is multi-branch, so "which pharmacy is this session working at?" is
 * a real question rather than a constant. RLS answers it through
 * `pf_current_branch()`, which reads `profiles.branch_id` — so the active branch
 * is server state, and this module is a *view* of it, never an authority.
 *
 * Three rules this file exists to hold to:
 *
 * 1. **Never assert a tenant from the browser.** Switching calls
 *    `pf_set_active_branch()`, which checks `branch_memberships` server-side. The
 *    set of reachable branches is exactly what the database returns — an
 *    `update profiles set branch_id = ...` would be the client claiming its own
 *    tenancy, and is deliberately absent.
 *
 * 2. **Never fabricate a branch.** A session with no membership resolves to
 *    `no-branches`, which the UI reports. It does not invent a fallback, because
 *    a fabricated branch would look like a working app while showing the wrong
 *    pharmacy's shelf.
 *
 * 3. **`AppState.branch` stays authoritative for nothing.** The prototype still
 *    reads it (see `_portal.tsx`), and that is left working — but `localStorage`
 *    is not consulted for tenant decisions here. Demo mode is the one exception,
 *    and it is explicitly a presentation fallback: `SEED_BRANCH` with no
 *    membership check, because there is no database to check against.
 *
 * Shape follows `src/lib/session.ts` deliberately: a module singleton plus
 * `useSyncExternalStore`, rather than a React context. The route guards already
 * run outside React, and two independent stores for the same session is how they
 * drift apart.
 */

export type ActiveBranchStatus =
  /** Nothing has been attempted yet. */
  | 'idle'
  /** Resolving the user and their branches. */
  | 'loading'
  /** At least one branch is available and `currentBranchId` is set. */
  | 'ready'
  /**
   * Signed in, but no branch membership. The database refused to let this session
   * pick a branch, so there is nothing to work at. Surfaced rather than papered
   * over.
   */
  | 'no-branches'
  /** Supabase is not configured; running on seeded demo data. */
  | 'demo'
  /** A failure worth showing, e.g. the network dropped mid-resolution. */
  | 'error';

export interface ActiveBranchState {
  status: ActiveBranchStatus;
  /** The active branch, or null when none could be resolved. */
  currentBranchId: string | null;
  /** Exactly what the database says this session may open. */
  availableBranches: AvailableBranch[];
  /** Set when `status === 'error'`. */
  error: string | null;
  /** True while a switch is in flight, so the UI can disable itself. */
  switching: boolean;
  /**
   * Where the active branch came from. `cache` means a previously confirmed
   * branch was used because the server could not be reached; it is usable for
   * the POS safety net but is never presented as a fresh authorisation check.
   */
  source: 'server' | 'cache';
  /** When the cached branch was last confirmed by the server, if source is cache. */
  cachedAt: number | null;
  /**
   * Set when the current branch is usable online but could not be saved for an
   * offline reload (for example, storage is full or blocked). This is a warning,
   * not a reason to stop the online till.
   */
  snapshotError?: string | null;
}

const UNRESOLVED: ActiveBranchState = {
  status: 'idle',
  currentBranchId: null,
  availableBranches: [],
  error: null,
  switching: false,
  source: 'server',
  cachedAt: null,
};

/**
 * Demo mode. The prototype's single seeded branch, presented through the same
 * shape so components need no branch of their own. `role` is left off here — the
 * demo session carries its own role — and `roleForBranch` accounts for that.
 */
function demoRole(): StaffRole {
  return peekSession().user?.role === 'assistant' ? 'assistant' : 'owner';
}

function demoState(): ActiveBranchState {
  const branch: Branch = SEED_BRANCH;
  const seeded: AvailableBranch = {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    city: branch.city,
    state: branch.state,
    phone: branch.phone,
    opening_hours: branch.openingHours,
    is_open_now: branch.isOpenNow,
    is_main_hub: branch.isMainHub ?? false,
    rating: branch.rating,
    reviews_count: branch.reviewsCount,
    // Not configured in demo mode. Null is the honest value and the dashboard
    // renders "Not set"; it must never fall back to a plausible-looking number.
    pcn_number: branch.pcnNumber ?? null,
    premises_number: branch.premisesNumber ?? null,
    created_at: '',
    updated_at: '',
    role: demoRole(),
    isDefault: true,
  };
  return {
    status: 'demo',
    currentBranchId: branch.id,
    availableBranches: [seeded],
    error: null,
    switching: false,
    source: 'server',
    cachedAt: null,
  };
}

let current: ActiveBranchState = isDemoMode() ? demoState() : UNRESOLVED;

const listeners = new Set<() => void>();

function emit(next: ActiveBranchState) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;

/* ------------------------------------------------------- saved branch */

/**
 * The user id carried by the local Supabase session.
 *
 * Deliberately `auth.getSession()`, not the editable profile cache: a snapshot
 * may only be re-used by the same authenticated user, and the auth session is
 * the closest local proof of that identity. Offline this still reads from the
 * Supabase client's own storage; an expired/absent session returns null and the
 * caller fails closed rather than trusting a cached role.
 */
async function localSessionUserId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await client().auth.getSession();
    if (error) return null;
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

function branchForSnapshot(branch: AvailableBranch): BranchSnapshotBranch {
  return { ...branch, isDefault: true };
}

/** Persists a branch only after the server has confirmed it (and the role for it). */
async function rememberConfirmedBranch(branch: AvailableBranch | undefined): Promise<string | null> {
  if (!branch) return null;
  const userId = await localSessionUserId();
  if (!userId) return 'This device could not identify the saved session for offline use.';
  // A storage failure must not break an otherwise valid online session. It only
  // means this device will not be able to reopen the POS offline, which the UI
  // reports rather than discovering after a reload.
  const written = writeBranchSnapshot({
    userId,
    branch: branchForSnapshot(branch),
    role: branch.role,
  });
  return written.ok ? null : (written.error ?? 'This device could not save the branch for offline use.');
}

/**
 * Reconstructs the last confirmed branch when the server cannot be reached.
 *
 * This path is only taken for transport-shaped failures. A refusal from the
 * server (expired JWT, missing profile, policy error) never falls back to the
 * cache. The returned role is always `assistant`: the cached role is evidence of
 * what the server once said, not authority to show owner-only data offline.
 */
async function restoreSavedBranch(failure: string): Promise<ActiveBranchState | null> {
  if (!isOfflineBranchFailure(failure)) return null;

  const userId = await localSessionUserId();
  if (!userId) {
    return {
      status: 'error',
      currentBranchId: null,
      availableBranches: [],
      error: 'Your saved sign-in has expired. Reconnect and sign in again before using the till.',
      switching: false,
      source: 'cache',
      cachedAt: null,
    };
  }

  // The POS local database is namespaced by the signed-in profile as well as
  // the branch. An auth session without a readable cached profile has no local
  // till identity, so opening a branch would render a POS that cannot record
  // anything. Fail closed and ask for a reconnect.
  if (peekSession().user?.id !== userId) {
    return {
      status: 'error',
      currentBranchId: null,
      availableBranches: [],
      error: 'Your saved staff profile could not be loaded. Reconnect and sign in again before using the till.',
      switching: false,
      source: 'cache',
      cachedAt: null,
    };
  }

  const saved = readBranchSnapshot({ userId });
  if (!saved.ok) {
    return {
      status: 'error',
      currentBranchId: null,
      availableBranches: [],
      error: saved.error,
      switching: false,
      source: 'cache',
      cachedAt: null,
    };
  }

  const offlineBranch: AvailableBranch = savedBranchForOffline(saved.snapshot);

  return {
    status: 'ready',
    currentBranchId: saved.snapshot.branchId,
    availableBranches: [offlineBranch],
    error: null,
    switching: false,
    source: 'cache',
    cachedAt: saved.snapshot.confirmedAt,
  };
}

/* --------------------------------------------------------------- resolving */

/**
 * Initial resolution, in the order the product needs:
 *
 *   1. load the branches this session may open (`pf_my_branches`);
 *   2. keep the existing active branch **if it is still permitted** — the check
 *      matters, because an owner may have been moved off a counter since last
 *      login, and an id that is no longer in the list must not be trusted;
 *   3. otherwise prefer the membership marked default, then the first row;
 *   4. commit the choice with `pf_set_active_branch()` so RLS agrees;
 *   5. leave `currentBranchId` null when there is nothing to pick.
 *
 * Step 4 runs even when the existing branch is still valid, because that is the
 * call that re-asserts membership server-side before any query depends on it.
 */
export async function resolveActiveBranch(): Promise<ActiveBranchState> {
  if (isDemoMode()) {
    const state = demoState();
    emit(state);
    return state;
  }

  if (!isSupabaseConfigured()) {
    emit({ ...UNRESOLVED, status: 'error', error: 'Supabase is not configured' });
    return current;
  }

  emit({ ...current, status: 'loading', error: null });

  const selection = await listAvailableBranches();

  if (!selection.ok) {
    // A transport failure may be recoverable from the last branch the server
    // confirmed. Any other refusal is a real error and must not be papered over.
    const restored = await restoreSavedBranch(selection.error);
    if (restored) {
      emit(restored);
      return restored;
    }

    // A signed-out session is not an error state here; the auth guard owns that.
    const state: ActiveBranchState = {
      status: selection.error === 'Not signed in' ? 'idle' : 'error',
      currentBranchId: null,
      availableBranches: [],
      error: selection.ok ? null : selection.error,
      switching: false,
      source: 'server',
      cachedAt: null,
    };
    emit(state);
    return state;
  }

  const { branches, currentBranchId } = selection.data;

  if (branches.length === 0) {
    emit({
      status: 'no-branches',
      currentBranchId: null,
      availableBranches: [],
      error: null,
      switching: false,
      source: 'server',
      cachedAt: null,
    });
    return current;
  }

  const existing = branches.find((b) => b.id === currentBranchId);
  const preferred =
    existing ?? branches.find((b) => b.isDefault) ?? branches[0]!;

  // Commit through the secure function. If this fails the session has no tenant,
  // so do not pretend otherwise.
  const committed = await switchBranch(preferred.id);
  if (!committed.ok) {
    emit({
      status: 'error',
      currentBranchId: null,
      availableBranches: branches,
      error: committed.error,
      switching: false,
      source: 'server',
      cachedAt: null,
    });
    return current;
  }

  const state: ActiveBranchState = {
    status: 'ready',
    currentBranchId: committed.data,
    availableBranches: branches,
    error: null,
    switching: false,
    source: 'server',
    cachedAt: null,
  };
  const snapshotError = await rememberConfirmedBranch(branches.find((b) => b.id === committed.data));
  const resolved = { ...state, snapshotError };
  emit(resolved);
  return resolved;
}

/**
 * Switch the active branch.
 *
 * On success the session profile is refetched, because `pf_set_active_branch()`
 * writes the role for the newly active branch onto `profiles.role` and the
 * session caches `User.role` from that row. Without the refresh the UI would keep
 * showing the previous branch's permissions — an owner who is only an assistant at
 * a counter would still see the pricing screen.
 *
 * The session is preserved throughout: no sign-out, no re-auth.
 */
export async function switchActiveBranch(branchId: string): Promise<Result<ActiveBranchState>> {
  if (isDemoMode()) {
    // One seeded branch. Nothing to switch to, and nothing to pretend about.
    const state = demoState();
    emit(state);
    return ok(state);
  }

  emit({ ...current, switching: true, error: null });

  const result = await switchBranch(branchId);

  if (!result.ok) {
    // Keep the previous branch active. A refused switch must not leave the app
    // pointing at a branch the database never accepted.
    emit({ ...current, switching: false, error: result.error });
    return fail(result.error, result.code);
  }

  // Refresh role from the server so the UI matches the branch now in force.
  if (!isDemoMode()) await refreshSessionProfile();

  const branches = current.availableBranches.map((b) =>
    b.id === result.data ? { ...b, isDefault: true } : { ...b, isDefault: false },
  );

  const state: ActiveBranchState = {
    status: 'ready',
    currentBranchId: result.data,
    availableBranches: branches,
    error: null,
    switching: false,
    source: 'server',
    cachedAt: null,
  };
  const snapshotError = await rememberConfirmedBranch(branches.find((b) => b.id === result.data));
  const resolved = { ...state, snapshotError };
  emit(resolved);
  return ok(resolved);
}

/* ------------------------------------------------------------------- reads */

/**
 * Is this session's own branch suspended?
 *
 * ## Why this needs asking at all
 *
 * Suspension works by making `pf_current_branch()` return NULL and by removing
 * the branch from `pf_my_branches`. Both are correct - they deny the access - but
 * from inside the app they look exactly like "this pharmacy has no data". A user
 * whose counter was switched off by an operator would otherwise be shown an
 * empty stock list with no explanation, and would reasonably conclude their
 * records were gone.
 *
 * `pf_my_branch_status()` answers that one question. It takes no arguments, so it
 * cannot be pointed at somebody else's pharmacy, and it returns one word.
 *
 * Returns `null` for: not configured, not signed in, no branch membership, or a
 * query error. `null` is deliberately not `false`-with-a-reason: the caller cannot
 * tell those apart, and none of them mean "suspended".
 */
export async function fetchMyBranchStatus(): Promise<PharmacyStatus | null> {
  if (!isSupabaseConfigured()) return null;
  if (!(await hasSession())) return null;

  const { data, error } = await client().rpc('pf_my_branch_status');
  if (error) return null;
  return data ?? null;
}

/** The role this session holds at a given branch, or null if not permitted. */
export function roleForBranch(branchId: string | null): StaffRole | null {
  if (!branchId) return null;
  // A role switch updates the session, not the branch snapshot. Read the demo
  // session here so the sidebar and shell change on the same render as the
  // account control, instead of keeping the role the branch was built with.
  if (isDemoMode()) return demoRole();
  return current.availableBranches.find((b) => b.id === branchId)?.role ?? null;
}

/** The role for the branch currently in force. */
export function activeRole(): StaffRole | null {
  return roleForBranch(current.currentBranchId);
}

/**
 * Re-exported here so shell/POS callers have one branch-context import for the
 * "cached branch is always assistant" rule.
 */
export { effectiveRole };

export function activeBranch(): AvailableBranch | null {
  if (!current.currentBranchId) return null;
  return current.availableBranches.find((b) => b.id === current.currentBranchId) ?? null;
}

/** True when this session may open more than one branch. */
export function hasMultipleBranches(): boolean {
  return current.availableBranches.length > 1;
}

/** Synchronous read, for code outside React. */
export function peekActiveBranch(): ActiveBranchState {
  return current;
}

/** Subscribe to the active branch. */
export function useActiveBranch(): ActiveBranchState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Convenience selector: just the id. */
export function useCurrentBranchId(): string | null {
  const select = useCallback(() => current.currentBranchId, []);
  return useSyncExternalStore(subscribe, select, select);
}

/** Reset. Used by sign-out so the next session resolves from scratch. */
export function resetActiveBranch(): void {
  clearBranchSnapshot();
  emit(isDemoMode() ? demoState() : UNRESOLVED);
}

/**
 * The active branch name, for display.
 *
 * This is the compatibility boundary. The prototype still keeps its own
 * `AppState.branch` in `localStorage`, and screens that answer "which pharmacy am
 * I looking at" read it. Rather than removing that — which would break
 * `_portal.tsx` and the sidebar before the store is migrated — they can read this
 * and keep a fallback to their existing value.
 *
 * Returns `null` until a branch resolves, so a caller must decide what to show
 * meanwhile. Falling back to `AppState.branch` is fine for a *label* and is never
 * acceptable for a security decision, because that object is localStorage and
 * therefore editable.
 */
export function useBranchName(): string | null {
  const select = useCallback(
    () => current.availableBranches.find((b) => b.id === current.currentBranchId)?.name ?? null,
    [],
  );
  return useSyncExternalStore(subscribe, select, select);
}