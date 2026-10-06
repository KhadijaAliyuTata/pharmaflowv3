/**
 * Branch membership is the authoritative role source.
 *
 * Replaces `audit-role-source.mjs`, which was a failure report. That file
 * documented a confirmed fail-open defect: `pf_is_owner()` read `profiles.role`,
 * which a membership change never updated, so promoting someone took effect only
 * after a branch switch (fails closed) while demoting them never took effect at
 * all (fails open). A demoted owner kept reading owner-only cost data and kept
 * running owner-only destructive statements.
 *
 * The defect is fixed by migration
 * `20261005250000_branch_membership_role_authority.sql`. This suite is now a
 * normal gate member named `verify-*`, and every case here asserts the SECURE
 * behaviour.
 *
 * ## Assertion style
 *
 * Every negative case re-reads the affected row as the server role. An
 * RLS-forbidden write matches zero rows and reports success, so "did it throw?"
 * is the wrong question. Several cases below would pass for entirely the wrong
 * reason if they trusted the error alone.
 *
 * Isolation is one freshly migrated database per group, so no group inherits a
 * role state from another.
 */

import {
  SINGLE_UNIT_UNITS,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, section, note, finish } = createReporter('verify-role-authority');

/** Fresh database, tenants seeded, nothing else done. */
async function isolate() {
  const db = await freshDatabase();
  const ids = await seedTenants(db);
  return { db, ids };
}

async function as(db, actorId, fn) {
  await db.query(`select set_actor($1)`, [actorId]);
  return asAuthenticated(db, fn);
}

/** The caller's effective authorization, evaluated as the caller. */
async function effective(db, actorId) {
  const r = await as(db, actorId, () =>
    query(db, `select pf_is_owner() as is_owner, pf_current_role()::text as role`),
  );
  return r.ok ? r.value[0] : { error: r.err };
}

const membershipRole = async (db, userId, branchId) =>
  (await query(db, `select role from branch_memberships where user_id = $1 and branch_id = $2`, [
    userId,
    branchId,
  ]))[0]?.role;

const profileRole = async (db, userId) =>
  (await query(db, `select role from profiles where id = $1`, [userId]))[0]?.role;

/** Owner writes a membership role, the supported admin path. */
const setMembershipRole = (db, ownerId, userId, branchId, role) =>
  as(db, ownerId, () =>
    query(
      db,
      `update branch_memberships set role = $3 where user_id = $1 and branch_id = $2`,
      [userId, branchId, role],
    ),
  );

async function seedMedicine(db, branchId) {
  await query(
    db,
    `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
     values ($1, 'Authority Probe', 'authgen', $2::jsonb, 50, 100, current_date + 365)`,
    [branchId, SINGLE_UNIT_UNITS],
  );
}

/* ==================================================== A / B: basic identity */

section('A/B: owner is owner, assistant is not');
{
  const { db, ids } = await isolate();

  const owner = await effective(db, ids.OWNER_A);
  check('A: the branch owner is an owner', owner.is_owner === true, `pf_is_owner()=${owner.is_owner}`);

  const staff = await effective(db, ids.ASSISTANT_A);
  check('B: an assistant is not an owner', staff.is_owner === false, `pf_is_owner()=${staff.is_owner}`);

  check(
    'and the role reported for each is the membership role',
    owner.role === 'owner' && staff.role === 'assistant',
    `owner=${owner.role}, assistant=${staff.role}`,
  );

  await db.close();
}

/* ============================ the resolution chain itself (M, and STEP 2) */

