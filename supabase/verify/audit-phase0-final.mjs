/**
 * Final Phase 0 security audit.
 *
 * One pass over the live schema, the migration chain and the built artefact, so the
 * answer to "is Phase 0 secure" comes from observed behaviour rather than from
 * reading the source and concluding it looks right.
 *
 * Not a gate member: this is a report, and it re-derives conclusions the individual
 * suites already reach. It exists so the audit is one readable transcript.
 */

import {
  SINGLE_UNIT_UNITS,
  applyMigrationTo,
  asAuthenticated,
  createReporter,
  freshDatabase,
  migrationFiles,
  query,
  seedTenants,
} from './harness.mjs';
import { asActor, currentActor } from './harness.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const { check, section, note, finish } = createReporter('phase0-final-audit');

const REPO = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3';
const DIST = `${REPO}/dist`;

const as = (db, actorId, fn) => asActor(db, actorId, () => asAuthenticated(db, fn));

/**
 * Run a statement as the database owner, with the JWT actor cleared.
 *
 * Delegates to `asActor`, which RESTORES the previous actor on the way out. Setting the
 * actor and leaving it set is what made this audit produce a false failure: a fixture
 * insert written straight after an `as()` call ran as that user rather than as the
 * owner, and the cost guard refused it with "Only an owner can set a purchase cost" in
 * a context where no owner was involved.
 */
const asServer = (db, fn) => asActor(db, null, fn);

/**
 * A fresh database with the tenants seeded AND the JWT actor cleared.
 *
 * `seedTenants` leaves `request.jwt.claim.sub` set to the last user it touched, and
 * that setting is session-level so it survives into the next statement. Server-role
 * bootstrap inserts made straight after seeding would therefore run as that user
 * rather than as the database owner, which is how a cost-guard trigger fires at a
 * moment when the audit never meant to sign anyone in. Every other suite calls
 * `as()` before it writes, which hid this; an audit that writes fixtures directly
 * has to clear the actor itself.
 */
async function isolate() {
  const db = await freshDatabase();
  const ids = await seedTenants(db);
  await db.query(`select set_actor($1)`, [null]); // null -> empty claim -> auth.uid() is null
  return { db, ids };
}

/**
 * Every JS artefact under `dist/`, by recursive directory walk.
 *
 * NOT Bun.Glob, which is what this file used first: on one build it returned 261 files
 * including the SSR chunk, and on the next identical build 125, silently unable to
 * traverse `dist/server`. Half a scan that reports success is worse than none,
 * because it is believed. readdirSync finds the same 261 every time, and the
 * coverage assertions below fail loudly if it ever does not.
 */
function walkJs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.log('      scan error in ' + dir + ': ' + String(e.message).split('\n')[0].slice(0, 70));
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Absolute path -> path relative to `root`, so callers can re-join with a forward slash. */
function relative(root, full) {
  return full.slice(root.length + 1).replace(/\\\\/g, '/');
}

const stripComments = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ============================================ 1. migrations + fresh database */

section('1. migrations are tracked, ordered, idempotent, and apply to a fresh database');
{
  const { db } = await isolate(); // proves the whole chain applies in order

  const tables = await query(
    db,
    `select count(*)::int as n from pg_tables where schemaname = 'public'`,
  );
  check('the whole chain applies to a fresh database', tables[0].n >= 17, `${tables[0].n} tables`);

  // Re-apply every migration a second time. `applyMigrationTo` is the harness's own
  // helper for this; the first version of this block re-read the files and re-did the
  // pgcrypto substitution inline and blew the stack, because that is not what the
  // proven code path does.
  const files = migrationFiles();
  let reapplied = 0;
  for (const f of files) {
    try {
      await applyMigrationTo(db, f);
      reapplied++;
    } catch (e) {
      check(`re-applying ${f} is a no-op`, false, String(e.message).split('\n')[0].slice(0, 80));
    }
  }
  check(
    'every migration is re-runnable without error',
    reapplied === files.length,
    `${reapplied}/${files.length} files`,
  );

  await db.close();
}

/* ================================== 2. RLS + tenant isolation */

