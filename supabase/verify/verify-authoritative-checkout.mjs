/**
 * Authoritative checkout — `pf_complete_sale`.
 *
 * The live POS used to ring up a sale by mutating `localStorage`. This suite
 * covers the database path that replaced it, and asserts the properties that
 * make it safe to point a till at:
 *
 *   POSITIVE   — a box, a strip and tablets all deduct the right integer number
 *                of base units; FEFO picks the earliest-expiring lot; a line that
 *                spans two lots is still satisfied; stock and movements move
 *                exactly once.
 *   NEGATIVE   — an unknown product, another pharmacy's product, an invented
 *                unit, a fractional quantity, a locked product, insufficient
 *                stock, an expired lot and a recalled lot are all refused, and a
 *                refusal leaves nothing behind.
 *   AUTHORITY  — `anon` cannot reach it; an attendant can sell; a cost-bearing
 *                value is never returned to the caller.
 *
 * ## What this suite does NOT prove
 *
 * PGlite is a single-connection embedded database. Two genuinely overlapping
 * transactions cannot be interleaved here, so the row locks in `pf_complete_sale`
 * are NOT exercised by this file. What it does prove is the observable
 * consequence that matters: once one sale has taken the stock, a second sale
 * competing for the same quantity is refused rather than allowed to oversell.
 * Real lock-contention testing needs two live connections against real Postgres.
 */

import {
  asActor,
  asAuthenticated,
  asAnon,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-authoritative-checkout');

const database = await freshDatabase();
const ids = await seedTenants(database);

/* ------------------------------------------------------------------ fixtures */

/**
 * Tablet / Strip / Box, priced independently of the multiplier, as the app allows.
 *
 * Base cost 2 against a base price of 5, so `medicines_price_above_cost` holds,
 * and every unit sells above the cost of that unit (2 / 20 / 200 < 5 / 45 / 400).
 */
const MULTI_UNITS = JSON.stringify([
  { key: 'tablet', name: 'Tablet', multiplier: 1, sellingPrice: 5 },
  { key: 'strip', name: 'Strip', multiplier: 10, sellingPrice: 45 },
  { key: 'box', name: 'Box', multiplier: 100, sellingPrice: 400 },
]);

const BASE_COST = 2;
const BASE_PRICE = 5;

async function seedMultiUnitMedicine(branchId, name = 'Multi Drug') {
  const [medicine] = await query(
    database,
    `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
     values ($1, $2, 'multigen', $3::jsonb, $4, $5, current_date + 365)
     returning id`,
    [branchId, name, MULTI_UNITS, BASE_COST, BASE_PRICE],
  );
  return medicine.id;
}

/** Branch A's product: two lots, the earlier-expiring one deliberately short. */
const medA = await seedMultiUnitMedicine(ids.BRANCH_A, 'Drug A');
const [earlyRow] = await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
   values ($1, $2, 'A-EARLY', current_date + 100, 150, 20) returning id`,
  [ids.BRANCH_A, medA],
);
const batchEarly = earlyRow.id;

const [lateRow] = await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
   values ($1, $2, 'A-LATE', current_date + 400, 500, 20) returning id`,
  [ids.BRANCH_A, medA],
);
const batchLate = lateRow.id;

/** A product whose only lot is already past date. */
const medExpired = await seedMultiUnitMedicine(ids.BRANCH_A, 'Drug Expired');
await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
   values ($1, $2, 'X-PAST', current_date - 5, 900, 20)`,
  [ids.BRANCH_A, medExpired],
);

/** A product whose only lot has been recalled. */
const medRecalled = await seedMultiUnitMedicine(ids.BRANCH_A, 'Drug Recalled');
await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit, is_recalled, recall_reason)
   values ($1, $2, 'R-LOT', current_date + 200, 900, 20, true, 'manufacturer recall')`,
  [ids.BRANCH_A, medRecalled],
);

/** A safety-locked product with perfectly good stock. */
const medLocked = await seedMultiUnitMedicine(ids.BRANCH_A, 'Drug Locked');
await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
   values ($1, $2, 'L-LOT', current_date + 200, 900, 20)`,
  [ids.BRANCH_A, medLocked],
);
await query(database, `update medicines set do_not_sell = true where id = $1`, [medLocked]);

/** Branch B's product — must be unreachable from branch A. */
const medB = await seedMultiUnitMedicine(ids.BRANCH_B, 'Drug B');
await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
   values ($1, $2, 'B-LOT', current_date + 200, 900, 20)`,
  [ids.BRANCH_B, medB],
);

/** A walk-in customer, for the part-payment path. */
const [customerRow] = await query(
  database,
  `insert into customers (branch_id, code, name, phone)
   values ($1, 'C-1', 'Test Customer', '08000000001') returning id`,
  [ids.BRANCH_A],
);
const CUSTOMER = customerRow.id;