section('the resolution chain reads branch_memberships, not profiles.role');
{
  const { db, ids } = await isolate();

  const [body] = await query(db, `select prosrc, prosecdef from pg_proc where proname = 'pf_current_role'`);
  const executable = body.prosrc
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('--'))
    .join(' ');
  check(
    'pf_current_role() reads branch_memberships',
    /from\s+branch_memberships/.test(executable),
    executable.replace(/\s+/g, ' ').trim(),
  );
  check(
    'and no longer reads profiles.role',
    !/from\s+profiles/.test(executable),
    'comments may mention profiles.role; the executable body does not read it',
  );
  check(
    'it stays SECURITY DEFINER, which is load-bearing because the table it reads has RLS',
    body.prosecdef === true,
    `prosecdef=${body.prosecdef}`,
  );

  // M: identity binding. An earlier version of this case joined pg_proc to pg_type
  // on a column that does not exist (`typid` is on pg_type, and it was being read
  // off pg_proc), which crashed the run before any of the cases below could run.
  const signatures = await query(
    db,
    `select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
     from pg_proc p
     where p.proname in ('pf_current_role','pf_is_owner','pf_current_branch','pf_set_active_branch')
     order by p.proname`,
  );
  check(
    'M: all four authorization helpers are present',
    signatures.length === 4,
    signatures.map((s) => s.proname).join(', '),
  );
  check(
    'N: no helper accepts a caller-supplied user id or role',
    signatures.every((s) => !/role|user|actor/i.test(s.args)),
    signatures.map((s) => `${s.proname}(${s.args})`).join(', '),
  );
  check(
    'the read-only helpers stay SECURITY DEFINER so they can read what RLS hides',
    signatures.filter((s) => s.proname !== 'pf_set_active_branch').every((s) => s.prosecdef === true),
    signatures.map((s) => `${s.proname}=${s.prosecdef}`).join(', '),
  );

  await db.close();
}

/* ================== C / D: promotion and demotion take effect immediately */

