/**
 * Shared harness for the database verification suites.
 *
 * Every suite applies the real migration chain to a fresh PGlite database and
 * then acts as a real Supabase role. Four rules below exist because breaking any
 * one of them produces a *false* result rather than an error, which is worse:
 *
 *  1. `grant usage on schema auth` — real Supabase grants this to `anon` and
 *     `authenticated`. Without it, `SECURITY INVOKER` triggers that call
 *     `auth.uid()` directly (`pf_guard_cost_write`, `pf_require_owner_to_price`)
 *     fail with "permission denied", and the suite reports a write path as broken
 *     when it is not. This produced three false findings during the audit.
 *
 *  2. Reset the role in a `finally`. The role reset is the part that matters: a
 *     suite that leaves `set role authenticated` in place silently filters its
 *     own later "server-role" reads through RLS and sees empty tables.
 *
 *     The ROLLBACK half of `asRole` is a no-op in PGlite. It runs in autocommit,
 *     so each statement is its own implicit transaction and a failed statement
 *     cannot abort a later one. That was verified directly rather than assumed,
 *     after a transaction-poisoning theory turned out to be wrong and sent the
 *     audit investigation down the wrong path. Real isolation comes from rule 3.
 *
 *  3. A fresh database per scenario group, so one poisoned transaction cannot
 *     contaminate later groups.
 *
 *  4. Assert on STORED STATE, not on whether an error was raised. RLS filters a
 *     forbidden write down to zero matching rows and still reports success, so
 *     "did it throw?" is the wrong question — "is the value unchanged?" is the
 *     right one. The first version of the branch-registration test passed for
 *     entirely the wrong reason.
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');

/** Migrations in timestamp order. The suite must not hardcode a subset. */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * PGlite has no `pgcrypto` extension, so the one `create extension` statement is
 * substituted for an equivalent function.
 *
 * The replacer is a FUNCTION on purpose: with a string replacement, `$$` in the
 * replacement is an escaped literal `$`, which corrupts the dollar-quoted body
 * and produces a bogus "syntax error at or near $".
 */
function applyPgCryptoSubstitution(sql) {
  return sql.replace(
    /create extension if not exists "pgcrypto"[^;]*;/i,
    () =>
      `create or replace function gen_random_uuid() returns uuid language sql volatile as $q$ ` +
      `select md5(random()::text || clock_timestamp()::text)::uuid $q$;`,
  );
}

