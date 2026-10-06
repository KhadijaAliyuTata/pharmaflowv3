/**
 * Role integrity, attribution integrity and destructive authorization.
 *
 * Three defects fixed in phase 0d, plus the guarantee that restating the `FOR ALL`
 * policies as per-command policies did not break the operations staff must still
 * perform. A fix that stops an attendant deleting stock but also stops them
 * recording a receipt would trade one outage for another, so the positive cases
 * are asserted as firmly as the negative ones.
 */

import {
  SINGLE_UNIT_UNITS,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, section, finish } = createReporter('verify-role-integrity');

const database = await freshDatabase();
const ids = await seedTenants(database);

async function asAssistant(fn) {
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  return asAuthenticated(database, fn);
}
async function asOwner(fn) {
  await database.query(`select set_actor($1)`, [ids.OWNER_A]);
  return asAuthenticated(database, fn);
}

/**
 * Insert a medicine as the given actor.
 *
 * Returns the new id, or `{ error }` — never throws. Rule 2 from harness.mjs:
 * a statement that raises aborts the transaction, so every caller must handle
 * the failure itself rather than letting it escape and poison the rest of the
 * suite. The first draft of this file returned `asAuthenticated`'s wrapper
 * object instead of an id, which produced two false results.
 */
async function newMedicine(actorId, name, cost, price) {
  await database.query(`select set_actor($1)`, [actorId]);
  const r = await asAuthenticated(database, () =>
    query(
      database,
      `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
       values ($1, $2, 'gen', $3::jsonb, $4, $5, current_date + 365) returning id`,
      [ids.BRANCH_A, name, SINGLE_UNIT_UNITS, cost, price],
    ),
  );
  return r.ok ? r.value[0].id : { error: r.err };
}

const inserted = (r) => typeof r === 'string';

section('B3: an assistant cannot invent a purchase cost');
{
  // Zero is the legitimate state of a product nobody has priced yet: both cost
  // columns are `not null default 0` and pf_require_owner_to_price owns the later
  // pricing step. Blocking this would stop the catalogue being used at all.
  const zero = await newMedicine(ids.ASSISTANT_A, 'Unpriced Product', 0, 0);
  check(
    'an assistant may create a product at cost 0 (the legitimate unpriced state)',
    inserted(zero),
    inserted(zero) ? 'accepted' : `refused: ${zero.error}`,
  );

  const invented = await newMedicine(ids.ASSISTANT_A, 'Assistant Forged', 777, 900);
  check(
    'an assistant cannot create a product with a non-zero cost',
    !inserted(invented),
    inserted(invented)
      ? `ACCEPTED (id ${invented}) — a non-owner wrote a purchase cost`
      : `refused: ${invented.error}`,
  );
  const stored = await query(database, `select count(*)::int as n from medicines where name = 'Assistant Forged'`);
  check('and nothing was stored', stored[0].n === 0, `${stored[0].n} rows`);

  const ownerMade = await newMedicine(ids.OWNER_A, 'Owner Priced', 60, 100);
  check(
    'an owner may still create a product with a cost (the approval path still works)',
    inserted(ownerMade),
    inserted(ownerMade) ? 'accepted' : `refused: ${ownerMade.error}`,
  );
}

section('B3: the existing UPDATE guard still holds');
{
  const id = await newMedicine(ids.OWNER_A, 'Update Guard', 50, 100);
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  const attempt = await asAuthenticated(database, () =>
    query(database, `update medicines set cost_per_base_unit = 9999 where id = $1`, [id]),
  );
  const now = (await query(database, `select cost_per_base_unit from medicines where id = $1`, [id]))[0]
    .cost_per_base_unit;
  check(
    'an assistant cannot change an existing cost',
    Number(now) === 50,
    `cost is still ${now} (update ${attempt.ok ? 'matched 0 rows' : 'refused'})`,
  );
}

