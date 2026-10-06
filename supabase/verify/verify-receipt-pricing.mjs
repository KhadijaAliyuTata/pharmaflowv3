/**
 * The owner receipt-pricing path.
 *
 * Closes B5, and pins the whole intended flow in both directions:
 *
 *   POSITIVE  receive -> owner prices -> owner approves, every step succeeding.
 *   NEGATIVE  an assistant may receive, but may neither write a cost nor approve.
 *
 * The reason this suite exists in this shape: the defect was not that the rule was
 * missing, it was that the rule's *enforcement* was an accident of privilege
 * evaluation. `pf_require_owner_to_price` was SECURITY INVOKER and referenced a
 * cost column that role cannot read, so the outcome depended on whether
 * PostgreSQL evaluated that reference on a given statement:
 *
 *     OWNER     set cost + price  -> REFUSED   (the owner could not price)
 *     ASSISTANT set cost          -> ACCEPTED  (an attendant wrote a cost)
 *
 * Both wrong, in opposite directions. Asserting only "an assistant is refused"
 * would have passed against the original code, because the owner's path was broken
 * too and that is what the positive half is here to catch.
 */

import {
  SINGLE_UNIT_UNITS,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, section, note, finish } = createReporter('verify-receipt-pricing');

const database = await freshDatabase();
const ids = await seedTenants(database);

// `query` returns the rows array, so this destructures the row; the id needs
// picking out explicitly or every receipt insert below carries "[object Object]".
const [medRow] = await query(
  database,
  `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
   values ($1, 'Priced Drug', 'pricedgen', $2::jsonb, 50, 100, current_date + 365) returning id`,
  [ids.BRANCH_A, SINGLE_UNIT_UNITS],
);
const med = medRow.id;

/** Run as `actorId`, returning the harness wrapper. Never throws. */
async function as(actorId, fn) {
  await database.query(`select set_actor($1)`, [actorId]);
  return asAuthenticated(database, fn);
}

/**
 * Insert a pending receipt. Returns `{ id }` or `{ error }` — never null, so a
 * refusal is reportable instead of becoming an undefined-property crash several
 * checks later.
 */
async function insertReceipt(receiptNumber, actorId) {
  const r = await as(actorId, () =>
    query(
      database,
      `insert into stock_receipts (branch_id, receipt_number, medicine_id, batch_number, base_units_received, expiry_date, received_by, state)
       values ($1, $2, $3, 'BATCH-R', 100, current_date + 300, $4, 'pending_pricing') returning id`,
      [ids.BRANCH_A, receiptNumber, med, actorId],
    ),
  );
  return r.ok ? { id: r.value[0].id } : { error: r.err };
}

section('POSITIVE: the owner can complete receive -> price -> approve');
{
  const made = await insertReceipt('RCP-OWNER', ids.OWNER_A);
  check('owner receives stock as a pending receipt', !!made.id, made.id ?? `REFUSED: ${made.error}`);

  if (!made.id) {
    note('pricing steps skipped — there is no receipt to price', made.error);
  } else {
    const receipt = made.id;

    // No `returning cost_per_base_unit` here, and that is the whole point.
    //
    // `authenticated` deliberately holds no SELECT on the cost column, so an
    // `UPDATE ... RETURNING cost_per_base_unit` fails with "permission denied for
    // table stock_receipts" even when the write itself is permitted. An earlier
    // draft of this suite used RETURNING and so reported the owner being unable to
    // price — a defect that did not exist. Costs are read back through
    // `pf_receipt_costs`, and the write is verified below as the server role.
    const priced = await as(ids.OWNER_A, () =>
      query(
        database,
        `update stock_receipts set cost_per_base_unit = 55, price_per_base_unit = 120 where id = $1`,
        [receipt],
      ),
    );
    check(
      'owner sets the purchase cost and selling price',
      priced.ok,
      priced.ok ? 'both columns written' : `REFUSED: ${priced.err}`,
    );

    const confirmed = await as(ids.OWNER_A, () =>
      query(
        database,
        `update stock_receipts set state = 'confirmed', priced_by = $1, priced_at = now()
         where id = $2`,
        [ids.OWNER_A, receipt],
      ),
    );
    check('owner approves the pricing', confirmed.ok, confirmed.ok ? 'accepted' : `REFUSED: ${confirmed.err}`);

    const stored = await query(
      database,
      `select cost_per_base_unit, price_per_base_unit, state, priced_by from stock_receipts where id = $1`,
      [receipt],
    );
    check(
      'the cost, price and approval are all persisted together',
      Number(stored[0].cost_per_base_unit) === 55 &&
        Number(stored[0].price_per_base_unit) === 120 &&
        stored[0].state === 'confirmed' &&
        stored[0].priced_by === ids.OWNER_A,
      `cost=${stored[0].cost_per_base_unit} price=${stored[0].price_per_base_unit} ` +
        `state=${stored[0].state} priced_by=${String(stored[0].priced_by).slice(0, 8)}`,
    );
  }
}

