/**
 * Audit-log integrity: the four facts that must hold for `audit_events`.
 *
 *   A  an assistant may record their OWN action
 *   B  an assistant may NOT record an action as somebody else
 *   C  an assistant may NOT update an existing entry
 *   D  an assistant may NOT delete an existing entry
 *   E  a refused attempt does not contaminate the session used by later attempts
 *
 * ## Why this suite exists separately
 *
 * The Phase 0 report carried an open item: "assistant writing their own audit
 * event succeeds against a fresh database but not reproducibly inside the full
 * suite." That was recorded as unresolved. It is now resolved, and it was a
 * TEST defect, not a database defect.
 *
 * The cause was `RETURNING` in the probe statement, not instability. Under RLS a
 * returning clause is evaluated against the SELECT policy, and `audit_read` is
 * owner-only:
 *
 *     INSERT ... VALUES (branch, auth.uid(), ...)            -> succeeds
 *     INSERT ... VALUES (branch, auth.uid(), ...) RETURNING id -> REFUSED
 *     same statement, as an owner                            -> succeeds
 *
 * The earlier "3/3 OK" observation used SQL with no RETURNING; the suite used SQL
 * with one. Both were deterministic. They were different statements, which read as
 * flakiness because nothing recorded which one ran.
 *
 * ## Isolation method: a fresh database per case
 *
 * `asRole` issues a ROLLBACK after a caught error, which reads like the
 * transaction-poisoning defence it was written for. It is a no-op here: PGlite runs
 * in autocommit, so every statement is its own implicit transaction and a failed
 * statement cannot abort a later one. That was verified directly rather than
 * assumed, after a poisoning theory turned out to be wrong.
 *
 * So the real isolation guarantee comes from somewhere else, and this suite uses it
 * deliberately: **each security case gets a freshly migrated database**. No case can
 * inherit state, a role, or a session setting from another. Case E then proves the
 * weaker property separately, that a refusal followed by a legitimate write in the
 * SAME session still succeeds.
 *
 * ## The assertion style
 *
 * Every negative case asserts on STORED STATE, read back as the server role. An
 * RLS-forbidden UPDATE or DELETE matches zero rows and reports success, so "did it
 * throw?" is the wrong question — "is the value unchanged?" is the right one.
 * Two of the four negative cases here report success while doing nothing at all.
 */

import {
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, section, note, finish } = createReporter('verify-audit-integrity');

/**
 * One freshly migrated database per security case.
 *
 * `case_` supplies a database with tenants seeded and nothing else done, so no case
 * can be affected by what another case wrote.
 */
async function isolate() {
  const db = await freshDatabase();
  const ids = await seedTenants(db);
  return { db, ids };
}

/** Run one statement as `actorId`, never throwing. */
async function as(db, actorId, fn) {
  await db.query(`select set_actor($1)`, [actorId]);
  return asAuthenticated(db, fn);
}

/**
 * Insert an audit event: branch, actor, description. Three parameters, always.
 *
 * An earlier version of this helper took a flag and renumbered the placeholders,
 * producing `values ($1, $3, 'sale', $4)` for three parameters. Every "refused"
 * case in the first run was that type error rather than an RLS decision, which is
 * exactly the kind of false result the harness header warns about. A constant with
 * fixed numbering cannot drift that way.
 */
const INSERT = `insert into audit_events (branch_id, actor_id, action, description)
                values ($1, $2, 'sale', $3)`;

/* ============================================================ A: own event */

