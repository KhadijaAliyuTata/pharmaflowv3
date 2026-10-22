/**
 * The settlement rule for a sale that cannot reach the server.
 *
 * An offline sale is deliberately narrower than an online one: the till cannot
 * read the customer's live debt or wallet balance, and it cannot ask the server
 * to validate a credit limit. The safe settlement is therefore cash, in full,
 * with no balance left behind. The POS disables the other choices and calls
 * this function again at submission time, so a stale render or a keyboard path
 * cannot bypass the UI.
 */

import type { PaymentMethod } from '~/domain/types';

export type OfflinePaymentMode = 'full' | 'part' | 'debt' | 'split';

export const OFFLINE_CASH_ONLY_MESSAGE =
  'Offline sales must be paid in full with cash. Debt, part payment, wallet, split, transfer and card are unavailable until the server is reachable.';

/**
 * Returns the attendant-facing refusal, or `null` when the settlement is
 * allowed offline. Only `full` + `cash` is allowed.
 */
export function offlineSettlementError(
  payMode: OfflinePaymentMode,
  paymentMethod: PaymentMethod,
): string | null {
  return payMode === 'full' && paymentMethod === 'cash'
    ? null
    : OFFLINE_CASH_ONLY_MESSAGE;
}
