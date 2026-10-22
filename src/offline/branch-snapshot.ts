/**
 * The last server-confirmed branch for this browser.
 *
 * ## What this is, and what it is not
 *
 * Losing connectivity after a reload used to leave the active branch unresolved,
 * because the branch list is a live read. The POS then could not open its local
 * database and an attendant was locked out of a till that was already signed in.
 *
 * This module persists the smallest thing that fixes that: one branch that the
 * server explicitly returned, for one authenticated user, with the role the
 * server reported at the time. It deliberately does **not** persist the branch
 * list, an owner session, or any permission decision that can outlive the
 * server's answer.
 *
 * When the snapshot is used, the caller must treat it as stale authorisation:
 * the role is downgraded by `branch-context.ts`, the UI says the branch is saved
 * rather than verified, and a reconnect resolves the branch again. A signed-out
 * user, a different user id, an expired snapshot, or malformed storage all fail
 * closed.
 */

import type { BranchRow, StaffRole } from '~/lib/db.types';

export const BRANCH_SNAPSHOT_KEY = 'pharmaflow:branch-snapshot:v1';

/** Seven days mirrors the profile cache's maximum age. */
export const BRANCH_SNAPSHOT_MAX_AGE_MS = 7 * 86_400_000;

/** Five minutes of clock tolerance; a snapshot from the future is suspicious. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const ID_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

export interface BranchSnapshotBranch extends BranchRow {
  isDefault: boolean;
}

export interface BranchSnapshot {
  version: 1;
  /** The authenticated user this branch was confirmed for. */
  userId: string;
  /** The tenant association: a branch is the pharmacy counter in this data model. */
  branchId: string;
  branch: BranchSnapshotBranch;
  /** The role the server reported at confirmation time. Never elevated offline. */
  role: StaffRole;
  /** When the server confirmed the branch. */
  confirmedAt: number;
}

/**
 * The branch as it may be exposed offline. The saved role is deliberately not
 * copied: every cached branch is presented as an assistant branch, so an owner
 * who reloads offline cannot reach owner-only screens from localStorage.
 */
export function savedBranchForOffline(
  snapshot: BranchSnapshot,
): BranchSnapshotBranch & { role: StaffRole } {
  return { ...snapshot.branch, role: 'assistant', isDefault: true };
}

export type SnapshotReadResult =
  | { ok: true; snapshot: BranchSnapshot }
  | {
      ok: false;
      reason: 'missing' | 'malformed' | 'expired' | 'storage-error';
      error: string;
    };

export interface SnapshotWriteResult {
  ok: boolean;
  error?: string;
}

function defaultStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isBranch(value: unknown): value is BranchSnapshotBranch {
  if (!isRecord(value)) return false;
  return (
    isText(value.id) &&
    isText(value.name) &&
    isText(value.address) &&
    isText(value.city) &&
    isText(value.state) &&
    isText(value.phone) &&
    isText(value.opening_hours) &&
    typeof value.is_open_now === 'boolean' &&
    typeof value.is_main_hub === 'boolean' &&
    typeof value.rating === 'number' &&
    Number.isFinite(value.rating) &&
    typeof value.reviews_count === 'number' &&
    Number.isInteger(value.reviews_count) &&
    (value.pcn_number === null || isText(value.pcn_number) || value.pcn_number === undefined) &&
    (value.premises_number === null || isText(value.premises_number) || value.premises_number === undefined) &&
    isText(value.created_at) &&
    isText(value.updated_at) &&
    typeof value.isDefault === 'boolean'
  );
}

/**
 * Validates one decoded snapshot against the current identity and clock.
 *
 * This is intentionally stricter than "does it parse". A branch id is both the
 * tenant key and the local-database namespace, so an empty or malformed id is a
 * malformed snapshot rather than something to sanitise into a shared bucket.
 */