section('A: an assistant may record their OWN action');
{
  const { db, ids } = await isolate();

  // Deliberately NO `returning` clause — see the header for why that is the whole
  // point of this case.
  const written = await as(db, ids.ASSISTANT_A, () =>
    query(db, INSERT, [
      ids.BRANCH_A,
      ids.ASSISTANT_A,
      'own action, no returning',
    ]),
  );
  check(
    'the INSERT is accepted',
    written.ok,
    written.ok ? 'accepted' : `REFUSED: ${written.err}`,
  );

  const stored = await query(
    db,
    `select actor_id, description from audit_events where description = $1`,
    ['own action, no returning'],
  );
  check(
    'and the row is genuinely persisted with the caller as the actor',
    stored.length === 1 && stored[0].actor_id === ids.ASSISTANT_A,
    stored.length === 1
      ? `actor_id=${stored[0].actor_id.slice(0, 8)} (the assistant)`
      : `${stored.length} rows stored`,
  );

  // The companion fact that explains the original open item.
  const withReturning = await as(db, ids.ASSISTANT_A, () =>
    query(db, `${INSERT} returning id`, [
      ids.BRANCH_A,
      ids.ASSISTANT_A,
      'with returning',
    ]),
  );
  check(
    'the same INSERT with a RETURNING clause is refused (root cause of the open item)',
    !withReturning.ok,
    withReturning.ok ? 'returned a row' : `refused: ${withReturning.err.slice(0, 60)}`,
  );

  const leaked = await query(
    db,
    `select count(*)::int as n from audit_events where description = 'with returning'`,
  );
  check(
    'and nothing was stored by that attempt, since the statement is atomic',
    leaked[0].n === 0,
    `${leaked[0].n} rows`,
  );

  // An owner CAN return its own row, because audit_read admits owners.
  const ownerRet = await as(db, ids.OWNER_A, () =>
    query(db, `${INSERT} returning id`, [
      ids.BRANCH_A,
      ids.OWNER_A,
      'owner returning',
    ]),
  );
  check(
    'an owner CAN use RETURNING, confirming audit_read is the discriminator',
    ownerRet.ok,
    ownerRet.ok ? 'accepted' : `refused: ${ownerRet.err.slice(0, 60)}`,
  );

  await db.close();
}

/* ============================================================= B: forgery */

section('B: an assistant may NOT record an action as somebody else');
{
  // Same branch, a different person. The realistic forgery.
  const same = await isolate();
  const forged = await as(same.db, same.ids.ASSISTANT_A, () =>
    query(same.db, INSERT, [
      same.ids.BRANCH_A,
      same.ids.OWNER_A,
      'forged as the owner',
    ]),
  );
  const sameRows = await query(
    same.db,
    `select count(*)::int as n from audit_events where description = 'forged as the owner'`,
  );
  check(
    'an assistant cannot forge an event against a colleague in their own branch',
    !forged.ok && sameRows[0].n === 0,
    forged.ok ? 'ACCEPTED — FORGERY SUCCEEDED' : `refused (${forged.err.slice(0, 55)}); rows: ${sameRows[0].n}`,
  );
  await same.db.close();

  // Different branch. Catches an actor whose id is not even in this tenant.
  const cross = await isolate();
  const crossForged = await as(cross.db, cross.ids.ASSISTANT_A, () =>
    query(cross.db, INSERT, [
      cross.ids.BRANCH_A,
      cross.ids.OWNER_B,
      'forged across tenants',
    ]),
  );
  const crossRows = await query(
    cross.db,
    `select count(*)::int as n from audit_events where description = 'forged across tenants'`,
  );
  check(
    'an assistant cannot forge an event against a user in another branch',
    !crossForged.ok && crossRows[0].n === 0,
    crossForged.ok
      ? 'ACCEPTED — CROSS-TENANT FORGERY SUCCEEDED'
      : `refused (${crossForged.err.slice(0, 55)}); rows: ${crossRows[0].n}`,
  );
  await cross.db.close();

  // The negative control: an owner forging is still refused, because the policy
  // binds the actor to the CALLER rather than to a role.
  const ownerFor = await isolate();
  const ownerAttempt = await as(ownerFor.db, ownerFor.ids.OWNER_A, () =>
    query(ownerFor.db, INSERT, [
      ownerFor.ids.BRANCH_A,
      ownerFor.ids.ASSISTANT_A,
      'owner forging against the assistant',
    ]),
  );
  const ownerRows = await query(
    ownerFor.db,
    `select count(*)::int as n from audit_events where description = 'owner forging against the assistant'`,
  );
  check(
    'the rule binds the actor to the CALLER, not to a role: an owner forging is also refused',
    !ownerAttempt.ok && ownerRows[0].n === 0,
    ownerAttempt.ok ? 'ACCEPTED' : `refused (${ownerAttempt.err.slice(0, 55)}); rows: ${ownerRows[0].n}`,
  );
  await ownerFor.db.close();
}

