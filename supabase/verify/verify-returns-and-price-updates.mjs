/**
 * Customer returns and authoritative selling-price updates.
 *
 * The properties this suite exists to prove:
 *
 *   RETURNS
 *   - A return is a separate linked transaction; the original sale and its lines
 *     never change.
 *   - Stock is restored to the exact lots the sale consumed, from the movement
 *     ledger, never by re-running FEFO.
 *   - A partial return never marks the whole sale returned or changes its state.
 *   - Over-return, duplicate sale lines, voided sales, cross-branch sales and a
 *     void after a return are refused.
 *   - Attendants can request; only owners can approve/reject. A pending return
 *     moves no stock and no money.
 *   - Damaged, expired, recalled and unprovenanced stock is quarantined and is
 *     not added back to sellable batches.
 *   - A credit return reduces the customer/credit-account balance and the net
 *     sale outstanding without rewriting the original sale total or payments.
 *   - Repeating an idempotency key returns the same return and does not restore
 *     stock twice.
 *
 *   PRICES
 *   - Only an owner can change a price, only in their branch, only for a real
 *     unit, only with the expected current price, and never at or below cost.
 *   - The update changes units[].sellingPrice (and the base mirror when the unit
 *     is the base unit) and nothing else: no cost, batch, expiry or stock.
 *   - A stale expected price is refused rather than overwriting a newer price.
 *   - Completed sale lines retain their historical price; the new price applies
 *     to future sales.
 *   - Price changes are append-only and audited.
 *
 * PGlite is single-connection. This suite cannot prove row-lock concurrency under
 * real parallel sessions; the stale-price and quantity-cap checks prove the
 * server's guards, not lock scheduling. Real Postgres/staging remains unverified.
 */

import {
  asActor,
  asAnon,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-returns-and-price-updates');
const database = await freshDatabase();
const ids = await seedTenants(database);

const asUser = (actorId, fn) =>
  asAuthenticated(database, () => asActor(database, actorId, fn));

async function server(sql, params) {
  return query(database, sql, params);
}

async function callSale(actor, lines, opts = {}) {
  const call = await asUser(actor, () =>
    database.query(
      `select * from public.pf_complete_sale(
         p_lines => $1::jsonb,
         p_payment_method => $2::public.payment_kind,
         p_amount_paid => $3,
         p_discount => $4,
         p_customer_id => $5,
         p_credit_account_id => $6,
         p_idempotency_key => $7
       )`,
      [
        JSON.stringify(lines),
        opts.paymentMethod ?? 'cash',
        opts.amountPaid ?? 0,
        opts.discount ?? 0,
        opts.customerId ?? null,
        opts.creditAccountId ?? null,
        opts.idempotencyKey ?? null,
      ],
    ),
  );
  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, ...call.value.rows[0] };
}

async function callReturn(actor, saleId, items, opts = {}) {
  const call = await asUser(actor, () =>
    database.query(
      `select * from public.pf_create_return(
         p_sale_id => $1,
         p_items => $2::jsonb,
         p_reason => $3,
         p_note => $4,
         p_refund_method => $5,
         p_idempotency_key => $6
       )`,
      [
        saleId,
        JSON.stringify(items),
        opts.reason ?? 'customer_changed_mind',
        opts.note ?? null,
        opts.refundMethod ?? null,
        opts.idempotencyKey ?? null,
      ],
    ),
  );
  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, ...call.value.rows[0] };
}

async function callReturnable(actor, saleId) {
  const call = await asUser(actor, () =>
    database.query(`select * from public.pf_sale_returnable($1)`, [saleId]),
  );
  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, rows: call.value.rows };
}

async function callReview(actor, returnId, approve, opts = {}) {
  const call = await asUser(actor, () =>
    database.query(
      `select * from public.pf_review_return(
         p_return_id => $1, p_approve => $2, p_note => $3, p_refund_method => $4
       )`,
      [returnId, approve, opts.note ?? null, opts.refundMethod ?? null],
    ),
  );
  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, ...call.value.rows[0] };
}

async function callPrice(actor, medicineId, unitKey, newPrice, expected, reason = 'test') {
  const call = await asUser(actor, () =>
    database.query(
      `select * from public.pf_update_medicine_price(
         p_medicine_id => $1, p_unit_key => $2, p_new_price => $3,
         p_expected_price => $4, p_reason => $5
       )`,
      [medicineId, unitKey, newPrice, expected, reason],
    ),
  );
  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, ...call.value.rows[0] };
}

async function callVoid(actor, saleId, reason = 'test void') {
  const call = await asUser(actor, () =>
    database.query(`select * from public.pf_void_sale($1::uuid, $2)`, [saleId, reason]),
  );
  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, ...call.value.rows[0] };
}

async function sellable(medicineId) {
  const rows = await server(
    `select id, batch_number, quantity, expiry_date, is_recalled
       from medicine_batches
      where medicine_id = $1
      order by batch_number`,
    [medicineId],
  );
  return rows;
}

async function batchQty(batchId) {
  const [row] = await server(`select quantity from medicine_batches where id = $1`, [batchId]);
  return Number(row?.quantity ?? -1);
}

async function totalQty(medicineId) {
  const [row] = await server(
    `select coalesce(sum(quantity), 0)::int as quantity
       from medicine_batches where medicine_id = $1`,
    [medicineId],
  );
  return Number(row?.quantity ?? -1);
}