/** A credit account, for the charge-against-account path. */
const [creditRow] = await query(
  database,
  `insert into credit_accounts (branch_id, name, kind, contact_person, phone, credit_limit)
   values ($1, 'Test Clinic', 'clinic', 'Contact', '08000000002', 100000) returning id`,
  [ids.BRANCH_A],
);
const CREDIT = creditRow.id;

/* -------------------------------------------------------------------- helpers */

/** A line, with the quantity injected as a raw JSON value so bad shapes are testable. */
const line = (medicineId, unitKey, quantity) =>
  `[{"medicine_id": ${JSON.stringify(medicineId)}, ` +
  `"unit_key": ${JSON.stringify(unitKey)}, "quantity": ${quantity}}]`;

const multiLine = (rows) => JSON.stringify(rows);

/** Calls the RPC as a signed-in staff member and normalises the outcome. */
async function sell(actorId, lines, opts = {}) {
  const params = [
    lines,
    opts.paymentMethod ?? 'cash',
    opts.amountPaid ?? 0,
    opts.discount ?? 0,
    opts.discountReason ?? null,
    opts.customerId ?? null,
    opts.creditAccountId ?? null,
    opts.prescription ?? false,
    opts.idempotencyKey ?? null,
    opts.soldAt ?? null,
    // Named array of {method, amount} parts for a split sale; null otherwise.
    opts.breakdown ?? null,
  ];

  // `asAuthenticated` and `asActor` each wrap what they return, so the row comes
  // back one level deep. Unwrapped here so the assertions read like the API.
  const call = await asAuthenticated(database, () =>
    asActor(database, actorId, async () => {
      const { rows } = await database.query(
        `select * from public.pf_complete_sale(
           p_lines => $1::jsonb,
           p_payment_method => $2::public.payment_kind,
           p_amount_paid => $3,
           p_discount => $4,
           p_discount_reason => $5,
           p_customer_id => $6,
           p_credit_account_id => $7,
           p_dispensed_against_prescription => $8,
           p_idempotency_key => $9,
           p_sold_at => $10,
           p_payment_breakdown => $11::jsonb
         )`,
        params,
      );
      return rows[0];
    }),
  );

  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, ...call.value };
}

/** Calls the customer-debt repayment RPC as a signed-in staff member. */
async function repay(actorId, saleId, amount, method = 'cash') {
  const call = await asAuthenticated(database, () =>
    asActor(database, actorId, async () => {
      const { rows } = await database.query(
        `select * from public.pf_record_customer_payment(
           p_sale_id => $1, p_amount => $2, p_method => $3::public.payment_kind, p_note => null
         )`,
        [saleId, amount, method],
      );
      return rows[0];
    }),
  );
  if (!call.ok) return { ok: false, err: call.err };
  return { ok: true, ...call.value };
}

const paymentsOf = async (saleId) =>
  await query(
    database,
    `select method::text, amount from public.sale_payments where sale_id = $1 order by amount, method::text`,
    [saleId],
  );

const qtyOf = async (batchId) =>
  (await query(database, `select quantity from medicine_batches where id = $1`, [batchId]))[0].quantity;

const totalOf = async (medicineId) =>
  (await query(database, `select total_quantity from medicines where id = $1`, [medicineId]))[0]
    .total_quantity;

const saleCount = async () =>
  (await query(database, `select count(*)::int as n from sales`))[0].n;

const movementCount = async (kind) =>
  (
    await query(
      database,
      `select count(*)::int as n from stock_movements where kind = $1::public.movement_kind`,
      [kind],
    )
  )[0].n;

const saleMovementsFor = async (saleId) =>
  await query(
    database,
    `select sm.* from stock_movements sm
      where sm.reference_id = $1 or sm.batch_id in (
        select batch_id from sale_items where sale_id = $1 and batch_id is not null
      )`,
    [saleId],
  );

/* ============================================================ positive paths */

section('POSITIVE: a strip and a tablet deduct the right number of base units');

{
  const before = await qtyOf(batchEarly);
  const r = await sell(ids.ASSISTANT_A, line(medA, 'strip', 2), { amountPaid: 90 });
  check('the sale was accepted', r.ok, r.ok ? r.receipt_number : r.err);
  check('a receipt number was issued', /^PF-\d{4}-\d{4}$/.test(r.ok ? r.receipt_number : ''), r.ok ? r.receipt_number : '');
  check(
    'two strips removed 20 base units from the lot',
    (await qtyOf(batchEarly)) === before - 20,
    `${before} -> ${await qtyOf(batchEarly)}`,
  );
  check('the medicine total followed the lot', (await totalOf(medA)) === (before - 20) + 500);
}

section('POSITIVE: the base unit itself is sellable');