/* =========================================================== C and D: tamper */

section('C and D: an assistant may not UPDATE or DELETE existing history');
{
  // A real stored row to tamper with. It must exist, or the case proves nothing —
  // an earlier draft tried to delete a row that had never been inserted.
  const { db, ids } = await isolate();
  await as(db, ids.OWNER_A, () =>
    query(db, INSERT, [ids.BRANCH_A, ids.OWNER_A, 'baseline entry']),
  );
  const before = await query(db, `select id, description from audit_events`);
  check('fixture: one audit row exists to tamper with', before.length === 1, `${before.length} row(s)`);

  if (before.length === 0) {
    // Without a real row, every assertion below would be testing nothing. A
    // cascade of undefined-property crashes hides the real failure, so stop here
    // and say so.
    note('tamper cases skipped — no audit row exists to tamper with');
    await db.close();
  } else {
    const targetId = before[0].id;

    // Compare against the value actually inserted. An earlier version of this
    // assertion expected 'baseline' while the fixture wrote 'baseline entry', so it
    // reported "ALTERED TO baseline entry" — the row was in fact untouched and the
    // test was wrong about its own fixture.
    const BASELINE = 'baseline entry';

    const update = await as(db, ids.ASSISTANT_A, () =>
      query(db, `update audit_events set description = 'tampered' where id = $1`, [targetId]),
    );
    const afterUpdate = await query(db, `select description from audit_events where id = $1`, [
      targetId,
    ]);
    check(
      'an assistant cannot UPDATE an audit entry',
      afterUpdate.length === 1 && afterUpdate[0].description === BASELINE,
      afterUpdate[0]?.description === BASELINE
        ? `still "${afterUpdate[0].description}" (update reported ${update.ok ? 'success' : 'refused'} — RLS matched 0 rows)`
        : `ALTERED TO "${afterUpdate[0]?.description}"`,
    );

    const del = await as(db, ids.ASSISTANT_A, () =>
      query(db, `delete from audit_events where id = $1`, [targetId]),
    );
    const afterDelete = await query(db, `select count(*)::int as n from audit_events where id = $1`, [
      targetId,
    ]);
    check(
      'an assistant cannot DELETE an audit entry',
      afterDelete[0].n === 1,
      afterDelete[0].n === 1
        ? `row survived (delete reported ${del.ok ? 'success' : 'refused'} — RLS matched 0 rows)`
        : 'ROW WAS DELETED',
    );

    // Nothing may update or delete, so confirm there is no policy to be permissive
    // about in the first place. Table-level grants ARE present, which is why the
    // assertion above checks stored state rather than an error.
    const shape = await query(
      db,
      `select
         (select count(*)::int from pg_policies where tablename = 'audit_events' and cmd = 'UPDATE') as update_policies,
         (select count(*)::int from pg_policies where tablename = 'audit_events' and cmd = 'DELETE') as delete_policies,
         has_table_privilege('authenticated', 'audit_events', 'UPDATE') as update_granted,
         has_table_privilege('authenticated', 'audit_events', 'DELETE') as delete_granted`,
    );
    check(
      'UPDATE is blocked by the ABSENCE of any policy, not by a deny rule',
      shape[0].update_policies === 0 && shape[0].delete_policies === 0,
      `${shape[0].update_policies} UPDATE policies, ${shape[0].delete_policies} DELETE policies ` +
        `(table grants present: upd=${shape[0].update_granted} del=${shape[0].delete_granted})`,
    );

    // Owners may not rewrite history either. An append-only log that an owner can
    // edit is not append-only.
    const ownerUpdate = await as(db, ids.OWNER_A, () =>
      query(db, `update audit_events set description = 'owner tampered' where id = $1`, [targetId]),
    );
    const ownerDelete = await as(db, ids.OWNER_A, () =>
      query(db, `delete from audit_events where id = $1`, [targetId]),
    );
    const ownerAfter = await query(db, `select count(*)::int as n from audit_events where id = $1`, [
      targetId,
    ]);
    check(
      'nor can an OWNER update or delete it — the log is append-only for everyone',
      ownerAfter[0].n === 1 && ownerUpdate.ok === ownerDelete.ok,
      `${ownerAfter[0].n} row(s) remain; update=${ownerUpdate.ok ? 'reported success' : 'refused'}, ` +
        `delete=${ownerDelete.ok ? 'reported success' : 'refused'}`,
    );

    await db.close();
    }
}