async function medicineState(medicineId) {
  const [row] = await server(
    `select total_quantity, units, price_per_base_unit, cost_per_base_unit, expiry_date, updated_at
       from medicines where id = $1`,
    [medicineId],
  );
  return row;
}

/** A product with a tablet (base) and a box (10 tablets), and two lots. */
async function seedPricedMedicine(branchId, suffix) {
  const units = JSON.stringify([
    { key: 'tablet', name: 'Tablet', multiplier: 1, sellingPrice: 100 },
    { key: 'box', name: 'Box', multiplier: 10, sellingPrice: 900 },
  ]);
  const [medicine] = await server(
    `insert into medicines (
       branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date
     ) values ($1, $2, 'testgen', $3::jsonb, 50, 100, current_date + 365)
     returning id`,
    [branchId, `Return Drug ${suffix}`, units],
  );
  const [a] = await server(
    `insert into medicine_batches (
       branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit
     ) values ($1, $2, $3, current_date + 30, 10, 50)
     returning id`,
    [branchId, medicine.id, `LOT-A-${suffix}`],
  );
  const [b] = await server(
    `insert into medicine_batches (
       branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit
     ) values ($1, $2, $3, current_date + 90, 10, 50)
     returning id`,
    [branchId, medicine.id, `LOT-B-${suffix}`],
  );
  return { medicineId: medicine.id, batchA: a.id, batchB: b.id };
}

async function seedCustomer(branchId, suffix) {
  const [customer] = await server(
    `insert into customers (branch_id, code, name, phone)
     values ($1, $2, $3, $4)
     returning id`,
    [branchId, `C-${suffix}`, `Customer ${suffix}`, `08000000${suffix}`],
  );
  const [account] = await server(
    `insert into credit_accounts (branch_id, name, credit_limit)
     values ($1, $2, 100000)
     returning id`,
    [branchId, `Account ${suffix}`],
  );
  return { customerId: customer.id, accountId: account.id };
}

const drug = await seedPricedMedicine(ids.BRANCH_A, 'A');
const drugB = await seedPricedMedicine(ids.BRANCH_B, 'B');
const pricingDrug = await seedPricedMedicine(ids.BRANCH_A, 'P');
const customer = await seedCustomer(ids.BRANCH_A, 'A');

/* ================================================================ RETURNS */

section('RETURN 1 — a sale consumes the two original lots in FEFO order');

const sale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 12 },
], { amountPaid: 1200 });
check('the sale completed', sale.ok, sale.ok ? sale.receipt_number : sale.err);
check('lot A was consumed first', (await batchQty(drug.batchA)) === 0, '');
check('lot B supplied the remainder', (await batchQty(drug.batchB)) === 8, '');

const originalLine = (await server(
  `select id, quantity, unit_price, line_total, base_units_total
     from sale_items where sale_id = $1`,
  [sale.sale_id],
))[0];
const originalSale = (await server(
  `select total, subtotal, amount_paid, outstanding, state, returned_credit
     from sales where id = $1`,
  [sale.sale_id],
))[0];

const returnableBefore = await callReturnable(ids.OWNER_A, sale.sale_id);
const beforeRow = returnableBefore.ok
  ? returnableBefore.rows.find((row) => row.sale_item_id === originalLine.id)
  : null;
check('pf_sale_returnable lists the sold line before any return',
  returnableBefore.ok && beforeRow !== undefined,
  returnableBefore.ok ? `${returnableBefore.rows.length} row(s)` : returnableBefore.err);
check('the returnable line starts with the full sold quantity',
  beforeRow && Number(beforeRow.quantity_remaining) === 12 && Number(beforeRow.quantity_returned) === 0,
  beforeRow ? `${beforeRow.quantity_remaining} remaining` : 'missing');
check('the returnable value uses the historical unit price',
  beforeRow && Number(beforeRow.return_value_per_unit) === 100,
  beforeRow ? String(beforeRow.return_value_per_unit) : 'missing');

section('RETURN 2 — a partial return restores only the original lot and keeps the sale intact');

const partial = await callReturn(
  ids.OWNER_A,
  sale.sale_id,
  [{ sale_item_id: originalLine.id, quantity: 4 }],
  { reason: 'customer_changed_mind', note: 'unopened', refundMethod: 'cash' },
);
check('the owner return completed immediately', partial.ok && partial.status === 'completed',
  partial.ok ? `${partial.return_number} ${partial.status}` : partial.err);
check('the return value is 4 × the historical unit price', partial.ok && Number(partial.refund_value) === 400,
  partial.ok ? String(partial.refund_value) : '');
check('the paid sale records no credit', partial.ok && Number(partial.credit_applied) === 0, '');
check('the refund is recorded as due/paid', partial.ok && Number(partial.refund_amount) === 400, '');
check('4 units went back to lot A', (await batchQty(drug.batchA)) === 4, '');
check('lot B was not touched by the partial return', (await batchQty(drug.batchB)) === 8, '');

const saleAfter = (await server(
  `select total, subtotal, amount_paid, outstanding, state, returned_credit
     from sales where id = $1`,
  [sale.sale_id],
))[0];
const lineAfter = (await server(
  `select quantity, unit_price, line_total from sale_items where id = $1`, [originalLine.id],
))[0];
check('the original sale total is unchanged', Number(saleAfter.total) === Number(originalSale.total),
  `${saleAfter.total}`);