{
  const before = await qtyOf(batchEarly);
  const r = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 7), { amountPaid: 35 });
  check('a 7-tablet sale was accepted', r.ok, r.ok ? r.receipt_number : r.err);
  check('seven tablets removed 7 base units', (await qtyOf(batchEarly)) === before - 7);
  check('the server priced it from the unit (7 x 5)', r.ok && Number(r.total) === 35, r.ok ? String(r.total) : '');
}

section('POSITIVE: a box line is FEFO-split across two lots, and batch_id stays null');

{
  const earlyBefore = await qtyOf(batchEarly);
  const lateBefore = await qtyOf(batchLate);
  // 3 boxes = 300 base units. The early lot only holds 43, so the line must span
  // both lots — which is the case the single-lot deduction trigger cannot express.
  const r = await sell(ids.ASSISTANT_A, line(medA, 'box', 3), { amountPaid: 1200 });

  check('the three-box sale was accepted', r.ok, r.ok ? r.receipt_number : r.err);
  check(
    'the earliest lot was drained first',
    (await qtyOf(batchEarly)) === 0,
    `early ${earlyBefore} -> ${await qtyOf(batchEarly)}`,
  );
  check(
    'the remainder came off the later lot',
    (await qtyOf(batchLate)) === lateBefore - (300 - earlyBefore),
    `late ${lateBefore} -> ${await qtyOf(batchLate)}`,
  );
  check('the server priced it from the box unit (3 x 400)', r.ok && Number(r.total) === 1200);

  const [item] = await query(
    database,
    `select batch_id, unit_multiplier, quantity, base_units_total from sale_items
      where sale_id = $1`,
    [r.ok ? r.sale_id : null],
  );
  check(
    'the split line stored the full 300 base units',
    item && item.base_units_total === 300 && item.quantity === 3 && item.unit_multiplier === 100,
    item ? `${item.quantity} x ${item.unit_multiplier} = ${item.base_units_total}` : 'no row',
  );
  check(
    'a split line records no single lot',
    item && item.batch_id === null,
    item ? String(item.batch_id) : '',
  );
}

section('POSITIVE: a line covered by one lot names it, and the trigger deducts');

{
  const lateBefore = await qtyOf(batchLate);
  const r = await sell(ids.ASSISTANT_A, line(medA, 'box', 1), { amountPaid: 400 });

  check('the one-box sale was accepted', r.ok, r.ok ? r.receipt_number : r.err);
  check('the later lot lost exactly 100 base units', (await qtyOf(batchLate)) === lateBefore - 100);

  const [item] = await query(
    database,
    `select batch_id from sale_items where sale_id = $1`,
    [r.ok ? r.sale_id : null],
  );
  check(
    'the line names the lot it came from',
    item && item.batch_id === batchLate,
    item ? String(item.batch_id) : '',
  );
}

section('POSITIVE: stock movements are written exactly once, labelled sale');

{
  const sales = await movementCount('sale');
  check('every sale so far produced movement rows', sales > 0, `${sales} sale movement(s)`);

  const before = await qtyOf(batchLate);
  const r = await sell(ids.ASSISTANT_A, line(medA, 'strip', 1), { amountPaid: 45 });
  const after = await qtyOf(batchLate);

  const movements = await query(
    database,
    `select quantity_changed, resulting_quantity from stock_movements
      where kind = 'sale' and batch_id = $1 and resulting_quantity = $2`,
    [batchLate, after],
  );
  check(
    'one movement recorded the 10-unit drop',
    movements.length === 1 && movements[0].quantity_changed === -10,
    `${movements.length} row(s), change ${movements[0]?.quantity_changed}`,
  );
  check('the later lot moved', after === before - 10, `${before} -> ${after}`);
}

section('POSITIVE: an owner may sell, exactly as an attendant may');

{
  const r = await sell(ids.OWNER_A, line(medA, 'tablet', 1), { amountPaid: 5 });
  check("an owner's sale was accepted", r.ok, r.ok ? r.receipt_number : r.err);
}

section('POSITIVE: a discount and a part payment are recomputed server-side');

{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'strip', 2), {
    amountPaid: 50,
    discount: 10,
    discountReason: 'staff',
    customerId: CUSTOMER,
  });
  check('a discounted part-paid sale was accepted', r.ok, r.ok ? r.receipt_number : r.err);
  check('the total is subtotal minus the discount (90 - 10)', r.ok && Number(r.total) === 80, r.ok ? String(r.total) : '');

  const [row] = await query(
    database,
    `select state, amount_paid, outstanding from sales where id = $1`,
    [r.ok ? r.sale_id : null],
  );
  check('the server chose the part_paid state', row && row.state === 'part_paid', row ? row.state : '');
  check('the outstanding balance is what was left', row && Number(row.outstanding) === 30, row ? String(row.outstanding) : '');

  const [cust] = await query(
    database,
    `select total_spent, purchase_count, outstanding_debt from customers where id = $1`,
    [CUSTOMER],
  );
  check('the customer totals were updated', cust && Number(cust.total_spent) === 80 && cust.purchase_count === 1, cust ? `${cust.total_spent} / ${cust.purchase_count}` : '');
}