section('C/D: promotion and demotion are immediate, with no branch switch');
{
  const { db, ids } = await isolate();

  check('fixture: the assistant starts with no owner rights', (await effective(db, ids.ASSISTANT_A)).is_owner === false, 'pf_is_owner()=false');

  // ---- C: promote
  const promoted = await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'owner');
  check(
    'C1: the owner can promote via branch_memberships',
    promoted.ok && (await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_A)) === 'owner',
    promoted.ok ? 'accepted' : `refused: ${promoted.err.slice(0, 50)}`,
  );

  const afterPromote = await effective(db, ids.ASSISTANT_A);
  check(
    'C2: the promotion is effective IMMEDIATELY, with no branch switch',
    afterPromote.is_owner === true && afterPromote.role === 'owner',
    `pf_is_owner()=${afterPromote.is_owner} role=${afterPromote.role} ` +
      `(profiles.role cache still reads ${await profileRole(db, ids.ASSISTANT_A)})`,
  );

  const costs = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from pf_medicine_costs`),
  );
  check(
    'C3: a promoted user can read owner-only cost data at once',
    costs.ok && costs.value[0].n === 0,
    `pf_medicine_costs rows=${costs.ok ? costs.value[0].n : costs.err} (0 = no medicine seeded yet)`,
  );

  // ---- D: demote
  const demoted = await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'assistant');
  check(
    'D1: the owner can demote via branch_memberships',
    demoted.ok && (await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_A)) === 'assistant',
    demoted.ok ? 'accepted' : `refused: ${demoted.err.slice(0, 50)}`,
  );

  const afterDemote = await effective(db, ids.ASSISTANT_A);
  check(
    'D2: the demotion is effective IMMEDIATELY, with no branch switch',
    afterDemote.is_owner === false && afterDemote.role === 'assistant',
    `pf_is_owner()=${afterDemote.is_owner} role=${afterDemote.role} ` +
      `(profiles.role cache still reads ${await profileRole(db, ids.ASSISTANT_A)}, which no longer matters)`,
  );

  await db.close();
}

/* =============== E: the exact consequences the defect allowed (the regression) */

section('E: a demoted user loses owner-only read, write and destructive access');
{
  const { db, ids } = await isolate();
  await seedMedicine(db, ids.BRANCH_A);

  // Reach owner, then get demoted. This is the sequence that used to fail open.
  await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'owner');
  check('fixture: the user holds owner rights before the demotion', (await effective(db, ids.ASSISTANT_A)).is_owner === true, 'pf_is_owner()=true');

  await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'assistant');

  // E1: owner-only READ
  const costs = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from pf_medicine_costs`),
  );
  check(
    'E1: a demoted owner cannot read owner-only cost data',
    costs.ok && costs.value[0].n === 0,
    costs.ok ? `${costs.value[0].n} rows visible` : costs.err,
  );

  // E2: owner-only DESTRUCTIVE
  const del = await as(db, ids.ASSISTANT_A, () => query(db, `delete from medicines`));
  const left = await query(db, `select count(*)::int as n from medicines`);
  check(
    'E2: a demoted owner cannot delete catalogue rows',
    left[0].n === 1,
    `${left[0].n} row(s) left (delete reported ${del.ok ? 'success' : 'refused'})`,
  );

  // E3: owner-only WRITE
  const audit = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from audit_events`),
  );
  check(
    'E3: a demoted owner cannot read the owner-only audit log',
    audit.ok && audit.value[0].n === 0,
    audit.ok ? `${audit.value[0].n} rows visible` : audit.err,
  );

  const membershipWrite = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );
  const stillStaff = await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_A);
  check(
    'E4: a demoted owner cannot promote themselves back through branch_memberships',
    stillStaff === 'assistant',
    `membership role is still ${stillStaff} (update ${membershipWrite.ok ? 'reported success' : 'refused'})`,
  );

  await db.close();
}

/* ==================================== F: the stale cache can grant nothing */

section('F/K/L: a stale profiles.role neither grants nor withholds');
{
  const { db, ids } = await isolate();
  await seedMedicine(db, ids.BRANCH_A);

  // ---- K: stale 'owner' in the cache, membership says assistant.
  const staleOwner = await as(db, ids.OWNER_A, () =>
    query(db, `update profiles set role = 'owner' where id = $1`, [ids.ASSISTANT_A]),
  );
  check(
    'K1: the cache can be forced to read owner by an owner write',
    staleOwner.ok && (await profileRole(db, ids.ASSISTANT_A)) === 'owner',
    `profiles.role=${await profileRole(db, ids.ASSISTANT_A)} (update ${staleOwner.ok ? 'accepted' : 'refused'})`,
  );

  const kEff = await effective(db, ids.ASSISTANT_A);
  check(
    'K2: a stale profiles.role = owner grants NOTHING when the membership says assistant',
    kEff.is_owner === false && kEff.role === 'assistant',
    `pf_is_owner()=${kEff.is_owner} role=${kEff.role}`,
  );

  const kCosts = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from pf_medicine_costs`),
  );
  check(
    'K3: and owner-only cost data stays out of reach',
    kCosts.ok && kCosts.value[0].n === 0,
    kCosts.ok ? `${kCosts.value[0].n} rows visible` : kCosts.err,
  );

  const kDel = await as(db, ids.ASSISTANT_A, () => query(db, `delete from medicines`));
  const kLeft = await query(db, `select count(*)::int as n from medicines`);
  check(
    'K4: and owner-only destructive statements stay refused',
    kLeft[0].n === 1,
    `${kLeft[0].n} row(s) left (delete reported ${kDel.ok ? 'success' : 'refused'})`,
  );

  // ---- L: stale 'assistant' in the cache, membership says owner.
  const { db: db2, ids: ids2 } = await isolate();
  await setMembershipRole(db2, ids2.OWNER_A, ids2.ASSISTANT_A, ids2.BRANCH_A, 'owner');
  await as(db2, ids2.OWNER_A, () =>
    query(db2, `update profiles set role = 'assistant' where id = $1`, [ids2.ASSISTANT_A]),
  );
  const lCache = await profileRole(db2, ids2.ASSISTANT_A);
  const lEff = await effective(db2, ids2.ASSISTANT_A);
  check(
    'L: a stale profiles.role = assistant does NOT withhold a legitimate owner membership',
    lCache === 'assistant' && lEff.is_owner === true && lEff.role === 'owner',
    `profiles.role=${lCache} but pf_is_owner()=${lEff.is_owner} role=${lEff.role}`,
  );
  await seedMedicine(db2, ids2.BRANCH_A);
  const lCosts = await as(db2, ids2.ASSISTANT_A, () =>
    query(db2, `select count(*)::int as n from pf_medicine_costs`),
  );
  check(
    'L2: and owner-only cost data is genuinely reachable',
    lCosts.ok && lCosts.value[0].n === 1,
    lCosts.ok ? `${lCosts.value[0].n} row(s) visible` : lCosts.err,
  );
  await db2.close();

  await db.close();
}

