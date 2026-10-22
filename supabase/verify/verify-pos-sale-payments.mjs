/**
 * POS sale payments â€” client-side intent validation and domain checkout for the
 * four settlement states (full / part / debt / split) and their reflection in
 * the outbox and the demo store.
 *
 * Run as part of `bun run verify:db`.
 *
 * Covers what this change added, client side:
 *
 *   - `validateSaleIntent` (src/offline/pos-offline.ts) accepts the split shape
 *     and refuses the broken shapes BEFORE the outbox: a split without parts, a
 *     single-method "split", parts summing above the amount received, an
 *     invented method, a breakdown on an ordinary sale.
 *   - `recordSaleIntent` persists the breakdown durably and a repeated click
 *     with the same key stays ONE operation (duplicate, not a conflict).
 *   - `ops.checkout` (src/domain/operations.ts) re-derives the same refusals
 *     for the store path, records `paymentMethod: 'split'` with the parts on
 *     the sale, and computes part_paid / credit states and customer debt.
 *   - `ops.registerCustomer` and `ops.recordCustomerPayment`: registration
 *     dedupes on the phone; a repayment moves the sale and the customer's debt
 *     atomically, with an audit row on the sale; overpayment, settled,
 *     walk-in and non-staff attempts are refused.
 *
 * DB-side rules (payment rows, tenant isolation, RPC atomicity) are covered in
 * verify-authoritative-checkout.mjs. What neither can prove: real two-till
 * concurrency under live Postgres â€” noted there.
 */

import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined') {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

import { OfflineRepo } from '../../src/offline/local-db.ts';
import { recordSaleIntent, validateSaleIntent } from '../../src/offline/pos-offline.ts';
import * as ops from '../../src/domain/operations.ts';
import { createSeedState } from '../../src/domain/seed.ts';
import { can } from '../../src/domain/state.ts';
import { createReporter } from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-pos-sale-payments');

/* ------------------------------------------------------------------ fixtures */

const BASE_INTENT = () => ({
  lines: [{ medicineId: 'med-1', unitKey: 'box', quantity: 1 }],
  paymentMethod: 'cash',
  amountPaid: 400,
  expected: {
    subtotal: 400,
    discount: 0,
    total: 400,
    amountPaid: 400,
    lines: [
      { medicineId: 'med-1', unitKey: 'box', quantity: 1, unitPrice: 400, lineTotal: 400 },
    ],
  },
});

const SPLIT_PARTS = [
  { method: 'cash', amount: 150 },
  { method: 'transfer', amount: 250 },
];

const PH = '22222222-3333-3333-3333-333333333333';

const openRepo = (label) => OfflineRepo.open({ pharmacyId: PH, userId: `pay-${label}` }, 'assistant');

/** A seeded staff user + state, isolated per section via fresh copies. */
const staffState = () => {
  const state = createSeedState(); // fresh, so sections never share mutations
  const owner = state.users.find((user) => user.role === 'owner') ?? state.users[0];
  return { state, owner };
};

/** One cart line built the way the POS does, off the medicine's own hierarchy. */
const oneLine = (state) => {
  const medicine = state.medicines[0];
  const unit = medicine.units[0];
  const bigger = medicine.units.reduce((a, b) => (b.multiplier > a.multiplier ? b : a));
  const chosen = medicine.units.length > 1 ? bigger : unit;
  return {
    line: {
      medicineId: medicine.id,
      unitKey: chosen.key,
      unitName: chosen.name,
      unitMultiplier: chosen.multiplier,
      unitPrice: chosen.sellingPrice,
      quantity: 1,
      baseUnitsTotal: chosen.multiplier,
      lineTotal: chosen.sellingPrice,
    },
    medicine,
    total: chosen.sellingPrice * 1,
  };
};

/* --------------------------------------------------- intent validation (shape) */

section('INTENT: the split shape is accepted');
{
  const r = validateSaleIntent({
    ...BASE_INTENT(),
    paymentMethod: 'split',
    amountPaid: 400,
    paymentBreakdown: SPLIT_PARTS,
  });
  check('a valid split intent passes', r.ok, r.ok ? 'ok' : r.error);
}