check('the original sale state remains paid', saleAfter.state === 'paid', saleAfter.state);
check('the original sale payment is unchanged', Number(saleAfter.amount_paid) === 1200, '');
check('the original sale line is unchanged', Number(lineAfter.quantity) === 12 && Number(lineAfter.unit_price) === 100,
  `${lineAfter.quantity} × ${lineAfter.unit_price}`);
check('a partial return did not mark the whole sale returned',
  saleAfter.state === 'paid' && Number(saleAfter.returned_credit) === 0,
  '');

const movement = (await server(
  `select kind::text, quantity_changed, reference_id, batch_id
     from stock_movements
    where reference_id = $1 and kind = 'return'`,
  [partial.return_id],
))[0];
check('the return wrote a return movement linked to the return, not the sale',
  movement && movement.kind === 'return' && movement.reference_id === partial.return_id,
  movement ? `${movement.kind} ${movement.quantity_changed}` : 'missing');
check('the return movement names the original lot', movement?.batch_id === drug.batchA, '');

const returnableAfterPartial = await callReturnable(ids.OWNER_A, sale.sale_id);
const afterPartialRow = returnableAfterPartial.ok
  ? returnableAfterPartial.rows.find((row) => row.sale_item_id === originalLine.id)
  : null;
check('pf_sale_returnable subtracts accepted quantities',
  afterPartialRow && Number(afterPartialRow.quantity_returned) === 4 &&
    Number(afterPartialRow.quantity_remaining) === 8,
  afterPartialRow
    ? `${afterPartialRow.quantity_returned} returned, ${afterPartialRow.quantity_remaining} remaining`
    : 'missing');

section('RETURN 3 — another partial return uses the next remaining original lot units');

const second = await callReturn(
  ids.OWNER_A,
  sale.sale_id,
  [{ sale_item_id: originalLine.id, quantity: 2 }],
  { refundMethod: 'cash' },
);
check('the second partial return completed', second.ok && second.status === 'completed', second.err ?? '');
check('two more units went back to lot A', (await batchQty(drug.batchA)) === 6, '');

const returnableAfterSecond = await callReturnable(ids.OWNER_A, sale.sale_id);
const afterSecondRow = returnableAfterSecond.ok
  ? returnableAfterSecond.rows.find((row) => row.sale_item_id === originalLine.id)
  : null;
check('pf_sale_returnable tracks successive partial returns',
  afterSecondRow && Number(afterSecondRow.quantity_returned) === 6 &&
    Number(afterSecondRow.quantity_remaining) === 6,
  afterSecondRow
    ? `${afterSecondRow.quantity_returned} returned, ${afterSecondRow.quantity_remaining} remaining`
    : 'missing');

section('RETURN 4 — over-return is refused and leaves stock unchanged');

const over = await callReturn(
  ids.OWNER_A,
  sale.sale_id,
  [{ sale_item_id: originalLine.id, quantity: 7 }],
);
check('returning more than the remaining six units is refused', !over.ok, over.ok ? 'accepted' : over.err);
check('the refused over-return moved no stock', (await batchQty(drug.batchA)) === 6, '');

section('RETURN 5 — the final return completes the quantity cap and cannot be voided');

const final = await callReturn(
  ids.OWNER_A,
  sale.sale_id,
  [{ sale_item_id: originalLine.id, quantity: 6 }],
  { refundMethod: 'transfer' },
);
check('the final return completed', final.ok && final.status === 'completed', final.err ?? '');
check('all ten units returned to lot A', (await batchQty(drug.batchA)) === 10, '');
check('lot B is fully restored', (await batchQty(drug.batchB)) === 10, '');
check('the sale still keeps its original state, not a rewritten refunded total',
  (await server(`select state from sales where id = $1`, [sale.sale_id]))[0].state === 'paid', '');

const voidAfterReturn = await callVoid(ids.OWNER_A, sale.sale_id);
check('a sale with accepted returns cannot be voided', !voidAfterReturn.ok,
  voidAfterReturn.ok ? 'voided' : voidAfterReturn.err);
check('the refused void did not restore stock again', (await batchQty(drug.batchA)) === 10, '');

section('RETURN 6 — an attendant can request, but cannot approve');

const assistantSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 5 },
], { amountPaid: 500 });
const assistantLine = (await server(
  `select id from sale_items where sale_id = $1`, [assistantSale.sale_id],
))[0];

const pending = await callReturn(
  ids.ASSISTANT_A,
  assistantSale.sale_id,
  [{ sale_item_id: assistantLine.id, quantity: 2 }],
  { reason: 'customer_changed_mind' },
);
check('an attendant creates a pending-review return', pending.ok && pending.status === 'pending_review',
  pending.ok ? pending.status : pending.err);
const voidWhilePending = await callVoid(ids.OWNER_A, assistantSale.sale_id);
check('a sale with a pending return cannot be voided', !voidWhilePending.ok,
  voidWhilePending.ok ? 'voided' : voidWhilePending.err);

const returnableWhilePending = await callReturnable(ids.OWNER_A, assistantSale.sale_id);
const pendingRow = returnableWhilePending.ok
  ? returnableWhilePending.rows.find((row) => row.sale_item_id === assistantLine.id)
  : null;