section('2. RLS is enabled everywhere and tenant isolation holds');
{
  const { db, ids } = await isolate();

  const unprotected = await query(
    db,
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (not c.relrowsecurity or c.relforcerowsecurity)`,
  );
  check('no public table has RLS disabled or forced', unprotected.length === 0,
    unprotected.length === 0 ? 'all tables protected' : unprotected.map((t) => t.relname).join(', '));

  const anon = await query(
    db,
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`,
  );
  check('anon holds no privilege on any public table', anon.length === 0,
    anon.length === 0 ? 'none' : anon.map((t) => t.relname).join(', '));

  // Cross-tenant reads, run as the caller.
  await asServer(db, () => query(
    db,
    `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
     values ($1, 'Tenant Probe', 'tp', $2::jsonb, 50, 100, current_date + 365)`,
    [ids.BRANCH_A, SINGLE_UNIT_UNITS],
  ));

  for (const [label, sql, params] of [
    ['medicines', `select count(*)::int as n from medicines`, []],
    ['medicine_batches', `select count(*)::int as n from medicine_batches`, []],
    ['sales', `select count(*)::int as n from sales`, []],
    ['audit_events', `select count(*)::int as n from audit_events`, []],
  ]) {
    const r = await as(db, ids.ASSISTANT_A, () => query(db, sql, params));
    const seen = r.ok ? r.value[0].n : 'err';
    check(
      `2: a branch-A assistant sees only branch A in ${label}`,
      label === 'audit_events' ? seen === 0 : seen <= 1,
      `${seen} row(s) visible`,
    );
  }

  const foreignBranch = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from branches where id = $1`, [ids.BRANCH_B]),
  );
  check(
    '2: a branch-A assistant cannot see branch B at all',
    foreignBranch.ok && foreignBranch.value[0].n === 0,
    `${foreignBranch.ok ? foreignBranch.value[0].n : '?'} rows`,
  );

  await db.close();
}

/* ================================ 3. branch_memberships.role is the authority */

section('3. branch_memberships.role is the sole authorization authority');
{
  const { db, ids } = await isolate();

  const [fn] = await query(db, `select prosrc, prosecdef from pg_proc where proname = 'pf_current_role'`);
  const body = stripComments(fn.prosrc);
  check(
    'pf_current_role() resolves from branch_memberships',
    /from\s+branch_memberships/.test(body) && /auth\.uid\(\)/.test(body),
    body.replace(/\s+/g, ' ').trim(),
  );
  check('pf_current_role() does not read profiles.role', !/from\s+profiles/.test(body),
    'profiles.role is a cache and must not gate anything');
  check('and stays SECURITY DEFINER, which the RLS on that table requires', fn.prosecdef === true,
    `prosecdef=${fn.prosecdef}`);

  // No authorization helper may read profiles.role.
  const readers = await query(
    db,
    `select proname from pg_proc
     where prosrc ~ 'from\\s+profiles' and prosrc ~ '\\brole\\b'
       and proname in ('pf_is_owner','pf_current_role','pf_is_staff','pf_is_customer')`,
  );
  check('no authorization helper reads profiles.role', readers.length === 0,
    readers.length === 0 ? 'none' : readers.map((r) => r.proname).join(', '));

  // The cache cannot grant, and cannot be written back into the authority.
  const grant = await as(db, ids.OWNER_A, () =>
    query(db, `update profiles set role = 'owner' where id = $1`, [ids.ASSISTANT_A]),
  );
  const after = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select pf_is_owner() as o, pf_current_role()::text as r`),
  );
  const mem = await query(db, `select role from branch_memberships where user_id=$1 and branch_id=$2`,
    [ids.ASSISTANT_A, ids.BRANCH_A]);
  check(
    '3: a stale profiles.role=owner grants nothing and rewrites no membership',
    grant.ok && after.value[0].o === false && mem[0].role === 'assistant',
    `profiles.role forced to owner; pf_is_owner=${after.value[0].o}, membership=${mem[0].role}`,
  );

  await db.close();
}

/* ============================== 4. role changes audited and unforgeable */