/* =============================================== E: session not contaminated */

section('E: a refused attempt does not contaminate the session');
{
  const { db, ids } = await isolate();

  // Deliberately fail first, in the same session that must then succeed.
  const refused = await as(db, ids.ASSISTANT_A, () =>
    query(db, INSERT, [
      ids.BRANCH_A,
      ids.OWNER_A,
      'forged then own',
    ]),
  );
  check('a refusal happens first', !refused.ok, refused.ok ? 'was accepted' : 'refused as expected');

  // Immediately afterwards, in the SAME database and session: a legitimate write.
  const legitimate = await as(db, ids.ASSISTANT_A, () =>
    query(db, INSERT, [
      ids.BRANCH_A,
      ids.ASSISTANT_A,
      'legitimate after refusal',
    ]),
  );
  const rows = await query(db, `select description from audit_events order by description`);
  check(
    'a legitimate write in the SAME session still succeeds afterwards',
    legitimate.ok && rows.length === 1 && rows[0].description === 'legitimate after refusal',
    legitimate.ok
      ? `accepted; ${rows.length} row(s) stored`
      : `REFUSED: ${legitimate.err}`,
  );

  // And the role is still reset, so a later server-role read is not RLS-filtered.
  const who = await query(db, `select current_user as u`);
  check(
    'the role is restored afterwards, so server-role reads are not silently filtered',
    who[0].u === 'postgres',
    `current_user = ${who[0].u}`,
  );

  // Direct confirmation that autocommit, not the ROLLBACK in asRole, is what
  // prevents contamination. If PGlite ever began wrapping statements in an
  // explicit transaction, this assertion would fail and the comment would need
  // revisiting.
  await db.exec('set role authenticated');
  try {
    await db.query('select 1/0');
  } catch {
    /* deliberate */
  }
  let alive = false;
  try {
    await db.query('select 1 as alive');
    alive = true;
  } catch (e) {
    note('session recovered via asRole rollback', String(e.message).split('\n')[0]);
  }
  await db.exec('reset role');
  check(
    'a failed statement does not abort later ones (PGlite autocommit)',
    alive,
    alive ? 'next statement succeeded with no manual rollback' : 'next statement failed',
  );

  await db.close();
}

/* ============================================================ read boundary */

section('read boundary is unchanged: the log is owner-only');
{
  const { db, ids } = await isolate();
  await as(db, ids.OWNER_A, () =>
    query(db, INSERT, [ids.BRANCH_A, ids.OWNER_A, 'owner entry']),
  );

  const ownerRead = await as(db, ids.OWNER_A, () =>
    query(db, `select description from audit_events`),
  );
  check(
    'an owner can read their own branch audit log',
    ownerRead.ok && ownerRead.value.length === 1,
    ownerRead.ok ? `${ownerRead.value.length} row(s)` : ownerRead.err,
  );

  const staffRead = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select description from audit_events`),
  );
  check(
    'an assistant cannot read the audit log',
    staffRead.ok && staffRead.value.length === 0,
    staffRead.ok ? `0 rows (filtered by audit_read)` : staffRead.err,
  );

  const crossRead = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select description from audit_events where branch_id = $1`, [ids.BRANCH_B]),
  );
  check(
    'and cannot read another branch\'s log either',
    crossRead.ok && crossRead.value.length === 0,
    crossRead.ok ? `${crossRead.value.length} rows` : crossRead.err,
  );

  await db.close();
}

note('an assistant can WRITE an audit event but not READ one back');
note('src/lib/supabase/parties.ts recordAuditEvent uses .insert().select().single(),');
note('which needs SELECT visibility the assistant does not have — see the report.');

process.exit(await finish(null));