check('pf_sale_returnable reserves pending quantities',
  pendingRow && Number(pendingRow.quantity_pending) === 2 &&
    Number(pendingRow.quantity_remaining) === 3,
  pendingRow
    ? `${pendingRow.quantity_pending} pending, ${pendingRow.quantity_remaining} remaining`
    : 'missing');

const stockBeforeApproval = await batchQty(drug.batchA);
const approveByAssistant = await callReview(ids.ASSISTANT_A, pending.return_id, true);
check('an attendant cannot approve a return', !approveByAssistant.ok,
  approveByAssistant.ok ? 'approved' : approveByAssistant.err);
check('a pending return moves no stock', (await batchQty(drug.batchA)) === stockBeforeApproval, '');

const approved = await callReview(ids.OWNER_A, pending.return_id, true, {
  note: 'checked',
  refundMethod: 'cash',
});
check('an owner can approve a pending return', approved.ok && approved.status === 'completed',
  approved.ok ? approved.status : approved.err);
check('approval restores the accepted two units', (await batchQty(drug.batchA)) === stockBeforeApproval + 2, '');

const returnableAfterApproval = await callReturnable(ids.OWNER_A, assistantSale.sale_id);
const approvedRow = returnableAfterApproval.ok
  ? returnableAfterApproval.rows.find((row) => row.sale_item_id === assistantLine.id)
  : null;
check('approval moves pending quantities into returned quantities',
  approvedRow && Number(approvedRow.quantity_pending) === 0 &&
    Number(approvedRow.quantity_returned) === 2 &&
    Number(approvedRow.quantity_remaining) === 3,
  approvedRow
    ? `${approvedRow.quantity_returned} returned, ${approvedRow.quantity_pending} pending`
    : 'missing');

section('RETURN 7 — an owner can reject without moving stock or money');

const rejectSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 3 },
], { amountPaid: 300 });
const rejectLine = (await server(
  `select id from sale_items where sale_id = $1`, [rejectSale.sale_id],
))[0];
const rejectPending = await callReturn(
  ids.ASSISTANT_A,
  rejectSale.sale_id,
  [{ sale_item_id: rejectLine.id, quantity: 1 }],
);
const stockBeforeReject = await batchQty(drug.batchA);
const rejected = await callReview(ids.OWNER_A, rejectPending.return_id, false, {
  note: 'outside policy',
});
check('the owner rejected the pending return', rejected.ok && rejected.status === 'rejected',
  rejected.ok ? rejected.status : rejected.err);
check('a rejected return moves no stock', (await batchQty(drug.batchA)) === stockBeforeReject, '');
check('a rejected return applies no credit',
  Number((await server(`select returned_credit from sales where id = $1`, [rejectSale.sale_id]))[0].returned_credit) === 0,
  '');

const returnableAfterReject = await callReturnable(ids.OWNER_A, rejectSale.sale_id);
const rejectedRow = returnableAfterReject.ok
  ? returnableAfterReject.rows.find((row) => row.sale_item_id === rejectLine.id)
  : null;
check('a rejected return releases its reserved quantity',
  rejectedRow && Number(rejectedRow.quantity_pending) === 0 &&
    Number(rejectedRow.quantity_remaining) === 3,
  rejectedRow
    ? `${rejectedRow.quantity_pending} pending, ${rejectedRow.quantity_remaining} remaining`
    : 'missing');

section('RETURN 8 — damaged stock is quarantined, not restocked');

const damageSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 2 },
], { amountPaid: 200 });
const damageLine = (await server(
  `select id from sale_items where sale_id = $1`, [damageSale.sale_id],
))[0];
const stockBeforeDamage = await batchQty(drug.batchA);
const damaged = await callReturn(
  ids.OWNER_A,
  damageSale.sale_id,
  [{ sale_item_id: damageLine.id, quantity: 2 }],
  { reason: 'damaged' },
);
check('the damaged return was recorded', damaged.ok && damaged.status === 'completed', damaged.err ?? '');
check('damaged stock is not added back to the batch', (await batchQty(drug.batchA)) === stockBeforeDamage, '');
const damageAlloc = (await server(
  `select disposition, base_units, batch_id from medicine_return_allocations
    where return_item_id = (select id from medicine_return_items where return_id = $1)`,
  [damaged.return_id],
))[0];
check('the damaged units are held as quarantined',
  damageAlloc?.disposition === 'quarantined' && Number(damageAlloc.base_units) === 2,
  damageAlloc ? `${damageAlloc.disposition} ${damageAlloc.base_units}` : 'missing');

section('RETURN 9 — a recalled original lot is quarantined');

const recallSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 1 },
], { amountPaid: 100 });
const recallLine = (await server(
  `select id, batch_id from sale_items where sale_id = $1`, [recallSale.sale_id],
))[0];
await server(`update medicine_batches set is_recalled = true, recall_reason = 'test recall' where id = $1`,
  [recallLine.batch_id]);
