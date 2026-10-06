/**
 * The harness must not leak identity between calls.
 *
 * `request.jwt.claim.sub` is session-level, so setting it outlives the statement that
 * set it. `asRole()` restores the ROLE and nothing else, which means after
 * `as(db, ASSISTANT, ...)` a bare `query()` still ran as the assistant even though the
 * role had reverted to the database owner.
 *
 * That is not a hypothetical. It produced a cost insert refused with "Only an owner can
 * set a purchase cost" in a context where no owner was involved, and an audit that
 * quietly wrote its fixtures under somebody else's identity. Both looked like product
 * findings and both were harness bugs.
 *
 * This suite pins the restoration, because a harness that leaks identity will eventually
 * produce a false PASS as easily as a false FAIL, and a false pass is worse.
 */

import { asAuthenticated, createReporter, freshDatabase, query, seedTenants } from './harness.mjs';
import { asActor, currentActor } from './harness.mjs';

const { check, section, finish } = createReporter('verify-harness-isolation');

const database = await freshDatabase();
const ids = await seedTenants(database);

/**
 * Impersonate `actorId` for the duration of `fn`, restoring whatever was in place
 * before.
 *
 * The original helper did `set_actor(actor)` and THEN called `asAuthenticated`, which
 * sets the role inside the scope. Because the actor was set outside it, `asRole`
 * captured the assistant as the "previous" value and dutifully restored it — so the
 * identity still leaked. Setting the actor inside `asActor` is what makes the scope
 * real. Every suite that needs a clean server context afterwards has to use this shape.
 */
const as = async (actorId, fn) => asActor(database, actorId, () => asAuthenticated(database, fn));

section('an assistant-scoped operation does not leak into the next statement');
{
  // Start from a known server context, the way a suite that writes fixtures wants to.
  await database.query(`select set_actor($1)`, [null]);
  check('fixture: the session starts with no end-user actor', (await currentActor(database)) === null,
    `actor=${await currentActor(database)}`);

  // 1. run an assistant-scoped operation
  const scoped = await as(ids.ASSISTANT_A, () =>
    query(database, `select pf_is_owner() as o, auth.uid()::text as uid`),
  );
  check('1: the assistant-scoped operation ran as the assistant',
    scoped.ok && scoped.value[0].uid === ids.ASSISTANT_A && scoped.value[0].o === false,
    scoped.ok ? `auth.uid()=${scoped.value[0].uid.slice(0, 8)}, pf_is_owner=${scoped.value[0].o}` : scoped.err);

  // 2. exit that scope, then 3. observe what a bare statement would run as.
  const leaked = await currentActor(database);
  check(
    '2/3: after leaving the scope a bare statement is the SERVER actor, not the assistant',
    leaked === null,
    leaked === null
      ? 'actor restored to null (trusted server context)'
      : `LEAKED: still ${String(leaked).slice(0, 8)} — the assistant would own later fixtures`,
  );

  // 4. and prove it behaviourally, not just by reading the setting: a server-role
  // write that an assistant is forbidden to perform must now succeed.
  // No RETURNING, so `query` yields an empty array on success and THROWS on failure.
  // The assertion is therefore the stored row plus the fact that we reached this line
  // at all — checking `serverWrite.length === 1` was wrong, because an INSERT that
  // returns nothing has length 0 whether it succeeded or not.
  let serverWriteOk = true;
  try {
    await query(
      database,
      `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
       values ($1, 'Server Context Probe', 'scp',
         '[{"key":"tablet","name":"Tablet","multiplier":1,"sellingPrice":100}]'::jsonb, 50, 100, current_date + 365)`,
      [ids.BRANCH_A],
    );
  } catch {
    serverWriteOk = false;
  }
  const rows = await query(database, `select count(*)::int as n from medicines where name = 'Server Context Probe'`);
  check(
    '4: a server-role cost write succeeds after an assistant-scoped call',
    serverWriteOk && rows[0].n === 1,
    serverWriteOk ? 'accepted, so the actor really was the server' : 'refused — the assistant identity leaked',
  );

  // The same write performed AS the assistant must still be refused, which proves the
  // guard is live and the previous line is not simply always-true.
  const asAssistant = await as(ids.ASSISTANT_A, () =>
    query(
      database,
      `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
       values ($1, 'Assistant Cost Probe', 'acp',
         '[{"key":"tablet","name":"Tablet","multiplier":1,"sellingPrice":100}]'::jsonb, 50, 100, current_date + 365)`,
      [ids.BRANCH_A],
    ),
  );
  const asRows = await query(database, `select count(*)::int as n from medicines where name = 'Assistant Cost Probe'`);
  check(
    'and the identical write as the assistant is still refused',
    !asAssistant.ok && asRows[0].n === 0,
    asAssistant.ok ? 'ACCEPTED' : `refused (${asAssistant.err.slice(0, 45)})`,
  );
}

section('asActor restores the previous actor, and a null actor is the server context');
{
  await asActor(database, ids.OWNER_A, async () => {
    await asActor(database, ids.ASSISTANT_A, async () => {
      const inner = await currentActor(database);
      check('nested: the inner scope sees the assistant', inner === ids.ASSISTANT_A, String(inner).slice(0, 8));
    });
    const restored = await currentActor(database);
    check('nested: leaving the inner scope restores the owner',
      restored === ids.OWNER_A, String(restored).slice(0, 8));
  });
  const after = await currentActor(database);
  check('and leaving the outer scope restores what was there before',
    after === null, after === null ? 'back to the server context' : String(after).slice(0, 8));

  // Restoration must survive a THROWN error, or a failed case poisons the rest.
  let threw = false;
  try {
    await asActor(database, ids.ASSISTANT_A, async () => {
      throw new Error('deliberate');
    });
  } catch {
    threw = true;
  }
  const afterThrow = await currentActor(database);
  check('a scope that throws still restores the actor',
    threw && afterThrow === null,
    afterThrow === null ? 'restored despite the throw' : `LEAKED: ${String(afterThrow).slice(0, 8)}`);
}

section('asRole restores the ROLE even when the statement fails');
{
  await database.query(`select set_actor($1)`, [null]);
  const failed = await asAuthenticated(database, () => database.query('select 1/0'));
  check('the failing statement is reported, not thrown', !failed.ok,
    failed.ok ? 'unexpectedly succeeded' : failed.err.slice(0, 40));
  const who = await query(database, `select current_user as u`);
  check('and current_user is the database owner again',
    who[0].u !== 'authenticated', `current_user=${who[0].u}`);
}

process.exit(await finish(database));