section('POSITIVE: a duplicate submission returns the original sale, once');

{
  const key = 'pos-retry-key-001';
  const before = await saleCount();
  const first = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), { amountPaid: 5, idempotencyKey: key });
  const second = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), { amountPaid: 5, idempotencyKey: key });

  check('the first submission completed', first.ok, first.ok ? first.receipt_number : first.err);
  check('the retry returned the same sale', second.ok && second.sale_id === first.sale_id, second.ok ? String(second.sale_id) : second.err);
  check('the retry is reported as already completed', second.ok && second.already_completed === true);
  check('only one sale exists for the key', (await saleCount()) === before + 1, `${before} -> ${await saleCount()}`);
}

/* ============================================================ negative paths */

section('NEGATIVE: the function refuses an empty cart');
{
  const r = await sell(ids.ASSISTANT_A, JSON.stringify([]), { amountPaid: 0 });
  check('an empty cart was refused', !r.ok, r.ok ? 'accepted' : r.err);
}

section('NEGATIVE: an unknown product');
{
  const r = await sell(ids.ASSISTANT_A, line('00000000-0000-0000-0000-000000000009', 'tablet', 1), { amountPaid: 5 });
  check('a product that does not exist was refused', !r.ok, r.ok ? 'accepted' : r.err);
}

section("NEGATIVE: another pharmacy's product");
{
  const r = await sell(ids.ASSISTANT_A, line(medB, 'tablet', 1), { amountPaid: 5 });
  check('a cross-tenant product was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check('and the refusal names the boundary', !r.ok && /another pharmacy/i.test(r.err), r.err);
  check('the other tenant kept its stock', (await totalOf(medB)) === 900, String(await totalOf(medB)));
}

section("NEGATIVE: an invented unit");
{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'carton', 1), { amountPaid: 5 });
  check('a unit the product does not define was refused', !r.ok, r.ok ? 'accepted' : r.err);
}

section('NEGATIVE: a fractional or non-positive quantity');
{
  // Raw JSON values, so a fractional number actually reaches the function as one.
  for (const qty of ['0.5', '1.5', '0', '-3', '"abc"', 'null']) {
    const r = await sell(ids.ASSISTANT_A, line(medA, 'tablet', qty), { amountPaid: 5 });
    check(`quantity ${qty} was refused`, !r.ok, r.ok ? 'accepted' : r.err);
  }
}

section('NEGATIVE: a safety-locked product');
{
  const r = await sell(ids.ASSISTANT_A, line(medLocked, 'tablet', 1), { amountPaid: 5 });
  check('a locked product was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check('its stock was untouched', (await totalOf(medLocked)) === 900, String(await totalOf(medLocked)));
}

section('NEGATIVE: a product flagged past its own expiry date');

{
  // The lots here are all in date, so this is purely the PRODUCT-level rule —
  // the third branch of `saleBlock`, which the POS enforces but which the server
  // must not take on trust.
  await query(database, `update medicines set expiry_date = current_date - 1 where id = $1`, [
    medExpired,
  ]);
  await query(database, `update medicine_batches set expiry_date = current_date + 60 where medicine_id = $1`, [
    medExpired,
  ]);

  const r = await sell(ids.ASSISTANT_A, line(medExpired, 'box', 1), { amountPaid: 400 });
  check('a product past its expiry date was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check(
    'and the refusal says it is the expiry, not the stock',
    !r.ok && /expiry/i.test(r.err),
    r.err ?? '',
  );
  check('its in-date stock was not consumed', (await totalOf(medExpired)) === 900, String(await totalOf(medExpired)));

  await query(database, `update medicines set expiry_date = current_date + 365 where id = $1`, [
    medExpired,
  ]);
  // Restore the lot as well: a later section relies on this product having only
  // expired stock, so leaving it in date would silently change what that proves.
  await query(
    database,
    `update medicine_batches set expiry_date = current_date - 5 where medicine_id = $1`,
    [medExpired],
  );
}

section('NEGATIVE: stock that does not exist');
{
  const r = await sell(ids.ASSISTANT_A, line(medExpired, 'box', 1), { amountPaid: 400 });
  check('an expired-only product was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check('and it says there is nothing sellable', !r.ok && /sellable stock/i.test(r.err), r.err);
}

section('NEGATIVE: a recalled lot is not sellable stock');
{
  const r = await sell(ids.ASSISTANT_A, line(medRecalled, 'tablet', 1), { amountPaid: 5 });
  check('a recalled-only product was refused', !r.ok, r.ok ? 'accepted' : r.err);
}

section('NEGATIVE: more than the pharmacy holds');
{
  const late = await qtyOf(batchLate);
  const r = await sell(ids.ASSISTANT_A, line(medA, 'box', 99), { amountPaid: 0 });
  check('an oversized line was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check('no stock moved on the refusal', (await qtyOf(batchLate)) === late, `${late} -> ${await qtyOf(batchLate)}`);
}

section('NEGATIVE: money the server recomputes and rejects');

{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), { amountPaid: 500 });
  check('tendering more than the total was refused', !r.ok, r.ok ? 'accepted' : r.err);

  const d = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), { amountPaid: 5, discount: 999 });
  check('a discount beyond the subtotal was refused', !d.ok, d.ok ? 'accepted' : d.err);

  const u = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), { amountPaid: 0 });
  check('an unpaid balance with no customer was refused', !u.ok, u.ok ? 'accepted' : u.err);
}