section('4. role changes are audited, and a client cannot forge the record');
{
  const { db, ids } = await isolate();

  await as(db, ids.OWNER_A, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id=$1 and branch_id=$2`,
      [ids.ASSISTANT_A, ids.BRANCH_A]),
  );
  const ev = await query(
    db,
    `select id, actor_id, action, description, metadata from audit_events where action like 'role.%'`,
  );
  check('4: a promotion writes exactly one role-change event', ev.length === 1, `${ev.length} event(s)`);
  check('4: the actor is the owner who made the change', ev[0]?.actor_id === ids.OWNER_A,
    `actor_id=${String(ev[0]?.actor_id).slice(0, 8)}`);
  check('4: previous and new role are both recorded',
    ev[0]?.metadata?.previous_role === 'assistant' && ev[0]?.metadata?.new_role === 'owner',
    `${ev[0]?.metadata?.previous_role} -> ${ev[0]?.metadata?.new_role}`);

  const forged = [];
  for (const action of ['role.promoted', 'role.demoted', 'role.changed']) {
    for (const who of [ids.ASSISTANT_A, ids.OWNER_A]) {
      const r = await as(db, who, () =>
        query(db, `insert into audit_events (branch_id, actor_id, action, description) values ($1,$2,$3,'forged')`,
          [ids.BRANCH_A, who, action]),
      );
      if (r.ok) forged.push(`${action} by ${String(who).slice(0, 8)}`);
    }
  }
  check('4: neither staff nor owner can hand-write a role-change event', forged.length === 0,
    forged.length === 0 ? 'all six attempts refused' : forged.join(', '));

  const still = await query(db, `select count(*)::int as n from audit_events where description = 'forged'`);
  check('4: and nothing forged reached the log', still[0].n === 0, `${still[0].n} rows`);

  // Removal is audited too.
  await as(db, ids.OWNER_A, () =>
    query(db, `delete from branch_memberships where user_id=$1 and branch_id=$2`,
      [ids.ASSISTANT_A, ids.BRANCH_A]),
  );
  const removed = await query(db, `select action from audit_events where action = 'role.membership_removed'`);
  check('4: removing a membership is audited', removed.length === 1, `${removed.length} event(s)`);

  // Immutability.
  const target = ev[0];
  const upd = await as(db, ids.OWNER_A, () =>
    query(db, `update audit_events set description='tampered' where id=$1`, [target.id]));
  const del = await as(db, ids.OWNER_A, () =>
    query(db, `delete from audit_events where id=$1`, [target.id]));
  const alive = await query(db, `select description from audit_events where id=$1`, [target.id]);
  check('4: audit history cannot be updated or deleted, even by an owner',
    alive.length === 1 && alive[0].description === target.description &&
      upd.ok === del.ok,
    `row intact (update ${upd.ok ? 'reported success' : 'refused'}, delete ${del.ok ? 'reported success' : 'refused'})`);

  await db.close();
}

/* ===================================== 5. anon / PUBLIC function execution */

section('5. no anon or PUBLIC execute remains on pf_* functions');
{
  const { db } = await isolate();

  const anonReachable = await query(
    db,
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'pf\\_%'
       and has_function_privilege('anon', p.oid, 'EXECUTE')`,
  );
  check('5: anon can execute no pf_* function', anonReachable.length === 0,
    anonReachable.length === 0 ? 'none reachable' : anonReachable.map((f) => f.proname).join(', '));

  const publicDefault = await query(
    db,
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'pf\\_%'
       and has_function_privilege('public', p.oid, 'EXECUTE')`,
  );
  check('5: the default PUBLIC grant is revoked on every pf_* function', publicDefault.length === 0,
    publicDefault.length === 0 ? 'all revoked' : publicDefault.map((f) => f.proname).join(', '));

  const authGranted = await query(
    db,
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and p.proname like 'pf\\_%' order by 1`,
  );
  const names = authGranted.map((f) => f.proname).sort();
  const expected = ['pf_current_branch','pf_current_role','pf_is_customer','pf_is_owner','pf_is_staff','pf_set_active_branch'];
  check(
    '5: authenticated retains only the 6 functions the app needs',
    JSON.stringify(names) === JSON.stringify(expected),
    names.join(', '),
  );

  const unpinned = await query(
    db,
    `select proname from pg_proc where prosrc is not null
       and proname like 'pf\\_%' and proconfig is null and prosecdef`,
  );
  check('5: every SECURITY DEFINER pf_* pins its search_path', unpinned.length === 0,
    unpinned.length === 0 ? 'all pinned' : unpinned.map((f) => f.proname).join(', '));

  await db.close();
}

/* ==================== 6 + 7. demo removed, production auth is real Supabase */