/* ==================================== G/H: self-modification and tenancy */

section('G/H/I: self-modification, cross-tenant and cross-branch are refused');
{
  const { db, ids } = await isolate();

  const own = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );
  const ownAfter = await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_A);
  check(
    'G1: a user cannot modify their own membership role',
    ownAfter === 'assistant',
    `membership role is still ${ownAfter} (update ${own.ok ? 'reported success' : 'refused'})`,
  );

  const forge = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'owner')`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  const forged = await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_B);
  check(
    'G2: a user cannot forge themselves a membership in another branch',
    forged === undefined,
    forged === undefined
      ? `no membership created (insert ${forge.ok ? 'reported success' : 'refused'})`
      : `CREATED with role ${forged}`,
  );

  const otherTenant = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update branch_memberships set role = 'assistant' where user_id = $1 and branch_id = $2`, [
      ids.OWNER_B,
      ids.BRANCH_B,
    ]),
  );
  const tenantAfter = await membershipRole(db, ids.OWNER_B, ids.BRANCH_B);
  check(
    'H: a user cannot modify a membership belonging to another tenant',
    tenantAfter === 'owner',
    `branch-B owner membership is still ${tenantAfter} (update ${otherTenant.ok ? 'reported success' : 'refused'})`,
  );

  // I: an owner membership in branch A must grant nothing in branch B.
  await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'owner');
  const inA = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select pf_is_owner() as o, pf_current_branch()::text as b`),
  );
  check(
    'I1: the branch-A promotion works while branch A is active',
    inA.value[0].o === true,
    `pf_is_owner()=${inA.value[0].o}`,
  );

  const foreign = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from branches where id = $1`, [ids.BRANCH_B]),
  );
  check(
    'I2: a branch-A owner cannot see branch B',
    foreign.ok && foreign.value[0].n === 0,
    foreign.ok ? `${foreign.value[0].n} rows` : foreign.err,
  );

  await db.close();
}

/* ================================== J: switching resolves the new branch role */

