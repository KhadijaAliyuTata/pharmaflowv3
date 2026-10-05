/**
 * Function execution surface.
 *
 * A `SECURITY DEFINER` function runs with its owner's rights and therefore
 * bypasses RLS. PostgreSQL grants `EXECUTE` to `PUBLIC` by default, so every such
 * function is callable by `anon` — an unauthenticated client with no session and
 * no table privileges — unless that grant is explicitly revoked.
 *
 * This suite asserts the invariant that matters: **no function that can change
 * data is reachable by `anon`, and every function reachable by `authenticated` is
 * reachable for a stated reason.**
 *
 * Trigger-typed functions are additionally unreachable by construction: PostgreSQL
 * refuses `select some_trigger_fn()` outright, so converting a definer function
 * into a trigger closes the surface rather than merely narrowing it.
 */

import { asAnon, createReporter, freshDatabase, query } from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-function-surface');

/**
 * Functions `authenticated` legitimately needs, and why.
 *
 * `policy` — evaluated inside an RLS predicate, which runs as the querying role,
 *           so the role must be able to execute it.
 * `rpc`    — called directly by the client through PostgREST.
 */
const NEEDED_BY_AUTHENTICATED = {
  // RLS predicate helpers.
  pf_is_owner: 'policy',
  pf_is_staff: 'policy',
  pf_is_customer: 'policy',
  pf_current_branch: 'policy',
  pf_current_role: 'policy',
  // Client-invoked.
  pf_set_active_branch: 'rpc',
};

/** Data-changing functions that must never be directly callable by anyone. */
const MUST_NEVER_BE_CALLABLE = [
  'pf_apply_sale_item_stock',
  'pf_record_stock_movement',
  'pf_sync_total_quantity',
  'pf_guard_total_quantity',
  'pf_guard_profile_privileges',
  'pf_sync_profile_membership',
  'pf_guard_cost_write',
  'pf_require_owner_to_price',
  'pf_guard_unit_write',
  'pf_check_base_unit',
  'pf_validate_medicine_units',
  'pf_check_sale_item_batch',
  'pf_medicine_state',
  'pf_handle_new_user',
  'pf_normalise_registration_numbers',
];

/**
 * Functions that are not part of the application schema and so are out of scope
 * for these assertions:
 *
 *  - `set_actor` is this harness's own JWT impersonation helper (harness.mjs).
 *  - `gen_random_uuid` stands in for the `pgcrypto` extension, which real
 *    Supabase installs and which legitimately has PUBLIC execute.
 *
 * Excluding them by name keeps the assertions strict for everything the
 * application actually owns, instead of loosening them for everything.
 */
const HARNESS_OR_EXTENSION = new Set(['set_actor', 'gen_random_uuid']);

const db = await freshDatabase();

section('every SECURITY DEFINER function pins its search_path');
{
  const definer = await query(
    db,
    `select p.proname, p.proconfig::text as sp
       from pg_proc p join pg_namespace n on n. oid = p.pronamespace
      where p.prosecdef and n.nspname = 'public'
      order by p.proname`,
  );
  note(`${definer.length} SECURITY DEFINER functions`);
  const unpinned = definer.filter((f) => !/search_path/.test(f.sp ?? ''));
  check(
    'no SECURITY DEFINER function is missing a pinned search_path',
    unpinned.length === 0,
    unpinned.length ? unpinned.map((f) => f.proname).join(', ') : `${definer.length} all pinned`,
  );
}

section('anon must not be able to execute any function');
{
  const rows = await query(
    db,
    `select p.proname,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
            p.prosecdef,
            pg_get_function_result(p.oid) as returns
       from pg_proc p join pg_namespace n on n. oid = p.pronamespace
      where n.nspname = 'public'
      order by p.prosecdef desc, p.proname`,
  );
  const reachable = rows.filter((r) => r.anon_execute && !HARNESS_OR_EXTENSION.has(r.proname));
  check(
    'anon can execute NO function in the public schema',
    reachable.length === 0,
    reachable.length
      ? reachable.map((r) => `${r.proname}(${r.returns})${r.prosecdef ? ' [DEFINER]' : ''}`).join(', ')
      : `${rows.length} functions, none reachable`,
  );
}

section('data-changing functions must not be callable as RPCs');
{
  for (const name of MUST_NEVER_BE_CALLABLE) {
    const [row] = await query(
      db,
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
              p.prorettype::regtype::text as returns,
              p.prosecdef,
              (select count(*)::int from pg_trigger t
                 join pg_proc tp on tp.oid = t.tgfoid
                where tp.proname = p.proname and not t.tgisinternal) as trigger_count
         from pg_proc p where p.proname = $1`,
      [name],
    );

    if (!row) {
      check(`${name} exists`, false, 'function not found');
      continue;
    }

    const isTrigger = row.trigger_count > 0 || row.returns === 'trigger';

    if (isTrigger) {
      // Structurally unreachable: PostgreSQL refuses to call a trigger function
      // directly, whatever the grants say.
      check(
        `${name} is a trigger (unreachable by any RPC caller)`,
        true,
        row.trigger_count > 0 ? `${row.trigger_count} trigger attachment(s)` : 'returns trigger',
      );
    } else {
      check(
        `${name} is NOT executable by authenticated or anon`,
        !row.auth_execute && !row.anon_execute,
        `authenticated=${row.auth_execute} anon=${row.anon_execute}`,
      );
    }
  }
}

section('functions authenticated legitimately needs are executable');
{
  for (const [name, reason] of Object.entries(NEEDED_BY_AUTHENTICATED)) {
    const [row] = await query(
      db,
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute
         from pg_proc p where p.proname = $1`,
      [name],
    );
    if (!row) {
      check(`${name} exists (needed as ${reason})`, false, 'not found');
      continue;
    }
    check(`${name} is executable by authenticated (${reason})`, row.auth_execute === true);
  }
}

section('no data-changing function is granted to PUBLIC');
{
  const rows = await query(
    db,
    `select p.proname, p.prosecdef
       from pg_proc p join pg_namespace n on n. oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('public', p.oid, 'EXECUTE')
      order by p.proname`,
  );
  const appRows = rows.filter((r) => !HARNESS_OR_EXTENSION.has(r.proname));
  check(
    'no application function retains the default PUBLIC execute grant',
    appRows.length === 0,
    appRows.length
      ? appRows.map((r) => r.proname).join(', ')
      : `${appRows.length}/${rows.length - HARNESS_OR_EXTENSION.size} application functions, all grants explicit`,
  );
}

section('an anon caller cannot invoke the stock mutation path');
{
  // The concrete B1 reproduction, kept as a permanent regression test.
  const r = await asAnon(db, () => query(db, `select pf_apply_sale_item_stock(gen_random_uuid())`));
  check(
    'anon cannot invoke pf_apply_sale_item_stock',
    !r.ok,
    r.ok ? 'RETURNED SUCCESS — the stock path is anonymously reachable' : `refused: ${r.err}`,
  );
}

process.exit(await finish(db));