section('6/7. demo auth is gone from the build; production auth is Supabase only');
{
  const artefacts = walkJs(DIST).map((p) => relative(DIST, p));
  console.log('      walk found ' + artefacts.length + ' js file(s) under dist/');

  check('a production build was available to inspect', artefacts.length > 0,
    artefacts.length === 0 ? 'dist/ not found' : `${artefacts.length} bundle(s)`);

  if (artefacts.length > 0) {
    const sessionChunks = [];
    for (const rel of artefacts) {
      if (!/session-[^/]*\.js$/.test(rel)) continue;
      const f = Bun.file(`${DIST}/${rel}`);
      if (await f.exists()) sessionChunks.push({ file: rel, text: stripComments(await f.text()) });
    }

    check('both the client and the SSR session bundles were inspected', sessionChunks.length >= 2,
      sessionChunks.map((c) => c.file).join(', '));

    for (const c of sessionChunks) {
      const bound = /DEMO_ALLOWED\s*=\s*([^;\n]+)/.exec(c.text)?.[1]?.trim() ?? null;
      const eliminated = !c.text.includes('DEMO_ALLOWED') && !c.text.includes('usr-owner');
      check(
        `6: the demo auth path cannot be entered from ${c.file}`,
        eliminated || bound === 'false',
        eliminated ? 'eliminated entirely' : bound === null ? 'no gate, no credentials' : `DEMO_ALLOWED = ${bound}`,
      );
    }

    const runtimeGate = sessionChunks.filter((c) => /import\.meta\.env\.DEV|__DEV_SERVER__/.test(c.text));
    check('7: no output resolves the demo gate at runtime', runtimeGate.length === 0,
      runtimeGate.length === 0 ? 'substituted at build time everywhere' : runtimeGate.map((c) => c.file).join(', '));

    // The real sign-in path must still be there, and must call Supabase.
    const hasSupabaseSignIn = sessionChunks.some((c) => c.text.includes('signInWithPassword'));
    check('7: production sign-in goes through Supabase signInWithPassword', hasSupabaseSignIn,
      'the real authentication path is intact');

    const unconfigured = sessionChunks.some((c) => c.text.includes('Sign-in is not configured on this deployment'));
    check('4/7: an unconfigured deployment refuses to sign in', unconfigured,
      'signIn fails closed rather than falling back');
  }

  const config = await Bun.file(`${REPO}/vite.config.ts`).text();
  check('6: the demo gate is derived from the build command, not an env var',
    config.includes('__DEV_SERVER__') && config.includes("command === 'serve'") &&
      !/__DEV_SERVER__[\s\S]{0,80}process\.env/.test(config),
    'JSON.stringify(command === "serve")');
}

/* ============================ 8. owner-only cost and pricing protection */