section('NEGATIVE: an anonymous caller cannot reach the function at all');
{
  const r = await asAnon(database, () =>
    database.query(
      `select * from public.pf_complete_sale(
         p_lines => $1::jsonb, p_payment_method => 'cash', p_amount_paid => 0)`,
      [line(medA, 'tablet', 1)],
    ),
  );
  check('anon was refused', !r.ok, r.ok ? 'reached the function' : r.err);
}

section('NEGATIVE: a signed-in non-staff cannot sell');
{
  const r = await asAuthenticated(database, () =>
    asActor(database, null, () =>
      database.query(
        `select * from public.pf_complete_sale(
           p_lines => $1::jsonb, p_payment_method => 'cash', p_amount_paid => 0)`,
        [line(medA, 'tablet', 1)],
      ),
    ),
  );
  check('a session with no profile was refused', !r.ok, r.ok ? 'accepted' : r.err);
}

/* ================================================= credit account (charge) path */

section('CREDIT: a sale charged to an account updates the balance and the ledger');

{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'strip', 2), {
    amountPaid: 0,
    creditAccountId: CREDIT,
  });

  check('a credit sale was accepted', r.ok, r.ok ? r.receiptNumber : r.err);

  const [acct] = await query(
    database,
    `select outstanding_balance from credit_accounts where id = $1`,
    [CREDIT],
  );
  check(
    'the account balance rose by the sale total (90)',
    acct && Number(acct.outstanding_balance) === 90,
    acct ? String(acct.outstanding_balance) : '',
  );

  const [entry] = await query(
    database,
    `select kind, amount, balance_after, reference_id from credit_ledger
      where account_id = $1 order by entry_at desc limit 1`,
    [CREDIT],
  );
  check('a charge was written to the ledger', entry && entry.kind === 'charge', entry ? entry.kind : 'none');
  check(
    'the ledger entry carries the running balance',
    entry && Number(entry.balance_after) === 90,
    entry ? String(entry.balance_after) : '',
  );
  check(
    'the ledger entry points at the sale',
    entry && entry.reference_id === r.sale_id,
    entry ? String(entry.reference_id) : '',
  );
}

section('CREDIT: a SECOND charge to the same account still works');

{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 5), {
    amountPaid: 0,
    creditAccountId: CREDIT,
  });

  // This is the case that matters. `pf_check_credit_account_ledger` is a BEFORE
  // UPDATE trigger that compares the new balance against the LATEST ledger row.
  // Once a ledger row exists, raising the balance before writing the ledger row
  // is exactly the comparison that trigger is designed to reject.
  check('the second credit sale was accepted', r.ok, r.ok ? r.receiptNumber : r.err);

  const [acct] = await query(
    database,
    `select outstanding_balance from credit_accounts where id = $1`,
    [CREDIT],
  );
  check(
    'the balance accumulated to 115 (90 + 25)',
    acct && Number(acct.outstanding_balance) === 115,
    acct ? String(acct.outstanding_balance) : '',
  );

  const rows = await query(
    database,
    `select balance_after from credit_ledger where account_id = $1 order by entry_at, id`,
    [CREDIT],
  );
  check('the ledger has one row per charge', rows.length === 2, `${rows.length} row(s)`);
  check(
    'and the running balances are correct',
    rows.length === 2 && Number(rows[0].balance_after) === 90 && Number(rows[1].balance_after) === 115,
    rows.map((x) => String(x.balance_after)).join(' -> '),
  );
}

section('CREDIT: a suspended account and an over-limit sale are both refused');

