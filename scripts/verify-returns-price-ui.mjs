/**
 * Offline checks for the returns and selling-price UI rules.
 *
 * The database suite proves the row locks, RLS and RPC behaviour. This file
 * proves the client-side rules that decide what a receipt shows, whether a return
 * can be started, how a return credit nets against outstanding, and which price
 * edits are refused before a round trip.
 *
 * It imports the same TypeScript modules the screens import. Bun strips type-only
 * imports, so no database, network or build step is involved.
 */

import { readFileSync } from 'node:fs';
import {
  RETURN_METHOD_LABEL,
  RETURN_REASON_LABEL,
  RETURN_STATUS_LABEL,
  canStartReturn,
  completedReturns,
  fullyReturned,
  netOutstanding,
  pendingReturns,
  returnStateLabel,
  returnedCredit,
  returnedValue,
  saleReturnState,
} from '../src/domain/returns.ts';
import { validateSellingPrice } from '../src/domain/pricing.ts';
import { summariseSales } from '../src/domain/selectors.ts';
import { toSale } from '../src/hooks/sales-mapping.ts';

let failed = 0;
let passed = 0;

function check(ok, label, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

function baseSale(overrides = {}) {
  return {
    id: 'sale-1',
    receiptNumber: 'PF-2026-0001',
    date: '2026-10-20T10:00:00.000Z',
    attendantId: 'user-1',
    attendantName: 'Ada',
    items: [
      {
        id: 'line-1',
        medicineId: 'med-1',
        medicineName: 'Paracetamol',
        genericName: 'Paracetamol',
        unitKey: 'tablet',
        unitName: 'Tablet',
        unitMultiplier: 1,
        unitPrice: 100,
        quantity: 10,
        baseUnitsTotal: 10,
        lineTotal: 1000,
      },
    ],
    subtotal: 1000,
    discount: 0,
    total: 1000,
    paymentMethod: 'cash',
    status: 'paid',
    amountPaid: 1000,
    outstandingBalance: 0,
    ...overrides,
  };
}

function baseReturn(overrides = {}) {
  return {
    id: 'return-1',
    returnNumber: 'RT-2026-000001',
    status: 'completed',
    reason: 'customer_changed_mind',
    note: '',
    createdAt: '2026-10-20T11:00:00.000Z',
    refundValue: 200,
    creditApplied: 0,
    refundAmount: 200,
    refundMethod: 'cash',
    items: [
      {
        saleItemId: 'line-1',
        medicineId: 'med-1',
        medicineName: 'Paracetamol',
        quantity: 2,
        baseUnitsTotal: 2,
        returnValue: 200,
        restockedUnits: 2,
        quarantinedUnits: 0,
      },
    ],
    ...overrides,
  };
}

console.log('');
console.log('  Returns and selling-price UI rules (offline)');
console.log('  ' + '='.repeat(58));

/* ------------------------------------------------------------------ returns */

check(Object.keys(RETURN_REASON_LABEL).length === 6, 'all six return reasons are labelled');
check(Object.keys(RETURN_STATUS_LABEL).length === 3, 'all three return states are labelled');
check(Object.keys(RETURN_METHOD_LABEL).length === 6, 'all six refund methods are labelled');
check(
  RETURN_STATUS_LABEL.pending_review === 'Awaiting approval',
  'a pending return is not shown as completed',
);

const none = baseSale();
check(returnedValue(none) === 0, 'a sale with no returns has no returned value');
check(saleReturnState(none) === 'none', 'a sale with no returns is not badged');

const partial = baseSale({ returns: [baseReturn()] });
check(returnedValue(partial) === 200, 'a completed return is counted once');
check(returnedCredit(partial) === 0, 'a paid return contributes no credit');
check(!fullyReturned(partial), 'a partial return does not mark the whole sale returned');
check(saleReturnState(partial) === 'partial', 'a partial return is labelled part returned');

const pending = baseReturn({
  id: 'return-pending',
  returnNumber: 'RT-2026-000002',
  status: 'pending_review',
  creditApplied: 0,
  refundAmount: 0,
});
const withPending = baseSale({ returns: [pending] });
check(returnedValue(withPending) === 0, 'a pending return is not counted as revenue or refund');
check(pendingReturns(withPending).length === 1, 'a pending return is available to the review queue');
check(saleReturnState(withPending) === 'pending', 'a pending return is badged separately');

const rejected = baseReturn({
  id: 'return-rejected',
  returnNumber: 'RT-2026-000003',
  status: 'rejected',
  creditApplied: 0,
  refundAmount: 0,
});
const withRejected = baseSale({ returns: [rejected] });
check(returnedValue(withRejected) === 0, 'a rejected return is not counted');
check(pendingReturns(withRejected).length === 0, 'a rejected return is not in the review queue');
check(saleReturnState(withRejected) === 'none', 'a rejected return leaves no return badge');

const full = baseReturn({
  id: 'return-full',
  returnNumber: 'RT-2026-000004',
  refundValue: 1000,
  creditApplied: 0,
  refundAmount: 1000,
  items: [
    {
      saleItemId: 'line-1',
      medicineId: 'med-1',
      medicineName: 'Paracetamol',
      quantity: 10,
      baseUnitsTotal: 10,
      returnValue: 1000,
      restockedUnits: 10,
      quarantinedUnits: 0,
    },
  ],
});
const fully = baseSale({ returns: [full] });
check(fullyReturned(fully), 'a completed full return marks every sold unit returned');
check(saleReturnState(fully) === 'returned', 'a fully returned sale is labelled returned');
check(returnStateLabel('returned') === 'Returned', 'the returned label is stable');

check(!canStartReturn(baseSale({ status: 'voided' })), 'a voided sale cannot start a return');
check(!canStartReturn(baseSale({ status: 'refunded' })), 'a refunded sale cannot start a return');
check(canStartReturn(partial), 'a completed sale can start a return');
check(netOutstanding(baseSale({ outstandingBalance: -5 })) === 0, 'net outstanding never goes negative');

const creditReturn = baseReturn({
  id: 'return-credit',
  refundValue: 300,
  creditApplied: 300,
  refundAmount: 0,
  refundMethod: 'not_refunded',
});
const creditedSale = baseSale({
  status: 'credit',
  amountPaid: 0,
  outstandingBalance: 300,
  returnedCredit: 300,
  returns: [creditReturn],
});
check(completedReturns(creditedSale).length === 1, 'a credit return is a completed return');
check(returnedValue(creditedSale) === 300, 'the credit return value is recorded once');

const summarySale = baseSale({ returns: [partial.returns[0]] });
const summary = summariseSales([summarySale]);
check(summary.net === 1000, 'gross sale value is not rewritten by a return');
check(summary.returned === 200, 'the summary reports the accepted return value');
check(summary.netAfterReturns === 800, 'net after returns is sale value less accepted returns');
check(summary.outstanding === 0, 'a fully paid sale has no net outstanding');

const twoReturns = summariseSales([
  baseSale({ id: 'a', returns: [partial.returns[0]] }),
  baseSale({ id: 'b', returns: [baseReturn({ id: 'r-b', refundValue: 100, items: [] })] }),
]);
check(twoReturns.returned === 300, 'returns from separate sales sum once');
check(twoReturns.netAfterReturns === 1700, 'net after returns sums each sale once');

/* -------------------------------------------------------------- row mapping */

const mapped = toSale(
  {
    id: 'sale-map',
    receipt_number: 'PF-2026-0009',
    sold_at: '2026-10-20T10:00:00.000Z',
    attendant_id: 'user-1',
    customer_id: null,
    credit_account_id: null,
    subtotal: 1000,
    discount: 0,
    discount_reason: null,
    total: 1000,
    payment_method: 'credit',
    state: 'credit',
    amount_paid: 0,
    outstanding: 600,
    returned_credit: 300,
    dispensed_against_prescription: false,
    status_reason: null,
    status_changed_by: null,
    status_changed_at: null,
    sale_items: [
      {
        id: 'line-map',
        sale_id: 'sale-map',
        batch_id: null,
        medicine_id: 'med-1',
        medicine_name: 'Paracetamol',
        generic_name: 'Paracetamol',
        unit_key: 'tablet',
        unit_name: 'Tablet',
        unit_multiplier: 1,
        quantity: 10,
        base_units_total: 10,
        unit_price: 100,
        line_total: 1000,
      },
    ],
    medicine_returns: [
      {
        id: 'return-map',
        branch_id: 'branch-1',
        sale_id: 'sale-map',
        return_number: 'RT-2026-000005',
        status: 'completed',
        reason: 'damaged',
        note: 'torn pack',
        idempotency_key: null,
        requested_by: 'user-1',
        reviewed_by: 'owner-1',
        reviewed_at: '2026-10-20T11:00:00.000Z',
        review_note: null,
        completed_at: '2026-10-20T11:00:00.000Z',
        refund_value: 300,
        credit_applied: 300,
        refund_amount: 0,
        refund_method: 'not_refunded',
        created_at: '2026-10-20T11:00:00.000Z',
        updated_at: '2026-10-20T11:00:00.000Z',
        medicine_return_items: [
          {
            id: 'ri-map',
            return_id: 'return-map',
            sale_item_id: 'line-map',
            medicine_id: 'med-1',
            quantity: 3,
            base_units_total: 3,
            unit_price: 100,
            line_total: 300,
            return_value: 300,
            restocked_units: 0,
            quarantined_units: 3,
            created_at: '2026-10-20T11:00:00.000Z',
          },
        ],
      },
    ],
  },
  'Ada',
);
check(mapped.outstandingBalance === 300, 'mapped outstanding is net of the return credit');
check(mapped.returnedCredit === 300, 'mapped sale carries the return credit separately');
check(mapped.returns?.length === 1, 'mapped sale carries its linked returns');
check(mapped.returns?.[0].items[0].medicineName === 'Paracetamol', 'return line resolves the sale line name');
check(mapped.items[0].id === 'line-map', 'mapped sale lines retain their database id');

/* ----------------------------------------------------------------- prices */

function price(overrides) {
  return validateSellingPrice({
    price: 120,
    unitMultiplier: 1,
    costPerBaseUnit: 50,
    currentPrice: 100,
    expectedPrice: 100,
    ...overrides,
  });
}

check(price({}).ok && price({}).value === 120, 'a valid owner price is accepted');
check(price({ unitMultiplier: 10, price: 900, currentPrice: 800, expectedPrice: 800 }).ok,
  'a valid box price is accepted');
check(!price({ price: 0 }).ok, 'zero is refused');
check(!price({ price: -1 }).ok, 'a negative price is refused');
check(!price({ price: Number.NaN }).ok, 'NaN is refused');
check(!price({ price: Number.POSITIVE_INFINITY }).ok, 'Infinity is refused');
check(!price({ price: 120.001 }).ok, 'more than two decimal places is refused');
check(!price({ price: 100 }).ok, 'an unchanged price is refused');
check(!price({ expectedPrice: 90 }).ok, 'a stale expected price is refused');
check(!price({ price: 50 }).ok, 'a price at cost is refused');
check(!price({ price: 40 }).ok, 'a price below cost is refused');
check(!price({ unitMultiplier: 10, price: 400, currentPrice: 900, expectedPrice: 900 }).ok,
  'a box price below its unit cost is refused');
check(price({ costPerBaseUnit: undefined, price: 1 }).ok,
  'without cost access the client skips the cost floor (the server still enforces it)');
check(!price({ unitMultiplier: 0 }).ok, 'an invalid multiplier is refused');
check(price({ price: 120.004 }).error.includes('two decimal'), 'the decimal refusal explains itself');
check(price({ expectedPrice: 90 }).error.includes('changed'), 'the stale refusal explains itself');

/* ------------------------------------------------ offline queue boundaries */

const offlinePos = readFileSync(
  new URL('../src/offline/pos-offline.ts', import.meta.url),
  'utf8',
);
const returnDialog = readFileSync(
  new URL('../src/components/app/sale-return-dialog.tsx', import.meta.url),
  'utf8',
);
const reviewDialog = readFileSync(
  new URL('../src/components/app/sale-return-review-dialog.tsx', import.meta.url),
  'utf8',
);
const inventoryScreen = readFileSync(
  new URL('../src/routes/_app/inventory.tsx', import.meta.url),
  'utf8',
);
const salesScreen = readFileSync(
  new URL('../src/routes/_app/sales.tsx', import.meta.url),
  'utf8',
);

check(
  !offlinePos.includes('pf_create_return') && !offlinePos.includes('pf_review_return'),
  'returns are not queued in the offline POS outbox',
);
check(
  !offlinePos.includes('pf_update_medicine_price'),
  'price changes are not queued in the offline POS outbox',
);
check(
  returnDialog.includes('navigator.onLine === false') &&
    returnDialog.includes('createSaleReturn('),
  'the return dialog refuses offline instead of reporting a queued return',
);
check(
  reviewDialog.includes('navigator.onLine === false') &&
    reviewDialog.includes('reviewSaleReturn('),
  'the approval dialog refuses offline instead of reporting a queued decision',
);
check(
  inventoryScreen.includes('navigator.onLine === false') &&
    inventoryScreen.includes('updateMedicinePrice('),
  'the price dialog refuses offline and writes only through the authoritative RPC',
);
check(
  salesScreen.includes("source === 'supabase'") &&
    salesScreen.includes('live && sale && canStartReturn(sale)'),
  'the demo ledger does not offer a return that cannot be persisted',
);
check(
  salesScreen.includes('listPendingReturns(') && salesScreen.includes('pendingQueue'),
  'the owner review queue is a branch-wide read, not a window of recent sales',
);

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