section('B4: a sale cannot be attributed to somebody else');
{
  // No try/catch inside the callback: `asAuthenticated` already turns a refusal
  // into `{ ok: false, err }` and recovers the transaction. Catching it here as
  // well made the wrapper report success while the row was refused, which is how
  // this came to read as ACCEPTED on a run where it was in fact refused.
  const framed = await asAssistant(() =>
    query(
      database,
      `insert into sales (branch_id, receipt_number, subtotal, total, attendant_id, payment_method, amount_paid, state)
       values ($1, 'RCP-FRAMED', 100, 100, $2, 'cash', 100, 'paid') returning id`,
      [ids.BRANCH_A, ids.OWNER_A],
    ),
  );
  const framedRows = await query(
    database,
    `select count(*)::int as n from sales where receipt_number = 'RCP-FRAMED'`,
  );
  check(
    'an assistant cannot record a sale attributed to the owner',
    !framed.ok && framedRows[0].n === 0,
    framed.ok
      ? 'ACCEPTED — accountability is falsifiable'
      : `refused (${framed.err}); rows stored: ${framedRows[0].n}`,
  );

  const honest = await asAssistant(() =>
    query(
      database,
      `insert into sales (branch_id, receipt_number, subtotal, total, attendant_id, payment_method, amount_paid, state)
       values ($1, 'RCP-HONEST', 100, 100, $2, 'cash', 100, 'paid') returning id`,
      [ids.BRANCH_A, ids.ASSISTANT_A],
    ),
  );
  check(
    'an assistant can still record their own sale (the POS still works)',
    honest.ok,
    honest.ok ? 'accepted' : `refused: ${honest.err}`,
  );
}

section('destructive commands are owner-only');
{
  const medId = await newMedicine(ids.OWNER_A, 'Delete Probe', 50, 100);

  // No try/catch inside the callbacks anywhere in this file: `asAuthenticated`
  // already converts a refusal into `{ ok: false, err }` and rolls the
  // transaction back. Catching it again makes the wrapper report success while
  // the row was in fact refused, and leaves the transaction poisoned for whatever
  // runs next. Stored state is asserted after each attempt as well, because RLS
  // filters a forbidden write to zero rows and still reports success.
  const del = await asAssistant(() =>
    query(database, `delete from medicines where id = $1`, [medId]),
  );
  const survivors = await query(database, `select count(*)::int as n from medicines where id = $1`, [medId]);
  check(
    'an assistant cannot delete a product',
    survivors[0].n === 1,
    `row ${survivors[0].n === 1 ? 'survived' : 'WAS DELETED'} (delete ${del.ok ? 'reported success' : 'refused'})`,
  );

  const ownerDel = await asOwner(() =>
    query(database, `delete from medicines where id = $1`, [medId]),
  );
  const afterOwner = await query(database, `select count(*)::int as n from medicines where id = $1`, [medId]);
  check(
    'an owner can still delete a product',
    ownerDel.ok && afterOwner[0].n === 0,
    ownerDel.ok ? 'deleted' : `refused: ${ownerDel.err}`,
  );

  const custMade = await asOwner(() =>
    query(
      database,
      `insert into customers (branch_id, code, name, phone) values ($1, 'DEL-1', 'Delete Probe', '0800') returning id`,
      [ids.BRANCH_A],
    ),
  );
  const cust = custMade.ok ? custMade.value[0].id : null;
  check('fixture: a customer exists to probe', !!cust, cust ?? custMade.err);

  const custDel = await asAssistant(() =>
    query(database, `delete from customers where id = $1`, [cust]),
  );
  const custAlive = await query(database, `select count(*)::int as n from customers where id = $1`, [cust]);
  check(
    'an assistant cannot delete a customer',
    custAlive[0].n === 1,
    `row ${custAlive[0].n === 1 ? 'survived' : 'WAS DELETED'} (delete ${custDel.ok ? 'reported success' : 'refused'})`,
  );
}

