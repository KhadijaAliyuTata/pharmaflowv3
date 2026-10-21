/**
 * Reconciliation for an ambiguous non-cash checkout.
 *
 * The ordinary retry story relies on the server's idempotency key: re-sending
 * the SAME intent is safe because the replay returns the original sale. That
 * assumption breaks when the settlement itself changes. If a credit, part,
 * wallet, transfer, card or split attempt reached the server but the response
 * was lost, switching the same cart to Full + Cash and re-using the key would
 * replay the ORIGINAL sale. The server cannot tell us which method it stored
 * through `pf_complete_sale`, so the till must not present that replay as a
 * fresh cash receipt.
 *
 * The fix is deliberately not a new key (which would hide the uncertainty and
 * could ring up a second sale). Instead the failed attempt becomes explicit
 * reconciliation state: the cart and the evidence (key, method, amounts) are
 * kept, further submissions are blocked, and a person must check the ledger
 * before either closing the attempt or starting a genuinely new transaction.
 */

import type { PaymentMethod } from '~/domain/types';
import { offlineSettlementError, type OfflinePaymentMode } from './payment-policy';

/**
 * Local `meta` key for the current reconciliation block, scoped by the repo's
 * own `(pharmacy, user)` database. One POS cart exists at a time, so one key is
 * enough; submissions are blocked after the first unresolved attempt.
 */
export const UNRESOLVED_ATTEMPT_META_KEY = 'settlement:unresolved-attempt:v1';

/** What the till knows about an attempt whose outcome it never observed. */
export interface UnresolvedSaleAttempt {
  idempotencyKey: string;
  /**
   * The settlement shape originally chosen. Needed because Debt and Part are
   * blocked settlements even though their underlying method is cash.
   */
  payMode: OfflinePaymentMode;
  /** The method originally sent — never the method the cashier switched to. */
  paymentMethod: string;
  amountPaid: number;
  total: number;
  attemptedAt: string;
}

const OFFLINE_PAY_MODES = new Set<OfflinePaymentMode>(['full', 'part', 'debt', 'split']);

/** The honest short label for the attempt: Debt, Part, Wallet, Split, Cash… */
export function attemptSettlementLabel(attempt: UnresolvedSaleAttempt): string {
  return attempt.payMode === 'full' ? attempt.paymentMethod : attempt.payMode;
}

export interface NonCashFailureInput {
  failureKind: string;
  payMode: OfflinePaymentMode;
  paymentMethod: PaymentMethod;
  idempotencyKey: string;
  amountPaid: number;
  total: number;
  /** Injectable clock for tests; defaults to the real time. */
  at?: string;
}

/**
 * Evidence to preserve when a checkout lost its connection before an answer.
 *
 * Returns `null` for a full-cash attempt: that path has no blocked settlement
 * to confuse, so it can safely be queued and replayed under the same key.
 * A non-transport failure also returns `null` — a server refusal is a known
 * outcome, not an ambiguous one.
 */
export function unresolvedNonCashAttempt(
  input: NonCashFailureInput,
): UnresolvedSaleAttempt | null {
  if (input.failureKind !== 'network') return null;
  if (offlineSettlementError(input.payMode, input.paymentMethod) === null) return null;
  return {
    idempotencyKey: input.idempotencyKey,
    payMode: input.payMode,
    paymentMethod: input.paymentMethod,
    amountPaid: input.amountPaid,
    total: input.total,
    attemptedAt: input.at ?? new Date().toISOString(),
  };
}

/**
 * The refusal shown when anything is submitted while an attempt is unresolved.
 * It blocks even a cash retry with a different key: the point is to make the
 * cashier settle the earlier question first, not to route around it.
 */
export function unresolvedAttemptBlock(
  attempt: UnresolvedSaleAttempt | null,
): string | null {
  if (!attempt) return null;
  return (
    `An earlier ${attemptSettlementLabel(attempt)} attempt (key ${attempt.idempotencyKey}) ` +
    'may already be in the sales ledger. This till will not send another sale ' +
    'for this cart until you check the ledger and resolve that attempt.'
  );
}

/**
 * Keeps an in-memory attempt when an identity change re-reads the new identity's
 * `meta` store. A restored note may belong to another branch/account; it must
 * never replace the attempt that is still guarding this cart and key.
 */
export function retainUnresolvedAttempt(
  current: UnresolvedSaleAttempt | null,
  restored: UnresolvedSaleAttempt | null,
): UnresolvedSaleAttempt | null {
  return current ?? restored;
}

/**
 * True only when the durable note belongs to the database the POS is currently
 * using. Resolution must never clear another identity's evidence just because
 * the user switched branch or account before checking the ledger.
 *
 * The key is the storage identity (`pharmacyId:userId`), not the role-bearing
 * POS identity key: role changes open the same database, while branch/user
 * changes do not.
 */