section('NEGATIVE: an assistant may receive, but may not price or approve');
{
  const made = await insertReceipt('RCP-STAFF', ids.ASSISTANT_A);
  check('assistant can still receive stock', !!made.id, made.id ?? `REFUSED: ${made.error}`);

  if (!made.id) {
    note('pricing attempts skipped — there is no receipt to write against', made.error);
  } else {
    const receipt = made.id;

    const costAttempt = await as(ids.ASSISTANT_A, () =>
      query(database, `update stock_receipts set cost_per_base_unit = 1 where id = $1`, [receipt]),
    );
    const costNow = await query(database, `select cost_per_base_unit from stock_receipts where id = $1`, [
      receipt,
    ]);
    check(
      'assistant cannot write a purchase cost',
      !costAttempt.ok && costNow[0].cost_per_base_unit === null,
      costAttempt.ok
        ? `ACCEPTED — cost is now ${costNow[0].cost_per_base_unit}`
        : `refused (${costAttempt.err}); cost still ${costNow[0].cost_per_base_unit}`,
    );

    const confirmAttempt = await as(ids.ASSISTANT_A, () =>
      query(database, `update stock_receipts set state = 'confirmed' where id = $1`, [receipt]),
    );
    const stateNow = await query(database, `select state from stock_receipts where id = $1`, [receipt]);
    check(
      'assistant cannot approve pricing',
      !confirmAttempt.ok && stateNow[0].state === 'pending_pricing',
      confirmAttempt.ok
        ? `ACCEPTED — state is ${stateNow[0].state}`
        : `refused (${confirmAttempt.err}); state still ${stateNow[0].state}`,
    );

    // One combined statement must not be a way around the two checks above.
    const combined = await as(ids.ASSISTANT_A, () =>
      query(
        database,
        `update stock_receipts set cost_per_base_unit = 1, price_per_base_unit = 999, state = 'confirmed'
         where id = $1`,
        [receipt],
      ),
    );
    const after = await query(
      database,
      `select cost_per_base_unit, price_per_base_unit, state from stock_receipts where id = $1`,
      [receipt],
    );
    check(
      'a single combined statement cannot smuggle cost and approval past the guard',
      !combined.ok && after[0].cost_per_base_unit === null && after[0].state === 'pending_pricing',
      combined.ok
        ? `ACCEPTED — cost=${after[0].cost_per_base_unit} price=${after[0].price_per_base_unit} state=${after[0].state}`
        : `refused (${combined.err}); cost=${after[0].cost_per_base_unit} state=${after[0].state}`,
    );

    // An INSERT carrying a cost must be refused too, not only the UPDATE path.
    const insertWithCost = await as(ids.ASSISTANT_A, () =>
      query(
        database,
        `insert into stock_receipts (branch_id, receipt_number, medicine_id, batch_number, base_units_received, expiry_date, received_by, state, cost_per_base_unit)
         values ($1, 'RCP-STAFF-COST', $2, 'BATCH-C', 100, current_date + 300, $3, 'pending_pricing', 5)`,
        [ids.BRANCH_A, med, ids.ASSISTANT_A],
      ),
    );
    const insertRows = await query(
      database,
      `select count(*)::int as n from stock_receipts where receipt_number = 'RCP-STAFF-COST'`,
    );
    check(
      'an INSERT naming a cost is refused as well',
      !insertWithCost.ok && insertRows[0].n === 0,
      insertWithCost.ok
        ? `ACCEPTED — ${insertRows[0].n} row(s) written`
        : `refused (${insertWithCost.err}); rows: ${insertRows[0].n}`,
    );
  }
}

section('cost on a receipt stays un-readable to an assistant');
{
  const direct = await as(ids.ASSISTANT_A, () =>
    query(database, `select cost_per_base_unit from stock_receipts`),
  );
  check(
    'assistant cannot select a receipt cost column directly',
    !direct.ok,
    direct.ok ? 'READ SUCCEEDED — cost confidentiality is broken' : `refused: ${direct.err}`,
  );

  const view = await as(ids.ASSISTANT_A, () => query(database, `select * from pf_receipt_costs`));
  check(
    'pf_receipt_costs returns no rows to an assistant',
    view.ok && view.value.length === 0,
    view.ok ? `${view.value.length} rows` : view.err,
  );

  const ownerView = await as(ids.OWNER_A, () => query(database, `select * from pf_receipt_costs`));
  check(
    'and it does return the rows belonging to the owner',
    ownerView.ok && ownerView.value.length > 0,
    ownerView.ok ? `${ownerView.value.length} rows` : ownerView.err,
  );
}

section('the guard is enforced by the rule, not by a privilege accident');
{
  // Regression guard for the original defect. If the trigger ever reverts to
  // SECURITY INVOKER the owner path breaks again — and an assertion that only
  // checked "the assistant is refused" would keep passing, because on the original
  // code that refusal came from a privilege error rather than from the rule.
  const [definer] = await query(
    database,
    `select prosecdef from pg_proc where proname = 'pf_require_owner_to_price'`,
  );
  check(
    'pf_require_owner_to_price is SECURITY DEFINER',
    definer.prosecdef === true,
    `prosecdef=${definer.prosecdef}`,
  );

  const made = await insertReceipt('RCP-REGRESS', ids.OWNER_A);
  const stillWorks = made.id
    ? (await as(ids.OWNER_A, () =>
        query(database, `update stock_receipts set cost_per_base_unit = 60 where id = $1`, [made.id]),
      )).ok
    : false;
  check(
    'and the owner can still write a cost afterwards — the regression this suite exists for',
    stillWorks,
    stillWorks ? 'owner pricing works' : `owner pricing is broken again: ${made.error ?? 'update refused'}`,
  );
}

note('a confirmed receipt still does not create a medicine_batches row');
note('that handoff has no database mechanism yet; it is Phase 2 work, not a 0e gap');

process.exit(await finish(database));