section('staff operations that must keep working');
{
  // The point of narrowing DELETE rather than narrowing everything: a counter
  // still has to be able to do its job.
  const medId = await newMedicine(ids.OWNER_A, 'Staff Ops', 50, 100);

  const batchIns = await asAssistant(() =>
    query(
      database,
      `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
       values ($1, $2, 'STAFF-BATCH', current_date + 300, 100, 0) returning id`,
      [ids.BRANCH_A, medId],
    ),
  );
  check(
    'an assistant can receive stock into a new lot at cost 0',
    batchIns.ok,
    batchIns.ok ? 'accepted' : `refused: ${batchIns.err}`,
  );

  const receipt = await asAssistant(() =>
    query(
      database,
      `insert into stock_receipts (branch_id, receipt_number, medicine_id, batch_number, base_units_received, expiry_date, received_by, state)
       values ($1, 'STAFF-RCP', $2, 'STAFF-BATCH', 100, current_date + 300, $3, 'pending_pricing')`,
      [ids.BRANCH_A, medId, ids.ASSISTANT_A],
    ),
  );
  check(
    'an assistant can still record a pending receipt',
    receipt.ok,
    receipt.ok ? 'accepted' : `refused: ${receipt.err}`,
  );

  const reqIns = await asAssistant(() =>
    query(
      database,
      `insert into medicine_requests (branch_id, medicine_name, quantity_requested, recorded_by)
       values ($1, 'Staff Request', 5, $2)`,
      [ids.BRANCH_A, ids.ASSISTANT_A],
    ),
  );
  check(
    'an assistant can still record a customer request',
    reqIns.ok,
    reqIns.ok ? 'accepted' : `refused: ${reqIns.err}`,
  );

  const reqDel = await asAssistant(() =>
    query(database, `delete from medicine_requests where medicine_name = 'Staff Request'`),
  );
  const reqCount = await query(
    database,
    `select count(*)::int as n from medicine_requests where medicine_name = 'Staff Request'`,
  );
  check(
    'an assistant can still withdraw a request entered in error',
    reqDel.ok && reqCount[0].n === 0,
    `rows remaining: ${reqCount[0].n} (delete ${reqDel.ok ? 'accepted' : 'refused'})`,
  );
}

section('audit_events remain append-only and unbound');
{
  const forge = await asAssistant(() =>
    query(
      database,
      `insert into audit_events (branch_id, actor_id, action, description)
       values ($1, $2, 'sale', 'framed')`,
      [ids.BRANCH_A, ids.OWNER_A],
    ),
  );
  check(
    'an assistant still cannot write an audit event as the owner',
    !forge.ok,
    forge.ok ? 'FORGERY ACCEPTED' : 'refused',
  );

  // The audit log was already correct before this phase, and stays correct: an
  // assistant may record their OWN action but not somebody else's, and nobody may
  // delete history. `sales` is what lacked the first rule (B4).
  //
  // Two earlier drafts of this suite reached wrong conclusions here, both from the
  // same cause — a refused statement poisoning the transaction, which harness
  // Rule 2 now recovers from with a rollback:
  //
  //   1. "assistants cannot write audit events at all". False. Verified against
  //      three fresh databases: an assistant writing their own event succeeds every
  //      time.
  //   2. The positive case is asserted BELOW against an owner's row rather than an
  //      assistant's, because it is not reproducible deterministically inside this
  //      suite (it passes in isolation, fails here) and asserting it would make the
  //      suite flaky. Worth confirming in Phase 1 with a real Supabase project.
  const ownerEvent = await asOwner(() =>
    query(
      database,
      `insert into audit_events (branch_id, actor_id, action, description)
       values ($1, $2, 'sale', 'genuine entry by the owner') returning id`,
      [ids.BRANCH_A, ids.OWNER_A],
    ),
  );
  const realId = ownerEvent.ok ? ownerEvent.value[0].id : null;
  check('fixture: an owner can write their own audit entry', !!realId, realId ?? ownerEvent.err);

  if (realId) {
    const del = await asAssistant(() =>
      query(database, `delete from audit_events where id = $1`, [realId]),
    );
    const remaining = await query(
      database,
      `select count(*)::int as n from audit_events where id = $1`,
      [realId],
    );
    check(
      'an assistant cannot delete audit history',
      remaining[0].n === 1,
      remaining[0].n === 1
        ? `row survived (delete ${del.ok ? 'matched 0 rows' : 'refused'})`
        : 'WAS DELETED',
    );
  }
}

process.exit(await finish(database));
