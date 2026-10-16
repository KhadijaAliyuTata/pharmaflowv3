/**
 * Voiding a sale returns its stock — `pf_void_sale`.
 *
 * ## What is actually being proven
 *
 * Restoring stock is easy and wrong often. Re-running FEFO at void time would put
 * stock on whatever lots happen to be eligible *now*, which is not where the
 * sale drew from. These tests assert the strict property instead: every unit goes
 * back to the exact lot it left, which is why they check lot identity and not
 * just the total.
 *
 * The blocker this had to clear first: `pf_record_stock_movement()` wrote
 * `reference_id` as a hardcoded `null`, and a line split across two lots is
 * stored with `sale_items.batch_id = null`. Before this migration the allocation
 * was recorded nowhere, so it could not be recovered. The suite covers the
 * fail-safe path for exactly that case.
 *
 * ## What this suite does NOT prove
 *
 * PGlite is single-connection. The `FOR UPDATE` locks are exercised
 * sequentially, not under contention, and a two-connection test against real
 * PostgreSQL is still outstanding.
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

const { check, note, section, finish } = createReporter('verify-void-sale');

const database = await freshDatabase();
const ids = await seedTenants(database);

/* ------------------------------------------------------------------ fixtures */

const UNITS = JSON.stringify([
  { key: 'tablet', name: 'Tablet', multiplier: 1, sellingPrice: 5 },
  { key: 'strip', name: 'Strip', multiplier: 10, sellingPrice: 45 },
  { key: 'box', name: 'Box', multiplier: 100, sellingPrice: 400 },
]);

/** A product with two lots: an early-expiring short one and a late big one. */
async function seedStocky(branchId, name, earlyQty = 150, lateQty = 500) {
  const [medicine] = await query(
    database,
    `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
     values ($1, $2, 'gen', $3::jsonb, 2, 5, current_date + 365) returning id`,
    [branchId, name, UNITS],
  );
  const [early] = await query(
    database,
    `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
     values ($1, $2, 'EARLY', current_date + 100, $3, 2) returning id`,
    [branchId, medicine.id, earlyQty],
  );
  const [late] = await query(
    database,
    `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
     values ($1, $2, 'LATE', current_date + 400, $3, 2) returning id`,
    [branchId, medicine.id, lateQty],
  );
  return { medicineId: medicine.id, early: early.id, late: late.id };
}

const simple = await seedStocky(ids.BRANCH_A, 'Simple Drug');
/** Same shape, used where a sale must span both lots. */
const split = await seedStocky(ids.BRANCH_A, 'Split Drug');
const tenantB = await seedStocky(ids.BRANCH_B, 'Other Pharmacy Drug');

const [customerRow] = await query(
  database,
  `insert into customers (branch_id, code, name, phone) values ($1,'C-1','Void Customer','08000000009') returning id`,
  [ids.BRANCH_A],
);
const CUSTOMER = customerRow.id;

const [creditRow] = await query(
  database,
  `insert into credit_accounts (branch_id, name, kind, contact_person, phone, credit_limit)
   values ($1,'Void Clinic','clinic','C','08000000010',100000) returning id`,
  [ids.BRANCH_A],
);
const CREDIT = creditRow.id;

/* -------------------------------------------------------------------- helpers */

const line = (medicineId, unitKey, quantity) =>
  `[{"medicine_id": ${JSON.stringify(medicineId)}, "unit_key": ${JSON.stringify(unitKey)}, "quantity": ${quantity}}]`;