const stockBeforeRecallReturn = await batchQty(recallLine.batch_id);
const recalled = await callReturn(
  ids.OWNER_A,
  recallSale.sale_id,
  [{ sale_item_id: recallLine.id, quantity: 1 }],
  { reason: 'recalled' },
);
check('the recalled-lot return was recorded', recalled.ok && recalled.status === 'completed', recalled.err ?? '');
check('recalled stock is not restocked', (await batchQty(recallLine.batch_id)) === stockBeforeRecallReturn, '');
const recallAlloc = (await server(
  `select disposition, note from medicine_return_allocations
    where return_item_id = (select id from medicine_return_items where return_id = $1)`,
  [recalled.return_id],
))[0];
check('the recalled return is quarantined with a reason',
  recallAlloc?.disposition === 'quarantined', recallAlloc?.note ?? 'missing');

section('RETURN 10 — ambiguous line provenance is quarantined, never guessed');

const ambiguousSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 1 },
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 1 },
], { amountPaid: 200 });
const ambiguousLines = await server(
  `select id from sale_items where sale_id = $1 order by id`, [ambiguousSale.sale_id],
);
const stockBeforeAmbiguous = await batchQty(drug.batchA);
const ambiguous = await callReturn(
  ids.OWNER_A,
  ambiguousSale.sale_id,
  [{ sale_item_id: ambiguousLines[0].id, quantity: 1 }],
);
check('the ambiguous return was accepted as a record', ambiguous.ok && ambiguous.status === 'completed',
  ambiguous.err ?? '');
check('ambiguous provenance does not restock a guessed lot',
  (await batchQty(drug.batchA)) === stockBeforeAmbiguous, '');
const ambiguousAlloc = (await server(
  `select disposition, batch_id, note from medicine_return_allocations
    where return_item_id = (select id from medicine_return_items where return_id = $1)`,
  [ambiguous.return_id],
))[0];
check('the ambiguous unit is quarantined without a batch',
  ambiguousAlloc?.disposition === 'quarantined' && ambiguousAlloc.batch_id === null,
  ambiguousAlloc?.note ?? 'missing');

section('RETURN 11 — a credit return reduces debt and net outstanding without rewriting payments');

const creditSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 5 },
], {
  amountPaid: 0,
  customerId: customer.customerId,
  creditAccountId: customer.accountId,
});
check('the credit sale completed', creditSale.ok, creditSale.err ?? '');
const creditLine = (await server(
  `select id from sale_items where sale_id = $1`, [creditSale.sale_id],
))[0];
const debtBefore = Number((await server(
  `select outstanding_debt from customers where id = $1`, [customer.customerId],
))[0].outstanding_debt);
const accountBefore = Number((await server(
  `select outstanding_balance from credit_accounts where id = $1`, [customer.accountId],
))[0].outstanding_balance);

const creditReturn = await callReturn(
  ids.OWNER_A,
  creditSale.sale_id,
  [{ sale_item_id: creditLine.id, quantity: 2 }],
);
check('the credit return completed', creditReturn.ok && creditReturn.status === 'completed', creditReturn.err ?? '');
check('the return applied 200 as a credit', Number(creditReturn.credit_applied) === 200,
  String(creditReturn.credit_applied));
check('the return has no separate cash refund', Number(creditReturn.refund_amount) === 0,
  String(creditReturn.refund_amount));
check('the customer debt fell by the credit', Number((await server(
  `select outstanding_debt from customers where id = $1`, [customer.customerId],
))[0].outstanding_debt) === debtBefore - 200, '');
check('the credit-account balance fell by the credit', Number((await server(
  `select outstanding_balance from credit_accounts where id = $1`, [customer.accountId],
))[0].outstanding_balance) === accountBefore - 200, '');
check('the sale total and payment history are unchanged', Number((await server(
  `select total, amount_paid, returned_credit from sales where id = $1`, [creditSale.sale_id],
))[0].total) === 500, '');
check('the sale records the return credit separately', Number((await server(
  `select returned_credit from sales where id = $1`, [creditSale.sale_id],
))[0].returned_credit) === 200, '');

const repayTooMuch = await asUser(ids.ASSISTANT_A, () =>
  database.query(`select * from public.pf_record_customer_payment($1, 301, 'cash', null)`,
    [creditSale.sale_id]),
);
check('repayment above the net outstanding is refused', !repayTooMuch.ok,
  repayTooMuch.ok ? 'accepted' : repayTooMuch.err);
const repay = await asUser(ids.ASSISTANT_A, () =>
  database.query(`select * from public.pf_record_customer_payment($1, 300, 'cash', null)`,
    [creditSale.sale_id]),
);
check('repayment of the net outstanding succeeds', repay.ok,
  repay.ok ? String(repay.value.rows[0].outstanding) : repay.err);
check('the repayment returns net zero outstanding, not the original 300',
  repay.ok && Number(repay.value.rows[0].outstanding) === 0,
  repay.ok ? String(repay.value.rows[0].outstanding) : '');

section('RETURN 12 — idempotency prevents a duplicate restoration');

const idemSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 4 },
], { amountPaid: 400 });
const idemLine = (await server(
  `select id from sale_items where sale_id = $1`, [idemSale.sale_id],
))[0];
const stockBeforeIdem = await totalQty(drug.medicineId);
const idemOne = await callReturn(
  ids.OWNER_A,
  idemSale.sale_id,
  [{ sale_item_id: idemLine.id, quantity: 1 }],
  { idempotencyKey: 'return-key-1', refundMethod: 'cash' },
);
const stockAfterOne = await totalQty(drug.medicineId);
const idemTwo = await callReturn(
  ids.OWNER_A,
  idemSale.sale_id,
  [{ sale_item_id: idemLine.id, quantity: 1 }],
  { idempotencyKey: 'return-key-1', refundMethod: 'cash' },
);
check('the same idempotency key returns the same return',
  idemOne.ok && idemTwo.ok && idemOne.return_id === idemTwo.return_id && idemTwo.already_exists === true,
  idemTwo.ok ? String(idemTwo.already_exists) : idemTwo.err);