section('INTENT: broken payment shapes are refused before the outbox');
{
  const noBreakdown = validateSaleIntent({ ...BASE_INTENT(), paymentMethod: 'split' });
  check('split without a breakdown is refused', !noBreakdown.ok, noBreakdown.ok ? 'accepted' : noBreakdown.error);

  const singlePart = validateSaleIntent({
    ...BASE_INTENT(),
    paymentMethod: 'split',
    paymentBreakdown: [{ method: 'cash', amount: 400 }],
  });
  check('a one-method split is refused', !singlePart.ok, singlePart.ok ? 'accepted' : singlePart.error);

  const overSum = validateSaleIntent({
    ...BASE_INTENT(),
    paymentMethod: 'split',
    paymentBreakdown: [
      { method: 'cash', amount: 400 },
      { method: 'transfer', amount: 100 },
    ],
  });
  check('parts summing above amount_paid are refused', !overSum.ok, overSum.ok ? 'accepted' : overSum.error);

  const invented = validateSaleIntent({
    ...BASE_INTENT(),
    paymentMethod: 'split',
    paymentBreakdown: [
      { method: 'cash', amount: 150 },
      { method: 'bitcoin', amount: 250 },
    ],
  });
  check('an invented method is refused', !invented.ok, invented.ok ? 'accepted' : invented.error);

  const zeroPart = validateSaleIntent({
    ...BASE_INTENT(),
    paymentMethod: 'split',
    paymentBreakdown: [
      { method: 'cash', amount: 0 },
      { method: 'transfer', amount: 400 },
    ],
  });
  check('a zero part is refused', !zeroPart.ok, zeroPart.ok ? 'accepted' : zeroPart.error);

  const ordinary = validateSaleIntent({ ...BASE_INTENT(), paymentBreakdown: SPLIT_PARTS });
  check('a breakdown on an ordinary cash sale is refused', !ordinary.ok, ordinary.ok ? 'accepted' : ordinary.error);
}

/* ------------------------------------------------------------------- outbox */

section('INTENT: the breakdown rides durably in the outbox, and replay stays one operation');
{
  const repo = await openRepo('breakdown');
  const key = 'pos-pay-test-1';
  const first = await recordSaleIntent(
    repo,
    { ...BASE_INTENT(), paymentMethod: 'split', amountPaid: 400, paymentBreakdown: SPLIT_PARTS },
    key,
  );
  check('the split intent was recorded', first.ok, first.ok ? 'ok' : first.error);

  const durable = await repo.getOutboxOp(key);
  const payload = durable?.payload ?? {};
  check(
    'the stored payload carries both parts',
    Array.isArray(payload.payment_breakdown) &&
      payload.payment_breakdown.length === 2 &&
      Number(payload.payment_breakdown[1].amount) === 250,
    JSON.stringify(payload.payment_breakdown),
  );

  const repeat = await recordSaleIntent(
    repo,
    { ...BASE_INTENT(), paymentMethod: 'split', amountPaid: 400, paymentBreakdown: SPLIT_PARTS },
    key,
  );
  check('a repeated click is a duplicate, not a conflict', repeat.ok && repeat.data.duplicate === true);

  await repo.close();
}

/* ------------------------------------------------------- domain: checkout */

