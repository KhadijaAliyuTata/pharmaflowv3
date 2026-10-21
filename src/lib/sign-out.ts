/**
 * Sign-out orchestration for the local offline database.
 *
 * The low-level `session.signOut()` owns auth/session clearing. This wrapper
 * decides what may happen to the device's offline data first:
 *
 *   1. identify the branch/user database;
 *   2. inspect pending outbox rows, conflicts and strays;
 *   3. purge only when there is provably nothing unsynchronised;
 *   4. otherwise retain the data and return a warning for the UI to show.
 *
 * It never uses `purgeAllOffline()` on sign-out: one account's exit must not
 * erase another account's device data.
 */

import { inspectIdentityWork, purgeIdentity } from '~/offline/local-db';
import { decideOfflineSignOut } from '~/offline/signout-policy';
import { isDemoMode, peekSession, signOut } from './session';
import { peekActiveBranch } from './supabase/branch-context';

export interface SignOutResult {
  /** True only when the local database was deleted after a clean inspection. */
  purged: boolean;
  /** True when unsynchronised or unverified data was deliberately left behind. */
  retained: boolean;
  /** Rows that caused retention, when known. */
  pending: number;
  /** A user-facing warning, or null on a clean purge/demo exit. */
  warning: string | null;
}

export async function signOutSafely(): Promise<SignOutResult> {
  if (isDemoMode()) {
    signOut();
    return { purged: false, retained: false, pending: 0, warning: null };
  }

  const user = peekSession().user;
  if (!user) {
    signOut();
    return { purged: false, retained: false, pending: 0, warning: null };
  }

  const branchId = peekActiveBranch().currentBranchId;
  if (!branchId) {
    signOut();
    return {
      purged: false,
      retained: true,
      pending: 0,
      warning:
        'Signed out. The active branch could not be identified, so saved offline data was left on this device rather than risking deletion of another account\'s sales.',
    };
  }

  const identity = { pharmacyId: branchId, userId: user.id };
  let work = null;
  try {
    work = await inspectIdentityWork(identity);
  } catch {
    signOut();
    return {
      purged: false,
      retained: true,
      pending: 0,
      warning:
        'Signed out. The saved offline data could not be inspected, so it was left on this device. Do not assume it was deleted.',
    };
  }

  const decision = decideOfflineSignOut(work);
  if (decision.action === 'purge') {
    // Re-inspect immediately before deletion to narrow the race window where
    // another tab or in-flight checkout could write evidence between inspection
    // and purge. This does not eliminate the race; it only narrows the window.
    let recheckWork = null;
    try {
      recheckWork = await inspectIdentityWork(identity);
    } catch {
      // If we cannot re-inspect, do not purge. Conservatively retain.
      signOut();
      return {
        purged: false,
        retained: true,
        pending: 0,
        warning:
          'Signed out. The saved offline data could not be re-verified before deletion, so it was left on this device. Do not assume it was deleted.',
      };
    }
    const recheckDecision = decideOfflineSignOut(recheckWork);
    if (recheckDecision.action !== 'purge') {
      // New evidence appeared (outbox, conflicts, strays, or unresolved note).
      signOut();
      return {
        purged: false,
        retained: true,
        pending: recheckDecision.pending,
        warning:
          recheckDecision.warning ??
          'Signed out. Unsynchronised or unresolved evidence appeared during sign-out; the data was retained.',
      };
    }
    try {
      await purgeIdentity(identity);
      signOut();
      return { purged: true, retained: false, pending: 0, warning: null };
    } catch {
      signOut();
      return {
        purged: false,
        retained: true,
        pending: 0,
        warning:
          'Signed out, but the saved offline data could not be removed. It was left on this device; close other tabs and clear site data if this till is being handed over.',
      };
    }
  }

  signOut();
  return {
    purged: false,
    retained: true,
    pending: decision.pending,
    warning: decision.warning,
  };
}