check('the duplicate request restored stock once',
  stockAfterOne === stockBeforeIdem + 1 && (await totalQty(drug.medicineId)) === stockAfterOne,
  `${stockBeforeIdem} → ${stockAfterOne} → ${await totalQty(drug.medicineId)}`);

section('RETURN 13 — voided sales and cross-branch sales are ineligible');

const voidSale = await callSale(ids.OWNER_A, [
  { medicine_id: drug.medicineId, unit_key: 'tablet', quantity: 1 },
], { amountPaid: 100 });
const voidLine = (await server(
  `select id from sale_items where sale_id = $1`, [voidSale.sale_id],
))[0];
const voided = await callVoid(ids.OWNER_A, voidSale.sale_id);
check('the test sale was voided', voided.ok, voided.err ?? '');
const returnVoided = await callReturn(
  ids.OWNER_A,
  voidSale.sale_id,
  [{ sale_item_id: voidLine.id, quantity: 1 }],
);
check('a voided sale cannot be returned', !returnVoided.ok,
  returnVoided.ok ? 'accepted' : returnVoided.err);
const crossBranch = await callReturn(
  ids.OWNER_B,
  assistantSale.sale_id,
  [{ sale_item_id: assistantLine.id, quantity: 1 }],
);
check('an owner from another branch cannot return this sale', !crossBranch.ok,
  crossBranch.ok ? 'accepted' : crossBranch.err);
const crossBranchView = await callReturnable(ids.OWNER_B, assistantSale.sale_id);
check('an owner from another branch cannot read its returnable lines', !crossBranchView.ok,
  crossBranchView.ok ? `${crossBranchView.rows.length} row(s)` : crossBranchView.err);

section('RETURN 14 — anonymous callers cannot reach the return RPCs');

const anonReturn = await asAnon(database, () =>
  database.query(`select * from public.pf_create_return($1, '[]'::jsonb, 'other', null, null, null)`,
    [assistantSale.sale_id]),
);
check('anon cannot call pf_create_return', !anonReturn.ok, anonReturn.ok ? 'reached' : anonReturn.err);
const anonReview = await asAnon(database, () =>
  database.query(`select * from public.pf_review_return($1, true, null, null)`, [pending.return_id]),
);
check('anon cannot call pf_review_return', !anonReview.ok, anonReview.ok ? 'reached' : anonReview.err);
const anonReturnable = await asAnon(database, () =>
  database.query(`select * from public.pf_sale_returnable($1)`, [assistantSale.sale_id]),
);
check('anon cannot call pf_sale_returnable', !anonReturnable.ok,
  anonReturnable.ok ? 'reached' : anonReturnable.err);

section('RETURN 15 — branch RLS hides returns and quarantine allocations');

const rowsB = await asUser(ids.OWNER_B, () =>
  database.query(`select id from public.medicine_returns`),
);
check('another branch sees no return headers', rowsB.ok && rowsB.value.rows.length === 0,
  rowsB.ok ? String(rowsB.value.rows.length) : rowsB.err);
const rowsA = await asUser(ids.OWNER_A, () =>
  database.query(`select id from public.medicine_returns`),
);
check('the owning branch can read its returns', rowsA.ok && rowsA.value.rows.length > 0,
  rowsA.ok ? String(rowsA.value.rows.length) : rowsA.err);

section('RETURN 16 - a discount is not refunded as if it never existed');

const discountDrug = await seedPricedMedicine(ids.BRANCH_A, 'DISC');
const discountedSale = await callSale(ids.OWNER_A, [
  { medicine_id: discountDrug.medicineId, unit_key: 'tablet', quantity: 2 },
], { amountPaid: 180, discount: 20 });
check('the discounted sale completed', discountedSale.ok,
  discountedSale.ok ? discountedSale.receipt_number : discountedSale.err);
const discountedLine = (await server(
  `select id, quantity, unit_price, line_total from sale_items where sale_id = $1`,
  [discountedSale.sale_id],
))[0];
const discountedHeader = (await server(
  `select subtotal, discount, total, amount_paid, state from sales where id = $1`,
  [discountedSale.sale_id],
))[0];
check('the sale keeps its list subtotal and net discount',
  Number(discountedHeader.subtotal) === 200 && Number(discountedHeader.discount) === 20 &&
    Number(discountedHeader.total) === 180 && Number(discountedHeader.amount_paid) === 180,
  `${discountedHeader.subtotal} - ${discountedHeader.discount} = ${discountedHeader.total}`);
const discountedView = await callReturnable(ids.OWNER_A, discountedSale.sale_id);
const discountedRow = discountedView.ok
  ? discountedView.rows.find((row) => row.sale_item_id === discountedLine.id)
  : null;