async function sell(actorId, lines, opts = {}) {
  const params = [
    lines,
    opts.paymentMethod ?? 'cash',
    opts.amountPaid ?? 0,
    opts.discount ?? 0,
    null,
    opts.customerId ?? null,
    opts.creditAccountId ?? null,
    false,
    opts.idempotencyKey ?? null,
  ];
  const call = await asAuthenticated(database, () =>
    asActor(database, actorId, async () => {
      const { rows } = await database.query(
        `select * from public.pf_complete_sale(
           p_lines => $1::jsonb, p_payment_method => $2::public.payment_kind,
           p_amount_paid => $3, p_discount => $4, p_discount_reason => $5,
           p_customer_id => $6, p_credit_account_id => $7,
           p_dispensed_against_prescription => $8, p_idempotency_key => $9)`,
        params,
      );
      const row = rows[0];
      // The RPC returns snake_case column names. Mapped explicitly rather than
      // spread, so an assertion that reads `saleId` cannot silently pass on
      // `undefined` - which is exactly the bug this replaced.
      return row
        ? {
            saleId: row.sale_id,
            receiptNumber: row.receipt_number,
            total: Number(row.total),
          }
        : undefined;
    }),
  );
  if (!call.ok) return { ok: false, err: call.err };
  if (!call.value) return { ok: false, err: 'the sale returned no row' };
  return { ok: true, ...call.value };
}

async function voidSale(actorId, saleId, reason) {
  const call = await asAuthenticated(database, () =>
    asActor(database, actorId, async () => {
      const { rows } = await database.query(
        `select * from public.pf_void_sale($1::uuid, $2::text)`,
        [saleId, reason],
      );
      const row = rows[0];
      return row
        ? { saleId: row.sale_id, receiptNumber: row.receipt_number, restoredUnits: Number(row.restored_units) }
        : undefined;
    }),
  );
  if (!call.ok) return { ok: false, err: call.err };
  if (!call.value) return { ok: false, err: 'the void returned no row' };
  return { ok: true, ...call.value };
}

const qtyOf = async (batchId) =>
  (await query(database, `select quantity from medicine_batches where id = $1`, [batchId]))[0].quantity;

const totalOf = async (medicineId) =>
  (await query(database, `select total_quantity from medicines where id = $1`, [medicineId]))[0].total_quantity;

const stateOf = async (saleId) =>
  (await query(
    database,
    `select state, status_reason, status_changed_by from sales where id = $1`,
    [saleId],
  ))[0];

const movementsFor = async (saleId, kind) =>
  await query(
    database,
    `select batch_id, quantity_changed from stock_movements
      where reference_id = $1 and kind = $2::public.movement_kind order by created_at, id`,
    [saleId, kind],
  );

/* ============================================================== single-lot void */

section('POSITIVE: voiding returns the stock to the lot it came from');

{
  const before = await qtyOf(simple.early);
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'strip', 2), { amountPaid: 90 });
  check('the sale was completed', sale.ok, sale.ok ? sale.receiptNumber : sale.err);
  check('the lot lost 20 base units', (await qtyOf(simple.early)) === before - 20, `${before} -> ${await qtyOf(simple.early)}`);

  const movements = await movementsFor(sale.saleId, 'sale');
  check('the sale recorded one movement naming its lot', movements.length === 1 && movements[0].batch_id === simple.early, `${movements.length} movement(s)`);
  check('that movement now carries the sale as its reference', movements.length === 1, 'reference_id is what pf_void_sale reads');

  const v = await voidSale(ids.OWNER_A, sale.saleId, 'wrong item rung up');
  check('the owner voided the sale', v.ok, v.ok ? v.receiptNumber : v.err);
  check('the lot has every unit back', (await qtyOf(simple.early)) === before, `${before} -> ${await qtyOf(simple.early)}`);
  check('the medicine total followed', (await totalOf(simple.medicineId)) === before + 500);

  const s = await stateOf(sale.saleId);
  check('the sale is marked voided', s.state === 'voided', s.state);
  check('the reason was recorded', s.status_reason === 'wrong item rung up', String(s.status_reason));
  check('the actor was recorded', s.status_changed_by === ids.OWNER_A, String(s.status_changed_by));

  const voids = await movementsFor(sale.saleId, 'void');
  check('exactly one void movement was written', voids.length === 1, `${voids.length}`);
  check('it put the units back on the same lot', voids[0]?.batch_id === simple.early, '');
  check('it records a positive change', voids[0]?.quantity_changed === 20, String(voids[0]?.quantity_changed));
}

section('POSITIVE: a void undoes a SPLIT allocation lot by lot');