section('8. cost columns stay owner-only, in every direction');
{
  const { db, ids } = await isolate();

  const costReads = [];
  for (const table of ['medicines', 'medicine_batches', 'stock_receipts', 'sale_items']) {
    const col = table === 'sale_items' ? 'cost_per_base_unit_snapshot' : 'cost_per_base_unit';
    const r = await as(db, ids.ASSISTANT_A, () =>
      query(db, `select ${col} from ${table} limit 1`));
    if (r.ok) costReads.push(table);
  }
  check('8: an assistant cannot SELECT any cost column', costReads.length === 0,
    costReads.length === 0 ? 'all four refused' : `readable: ${costReads.join(', ')}`);

  await asServer(db, () => query(
    db,
    `insert into medicines (branch_id,name,generic_name,units,cost_per_base_unit,price_per_base_unit,expiry_date)
     values ($1,'CostProbe','cp',$2::jsonb,50,100,current_date+365)`,
    [ids.BRANCH_A, SINGLE_UNIT_UNITS],
  ));
  for (const view of ['pf_medicine_costs', 'pf_batch_costs', 'pf_receipt_costs', 'pf_sale_item_costs']) {
    const r = await as(db, ids.ASSISTANT_A, () => query(db, `select count(*)::int as n from ${view}`));
    check(`8: ${view} is empty for an assistant`, r.ok && r.value[0].n === 0,
      r.ok ? `${r.value[0].n} rows` : r.err);
  }
  const ownerView = await as(db, ids.OWNER_A, () =>
    query(db, `select count(*)::int as n from pf_medicine_costs`));
  check('8: and populated for an owner', ownerView.ok && ownerView.value[0].n > 0,
    ownerView.ok ? `${ownerView.value[0].n} row(s)` : ownerView.err);

  // Writes.
  const forgeCost = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into medicines (branch_id,name,generic_name,units,cost_per_base_unit,price_per_base_unit,expiry_date)
               values ($1,'Forged','f',$2::jsonb,777,900,current_date+365)`, [ids.BRANCH_A, SINGLE_UNIT_UNITS]));
  const forged = await query(db, `select count(*)::int as n from medicines where name='Forged'`);
  check('8: an assistant cannot invent a purchase cost', !forgeCost.ok && forged[0].n === 0,
    forgeCost.ok ? 'ACCEPTED' : `refused; ${forged[0].n} rows`);

  await db.close();
}

/* ==================================== 9. attribution cannot be forged */

section('9. an assistant cannot attribute an action to another user');
{
  const { db, ids } = await isolate();

  const sale = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into sales (branch_id,receipt_number,subtotal,total,attendant_id,payment_method,amount_paid,state)
                values ($1,'FRAMED',100,100,$2,'cash',100,'paid')`, [ids.BRANCH_A, ids.OWNER_A]));
  const saleRows = await query(db, `select count(*)::int as n from sales where receipt_number='FRAMED'`);
  check('9: an assistant cannot record a sale attributed to the owner',
    !sale.ok && saleRows[0].n === 0, sale.ok ? 'ACCEPTED' : `refused; ${saleRows[0].n} rows`);

  const audit = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into audit_events (branch_id,actor_id,action,description) values ($1,$2,'sale','framed')`,
      [ids.BRANCH_A, ids.OWNER_A]));
  const auditRows = await query(db, `select count(*)::int as n from audit_events where description='framed'`);
  check('9: an assistant cannot write an audit event as the owner',
    !audit.ok && auditRows[0].n === 0, audit.ok ? 'ACCEPTED' : `refused; ${auditRows[0].n} rows`);

  const own = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into audit_events (branch_id,actor_id,action,description) values ($1,$2,'sale','own')`,
      [ids.BRANCH_A, ids.ASSISTANT_A]));
  check('9: but an assistant may still record their OWN action', own.ok,
    own.ok ? 'accepted, as Phase 0 intends' : `refused: ${own.err.slice(0, 45)}`);

  await db.close();
}

/* ================================= 10. owner-only destructive operations */