check('the returnable unit value is proportional to the discounted total',
  discountedRow && Number(discountedRow.return_value_per_unit) === 90,
  discountedRow ? String(discountedRow.return_value_per_unit) : 'missing');
const discountedReturn = await callReturn(
  ids.OWNER_A,
  discountedSale.sale_id,
  [{ sale_item_id: discountedLine.id, quantity: 1 }],
  { refundMethod: 'cash' },
);
check('one returned unit refunds half the net line, not the list price',
  discountedReturn.ok && Number(discountedReturn.refund_value) === 90,
  discountedReturn.ok ? String(discountedReturn.refund_value) : discountedReturn.err);
const discountedLineAfter = (await server(
  `select quantity, unit_price, line_total from sale_items where id = $1`,
  [discountedLine.id],
))[0];
check('the discounted sale line is not rewritten by the return',
  Number(discountedLineAfter.quantity) === 2 && Number(discountedLineAfter.unit_price) === 100 &&
    Number(discountedLineAfter.line_total) === 200,
  `${discountedLineAfter.quantity} x ${discountedLineAfter.unit_price}`);

/* ================================================================= PRICES */

section('PRICE 1 — a sale recorded before the update keeps its historical price');

const historicSale = await callSale(ids.OWNER_A, [
  { medicine_id: pricingDrug.medicineId, unit_key: 'tablet', quantity: 1 },
], { amountPaid: 100 });
check('the historical sale completed at the old price', historicSale.ok, historicSale.err ?? '');

const beforePrice = await medicineState(pricingDrug.medicineId);
const beforeBatches = await sellable(pricingDrug.medicineId);
const priceUpdate = await callPrice(
  ids.OWNER_A, pricingDrug.medicineId, 'tablet', 120, 100, 'input cost changed',
);
check('the owner can update the tablet price', priceUpdate.ok, priceUpdate.ok ? String(priceUpdate.new_price) : priceUpdate.err);
check('the RPC reports the old and new price', priceUpdate.ok && Number(priceUpdate.old_price) === 100 && Number(priceUpdate.new_price) === 120,
  priceUpdate.ok ? `${priceUpdate.old_price} → ${priceUpdate.new_price}` : '');
const afterPrice = await medicineState(pricingDrug.medicineId);
const afterBatches = await sellable(pricingDrug.medicineId);
const tabletAfter = afterPrice.units.find((u) => u.key === 'tablet');
const boxAfter = afterPrice.units.find((u) => u.key === 'box');
check('units[].sellingPrice is the updated price', Number(tabletAfter.sellingPrice) === 120,
  String(tabletAfter.sellingPrice));
check('the base-unit mirror moved with the base unit', Number(afterPrice.price_per_base_unit) === 120,
  String(afterPrice.price_per_base_unit));
check('the other packaging unit was not repriced', Number(boxAfter.sellingPrice) === 900,
  String(boxAfter.sellingPrice));
check('purchase cost was not changed', Number(afterPrice.cost_per_base_unit) === Number(beforePrice.cost_per_base_unit),
  String(afterPrice.cost_per_base_unit));
check('batch quantities were not changed by a price edit',
  JSON.stringify(afterBatches) === JSON.stringify(beforeBatches), '');

const historicLine = (await server(
  `select unit_price, line_total from sale_items where sale_id = $1`, [historicSale.sale_id],
))[0];
check('the completed sale line still says 100', Number(historicLine.unit_price) === 100,
  String(historicLine.unit_price));

const newSale = await callSale(ids.OWNER_A, [
  { medicine_id: pricingDrug.medicineId, unit_key: 'tablet', quantity: 1 },
], { amountPaid: 120 });
const newLine = (await server(
  `select unit_price, line_total from sale_items where sale_id = $1`, [newSale.sale_id],
))[0];
check('a future sale uses the new price', Number(newLine.unit_price) === 120,
  String(newLine.unit_price));

section('PRICE 2 — the box is priced independently of the base unit');

const beforeBox = await medicineState(pricingDrug.medicineId);
const beforeBoxBatches = await sellable(pricingDrug.medicineId);
const boxPrice = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'box', 1000, 900, 'box margin');
check('the owner can update the box price', boxPrice.ok, boxPrice.err ?? '');
const afterBox = await medicineState(pricingDrug.medicineId);
const afterBoxBatches = await sellable(pricingDrug.medicineId);
check('the box has its own price', Number(afterBox.units.find((u) => u.key === 'box').sellingPrice) === 1000, '');
check('repricing the box did not move the base price', Number(afterBox.price_per_base_unit) === 120,
  String(afterBox.price_per_base_unit));

section('PRICE 3 — stale and invalid updates are refused and change nothing');

const stale = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'tablet', 130, 100, 'stale form');
check('a stale expected price is refused', !stale.ok, stale.ok ? 'accepted' : stale.err);
check('the stale refusal leaves the newer price in place',
  Number((await medicineState(pricingDrug.medicineId)).units.find((u) => u.key === 'tablet').sellingPrice) === 120, '');

for (const [label, value] of [
  ['zero', 0],
  ['negative', -1],
  ['fractional kobo', 120.001],
]) {
  const bad = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'tablet', value, 120, 'invalid');
  check(`a ${label} price is refused`, !bad.ok, bad.ok ? 'accepted' : bad.err);
}
const nan = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'tablet', 'NaN', 120, 'invalid');
check('a NaN price is refused', !nan.ok, nan.ok ? 'accepted' : nan.err);