{
  const [susp] = await query(
    database,
    `select id from credit_accounts where branch_id = $1 limit 1`,
    [ids.BRANCH_A],
  );
  await query(database, `update credit_accounts set is_suspended = true where id = $1`, [CREDIT]);
  const r = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), {
    amountPaid: 0,
    creditAccountId: CREDIT,
  });
  check('a suspended account was refused', !r.ok, r.ok ? 'accepted' : r.err);
  await query(database, `update credit_accounts set is_suspended = false where id = $1`, [CREDIT]);

  await query(database, `update credit_accounts set credit_limit = 50 where id = $1`, [CREDIT]);
  const over = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), {
    amountPaid: 0,
    creditAccountId: CREDIT,
  });
  check('a sale beyond the credit limit was refused', !over.ok, over.ok ? 'accepted' : over.err);
  await query(database, `update credit_accounts set credit_limit = 100000 where id = $1`, [CREDIT]);
}

section('CREDIT: the ledger invariant still fires for everyone else');

{
  // The RPC excuses `pf_check_credit_ledger_balance` for one transaction, via a
  // transaction-local setting. This proves that exemption does not persist: a
  // writer outside the RPC that posts a balance_after disagreeing with the
  // account must still be rejected.
  const [acct] = await query(
    database,
    `select outstanding_balance from credit_accounts where id = $1`,
    [CREDIT],
  );

  const bogus = await asAuthenticated(database, () =>
    asActor(database, ids.OWNER_A, async () => {
      const { rows } = await database.query(
        `insert into public.credit_ledger
           (account_id, branch_id, kind, amount, balance_after, note, recorded_by)
         values ($1, $2, 'charge', 10, $3, 'forged', $4)
         returning id`,
        [CREDIT, ids.BRANCH_A, Number(acct.outstanding_balance) + 999, ids.OWNER_A],
      );
      return rows;
    }),
  );

  check(
    'a forged balance_after is still rejected outside the RPC',
    !bogus.ok,
    bogus.ok ? 'accepted' : bogus.err,
  );
  check(
    'and the phrase names the invariant',
    !bogus.ok && /does not match the account balance/i.test(bogus.err),
    bogus.err ?? '',
  );
}

/* ================================================== atomicity and no oversell */

section('ATOMICITY: a sale that fails on its second line leaves nothing behind');

{
  const lateBefore = await qtyOf(batchLate);
  const totalBefore = await totalOf(medA);
  const salesBefore = await saleCount();
  const movementsBefore = await movementCount('sale');

  // First line is perfectly sellable; second asks for more than exists. The
  // function writes nothing until every line has passed, so this must not even
  // leave the first line's stock touched.
  const r = await sell(
    ids.ASSISTANT_A,
    multiLine([
      { medicine_id: medA, unit_key: 'strip', quantity: 1 },
      { medicine_id: medA, unit_key: 'box', quantity: 500 },
    ]),
    { amountPaid: 0 },
  );

  check('the multi-line sale was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check('no sale row was created', (await saleCount()) === salesBefore, `${salesBefore} -> ${await saleCount()}`);
  check('the good line deducted nothing', (await qtyOf(batchLate)) === lateBefore, `${lateBefore} -> ${await qtyOf(batchLate)}`);
  check('the medicine total is unchanged', (await totalOf(medA)) === totalBefore, `${totalBefore} -> ${await totalOf(medA)}`);
  check('no movement was written', (await movementCount('sale')) === movementsBefore, `${movementsBefore} -> ${await movementCount('sale')}`);
}

section('ATOMICITY: two sales competing for the same stock — the second is refused');

{
  // Sequential, because PGlite is single-connection. This proves the observable
  // consequence (no oversell) rather than lock contention itself.
  //
  // Stock is set to exactly one box so the second sale has nothing left to take.
  await query(
    database,
    `update medicine_batches set expiry_date = current_date + 50, quantity = 100
      where medicine_id = $1`,
    [medExpired],
  );
  const stock = await totalOf(medExpired);
  check('the scenario starts with exactly one box on hand', stock === 100, `${stock} base units`);

  const first = await sell(ids.ASSISTANT_A, line(medExpired, 'box', 1), { amountPaid: 400 });
  check('the first competing sale won its stock', first.ok, first.ok ? first.receipt_number : first.err);
  check('the stock it needed is gone', (await totalOf(medExpired)) === 0, `${stock} -> ${await totalOf(medExpired)}`);

  const second = await sell(ids.ASSISTANT_A, line(medExpired, 'box', 1), { amountPaid: 400 });
  check('the second competing sale was refused rather than overselling', !second.ok, second.ok ? 'accepted' : second.err);
  check('stock did not go negative', (await totalOf(medExpired)) === 0, String(await totalOf(medExpired)));
  check('and no lot holds a negative quantity', (await query(database, `select count(*)::int as n from medicine_batches where quantity < 0`))[0].n === 0);
}

/* ============================================================ data protection */

section('PROTECTION: the function never hands cost data back to the caller');
{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), { amountPaid: 5 });
  const keys = r.ok ? Object.keys(r) : [];
  check('the return carries no cost column', !keys.some((k) => /cost/i.test(k)), keys.join(', '));
  check('the return is exactly the documented shape',
    ['sale_id', 'receipt_number', 'total', 'line_count', 'already_completed'].every((k) => keys.includes(k)),
    keys.join(', '));

  // The stronger claim: an attendant still cannot read the stored snapshot back.
  const readable = await asAuthenticated(database, () =>
    asActor(database, ids.ASSISTANT_A, async () => {
      const { rows } = await database.query(
        `select cost_per_base_unit_snapshot from sale_items where sale_id = $1`,
        [r.ok ? r.sale_id : null],
      );
      return rows;
    }),
  );
  check(
    'an attendant cannot select the cost snapshot',
    !readable.ok || readable.value.length === 0,
    readable.ok ? `${readable.value.length} row(s) readable` : readable.err,
  );
}

