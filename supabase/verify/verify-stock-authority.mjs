/**
 * Stock authority — the B1 regression test, asserting BOTH directions.
 *
 * Refusing access is only half of the fix. A hardening change that closes the
 * hole by breaking the legitimate path would leave the pharmacy unable to sell,
 * which is a worse outcome than the vulnerability. So this suite asserts:
 *
 *   NEGATIVE — an unauthenticated caller cannot invoke the stock mutation path,
 *              and an authenticated caller from another tenant cannot reach it
 *              either. No role bypasses RLS to mutate stock.
 *
 *   POSITIVE — a genuine authenticated sale, written the way the repository
 *              writes it, still deducts the intended quantity from the intended
 *              lot, and leaves an auditable movement behind.
 *
 * The second half is the one that catches an over-tightening regression.
 */

import {
  SINGLE_UNIT_UNITS,
  asAnon,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedMedicine,
  seedTenants,
} from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-stock-authority');

const database = await freshDatabase();
const ids = await seedTenants(database);

/** A second, later-expiring lot, so FEFO ordering is observable. */
const soon = await seedMedicine(database, { branchId: ids.BRANCH_A, quantity: 500 });
/** A distinct lot on the same medicine, expiring much later. */
const [lateBatch] = await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
   values ($1, $2, 'BATCH-LATE', current_date + 600, 500, 50) returning id`,
  [ids.BRANCH_A, soon.medicineId],
);

/** Branch B has its own medicine and lot, for cross-tenant attempts. */
const tenantB = await seedMedicine(database, { branchId: ids.BRANCH_B, quantity: 500 });

const quantityOf = async (batchId) =>
  (await query(database, `select quantity from medicine_batches where id = $1`, [batchId]))[0].quantity;

section('NEGATIVE: the stock mutation path is not reachable without authority');
{
  // 1. anon, with no JWT and no session at all.
  const r = await asAnon(database, () =>
    query(database, `select pf_apply_sale_item_stock($1)`, [tenantB.batchId]),
  );
  check(
    'anon cannot invoke the stock mutation function',
    !r.ok,
    r.ok ? 'RETURNED SUCCESS — anonymously reachable' : `refused: ${r.err}`,
  );

  // Rule 4: prove the *state* is untouched, not merely that a call was refused.
  const anonQty = await quantityOf(tenantB.batchId);
  check(
    "another tenant's stock is unchanged after the anon attempt",
    anonQty === 500,
    `quantity ${anonQty}`,
  );

  // 2. Replay: the same call repeated must not walk stock down.
  for (let i = 0; i < 3; i += 1) {
    await asAnon(database, () => query(database, `select pf_apply_sale_item_stock($1)`, [tenantB.batchId]));
  }
  const afterReplay = await quantityOf(tenantB.batchId);
  check(
    'replaying the call does not drain stock',
    afterReplay === 500,
    `quantity after 4 attempts: ${afterReplay}`,
  );
}

section('NEGATIVE: an authenticated caller cannot mutate another tenant\'s stock');
{
  // An assistant of branch A attempting branch B's lot. RLS already hides the row
  // from this caller, so the attempt must change nothing.
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  const r = await asAuthenticated(database, () =>
    query(database, `select pf_apply_sale_item_stock($1)`, [tenantB.batchId]),
  );
  const qty = await quantityOf(tenantB.batchId);
  check(
    "an assistant of branch A cannot decrement branch B's lot",
    qty === 500,
    `quantity ${qty} (call ${r.ok ? 'reported success' : `refused: ${r.err}`})`,
  );

  const visible = await asAuthenticated(database, () =>
    query(database, `select id from medicine_batches where id = $1`, [tenantB.batchId]),
  );
  check(
    'and RLS already hides that row from them entirely',
    visible.ok && visible.value.length === 0,
    visible.ok ? `${visible.value.length} rows visible` : visible.err,
  );
}

section('POSITIVE: a genuine authenticated sale still deducts stock');
{
  // Written the way src/lib/supabase/sales.ts writes it: a sales header, then a
  // sale_items row carrying the lot it consumed.
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);

  const headerResult = await asAuthenticated(database, () =>
    query(
      database,
      `insert into sales (branch_id, receipt_number, subtotal, total, attendant_id, payment_method, amount_paid, state)
       values ($1, 'RCP-LEGIT-1', 1000, 1000, $2, 'cash', 1000, 'paid') returning id`,
      [ids.BRANCH_A, ids.ASSISTANT_A],
    ),
  );
  const sale = headerResult.ok ? headerResult.value[0] : undefined;
  check(
    'an authenticated sale header can be written',
    !!sale?.id,
    headerResult.ok ? 'header created' : `refused: ${headerResult.err}`,
  );

  const before = await quantityOf(soon.batchId);
  const lineResult = await asAuthenticated(database, () =>
    query(
      database,
      `insert into sale_items (sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
                              unit_multiplier, unit_price, quantity, base_units_total, line_total,
                              batch_id, cost_per_base_unit_snapshot)
       values ($1, $2, 'Test Drug', 'testgen', 'tablet', 'Tablet', 1, 100, 10, 10, 1000, $3, 50)
       returning id, batch_id`,
      [sale.id, soon.medicineId, soon.batchId],
    ),
  );
  const item = lineResult.ok ? lineResult.value[0] : undefined;
  check(
    'an authenticated sale line carrying its lot can be written',
    !!item?.id && item.batch_id === soon.batchId,
    lineResult.ok
      ? `line ${item.id.slice(0, 8)} on lot ${item.batch_id.slice(0, 8)}`
      : `refused: ${lineResult.err}`,
  );

  const after = await quantityOf(soon.batchId);
  check(
    'the intended quantity was deducted from the intended lot',
    after === before - 10,
    `${before} -> ${after} (10 base units)`,
  );

  const other = await quantityOf(lateBatch.id);
  check('the other lot was left alone', other === 500, `later lot still ${other}`);

  const aggregate = (
    await query(database, `select total_quantity from medicines where id = $1`, [soon.medicineId])
  )[0].total_quantity;
  check(
    'the derived medicine total followed the lot',
    aggregate === 990,
    `total_quantity ${aggregate} (500 + 500 - 10)`,
  );

  const movements = await query(
    database,
    `select kind, quantity_changed, resulting_quantity, performed_by
       from stock_movements where medicine_id = $1 order by created_at`,
    [soon.medicineId],
  );
  const saleMovement = movements.find((m) => m.quantity_changed === -10);
  check(
    'the deduction left an auditable movement',
    !!saleMovement,
    saleMovement
      ? `kind=${saleMovement.kind} change=${saleMovement.quantity_changed} resulting=${saleMovement.resulting_quantity} by=${String(saleMovement.performed_by).slice(0, 8)}`
      : `movements: ${movements.map((m) => `${m.kind}${m.quantity_changed >= 0 ? '+' : ''}${m.quantity_changed}`).join(', ') || 'none'}`,
  );
}

section('NEGATIVE: the depletion trigger refuses a foreign lot even when it can see it');
{
  // Two distinct layers, tested separately.
  //
  //  Layer 1 (pre-existing): `pf_check_sale_item_batch` is SECURITY INVOKER, so
  //  RLS hides a foreign lot and the BEFORE trigger rejects the line outright.
  //  That is what an ordinary caller actually meets.
  //
  //  Layer 2 (added by 0b): the depletion trigger is SECURITY DEFINER, so RLS does
  //  NOT apply to it. If it relied on layer 1 alone it would be one RLS change away
  //  from being the hole it was. This case is written as trusted bootstrap — no
  //  JWT, so layer 1 is not in the way — which isolates layer 2 and proves the
  //  check exists on its own rather than as a passenger.
  await database.query(`select set_actor(null)`);

  const [sale] = await query(
    database,
    `insert into sales (branch_id, receipt_number, subtotal, total, attendant_id, payment_method, amount_paid, state)
     values ($1, 'RCP-ISOLATED', 100, 100, $2, 'cash', 100, 'paid') returning id`,
    [ids.BRANCH_A, ids.ASSISTANT_A],
  );

  const before = await quantityOf(tenantB.batchId);
  let refused = false;
  let err = '';
  try {
    await query(
      database,
      `insert into sale_items (sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
                              unit_multiplier, unit_price, quantity, base_units_total, line_total,
                              batch_id, cost_per_base_unit_snapshot)
       values ($1, $2, 'Test Drug', 'testgen', 'tablet', 'Tablet', 1, 100, 10, 10, 1000, $3, 50)`,
      [sale.id, tenantB.medicineId, tenantB.batchId],
    );
  } catch (e) {
    refused = true;
    err = String(e?.message ?? e).split('\n')[0].slice(0, 140);
  }
  const after = await quantityOf(tenantB.batchId);
  check(
    'the depletion trigger itself refuses a foreign lot, independent of RLS',
    refused && after === before,
    refused
      ? `refused (${err}); foreign lot unchanged at ${after}`
      : `ACCEPTED — a SECURITY DEFINER trigger mutated another tenant's stock (${before} -> ${after})`,
  );
}
{
  // The deduction trigger is SECURITY DEFINER, so it updates batches with RLS out
  // of the way — which means IT is responsible for refusing a foreign lot.
  // batch_id is client-supplied, and the pre-existing batch check only proves the
  // lot matches the line's *medicine*, not its *branch*.
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);

  const [sale] = await query(
    database,
    `insert into sales (branch_id, receipt_number, subtotal, total, attendant_id, payment_method, amount_paid, state)
     values ($1, 'RCP-FOREIGN-LOT', 100, 100, $2, 'cash', 100, 'paid') returning id`,
    [ids.BRANCH_A, ids.ASSISTANT_A],
  );

  // tenantB's medicine and its lot, referenced from branch A's sale.
  const r = await asAuthenticated(database, () =>
    query(
      database,
      `insert into sale_items (sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
                              unit_multiplier, unit_price, quantity, base_units_total, line_total,
                              batch_id, cost_per_base_unit_snapshot)
       values ($1, $2, 'Test Drug', 'testgen', 'tablet', 'Tablet', 1, 100, 10, 10, 1000, $3, 50)
       returning id`,
      [sale.id, tenantB.medicineId, tenantB.batchId],
    ),
  );
  const qty = await quantityOf(tenantB.batchId);
  check(
    "a sale line naming another tenant's lot is refused",
    !r.ok && qty === 500,
    r.ok
      ? `ACCEPTED and the foreign lot became ${qty} — cross-tenant stock mutation`
      : `refused (${r.err}); foreign lot still ${qty}`,
  );
}