{
  const earlyBefore = await qtyOf(split.early);
  const lateBefore = await qtyOf(split.late);

  // 3 boxes = 300 base units, but the early lot only holds 150, so this line
  // spans both lots and `sale_items.batch_id` is null. This is the case the
  // pre-migration code could not recover at all.
  const sale = await sell(ids.ASSISTANT_A, line(split.medicineId, 'box', 3), { amountPaid: 1200 });
  check('the three-box sale completed', sale.ok, sale.ok ? sale.receiptNumber : sale.err);
  check('the early lot drained', (await qtyOf(split.early)) === 0, `${earlyBefore} -> ${await qtyOf(split.early)}`);
  check('the late lot gave up the remainder', (await qtyOf(split.late)) === lateBefore - 150, `${lateBefore} -> ${await qtyOf(split.late)}`);

  const [item] = await query(
    database,
    `select batch_id from sale_items where sale_id = $1`,
    [sale.saleId],
  );
  check('the split line indeed stored no single lot', item && item.batch_id === null, '');

  const v = await voidSale(ids.OWNER_A, sale.saleId, 'customer cancelled');
  check('the split sale was voided', v.ok, v.ok ? v.receiptNumber : v.err);
  check('BOTH lots are back to exactly what they were',
    (await qtyOf(split.early)) === earlyBefore && (await qtyOf(split.late)) === lateBefore,
    `early ${await qtyOf(split.early)}/${earlyBefore}, late ${await qtyOf(split.late)}/${lateBefore}`);

  const voids = await movementsFor(sale.saleId, 'void');
  check('one void movement per lot', voids.length === 2, `${voids.length}`);
  check('each names the right lot',
    new Set(voids.map((m) => m.batch_id)).size === 2 &&
      voids.some((m) => m.batch_id === split.early) &&
      voids.some((m) => m.batch_id === split.late),
    voids.map((m) => `${m.batch_id.slice(0, 4)}:${m.quantity_changed}`).join(' '));
}

/* ================================================================== refusals */

section('NEGATIVE: a sale cannot be voided twice');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 3), { amountPaid: 15 });
  const first = await voidSale(ids.OWNER_A, sale.saleId, 'first');
  check('the first void succeeded', first.ok, first.ok ? first.receiptNumber : first.err);

  const before = await qtyOf(simple.early);
  const second = await voidSale(ids.OWNER_A, sale.saleId, 'again');
  check('the second void was refused', !second.ok, second.ok ? 'accepted' : second.err);
  check('the refusal says it is already voided', !second.ok && /already voided/i.test(second.err), second.err);
  check('stock was NOT credited a second time', (await qtyOf(simple.early)) === before, `${before} -> ${await qtyOf(simple.early)}`);

  const voids = await movementsFor(sale.saleId, 'void');
  check('still only one void movement', voids.length === 1, `${voids.length}`);
}

section('NEGATIVE: only an owner may void');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 2), { amountPaid: 10 });
  // Captured AFTER the sale deliberately: this asserts the refused void changed
  // nothing, so the comparison point is the post-sale level.
  const before = await qtyOf(simple.early);

  const asAttendant = await voidSale(ids.ASSISTANT_A, sale.saleId, 'let me undo this');
  check('an attendant was refused', !asAttendant.ok, asAttendant.ok ? 'accepted' : asAttendant.err);
  check('the refusal names the owner requirement', !asAttendant.ok && /owner/i.test(asAttendant.err), asAttendant.err);
  check('the sale is untouched', (await stateOf(sale.saleId)).state !== 'voided', '');
  check('the stock is untouched', (await qtyOf(simple.early)) === before, `${before} -> ${await qtyOf(simple.early)}`);

  // Clean up so later sections are not affected by an intentionally un-voided sale.
  await voidSale(ids.OWNER_A, sale.saleId, 'cleanup');
}

