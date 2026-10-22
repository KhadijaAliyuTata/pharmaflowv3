import type { Sale, SaleReturn, SaleReturnMethod, SaleReturnReason, SaleReturnStatus } from './types';

/**
 * Returns, as the screens need them.
 *
 * The database owns eligibility, quantities, batch allocation and money. These
 * helpers only decide what a completed/returned/pending sale looks like and what
 * a person is allowed to try next. They never substitute for
 * `pf_sale_returnable` or `pf_create_return`.
 */

export const RETURN_REASON_LABEL: Record<SaleReturnReason, string> = {
  wrong_medicine: 'Wrong medicine dispensed',
  damaged: 'Damaged or unusable',
  customer_changed_mind: 'Customer changed their mind',
  expired: 'Expired',
  recalled: 'Recalled',
  other: 'Other',
};

export const RETURN_REASON_OPTIONS = (
  Object.keys(RETURN_REASON_LABEL) as SaleReturnReason[]
).map((value) => ({ value, label: RETURN_REASON_LABEL[value] }));

export const RETURN_STATUS_LABEL: Record<SaleReturnStatus, string> = {
  pending_review: 'Awaiting approval',
  completed: 'Completed',
  rejected: 'Rejected',
};

export const RETURN_METHOD_LABEL: Record<SaleReturnMethod, string> = {
  cash: 'Cash',
  transfer: 'Bank transfer',
  pos_card: 'POS terminal',
  wallet: 'Wallet',
  store_credit: 'Store credit',
  not_refunded: 'No refund due',
};

export const RETURN_METHOD_OPTIONS = (
  Object.keys(RETURN_METHOD_LABEL) as SaleReturnMethod[]
)
  .filter((value) => value !== 'not_refunded')
  .map((value) => ({ value, label: RETURN_METHOD_LABEL[value] }));

const COMPLETED = 'completed';
const PENDING = 'pending_review';

export function saleReturns(sale: Sale): SaleReturn[] {
  return sale.returns ?? [];
}

export function completedReturns(sale: Sale): SaleReturn[] {
  return saleReturns(sale).filter((entry) => entry.status === COMPLETED);
}

export function pendingReturns(sale: Sale): SaleReturn[] {
  return saleReturns(sale).filter((entry) => entry.status === PENDING);
}

/** Value of accepted returns. Pending and rejected returns do not reduce revenue. */
export function returnedValue(sale: Sale): number {
  return completedReturns(sale).reduce((total, entry) => total + entry.refundValue, 0);
}

export function returnedCredit(sale: Sale): number {
  return completedReturns(sale).reduce((total, entry) => total + entry.creditApplied, 0);
}

/**
 * Whether every sold unit has been accepted back.
 *
 * This is a whole-unit test because the return model is whole-unit. A sale with
 * two lines of the same medicine is still only "fully returned" when both lines
 * have no quantity left.
 */
export function fullyReturned(sale: Sale): boolean {
  const completed = completedReturns(sale);
  if (completed.length === 0 || sale.items.length === 0) return false;

  const returnedByLine = new Map<string, number>();
  for (const entry of completed) {
    for (const item of entry.items) {
      returnedByLine.set(
        item.saleItemId,
        (returnedByLine.get(item.saleItemId) ?? 0) + item.quantity,
      );
    }
  }

  if (sale.items.every((item) => item.id)) {
    return sale.items.every(
      (item) => (returnedByLine.get(item.id as string) ?? 0) >= item.quantity,
    );
  }

  // Demo seeds have no line ids. Fall back to the conservative base-unit test:
  // accepted units must cover every sold base unit.
  const soldBaseUnits = sale.items.reduce((total, item) => total + item.baseUnitsTotal, 0);
  const returnedBaseUnits = completed.reduce(
    (total, entry) =>
      total + entry.items.reduce((lineTotal, item) => lineTotal + item.baseUnitsTotal, 0),
    0,
  );
  return soldBaseUnits > 0 && returnedBaseUnits >= soldBaseUnits;
}

export type SaleReturnState = 'none' | 'pending' | 'partial' | 'returned';

/**
 * A single label for the receipt row. Completed returns win over a pending one:
 * the receipt has real returned units, and the pending request is shown in the
 * review queue separately.
 */
export function saleReturnState(sale: Sale): SaleReturnState {
  if (fullyReturned(sale)) return 'returned';
  if (completedReturns(sale).length > 0) return 'partial';
  if (pendingReturns(sale).length > 0) return 'pending';
  return 'none';
}

export function returnStateLabel(state: SaleReturnState): string {
  switch (state) {
    case 'returned':
      return 'Returned';
    case 'partial':
      return 'Part returned';
    case 'pending':
      return 'Return pending';
    default:
      return '';
  }
}

/**
 * A sale is eligible for the normal return workflow only after it completed and
 * before it was voided or marked refunded. The database checks the same thing.
 */
export function canStartReturn(sale: Sale): boolean {
  return (
    sale.items.length > 0 &&
    sale.status !== 'voided' &&
    sale.status !== 'refunded'
  );
}

/** Effective amount still owed after accepted return credits. */
export function netOutstanding(sale: Sale): number {
  return Math.max(sale.outstandingBalance, 0);
}
