/**
 * Tenant isolation and role protection.
 *
 * These assert the properties the audit found ALREADY working, so that Phase 0
 * hardening cannot silently regress them. A hardening change that quietly widens
 * access is the main risk of this work, so the things that were correct are
 * pinned here as regression tests.
 *
 * Rule 4 from harness.mjs applies throughout: a forbidden write is filtered to
 * zero rows by RLS and still reports success, so every destructive check asserts
 * on the stored value afterwards rather than on whether an error was raised.
 */

import {
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedMedicine,
  seedTenants,
} from './harness.mjs';

const { check, section, finish } = createReporter('verify-tenant-isolation');

// Rule 3: one fresh database for the whole suite, seeded once.
const database = await freshDatabase();
const ids = await seedTenants(database);
const own = await seedMedicine(database, { branchId: ids.BRANCH_A });
const other = await seedMedicine(database, { branchId: ids.BRANCH_B });

section('cross-branch reads are refused');
{
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  const r = await asAuthenticated(database, () =>
    query(database, `select id from medicines where branch_id <> pf_current_branch()`),
  );
  check(
    'an assistant reads no medicines from another branch',
    r.ok && r.value.length === 0,
    r.ok ? `${r.value.length} rows` : r.err,
  );

  const batches = await asAuthenticated(database, () =>
    query(database, `select id from medicine_batches where branch_id <> pf_current_branch()`),
  );
  check(
    'an assistant reads no batches from another branch',
    batches.ok && batches.value.length === 0,
    batches.ok ? `${batches.value.length} rows` : batches.err,
  );
}

section('cross-branch writes are refused');
{
  const before = (
    await query(database, `select name from medicines where id = $1`, [other.medicineId])
  )[0].name;

  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  const del = await asAuthenticated(database, () =>
    query(database, `delete from medicines where id = $1`, [other.medicineId]),
  );
  const after = await query(database, `select count(*)::int as n from medicines where id = $1`, [
    other.medicineId,
  ]);
  check(
    'an assistant cannot delete another branch\'s medicine',
    after[0].n === 1,
    `delete ${del.ok ? 'reported success' : `refused (${del.err})`}; row ${after[0].n === 1 ? 'survived' : 'WAS DELETED'}`,
  );

  const rename = await asAuthenticated(database, () =>
    query(database, `update medicines set name = 'hijacked' where id = $1`, [other.medicineId]),
  );
  const name = (await query(database, `select name from medicines where id = $1`, [other.medicineId]))[0]
    .name;
  check(
    'an assistant cannot rename another branch\'s medicine',
    name === before,
    `name is still "${name}" (update ${rename.ok ? 'matched 0 rows' : 'refused'})`,
  );
}

section('stock cannot be moved between branches');
{
  await database.query(`select set_actor($1)`, [ids.OWNER_A]);
  const move = await asAuthenticated(database, () =>
    query(database, `update medicines set branch_id = $1 where id = $2`, [
      ids.BRANCH_B,
      own.medicineId,
    ]),
  );
  const branch = (
    await query(database, `select branch_id from medicines where id = $1`, [own.medicineId])
  )[0].branch_id;
  check(
    'not even an owner can move a medicine to another branch',
    branch === ids.BRANCH_A,
    `branch_id is ${branch === ids.BRANCH_A ? 'unchanged' : 'CHANGED to ' + branch} (update ${move.ok ? 'matched 0 rows' : 'refused'})`,
  );
}

section('cost columns are unreadable by non-owners');
{
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  for (const [table, column] of [
    ['medicines', 'cost_per_base_unit'],
    ['medicine_batches', 'cost_per_base_unit'],
    ['stock_receipts', 'cost_per_base_unit'],
    ['sale_items', 'cost_per_base_unit_snapshot'],
  ]) {
    const r = await asAuthenticated(database, () =>
      query(database, `select ${column} from ${table}`),
    );
    check(
      `an assistant cannot select ${table}.${column}`,
      !r.ok,
      r.ok ? 'READ SUCCEEDED — cost confidentiality is broken' : `refused: ${r.err}`,
    );
  }
}