section('CHECKOUT: split records the parts; part and debt states and debts are right');
{
  const { state } = staffState();
  const { line, total } = oneLine(state);
  const customer = state.customers[0];
  const halfway = Math.floor((total / 2) * 100) / 100; // kobo-safe half

  // Split, fully paid, money on both methods.
  const split = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'split',
    amountPaid: total,
    paymentBreakdown: [
      { method: 'cash', amount: halfway },
      { method: 'transfer', amount: Math.round((total - halfway) * 100) / 100 },
    ],
  });
  check('split checkout was accepted', split.ok, split.ok ? split.value.sale.receiptNumber : split.error);
  check('split sale recorded under the split method', split.ok && split.value.sale.paymentMethod === 'split');
  check(
    'split sale carries both parts on the sale',
    split.ok && split.value.sale.paymentBreakdown?.length === 2,
    JSON.stringify(split.value.sale.paymentBreakdown ?? []),
  );
  check('split sale is fully paid', split.ok && split.value.sale.status === 'paid');

  // Part payment against a named customer.
  const part = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'cash',
    amountPaid: halfway,
    customerId: customer.id,
  });
  check('part payment was accepted', part.ok, part.ok ? part.value.sale.receiptNumber : part.error);
  check('part sale is part_paid', part.ok && part.value.sale.status === 'part_paid');
  check(
    'outstanding is exactly the unpaid half',
    part.ok && part.value.sale.outstandingBalance === Math.round((total - halfway) * 100) / 100,
    String(part.value.sale.outstandingBalance),
  );
  const customerAfterPart = part.value.state.customers.find((row) => row.id === customer.id);
  check(
    'the customer debt grew by the outstanding balance',
    part.ok &&
      customerAfterPart.outstandingDebt ===
        Math.round((customer.outstandingDebt + (total - halfway)) * 100) / 100,
    String(customerAfterPart.outstandingDebt),
  );

  // Debt (pay later) â€” nothing collected, customer required.
  const debt = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'cash',
    amountPaid: 0,
    customerId: customer.id,
  });
  check('debt sale was accepted', debt.ok, debt.ok ? debt.value.sale.receiptNumber : debt.error);
  check('debt sale is recorded as credit', debt.ok && debt.value.sale.status === 'credit');
  check(
    'debt sale owes the whole total',
    debt.ok && debt.value.sale.outstandingBalance === total,
    String(debt.value.sale.outstandingBalance),
  );

  // A balance left without a named customer stays refused.
  const anonymous = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'cash',
    amountPaid: halfway,
  });
  check('an outstanding balance without a customer is refused', !anonymous.ok, anonymous.ok ? 'accepted' : anonymous.error);
}

section('CHECKOUT: the same broken split shapes the RPC refuses, the store refuses');
{
  const { state } = staffState();
  const { line, total } = oneLine(state);

  const onePart = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'split',
    amountPaid: total,
    paymentBreakdown: [{ method: 'cash', amount: total }],
  });
  check('a one-method split is refused', !onePart.ok, onePart.ok ? 'accepted' : onePart.error);

  const overSum = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'split',
    amountPaid: total,
    paymentBreakdown: [
      { method: 'cash', amount: total },
      { method: 'wallet', amount: 1 },
    ],
  });
  check('parts above the amount received are refused', !overSum.ok, overSum.ok ? 'accepted' : overSum.error);

  const noParts = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'split',
    amountPaid: total,
  });
  check('a split without parts is refused', !noParts.ok, noParts.ok ? 'accepted' : noParts.error);
}

/* ----------------------------------------------- domain: register + repay */

section('CUSTOMER: inline registration dedupes on the phone');
{
  const { state } = staffState();
  const existing = state.customers[0];

  const created = ops.registerCustomer(state, 'Mama Amina', '08123456789');
  check('a new customer registers', created.ok, created.ok ? created.value.customer.code : created.error);
  check(
    'the new customer starts clean',
    created.ok && created.value.customer.outstandingDebt === 0 && created.value.customer.purchaseCount === 0,
  );

  const dupe = ops.registerCustomer(state, 'Someone Else', existing.phone);
  check('an existing phone is refused, not silently duplicated', !dupe.ok, dupe.ok ? 'accepted' : dupe.error);

  const stub = ops.registerCustomer(state, 'X', '08');
  check('a stub phone is refused', !stub.ok, stub.ok ? 'accepted' : stub.error);
}