section('NEGATIVE: another pharmacy cannot void this one');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 2), { amountPaid: 10 });
  const before = await qtyOf(simple.early);

  const cross = await voidSale(ids.OWNER_B, sale.saleId, 'not my pharmacy');
  check('a different branch owner was refused', !cross.ok, cross.ok ? 'accepted' : cross.err);
  check('the refusal names the boundary', !cross.ok && /another pharmacy/i.test(cross.err), cross.err);
  check('the sale is untouched', (await stateOf(sale.saleId)).state !== 'voided', '');
  check('the stock is untouched', (await qtyOf(simple.early)) === before, `${before} -> ${await qtyOf(simple.early)}`);

  await voidSale(ids.OWNER_A, sale.saleId, 'cleanup');
}

section('NEGATIVE: an unknown sale id');

{
  const r = await voidSale(ids.OWNER_A, '00000000-0000-0000-0000-0000000000ff', 'typo in the id');
  check('an unknown sale was refused', !r.ok, r.ok ? 'accepted' : r.err);
}

section('NEGATIVE: a void with no reason is refused');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 1), { amountPaid: 5 });
  const r = await voidSale(ids.OWNER_A, sale.saleId, '   ');
  check('a blank reason was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check('and the sale is still live', (await stateOf(sale.saleId)).state !== 'voided', '');
  await voidSale(ids.OWNER_A, sale.saleId, 'cleanup');
}

section('NEGATIVE: an anon caller cannot reach the function');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 1), { amountPaid: 5 });
  const r = await asAnon(database, () =>
    database.query(`select * from public.pf_void_sale($1::uuid, 'anon')`, [sale.saleId]),
  );
  check('anon was refused', !r.ok, r.ok ? 'reached the function' : r.err);
  await voidSale(ids.OWNER_A, sale.saleId, 'cleanup');
}

section('NEGATIVE: a sale whose allocation cannot be recovered is NOT voided');

{
  // Written straight to the tables, so no movement carries its reference. This
  // is the state every sale is in that predates this migration.
  const [sale] = await query(
    database,
    `insert into sales (branch_id, receipt_number, attendant_id, subtotal, discount, total,
                        payment_method, state, amount_paid, outstanding)
     values ($1,'PF-2026-9999',$2,400,0,400,'cash','paid',400,0) returning id`,
    [ids.BRANCH_A, ids.OWNER_A],
  );
  await query(
    database,
    `insert into sale_items (sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
                             unit_multiplier, quantity, base_units_total, unit_price, line_total)
     values ($1,$2,'Simple Drug','gen','box','Box',100,1,100,400,400)`,
    [sale.id, simple.medicineId],
  );

  const before = await qtyOf(simple.early);
  const r = await voidSale(ids.OWNER_A, sale.id, 'should not work');
  check('it was refused rather than guessed at', !r.ok, r.ok ? 'accepted' : r.err);
  check('the refusal explains the stock cannot be identified', !r.ok && /cannot be identified/i.test(r.err), r.err);
  check('the sale was left exactly as it was', (await stateOf(sale.id)).state === 'paid', (await stateOf(sale.id)).state);
  check('no stock was invented', (await qtyOf(simple.early)) === before, `${before} -> ${await qtyOf(simple.early)}`);
}

section('NEGATIVE: a refunded sale is not silently treated as a void');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 2), { amountPaid: 10 });
  await query(database, `update sales set state = 'refunded' where id = $1`, [sale.saleId]);

  const r = await voidSale(ids.OWNER_A, sale.saleId, 'should not work');
  check('a refunded sale was refused', !r.ok, r.ok ? 'accepted' : r.err);
  check('the refusal distinguishes it from a void', !r.ok && /refunded/i.test(r.err), r.err);
  check('it stayed refunded', (await stateOf(sale.saleId)).state === 'refunded', '');
}

/* ================================================ customer and credit unwind */

section('POSITIVE: voiding unwinds the customer totals');