section('POSITIVE: stock cannot be driven negative');
{
  const overdrawHeader = await asAuthenticated(database, () =>
    query(
      database,
      `insert into sales (branch_id, receipt_number, subtotal, total, attendant_id, payment_method, amount_paid, state)
       values ($1, 'RCP-OVERDRAW', 999999, 999999, $2, 'cash', 999999, 'paid') returning id`,
      [ids.BRANCH_A, ids.ASSISTANT_A],
    ),
  );
  const sale = overdrawHeader.ok ? overdrawHeader.value[0] : undefined;
  const before = await quantityOf(lateBatch.id);
  const r = await asAuthenticated(database, () =>
    query(
      database,
      `insert into sale_items (sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
                              unit_multiplier, unit_price, quantity, base_units_total, line_total,
                              batch_id, cost_per_base_unit_snapshot)
       values ($1, $2, 'Test Drug', 'testgen', 'tablet', 'Tablet', 1, 100, 99999, 99999, 9999900, $3, 50)
       returning id`,
      [sale.id, soon.medicineId, lateBatch.id],
    ),
  );
  const after = await quantityOf(lateBatch.id);
  check(
    'a sale larger than the lot is refused, not silently clamped',
    !r.ok && after === before,
    r.ok
      ? `the oversized line was ACCEPTED and the lot stayed at ${after} — nothing was deducted, so the sale is untraceable and stock never moved`
      : `refused (${r.err}); lot still ${after}`,
  );

  const negatives = await query(database, `select count(*)::int as n from medicine_batches where quantity < 0`);
  check('no batch anywhere has a negative quantity', negatives[0].n === 0, `${negatives[0].n} negative lots`);
}

note('FEFO allocation is intentionally NOT asserted here — the database has no allocation');
note('function yet. When it is added, this suite is where the ordering rule belongs.');

process.exit(await finish(database));