export function validateBranchSnapshot(
  raw: unknown,
  options: { userId: string; now?: number; maxAgeMs?: number },
): SnapshotReadResult {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? BRANCH_SNAPSHOT_MAX_AGE_MS;

  if (!isRecord(raw)) {
    return { ok: false, reason: 'malformed', error: 'The saved branch is not readable.' };
  }
  if (raw.version !== 1) {
    return { ok: false, reason: 'malformed', error: 'The saved branch has an unsupported format.' };
  }
  if (!isText(raw.userId) || !ID_TOKEN.test(raw.userId)) {
    return { ok: false, reason: 'malformed', error: 'The saved branch has no valid user identity.' };
  }
  if (!isText(raw.branchId) || !ID_TOKEN.test(raw.branchId)) {
    return { ok: false, reason: 'malformed', error: 'The saved branch has no valid branch identity.' };
  }
  if (!isBranch(raw.branch) || raw.branch.id !== raw.branchId) {
    return { ok: false, reason: 'malformed', error: 'The saved branch details are incomplete.' };
  }
  if (raw.role !== 'owner' && raw.role !== 'assistant') {
    return { ok: false, reason: 'malformed', error: 'The saved branch has no valid role.' };
  }
  if (typeof raw.confirmedAt !== 'number' || !Number.isFinite(raw.confirmedAt)) {
    return { ok: false, reason: 'malformed', error: 'The saved branch has no confirmation time.' };
  }
  if (raw.confirmedAt > now + FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: 'malformed', error: 'The saved branch has an invalid confirmation time.' };
  }
  if (now - raw.confirmedAt > maxAge) {
    return {
      ok: false,
      reason: 'expired',
      error: 'The saved branch is too old to use. Reconnect to verify access.',
    };
  }
  if (raw.userId !== options.userId) {
    return {
      ok: false,
      reason: 'malformed',
      error: 'The saved branch belongs to a different account. Reconnect to continue.',
    };
  }

  return {
    ok: true,
    snapshot: {
      version: 1,
      userId: raw.userId,
      branchId: raw.branchId,
      branch: raw.branch,
      role: raw.role,
      confirmedAt: raw.confirmedAt,
    },
  };
}

/** Reads and validates the snapshot. Never throws. */
export function readBranchSnapshot(options: {
  storage?: Storage | null;
  userId: string;
  now?: number;
  maxAgeMs?: number;
}): SnapshotReadResult {
  const store = options.storage === undefined ? defaultStorage() : options.storage;
  if (!store) {
    return {
      ok: false,
      reason: 'storage-error',
      error: 'This device cannot read its saved branch. Reconnect and sign in again.',
    };
  }

  let raw: string | null;
  try {
    raw = store.getItem(BRANCH_SNAPSHOT_KEY);
  } catch {
    return {
      ok: false,
      reason: 'storage-error',
      error: 'This device cannot read its saved branch. Reconnect and sign in again.',
    };
  }

  if (!raw) {
    return {
      ok: false,
      reason: 'missing',
      error: 'No saved branch is available on this device. Reconnect to continue.',
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: 'malformed',
      error: 'The saved branch is damaged. Reconnect to verify access.',
    };
  }

  return validateBranchSnapshot(decoded, {
    userId: options.userId,
    now: options.now,
    maxAgeMs: options.maxAgeMs,
  });
}

/** Persists a server-confirmed snapshot. A storage failure is reported, never hidden. */
export function writeBranchSnapshot(
  input: {
    userId: string;
    branch: BranchSnapshotBranch;
    role: StaffRole;
    confirmedAt?: number;
  },
  storage?: Storage | null,
): SnapshotWriteResult {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return { ok: false, error: 'This device cannot save the branch.' };

  const snapshot: BranchSnapshot = {
    version: 1,
    userId: input.userId,
    branchId: input.branch.id,
    branch: input.branch,
    role: input.role,
    confirmedAt: input.confirmedAt ?? Date.now(),
  };

  try {
    store.setItem(BRANCH_SNAPSHOT_KEY, JSON.stringify(snapshot));
    return { ok: true };
  } catch {
    return { ok: false, error: 'This device could not save the branch.' };
  }
}

/** Removes the snapshot on sign-out. Best-effort, because the session is gone anyway. */
export function clearBranchSnapshot(storage?: Storage | null): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.removeItem(BRANCH_SNAPSHOT_KEY);
  } catch {
    /* ignore: the snapshot is unreadable without a matching session */
  }
}

/** True for transport-shaped failures where a cached branch is the honest fallback. */
export function isOfflineBranchFailure(message: string): boolean {
  return /fetch|network|load failed|timeout|timed out|connection|offline/i.test(message);
}