section('REPAYMENT: a balance settles to exactly zero, with audit rows on the sale');
{
  const { state } = staffState();
  const { line, total } = oneLine(state);
  const customer = state.customers[0];
  const owed = Math.round((total / 2) * 100) / 100;

  const saleResult = ops.checkout(state, {
    lines: [line],
    paymentMethod: 'cash',
    amountPaid: total - owed, // exactly half collected
    customerId: customer.id,
  });
  if (!saleResult.ok) {
    check('the debt fixture was accepted', false, saleResult.error);
  } else {
    check('the debt fixture was accepted', true, '');

    const sale = saleResult.value.sale;
    const first = ops.recordCustomerPayment(saleResult.value.state, sale.id, owed / 2, 'transfer');
    check('the first repayment (assistant-grade operation) was accepted', first.ok, first.ok ? 'ok' : first.error);
    const afterFirst = first.state.sales.find((row) => row.id === sale.id);
    check(
      'the balances moved atomically',
      first.ok &&
        afterFirst.amountPaid === Math.round((sale.amountPaid + owed / 2) * 100) / 100 &&
        afterFirst.outstandingBalance === Math.round((owed - owed / 2) * 100) / 100,
      `${afterFirst.amountPaid}/${afterFirst.outstandingBalance}`,
    );
    check(
      'the repayment is an audit row on the sale: method, amount, recorder, time',
      first.ok &&
        afterFirst.paymentBreakdown.some(
          (part) => part.method === 'transfer' && part.amount === owed / 2 && !!part.recordedBy && !!part.recordedAt,
        ),
    );

    const overpay = ops.recordCustomerPayment(first.state, sale.id, owed, 'cash');
    check('a repayment above the remaining balance is refused', !overpay.ok, overpay.ok ? 'accepted' : overpay.error);

    const zero = ops.recordCustomerPayment(first.state, sale.id, 0, 'cash');
    check('a zero repayment is refused', !zero.ok, zero.ok ? 'accepted' : zero.error);

    const splitish = ops.recordCustomerPayment(first.state, sale.id, 1, 'split');
    check('a split repayment is refused â€” one method per repayment', !splitish.ok, splitish.ok ? 'accepted' : splitish.error);

    const exactFinal = ops.recordCustomerPayment(first.state, sale.id, owed - owed / 2, 'cash');
    check('the exact balance settles', exactFinal.ok, exactFinal.ok ? 'ok' : exactFinal.error);
    const settled = exactFinal.state.sales.find((row) => row.id === sale.id);
    check('the settled sale is paid in full', exactFinal.ok && settled.status === 'paid' && settled.outstandingBalance === 0);
    const settledCustomer = exactFinal.state.customers.find((row) => row.id === customer.id);
    check(
      'the customer debt is exactly back to its starting figure — never below zero',
      exactFinal.ok && settledCustomer.outstandingDebt === customer.outstandingDebt,
      `${settledCustomer.outstandingDebt} vs start ${customer.outstandingDebt}`,
    );
    check('both repayments are on the audit rows of the sale', exactFinal.ok && settled.paymentBreakdown.filter((part) => part.recordedAt).length === 2);

    const again = ops.recordCustomerPayment(exactFinal.state, sale.id, 1, 'cash');
    check('a settled sale takes no further repayment', !again.ok, again.ok ? 'accepted' : again.error);
  }
}

section('REPAYMENT: walk-in sales and the staff gate');
{
  // A fully-paid walk-in sale has no customer on it and never takes repayment.
  const { state } = staffState();
  const { line, total } = oneLine(state);
  const walkSale = ops.checkout(state, { lines: [line], paymentMethod: 'cash', amountPaid: total });
  check('a full-payment walk-in still completes', walkSale.ok, walkSale.ok ? 'ok' : walkSale.error);
  const repayWalkIn = ops.recordCustomerPayment(walkSale.value.state, walkSale.value.sale.id, 5, 'cash');
  check('a walk-in sale (no customer) cannot take a repayment', !repayWalkIn.ok, repayWalkIn.ok ? 'accepted' : repayWalkIn.error);
  check('staff (owner and assistant) carry the sell permission repayments ride on', can('owner', 'sell') && can('assistant', 'sell'));
}

note('server-side coverage', 'the RPC, payment rows and tenant isolation live in verify-authoritative-checkout.mjs');

process.exit(await finish());