export function shouldClearUnresolvedNote(
  originStorageIdentityKey: string | null,
  currentStorageIdentityKey: string | null,
): boolean {
  return (
    originStorageIdentityKey !== null &&
    originStorageIdentityKey === currentStorageIdentityKey
  );
}

/**
 * The minimal repository surface reconciliation needs. Keeping this structural
 * avoids a local-db import cycle while still checking the repository's ACTUAL
 * identity, not a display label or a stale React ref.
 */
export interface ReconciliationMetaRepo {
  readonly identity: { pharmacyId: string; userId: string };
  metaGet<T>(key: string): Promise<T | undefined>;
  metaSet(key: string, value: unknown): Promise<void>;
}

/** True only when the repository's validated branch/user matches the origin. */
export function reconciliationRepoMatches(
  repo: ReconciliationMetaRepo | null,
  originStorageIdentityKey: string | null,
): boolean {
  if (!repo || originStorageIdentityKey === null) return false;
  return (
    `${repo.identity.pharmacyId}:${repo.identity.userId}` ===
    originStorageIdentityKey
  );
}

/**
 * Saves an unresolved-attempt note only in the repository that was captured
 * when the attempt began. A mismatched, closed or unavailable repository fails
 * closed, and an existing note for a DIFFERENT key is never overwritten.
 */
export async function persistUnresolvedAttempt(
  repo: ReconciliationMetaRepo | null,
  originStorageIdentityKey: string | null,
  attempt: UnresolvedSaleAttempt,
): Promise<boolean> {
  if (!repo || !reconciliationRepoMatches(repo, originStorageIdentityKey)) return false;
  try {
    const existing = parseUnresolvedAttempt(
      await repo.metaGet<unknown>(UNRESOLVED_ATTEMPT_META_KEY),
    );
    if (existing && existing.idempotencyKey !== attempt.idempotencyKey) return false;
    await repo.metaSet(UNRESOLVED_ATTEMPT_META_KEY, attempt);
    return true;
  } catch {
    // A closed handle, quota failure or identity race must not be reported as
    // saved and must never fall back to another repository.
    return false;
  }
}

/**
 * Clears only the note belonging to this attempt in its originating repository.
 * A missing/mismatched repository, unreadable note or different key fails closed
 * so explicit resolution cannot delete another identity's evidence.
 */
export async function clearUnresolvedAttempt(
  repo: ReconciliationMetaRepo | null,
  originStorageIdentityKey: string | null,
  idempotencyKey: string,
): Promise<boolean> {
  if (!repo || !reconciliationRepoMatches(repo, originStorageIdentityKey)) return false;
  try {
    const raw = await repo.metaGet<unknown>(UNRESOLVED_ATTEMPT_META_KEY);
    if (raw !== undefined && raw !== null) {
      const existing = parseUnresolvedAttempt(raw);
      if (!existing || existing.idempotencyKey !== idempotencyKey) return false;
    }
    await repo.metaSet(UNRESOLVED_ATTEMPT_META_KEY, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * A replay is safe only when the original settlement is known to be the same
 * intent. A server `alreadyCompleted` response carries no payment method, so a
 * replay of an unresolved non-cash key must never be rendered as a clean cash
 * receipt. Normal cash retries have no unresolved attempt and remain allowed.
 */
export function isUnverifiedCompletedReplay(input: {
  alreadyCompleted: boolean;
  attempt: UnresolvedSaleAttempt | null;
  idempotencyKey: string;
}): boolean {
  return (
    input.alreadyCompleted &&
    input.attempt !== null &&
    input.attempt.idempotencyKey === input.idempotencyKey
  );
}

/**
 * Reads the durable note back defensively. IndexedDB contents are just bytes on
 * the device: a malformed or tampered note is ignored rather than trusted as
 * reconciliation state.
 */
export function parseUnresolvedAttempt(value: unknown): UnresolvedSaleAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.idempotencyKey !== 'string' || row.idempotencyKey.trim() === '') return null;
  if (!OFFLINE_PAY_MODES.has(row.payMode as OfflinePaymentMode)) return null;
  if (typeof row.paymentMethod !== 'string' || row.paymentMethod.trim() === '') return null;
  if (
    typeof row.amountPaid !== 'number' ||
    !Number.isFinite(row.amountPaid) ||
    row.amountPaid < 0
  ) {
    return null;
  }
  if (typeof row.total !== 'number' || !Number.isFinite(row.total) || row.total < 0) {
    return null;
  }
  if (typeof row.attemptedAt !== 'string' || Number.isNaN(Date.parse(row.attemptedAt))) {
    return null;
  }
  return {
    idempotencyKey: row.idempotencyKey,
    payMode: row.payMode as OfflinePaymentMode,
    paymentMethod: row.paymentMethod,
    amountPaid: row.amountPaid,
    total: row.total,
    attemptedAt: row.attemptedAt,
  };
}