section('J: switching branches resolves the membership role for that branch');
{
  const { db, ids } = await isolate();

  // Give the assistant an owner membership at branch B only.
  await as(db, ids.OWNER_B, () =>
    query(db, `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'owner')`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  const created = await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_B);
  check('fixture: an owner membership exists at branch B', created === 'owner', `membership.role=${created}`);

  const before = await effective(db, ids.ASSISTANT_A);
  check(
    'while branch A is active, the branch-B membership grants nothing',
    before.is_owner === false,
    `pf_is_owner()=${before.is_owner}`,
  );

  const switched = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select pf_set_active_branch($1) as b`, [ids.BRANCH_B]),
  );
  check('the switch to branch B is accepted', switched.ok, switched.ok ? `now ${switched.value[0].b}` : switched.err);

  const after = await effective(db, ids.ASSISTANT_A);
  check(
    'J2: after switching, the branch-B membership role governs',
    after.is_owner === true && after.role === 'owner',
    `pf_is_owner()=${after.is_owner} role=${after.role}`,
  );

  // And switching back must hand the authority back.
  await as(db, ids.ASSISTANT_A, () => query(db, `select pf_set_active_branch($1)`, [ids.BRANCH_A]));
  const back = await effective(db, ids.ASSISTANT_A);
  check(
    'J3: switching back to branch A restores the branch-A role',
    back.is_owner === false && back.role === 'assistant',
    `pf_is_owner()=${back.is_owner} role=${back.role}`,
  );

  // The assistant now holds a membership at branch B, so switching there is
  // legitimately allowed. Revoke it, then prove the switch is refused and the
  // active branch does not move.
  await as(db, ids.OWNER_B, () =>
    query(db, `delete from branch_memberships where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  const denied = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select pf_set_active_branch($1) as b`, [ids.BRANCH_B]),
  );
  const activeNow = await query(db, `select branch_id from profiles where id = $1`, [ids.ASSISTANT_A]);
  check(
    'J4: switching to a branch with no membership is refused',
    !denied.ok,
    denied.ok ? `SWITCHED to ${denied.value[0].b}` : `refused: ${denied.err.slice(0, 55)}`,
  );
  check(
    'J5: and the refused switch left the active branch untouched',
    activeNow[0].branch_id === ids.BRANCH_A,
    `active branch is ${String(activeNow[0].branch_id).slice(0, 8)}`,
  );

  // Revoking a membership by deleting it must also take effect at once, since
  // there is no cache left to go stale.
  await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'owner');
  check('fixture: the user is an owner again', (await effective(db, ids.ASSISTANT_A)).is_owner === true, 'pf_is_owner()=true');
  const revoke = await as(db, ids.OWNER_A, () =>
    query(db, `delete from branch_memberships where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );
  const afterRevoke = await effective(db, ids.ASSISTANT_A);
  check(
    'J6: deleting the membership revokes owner authorization immediately',
    revoke.ok && afterRevoke.is_owner === false && afterRevoke.role === null,
    `delete ${revoke.ok ? 'accepted' : 'refused'}; pf_is_owner()=${afterRevoke.is_owner} role=${afterRevoke.role}`,
  );

  await db.close();
}

/* ================================= the sync trigger no longer writes the source */

section('the cache can no longer rewrite the authoritative role');
{
  const { db, ids } = await isolate();

  // Assert on the executable body only. The function's comment block still names the
  // old `do update set role` clause in order to explain why it was removed, and a
  // comment is not an instruction the database will follow. An earlier version of
  // this assertion matched the comment and reported a false failure.
const [sync] = await query(
    db,
    `select prosrc from pg_proc where proname = 'pf_sync_profile_membership'`,
  );
  const syncBody = sync.prosrc
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('--'))
    .join(' ');
  check(
    'pf_sync_profile_membership uses on conflict do nothing',
    /on\s+conflict[\s\S]*do\s+nothing/i.test(syncBody),
    syncBody.replace(/\s+/g, ' ').match(/on conflict[^;]*/i)?.[0] ?? 'no conflict clause found',
  );
  check(
    'and never overwrites an existing membership role from the cache',
    !/do\s+update\s+set\s+role/i.test(syncBody),
    'no `do update set role` clause in the executable body',
  );

  // Empirically: force the cache to owner and confirm the membership is untouched.
  await as(db, ids.OWNER_A, () =>
    query(db, `update profiles set role = 'owner' where id = $1`, [ids.ASSISTANT_A]),
  );
  const after = await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_A);
  const eff = await effective(db, ids.ASSISTANT_A);
  check(
    'editing profiles.role does not rewrite the membership row',
    after === 'assistant' && eff.is_owner === false,
    `membership.role=${after}, pf_is_owner()=${eff.is_owner}`,
  );

  await db.close();
}

note('branch_memberships.role is authoritative; profiles.role is a display cache.');
note('A promotion or demotion is effective immediately, with no branch switch.');

process.exit(await finish(null));