const belowCost = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'tablet', 40, 120, 'below cost');
check('a price at or below cost is refused', !belowCost.ok, belowCost.ok ? 'accepted' : belowCost.err);
const boxBelowCost = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'box', 400, 1000, 'below cost');
check('a box price below its unit cost is refused', !boxBelowCost.ok,
  boxBelowCost.ok ? 'accepted' : boxBelowCost.err);
const unchanged = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'tablet', 120, 120, 'same');
check('an unchanged price is refused', !unchanged.ok, unchanged.ok ? 'accepted' : unchanged.err);
const unknownUnit = await callPrice(ids.OWNER_A, pricingDrug.medicineId, 'crate', 5000, 0, 'unknown');
check('an unknown unit is refused', !unknownUnit.ok, unknownUnit.ok ? 'accepted' : unknownUnit.err);
check('all invalid attempts left the price at 120',
  Number((await medicineState(pricingDrug.medicineId)).units.find((u) => u.key === 'tablet').sellingPrice) === 120, '');

section('PRICE 4 — role and branch authority');

const assistantPrice = await callPrice(ids.ASSISTANT_A, pricingDrug.medicineId, 'tablet', 140, 120, 'nope');
check('an assistant cannot change a price', !assistantPrice.ok,
  assistantPrice.ok ? 'accepted' : assistantPrice.err);
const crossPrice = await callPrice(ids.OWNER_B, pricingDrug.medicineId, 'tablet', 140, 120, 'nope');
check('an owner from another branch cannot change this price', !crossPrice.ok,
  crossPrice.ok ? 'accepted' : crossPrice.err);
const anonPrice = await asAnon(database, () =>
  database.query(`select * from public.pf_update_medicine_price($1, 'tablet', 140, 120, 'nope')`,
    [pricingDrug.medicineId]),
);
check('anon cannot call the price RPC', !anonPrice.ok, anonPrice.ok ? 'reached' : anonPrice.err);

section('PRICE 5 — the price-change ledger is append-only and complete');

const changes = await server(
  `select unit_key, unit_name, unit_multiplier, old_price, new_price, reason, changed_by
     from medicine_price_changes where medicine_id = $1 order by changed_at`,
  [pricingDrug.medicineId],
);
check('both successful changes were recorded', changes.length === 2, String(changes.length));
check('the tablet change names the unit and actor',
  changes[0]?.unit_key === 'tablet' && changes[0].changed_by === ids.OWNER_A, changes[0]?.unit_key ?? '');
check('the change reason and old/new values are retained',
  changes[0]?.reason === 'input cost changed' && Number(changes[0].old_price) === 100 && Number(changes[0].new_price) === 120,
  changes[0] ? `${changes[0].old_price} → ${changes[0].new_price}` : '');
const audit = await server(
  `select action, description, metadata from audit_events
    where action = 'price_change' and branch_id = $1
    order by created_at`,
  [ids.BRANCH_A],
);
check('the price change is in the audit log', audit.length >= 2, String(audit.length));
check('the audit metadata names the old and new price',
  audit.some((row) => Number(row.metadata?.old) === 100 && Number(row.metadata?.next) === 120), '');

const tamper = await asUser(ids.OWNER_A, () =>
  database.query(`update public.medicine_price_changes set new_price = 1 where medicine_id = $1`,
    [pricingDrug.medicineId]),
);
check('the append-only price ledger cannot be rewritten', !tamper.ok,
  tamper.ok ? 'updated' : tamper.err);
const tamperDelete = await asUser(ids.OWNER_A, () =>
  database.query(`delete from public.medicine_price_changes where medicine_id = $1`,
    [pricingDrug.medicineId]),
);
check('the append-only price ledger cannot be deleted', !tamperDelete.ok,
  tamperDelete.ok ? 'deleted' : tamperDelete.err);
const stillThere = await server(
  `select count(*)::int as n from medicine_price_changes where medicine_id = $1`,
  [pricingDrug.medicineId],
);
check('the ledger rows remain after refused tampering', stillThere[0].n === 2, String(stillThere[0].n));

const priceRowsB = await asUser(ids.OWNER_B, () =>
  database.query(`select id from public.medicine_price_changes`),
);
check('another branch cannot read this branch\'s price history',
  priceRowsB.ok && priceRowsB.value.rows.length === 0,
  priceRowsB.ok ? String(priceRowsB.value.rows.length) : priceRowsB.err);

section('PRICE 6 — stock, expiry and cost remain untouched');

check('the product expiry date is unchanged',
  String(afterBox.expiry_date) === String(beforeBox.expiry_date),
  `${beforeBox.expiry_date} → ${afterBox.expiry_date}`);
check('the product cost is unchanged', Number(afterBox.cost_per_base_unit) === 50,
  String(afterBox.cost_per_base_unit));
check('the batch quantities and expiry are unchanged by the box repricing',
  JSON.stringify(afterBoxBatches) === JSON.stringify(beforeBoxBatches), '');
check('the first price edit also left the product expiry unchanged',
  String(afterPrice.expiry_date) === String(beforePrice.expiry_date), '');

note('PGlite is single-connection', 'row-lock scheduling and real Postgres/staging remain unverified');

process.exitCode = await finish(database);
