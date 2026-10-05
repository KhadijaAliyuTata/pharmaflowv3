/**
 * Migration chain verification.
 *
 * Proves three things the app's correctness depends on but which "it builds" does
 * not establish:
 *
 *  1. The chain applies to a FRESH database the way the Supabase CLI applies it —
 *     each file as a single exec — not statement by statement. Splitting a file
 *     hides sequence-dependent failures, which is how a "passing" migration can
 *     still be unappliable.
 *  2. Every file is re-runnable, so a half-applied deploy can be repaired.
 *  3. The first migration stands ALONE, so a later file is never quietly masking
 *     an earlier failure.
 */

import {
  applyMigrationTo,
  createReporter,
  freshDatabase,
  migrationFiles,
} from './harness.mjs';

const { check, section, finish } = createReporter('verify-chain');
const files = migrationFiles();

section('migration inventory');
console.log(`  ${files.length} migration file(s), in timestamp order:`);
for (const f of files) console.log(`    ${f}`);
check('there is at least one migration', files.length > 0, `${files.length}`);
check(
  'filenames are ordered by timestamp',
  files.every((f, i) => i === 0 || files[i - 1] <= f),
);

section('whole chain applies to a fresh database, one exec per file');
{
  const db = await freshDatabase();
  for (const f of files) {
    // The signal is "did not throw". db.exec() resolves with a results array on
    // success, so asserting on the return value would be meaningless.
    let ok = true;
    let err = '';
    try {
      await applyMigrationTo(db, f);
    } catch (e) {
      ok = false;
      err = String(e?.message ?? e).split('\n')[0].slice(0, 120);
    }
    check(`applies: ${f}`, ok, err);
  }
  await db.close();
}

section('the first migration applies on its own');
{
  // Rule 3: a fresh database, so nothing later can mask an earlier failure.
  const db = await freshDatabase({ only: [files[0]] });
  const tables = await db.query(
    `select count(*)::int as n from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`,
  );
  check(
    'the initial schema creates its tables unaided',
    tables.rows[0].n > 0,
    `${tables.rows[0].n} tables`,
  );
  await db.close();
}

section('every migration is re-runnable');
{
  const db = await freshDatabase();
  for (const f of files) {
    let ok = true;
    let err = '';
    try {
      await applyMigrationTo(db, f);
    } catch (e) {
      ok = false;
      err = String(e?.message ?? e).split('\n')[0].slice(0, 100);
    }
    check(`re-applies cleanly: ${f}`, ok, err);
  }
  await db.close();
}

section('structural completeness');
{
  const db = await freshDatabase();

  const noRls = await db.query(
    `select c.relname as tbl from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by c.relname`,
  );
  check(
    'row level security is enabled on every table',
    noRls.rows.length === 0,
    noRls.rows.length ? noRls.rows.map((r) => r.tbl).join(', ') : 'all tables protected',
  );

  const noPolicy = await db.query(
    `select c.relname as tbl from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
        and not exists (select 1 from pg_policies p
                         where p.schemaname = 'public' and p.tablename = c.relname)
      order by c.relname`,
  );
  check(
    'no table has RLS enabled but no policy (which would mean deny-all or allow-all by accident)',
    noPolicy.rows.length === 0,
    noPolicy.rows.length ? noPolicy.rows.map((r) => r.tbl).join(', ') : 'every table has policies',
  );

  // A policy that compares a row column against a literal is how a client-supplied
  // tenant id sneaks in. Everything must route through a session-derived helper.
  const policies = await db.query(
    `select tablename, policyname, coalesce(qual, '') as qual, coalesce(with_check, '') as wc
       from pg_policies where schemaname = 'public'`,
  );
  const suspicious = policies.rows.filter((p) => {
    const expr = `${p.qual} ${p.wc}`;
    return (
      /\b(branch_id|user_id|actor_id|recipient_id|customer_id)\s*=/.test(expr) &&
      !/pf_current_branch\(\)|auth\.uid\(\)|current_setting/.test(expr)
    );
  });
  check(
    'no policy treats a row column as an authorization claim',
    suspicious.length === 0,
    suspicious.length
      ? suspicious.map((p) => `${p.tablename}.${p.policyname}`).join(', ')
      : `${policies.rows.length} policies all session-derived`,
  );

  await db.close();
}

process.exit(await finish(null));