async function bootstrapRoles(db) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;

    -- Rule 1: real Supabase grants this. See the note at the top of this file.
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated;

    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique,
      phone text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create or replace function auth.uid() returns uuid language sql stable as $q$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $q$;

    -- Harness-only: impersonate a signed-in user the way a JWT would.
    create or replace function set_actor(p uuid) returns void language plpgsql as $q$
    begin
      perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false);
    end $q$;
  `);
}

/**
 * A fresh database with the whole chain applied.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.only]  apply just these migration filenames (to prove one
 *                                file stands alone), instead of the whole chain.
 * @param {string[]} [opts.skip]  apply the chain minus these files.
 */
export async function freshDatabase({ only, skip } = {}) {
  const db = new PGlite();
  await bootstrapRoles(db);

  let files = migrationFiles();
  if (only) files = only;
  if (skip) files = files.filter((f) => !skip.includes(f));

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await db.exec(applyPgCryptoSubstitution(sql));
  }

  return db;
}

/** Apply one migration file verbatim, without a prior chain. Used by chain tests. */
export async function applyMigrationTo(db, file) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  return db.exec(applyPgCryptoSubstitution(sql));
}

/**
 * Rule 2: run as `role`, always restore it, always attempt to recover.
 *
 * The role reset is load-bearing. If `set role` were left in place, every later
 * "server-role" read in a suite would still be evaluated as `authenticated` and
 * silently filtered by RLS, so a correct query would look like an empty table.
 *
 * The rollback is defensive rather than load-bearing here. It was originally
 * written because catching an error without one leaves a PostgreSQL transaction
 * aborted, so every later statement fails with "current transaction is aborted".
 * That is true of a client that wraps statements in an explicit transaction, and
 * false of PGlite, which runs in autocommit: each statement is its own implicit
 * transaction, so a failed statement cannot affect a later one. Verified
 * directly — `select 1/0` followed by `select 1` succeeds with no manual
 * rollback.
 *
 * The rollback is kept because it is harmless and because it makes this helper
 * correct against a real Postgres connection, which a future suite may use for
 * real-project verification. It must not be counted on for isolation: see rule 3
 * and `verify-audit-integrity.mjs`, which gives each case a fresh database.
 */
export async function asRole(db, role, fn) {
  // Capture BOTH pieces of session state this helper changes. The role is obvious;
  // the actor is not, and forgetting it is what made a server-role fixture insert run
  // as the assistant — see the note on `asActor` and the suite that proves it.
  const previous = await db.query(
    `select nullif(current_setting('request.jwt.claim.sub', true), '') as sub`,
  );
  // `|| null`, not `?? null` — see `asActor`. An unset setting is an empty string, and
  // handing that to a uuid parameter is a type error rather than a restore.
  const priorActor = previous.rows[0]?.sub || null;

  await db.exec(`set role ${role}`);
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = String(e?.message ?? e).split('\n')[0].slice(0, 200);
    // Attempt to recover the session. A no-op under autocommit; meaningful if a
    // transaction is ever opened explicitly around a call.
    try {
      await db.exec('rollback');
    } catch {
      /* nothing to roll back */
    }
    return { ok: false, err };
  } finally {
    try {
      await db.exec('reset role');
    } catch {
      /* already reset */
    }
    // Restore the actor. Without this the next bare statement in the suite runs with
    // `auth.uid()` still pointing at whoever `as()` last impersonated, so a fixture
    // write that the database correctly refuses for that user looks like a product
    // defect. A NULL priorActor restores the trusted server context.
    try {
      await db.query(`select set_actor($1)`, [priorActor]);
    } catch {
      /* nothing to restore */
    }
  }
}

export const asAuthenticated = (db, fn) => asRole(db, 'authenticated', fn);
export const asAnon = (db, fn) => asRole(db, 'anon', fn);

/**
 * Run `fn` with `request.jwt.claim.sub` set to `actorId`, then RESTORE the previous
 * value whatever happens.
 *
 * This exists because the actor setting is session-level, so it outlives the call that
 * set it. `asRole()` restores the ROLE and nothing else, so after any
 * `as(db, ASSISTANT, ...)` call the next plain `query()` still ran with `auth.uid()` =
 * the assistant, even though the role had reverted to the database owner. A
 * server-role fixture insert that sets a purchase cost then ran as the assistant and
 * was refused by the very guard the test was about to exercise.
 *
 * That produced false failures before it was found: a cost insert refused with "Only an
 * owner can set a purchase cost" in a context where no owner was involved, and a suite
 * that wrote its fixtures under somebody else's identity.
 *
 * A NULL `actorId` is a deliberate "trusted server context": `auth.uid()` becomes NULL,
 * which is what a migration or a service_role connection looks like and what the
 * privilege-guard triggers treat as trusted.
 */
export async function asActor(db, actorId, fn) {
  const previous = await db.query(
    `select nullif(current_setting('request.jwt.claim.sub', true), '') as sub`,
  );
  // `|| null`, not `?? null`: `current_setting(..., true)` yields an EMPTY STRING when
  // the setting is absent, and passing that to a uuid parameter is a type error, so the
  // restore threw and the actor was left as the assistant.
  const before = previous.rows[0]?.sub || null;
  try {
    await db.query(`select set_actor($1)`, [actorId]);
    return await fn();
  } finally {
    await db.query(`select set_actor($1)`, [before]);
  }
}

/**
 * The actor a bare statement would currently run as, or null for the server context.
 * Exists so a suite can prove the restoration above rather than assume it.
 */
export async function currentActor(db) {
  const r = await db.query(
    `select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid as uid`,
  );
  return r.rows[0]?.uid ?? null;
}

export const query = async (db, sql, params) => (await db.query(sql, params)).rows;

/**
 * Seed a branch, an owner and an assistant in the FIRST branch, plus an owner in
 * a second branch so cross-tenant effects are observable.
 *
 * `pf_handle_new_user` creates the profile rows, so this updates rather than
 * inserts them, and `pf_sync_profile_membership` may have created the membership
 * rows already, so those inserts are conflict-tolerant.
 */
export async function seedTenants(db) {
  const OWNER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const ASSISTANT_A = 'aaaaaaaa-0000-0000-0000-000000000002';
  const OWNER_B = 'bbbbbbbb-0000-0000-0000-000000000001';
  const BRANCH_A = '11111111-1111-1111-1111-111111111111';
  const BRANCH_B = '22222222-2222-2222-2222-222222222222';

  await db.exec(`
    do $do$
    begin
      insert into branches (id, name) values
        ('${BRANCH_A}', 'Branch A'),
        ('${BRANCH_B}', 'Branch B');
      insert into auth.users (id, email) values
        ('${OWNER_A}', 'owner-a@example.test'),
        ('${ASSISTANT_A}', 'assistant-a@example.test'),
        ('${OWNER_B}', 'owner-b@example.test');
    end $do$;

    update profiles set role = 'owner',     branch_id = '${BRANCH_A}' where id = '${OWNER_A}';
    update profiles set role = 'assistant', branch_id = '${BRANCH_A}' where id = '${ASSISTANT_A}';
    update profiles set role = 'owner',     branch_id = '${BRANCH_B}' where id = '${OWNER_B}';
  `);

  await db.query(`select set_actor($1)`, [OWNER_A]);
  await db.query(
    `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'owner')
     on conflict do nothing`,
    [OWNER_A, BRANCH_A],
  );
  await db.query(
    `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'assistant')
     on conflict do nothing`,
    [ASSISTANT_A, BRANCH_A],
  );
  await db.query(`select set_actor($1)`, [OWNER_B]);
  await db.query(
    `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'owner')
     on conflict do nothing`,
    [OWNER_B, BRANCH_B],
  );

  return { OWNER_A, ASSISTANT_A, OWNER_B, BRANCH_A, BRANCH_B };
}

/** A minimal but valid single-base-unit packaging configuration. */
export const SINGLE_UNIT_UNITS = JSON.stringify([
  { key: 'tablet', name: 'Tablet', multiplier: 1, sellingPrice: 100 },
]);

/** Insert a medicine + one batch as trusted bootstrap (no JWT). */
export async function seedMedicine(db, { branchId, cost = 50, price = 100, quantity = 500 }) {
  const [medicine] = await query(
    db,
    `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
     values ($1, 'Test Drug', 'testgen', $2::jsonb, $3, $4, current_date + 365)
     returning id`,
    [branchId, SINGLE_UNIT_UNITS, cost, price],
  );
  const [batch] = await query(
    db,
    `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
     values ($1, $2, 'BATCH-1', current_date + 300, $3, $4)
     returning id`,
    [branchId, medicine.id, quantity, cost],
  );
  return { medicineId: medicine.id, batchId: batch.id };
}

/* ------------------------------------------------------------- assertions */

export function createReporter(suiteName) {
  let pass = 0;
  let fail = 0;
  const failures = [];

  const check = (name, cond, detail = '') => {
    if (cond) {
      pass++;
      console.log(`  PASS  ${name}${detail ? ` -> ${detail}` : ''}`);
    } else {
      fail++;
      failures.push(name);
      console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
    }
  };

  const note = (name, detail) => {
    console.log(`  NOTE  ${name}${detail ? ` -> ${detail}` : ''}`);
  };

  const section = (title) => console.log(`\n--- ${title} ---`);

  const finish = async (db) => {
    console.log(`\n${suiteName}: ${pass} passed, ${fail} failed`);
    if (failures.length) console.log(`  failing: ${failures.join(' | ')}`);
    try {
      await db?.close();
    } catch {
      /* already closed */
    }
    return fail === 0 ? 0 : 1;
  };

  return { check, note, section, pass, fail, finish };
}