section('10. an assistant cannot perform owner-only destructive operations');
{
  const { db, ids } = await isolate();
  const UNITS = SINGLE_UNIT_UNITS;

  const make = async (name) => {
    const r = await as(db, ids.OWNER_A, () =>
      query(db, `insert into medicines (branch_id,name,generic_name,units,cost_per_base_unit,price_per_base_unit,expiry_date)
                 values ($1,$2,'d',$3::jsonb,50,100,current_date+365) returning id`,
        [ids.BRANCH_A, name, UNITS]));
    return r.value[0].id;
  };

  const medId = await make('Destructive Probe');
  const del = await as(db, ids.ASSISTANT_A, () => query(db, `delete from medicines where id=$1`, [medId]));
  const left = await query(db, `select count(*)::int as n from medicines where id=$1`, [medId]);
  check('10: an assistant cannot delete a product', left[0].n === 1,
    `${left[0].n} row(s) left (delete ${del.ok ? 'reported success' : 'refused'})`);

  const cust = await as(db, ids.OWNER_A, () =>
    query(db, `insert into customers (branch_id,code,name,phone) values ($1,'D1','Probe','0800') returning id`,
      [ids.BRANCH_A]));
  const cdel = await as(db, ids.ASSISTANT_A, () =>
    query(db, `delete from customers where id=$1`, [cust.value[0].id]));
  const cleft = await query(db, `select count(*)::int as n from customers where id=$1`, [cust.value[0].id]);
  check('10: an assistant cannot delete a customer', cleft[0].n === 1,
    `${cleft[0].n} row(s) left (delete ${cdel.ok ? 'reported success' : 'refused'})`);

  const batch = await as(db, ids.OWNER_A, () =>
    query(db, `insert into medicine_batches (branch_id,medicine_id,batch_number,expiry_date,quantity,cost_per_base_unit)
               values ($1,$2,'DB',current_date+300,50,50) returning id`, [ids.BRANCH_A, medId]));
  const bdel = await as(db, ids.ASSISTANT_A, () =>
    query(db, `delete from medicine_batches where id=$1`, [batch.value[0].id]));
  const bleft = await query(db, `select count(*)::int as n from medicine_batches where id=$1`, [batch.value[0].id]);
  check('10: an assistant cannot delete a stock lot', bleft[0].n === 1,
    `${bleft[0].n} row(s) left (delete ${bdel.ok ? 'reported success' : 'refused'})`);

  const auditRow = await as(db, ids.OWNER_A, () =>
    query(db, `insert into audit_events (branch_id,actor_id,action,description) values ($1,$2,'sale','x') returning id`,
      [ids.BRANCH_A, ids.OWNER_A]));
  const adel = await as(db, ids.ASSISTANT_A, () =>
    query(db, `delete from audit_events where id=$1`, [auditRow.value[0].id]));
  const aleft = await query(db, `select count(*)::int as n from audit_events where id=$1`, [auditRow.value[0].id]);
  check('10: an assistant cannot delete audit history', aleft[0].n === 1,
    `${aleft[0].n} row(s) left (delete ${adel.ok ? 'reported success' : 'refused'})`);

  // Staff operations must still work.
  const recv = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into stock_receipts (branch_id,receipt_number,medicine_id,batch_number,base_units_received,expiry_date,received_by,state)
               values ($1,'S1',$2,'SB',100,current_date+300,$3,'pending_pricing')`,
      [ids.BRANCH_A, medId, ids.ASSISTANT_A]));
  check('10: but an assistant can still record a pending receipt', recv.ok,
    recv.ok ? 'accepted' : `refused: ${recv.err.slice(0, 45)}`);

  await db.close();
}

/* ============================ 11. stock deduction unreachable as an RPC */

section('11. sale stock deduction cannot be invoked as an RPC');
{
  const { db, ids } = await isolate();

  const med = (await query(db, `insert into medicines (branch_id,name,generic_name,units,cost_per_base_unit,price_per_base_unit,expiry_date)
    values ($1,'Stock','s',$2::jsonb,50,100,current_date+365) returning id`, [ids.BRANCH_A, SINGLE_UNIT_UNITS]))[0].id;
  const lot = (await query(db, `insert into medicine_batches (branch_id,medicine_id,batch_number,expiry_date,quantity,cost_per_base_unit)
    values ($1,$2,'L1',current_date+300,500,50) returning id`, [ids.BRANCH_A, med]))[0].id;

  const calls = [
    ['assistant: select pf_apply_sale_item_stock()', ids.ASSISTANT_A, `select pf_apply_sale_item_stock()`],
    ['owner:    select pf_apply_sale_item_stock()', ids.OWNER_A, `select pf_apply_sale_item_stock()`],
    ['owner:    execute pf_apply_sale_item_stock()', ids.OWNER_A, `execute pf_apply_sale_item_stock()`],
  ];
  for (const [label, who, sql] of calls) {
    const r = await as(db, who, () => query(db, sql));
    check(`11: ${label} is refused`, !r.ok, r.ok ? 'EXECUTED' : r.err.slice(0, 55));
  }

  const after = await query(db, `select quantity from medicine_batches where id=$1`, [lot]);
  check('11: stock is unchanged by the attempts', Number(after[0].quantity) === 500,
    `quantity ${after[0].quantity}`);

  // The legitimate sale must still deduct, or the closure would be a regression.
  const sale = (await query(db, `insert into sales (branch_id,receipt_number,subtotal,total,attendant_id,payment_method,amount_paid,state)
    values ($1,'OK',1000,1000,$2,'cash',1000,'paid') returning id`, [ids.BRANCH_A, ids.ASSISTANT_A]))[0].id;
  await asServer(db, () => query(db, `insert into sale_items (sale_id,medicine_id,medicine_name,generic_name,unit_key,unit_name,
    unit_multiplier,unit_price,quantity,base_units_total,line_total,batch_id,cost_per_base_unit_snapshot)
    values ($1,$2,'Stock','s','tablet','Tablet',1,100,10,10,1000,$3,50)`, [sale, med, lot]));
  const after2 = await query(db, `select quantity from medicine_batches where id=$1`, [lot]);
  const mv = await query(db, `select kind, quantity_changed from stock_movements where batch_id = $1
    order by created_at desc limit 1`, [lot]);
  check('11: a legitimate sale still deducts stock', Number(after2[0].quantity) === 490,
    `500 -> ${after2[0].quantity}, movement ${mv[0]?.kind} ${mv[0]?.quantity_changed}`);

  const trig = await query(db, `select count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relname='sale_items' and not t.tgisinternal and t.tgname='sale_items_deplete_stock'`);
  check('11: the deduction exists only as a trigger', trig[0].n === 1, `${trig[0].n} attachment(s)`);

  await db.close();
}

/* ============================= 12. receipt and pricing authorization */

section('12. receipt receive / price / approve authorization is correct');
{
  const { db, ids } = await isolate();

  const med = (await query(db, `insert into medicines (branch_id,name,generic_name,units,cost_per_base_unit,price_per_base_unit,expiry_date)
    values ($1,'Priced','p',$2::jsonb,50,100,current_date+365) returning id`, [ids.BRANCH_A, SINGLE_UNIT_UNITS]))[0].id;

  const receipt = async (num, who) => {
    const r = await as(db, who, () =>
      query(db, `insert into stock_receipts (branch_id,receipt_number,medicine_id,batch_number,base_units_received,expiry_date,received_by,state)
                 values ($1,$2,$3,'B',100,current_date+300,$4,'pending_pricing') returning id`,
        [ids.BRANCH_A, num, med, who]));
    return r.ok ? r.value[0].id : null;
  };

  const ownerReceipt = await receipt('OWNER-R', ids.OWNER_A);
  check('12: an owner can record a pending receipt', !!ownerReceipt, ownerReceipt ?? 'refused');

  const price = await as(db, ids.OWNER_A, () =>
    query(db, `update stock_receipts set cost_per_base_unit=55, price_per_base_unit=120 where id=$1`, [ownerReceipt]));
  check('12: an owner can price it', price.ok, price.ok ? 'accepted' : `refused: ${price.err.slice(0, 45)}`);

  const confirm = await as(db, ids.OWNER_A, () =>
    query(db, `update stock_receipts set state='confirmed', priced_by=$1, priced_at=now() where id=$2`,
      [ids.OWNER_A, ownerReceipt]));
  const stored = await query(db, `select cost_per_base_unit, price_per_base_unit, state, priced_by
    from stock_receipts where receipt_number='OWNER-R'`);
  check('12: an owner can approve, and it persists',
    confirm.ok && Number(stored[0].cost_per_base_unit) === 55 &&
      stored[0].state === 'confirmed' && stored[0].priced_by === ids.OWNER_A,
    `cost=${stored[0].cost_per_base_unit} price=${stored[0].price_per_base_unit} state=${stored[0].state}`);

  const staffReceipt = await receipt('STAFF-R', ids.ASSISTANT_A);
  check('12: an assistant can still receive', !!staffReceipt, staffReceipt ?? 'refused');

  const staffPrice = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update stock_receipts set cost_per_base_unit=1 where id=$1`, [staffReceipt]));
  const staffCost = await query(db, `select cost_per_base_unit from stock_receipts where receipt_number='STAFF-R'`);
  check('12: an assistant cannot write a cost',
    !staffPrice.ok && staffCost[0].cost_per_base_unit === null,
    staffPrice.ok ? `ACCEPTED, cost now ${staffCost[0].cost_per_base_unit}` : 'refused');

  const staffApprove = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update stock_receipts set state='confirmed' where id=$1`, [staffReceipt]));
  const staffState = await query(db, `select state from stock_receipts where receipt_number='STAFF-R'`);
  check('12: an assistant cannot approve pricing',
    !staffApprove.ok && staffState[0].state === 'pending_pricing',
    staffApprove.ok ? `ACCEPTED, state ${staffState[0].state}` : 'refused');

  // A confirmed receipt must still create no batch. Deferred, and asserted so it
  // cannot be mistaken for done.
  const batches = await query(db, `select count(*)::int as n from medicine_batches where batch_number='B'`);
  check('12: a confirmed receipt still creates no batch row (DEFERRED, Phase 2)',
    batches[0].n === 0, `${batches[0].n} batch row(s) — the handoff is not implemented`);

  await db.close();
}

note('Deferred by decision, not by oversight: FEFO allocation, receipt -> batch');
note('handoff, staff management, Purchase Orders, unattached credit-ledger');
note('checks, the recordAuditEvent insert/select limitation, sample offline seed data.');

process.exit(await finish(null));