section('owner-only cost views return nothing to an assistant');
{
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  for (const view of ['pf_medicine_costs', 'pf_batch_costs', 'pf_receipt_costs', 'pf_sale_item_costs']) {
    const r = await asAuthenticated(database, () => query(database, `select * from ${view}`));
    check(
      `${view} returns no rows to an assistant`,
      r.ok && r.value.length === 0,
      r.ok ? `${r.value.length} rows` : r.err,
    );
  }

  await database.query(`select set_actor($1)`, [ids.OWNER_A]);
  const owner = await asAuthenticated(database, () => query(database, `select * from pf_medicine_costs`));
  check(
    'pf_medicine_costs DOES return the owner\'s own branch rows',
    owner.ok && owner.value.length > 0,
    owner.ok ? `${owner.value.length} rows` : owner.err,
  );
}

section('role escalation is refused');
{
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);

  const promote = await asAuthenticated(database, () =>
    query(database, `update profiles set role = 'owner' where id = $1`, [ids.ASSISTANT_A]),
  );
  const role = (await query(database, `select role from profiles where id = $1`, [ids.ASSISTANT_A]))[0]
    .role;
  check(
    'an assistant cannot promote itself to owner',
    role === 'assistant',
    `role is still "${role}" (update ${promote.ok ? 'matched 0 rows' : 'refused'})`,
  );

  const grant = await asAuthenticated(database, () =>
    query(database, `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'owner')`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );
  const member = await query(
    database,
    `select count(*)::int as n from branch_memberships where user_id = $1 and role = 'owner'`,
    [ids.ASSISTANT_A],
  );
  check(
    'an assistant cannot grant itself an owner membership',
    member[0].n === 0,
    `owner memberships held: ${member[0].n} (insert ${grant.ok ? 'reported success' : 'refused'})`,
  );

  const fabricate = await asAuthenticated(database, () =>
    query(
      database,
      `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'assistant')`,
      ['cccccccc-0000-0000-0000-0000000000ff', ids.BRANCH_A],
    ),
  );
  const any = await query(
    database,
    `select count(*)::int as n from branch_memberships where user_id = $1`,
    ['cccccccc-0000-0000-0000-0000000000ff'],
  );
  check(
    'an assistant cannot fabricate a branch membership for anyone',
    any[0].n === 0,
    `rows created: ${any[0].n} (insert ${fabricate.ok ? 'reported success' : 'refused'})`,
  );
}

section('audit actor cannot be forged');
{
  await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);
  const forge = await asAuthenticated(database, () =>
    query(
      database,
      `insert into audit_events (branch_id, actor_id, action, description)
       values ($1, $2, 'sale', 'framed: the owner did this')`,
      [ids.BRANCH_A, ids.OWNER_A],
    ),
  );
  check(
    'an assistant cannot write an audit event attributed to the owner',
    !forge.ok,
    forge.ok ? 'FORGERY ACCEPTED' : `refused: ${forge.err}`,
  );
}

section('sale lines are immutable');
{
  const upd = await query(
    database,
    `select has_column_privilege('authenticated','sale_items','line_total','UPDATE') as can_update`,
  );
  check(
    'no column of sale_items is UPDATE-granted to authenticated',
    upd[0].can_update === false,
    'historical sale snapshots cannot be rewritten',
  );
}

section('derived quantities are not client-writable');
{
  const t = await query(
    database,
    `select has_column_privilege('authenticated','medicines','total_quantity','UPDATE') as can_set`,
  );
  check(
    'medicines.total_quantity cannot be set directly by a client',
    t[0].can_set === false,
    'it is recomputed from live batches by pf_guard_total_quantity',
  );
}

process.exit(await finish(database));