/* ============================================================ POS payments */

section('PAYMENTS: an ordinary sale writes one payment row for the collected amount');

{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'strip', 1), { amountPaid: 45 });
  check('the sale was accepted', r.ok, r.ok ? r.receipt_number : r.err);
  const rows = await paymentsOf(r.sale_id);
  check(
    'one row: cash, the amount received',
    rows.length === 1 && rows[0].method === 'cash' && Number(rows[0].amount) === 45,
    JSON.stringify(rows),
  );
}

section('PAYMENTS: a split sale stores one row per method, summing to the amount received');

{
  const r = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 9), {
    amountPaid: 45,
    paymentMethod: 'split',
    breakdown: [
      { method: 'cash', amount: 20 },
      { method: 'transfer', amount: 25 },
    ],
  });
  check('the split sale was accepted', r.ok, r.ok ? r.receipt_number : r.err);
  const rows = await paymentsOf(r.sale_id);
  const total = rows.reduce((t, row) => t + Number(row.amount), 0);
  check('two payment rows were written', rows.length === 2, JSON.stringify(rows));
  check('the parts add up to the amount received', total === 45, String(total));
  check(
    'methods are recorded, not just the sum',
    rows.every((row) => ['cash', 'transfer'].includes(row.method)),
    JSON.stringify(rows.map((row) => row.method)),
  );
}

section('PAYMENTS: a split part-payment leaves an outstanding balance on a named customer');

{
  // 2 strips = 90. 25 collected (15 cash + 10 transfer); customer owes 65.
  const r = await sell(ids.ASSISTANT_A, line(medA, 'strip', 2), {
    amountPaid: 25,
    paymentMethod: 'split',
    breakdown: [
      { method: 'cash', amount: 15 },
      { method: 'transfer', amount: 10 },
    ],
    customerId: CUSTOMER,
  });
  check('the split part-payment was accepted', r.ok, r.ok ? r.receipt_number : r.err);

  const state = (await query(database, `select state::text, amount_paid, outstanding from sales where id = $1`, [r.sale_id]))[0];
  check('the sale is part_paid', state.state === 'part_paid', state.state);
  check('amount_paid is 25', Number(state.amount_paid) === 25, String(state.amount_paid));
  check('outstanding is 65', Number(state.outstanding) === 65, String(state.outstanding));

  const debt = (await query(database, `select outstanding_debt from customers where id = $1`, [CUSTOMER]))[0];
  check('the customer debt moved', Number(debt.outstanding_debt) >= 65, String(debt.outstanding_debt));

  // The parts were still written, not just the total.
  const rows = await paymentsOf(r.sale_id);
  check('the split parts were recorded even with a balance left', rows.length === 2, JSON.stringify(rows));
}

section('PAYMENTS: a broken breakdown is refused before anything is written');

{
  const before = await saleCount();
  const tooMany = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), {
    amountPaid: 5,
    paymentMethod: 'split',
    breakdown: [{ method: 'cash', amount: 9 }],
  });
  check('parts summing to more than amount_paid is refused', !tooMany.ok, tooMany.ok ? 'accepted' : tooMany.err);

  const splitWithNoParts = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), {
    amountPaid: 5,
    paymentMethod: 'split',
  });
  check('a split sale without a breakdown is refused', !splitWithNoParts.ok, splitWithNoParts.ok ? 'accepted' : splitWithNoParts.err);

  const unknownMethod = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), {
    amountPaid: 5,
    paymentMethod: 'split',
    breakdown: [
      { method: 'cash', amount: 3 },
      { method: 'bitcoin', amount: 2 },
    ],
  });
  check('an invented method in the breakdown is refused', !unknownMethod.ok, unknownMethod.ok ? 'accepted' : unknownMethod.err);

  const zeroPart = await sell(ids.ASSISTANT_A, line(medA, 'tablet', 1), {
    amountPaid: 5,
    paymentMethod: 'split',
    breakdown: [
      { method: 'cash', amount: 0 },
      { method: 'transfer', amount: 5 },
    ],
  });
  check('a zero part is refused — a split is two real payments', !zeroPart.ok, zeroPart.ok ? 'accepted' : zeroPart.err);

  check('nothing was written by any of the refusals', (await saleCount()) === before);
}