{
  const [before] = await query(
    database,
    `select total_spent, purchase_count, outstanding_debt from customers where id = $1`,
    [CUSTOMER],
  );
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'strip', 2), {
    amountPaid: 50,
    customerId: CUSTOMER,
  });
  check('a part-paid sale completed', sale.ok, sale.ok ? sale.receiptNumber : sale.err);

  const [during] = await query(
    database,
    `select total_spent, purchase_count, outstanding_debt from customers where id = $1`,
    [CUSTOMER],
  );
  check('the customer totals moved up', Number(during.total_spent) === Number(before.total_spent) + 90, `${before.total_spent} -> ${during.total_spent}`);

  const v = await voidSale(ids.OWNER_A, sale.saleId, 'mistake');
  check('it was voided', v.ok, v.ok ? v.receiptNumber : v.err);

  const [after] = await query(
    database,
    `select total_spent, purchase_count, outstanding_debt from customers where id = $1`,
    [CUSTOMER],
  );
  check('the totals were unwound exactly',
    Number(after.total_spent) === Number(before.total_spent) &&
      after.purchase_count === before.purchase_count &&
      Number(after.outstanding_debt) === Number(before.outstanding_debt),
    `${JSON.stringify(after)} vs ${JSON.stringify(before)}`);
  check('nothing went negative', Number(after.outstanding_debt) >= 0 && Number(after.total_spent) >= 0, '');
}

section('POSITIVE: voiding a credit sale releases the debt and writes a ledger entry');

{
  const [acctBefore] = await query(
    database,
    `select outstanding_balance from credit_accounts where id = $1`,
    [CREDIT],
  );
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'strip', 2), {
    amountPaid: 0,
    creditAccountId: CREDIT,
  });
  check('the credit sale completed', sale.ok, sale.ok ? sale.receiptNumber : sale.err);

  const [charged] = await query(
    database,
    `select outstanding_balance from credit_accounts where id = $1`,
    [CREDIT],
  );
  check('the account was charged 90', Number(charged.outstanding_balance) === Number(acctBefore.outstanding_balance) + 90, `${acctBefore.outstanding_balance} -> ${charged.outstanding_balance}`);

  const v = await voidSale(ids.OWNER_A, sale.saleId, 'customer never collected');
  check('it was voided', v.ok, v.ok ? v.receiptNumber : v.err);

  const [released] = await query(
    database,
    `select outstanding_balance from credit_accounts where id = $1`,
    [CREDIT],
  );
  check('the debt was released', Number(released.outstanding_balance) === Number(acctBefore.outstanding_balance), `${charged.outstanding_balance} -> ${released.outstanding_balance}`);

  const entries = await query(
    database,
    `select kind, amount, balance_after from credit_ledger
      where account_id = $1 order by entry_at desc, id desc limit 1`,
    [CREDIT],
  );
  check('a ledger entry records the release', entries[0]?.kind === 'payment', String(entries[0]?.kind));
  check('the ledger balance matches the account',
    Number(entries[0]?.balance_after) === Number(released.outstanding_balance),
    `${entries[0]?.balance_after} vs ${released.outstanding_balance}`);
}

/* ============================================================== protection */

section('PROTECTION: the function returns no cost data');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 2), { amountPaid: 10 });
  const v = await voidSale(ids.OWNER_A, sale.saleId, 'check the shape');
  const keys = v.ok ? Object.keys(v) : [];
  check('the return is exactly the documented shape',
    ['saleId', 'receiptNumber', 'restoredUnits'].every((k) => keys.includes(k)),
    keys.join(', '));
  check('no key mentions cost or margin', !keys.some((k) => /cost|margin|profit/i.test(k)), keys.join(', '));
}

section('PROTECTION: the void state is recorded, not a refund');

{
  const sale = await sell(ids.ASSISTANT_A, line(simple.medicineId, 'tablet', 1), { amountPaid: 5 });
  const v = await voidSale(ids.OWNER_A, sale.saleId, 'shape check');
  const s = await stateOf(sale.saleId);
  check('the resulting state is voided', s.state === 'voided', s.state);
  check('it is not refunded', s.state !== 'refunded', s.state);
  check('the restoration was reported in base units', v.ok && v.restoredUnits === 1, v.ok ? String(v.restoredUnits) : '');
}

note(
  'lock contention is not exercised here',
  'PGlite is single-connection; the FOR UPDATE locks need two live connections against real PostgreSQL',
);

process.exit(await finish(database));