section('REPAYMENT: a customer balance settles down to exactly zero');

{
  // 4 strips = 180. 80 collected, 100 outstanding on the customer.
  const sale = await sell(ids.ASSISTANT_A, line(medA, 'strip', 4), {
    amountPaid: 80,
    customerId: CUSTOMER,
  });
  check('the unpaid-balance sale was accepted', sale.ok, sale.ok ? sale.receipt_number : sale.err);

  const first = await repay(ids.ASSISTANT_A, sale.sale_id, 60, 'transfer');
  check('an attendant can record a repayment', first.ok, first.ok ? first.receipt_number : first.err);
  check(
    'the sale moved to 140 paid / 40 outstanding',
    first.ok && Number(first.amount_paid) === 140 && Number(first.outstanding) === 40,
    first.ok ? `${first.amount_paid}/${first.outstanding}` : '',
  );
  check('the sale is still part_paid', first.ok && first.state === 'part_paid', String(first.state));

  const final = await repay(ids.OWNER_A, sale.sale_id, 40, 'cash');
  check('the owner can record the final repayment', final.ok, final.ok ? final.receipt_number : final.err);
  check('the sale settled to paid', final.ok && final.state === 'paid', String(final.state));
  check('nothing remains outstanding', final.ok && Number(final.outstanding) === 0, String(final.outstanding));
  check(
    'the returned customer debt matches the customer row',
    final.ok &&
      Number(final.customer_outstanding_debt) ===
        Number((await query(database, `select outstanding_debt from customers where id = $1`, [CUSTOMER]))[0].outstanding_debt),
  );

  const rows = await paymentsOf(sale.sale_id);
  check(
    'three payment rows: the original payment and both repayments',
    rows.length === 3,
    JSON.stringify(rows),
  );
  check(
    'each repayment carries its own method',
    rows.filter((row) => row.method === 'transfer').length === 1 &&
      rows.filter((row) => row.method === 'cash').length === 2,
    JSON.stringify(rows),
  );
}

section('REPAYMENT: refusals');

{
  const sale = await sell(ids.ASSISTANT_A, line(medA, 'strip', 2), {
    amountPaid: 25,
    customerId: CUSTOMER,
  });
  check('the fixture sale was accepted', sale.ok, sale.ok ? sale.receipt_number : sale.err);

  const overpay = await repay(ids.ASSISTANT_A, sale.sale_id, 999, 'cash');
  check('a repayment above the outstanding balance is refused', !overpay.ok, overpay.ok ? 'accepted' : overpay.err);

  const zero = await repay(ids.ASSISTANT_A, sale.sale_id, 0, 'cash');
  check('a zero repayment is refused', !zero.ok, zero.ok ? 'accepted' : zero.err);

  const split = await repay(ids.ASSISTANT_A, sale.sale_id, 10, 'split');
  check('a split repayment is refused — record each part separately', !split.ok, split.ok ? 'accepted' : split.err);

  // Another pharmacy's staff must not reach across branches.
  const otherBranch = await repay(ids.OWNER_B, sale.sale_id, 10, 'cash');
  check('another pharmacy\'s staff cannot repay a foreign sale', !otherBranch.ok, otherBranch.ok ? 'accepted' : otherBranch.err);

  // Settling the last naira must also lock the sale against a second pass.
  const settle = await repay(ids.ASSISTANT_A, sale.sale_id, 65, 'cash');
  check('the sale settled in full', settle.ok && settle.state === 'paid', settle.ok ? settle.state : settle.err);
  const again = await repay(ids.ASSISTANT_A, sale.sale_id, 10, 'cash');
  check('a fully settled sale takes no further repayment', !again.ok, again.ok ? 'accepted' : again.err);

  const anon = await asAnon(database, () =>
    database.query(`select * from public.pf_record_customer_payment(p_sale_id => $1, p_amount => 1, p_method => 'cash')`, [
      sale.sale_id,
    ]),
  );
  check('anon cannot call the repayment RPC', !anon.ok, anon.ok ? 'reached the function' : anon.err);
}

note(
  'concurrency is not exercised here',
  'PGlite is single-connection; overlapping transactions and the FOR UPDATE locks need two live connections against real Postgres',
);


process.exit(await finish(database));