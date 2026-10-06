/**
 * Role source of truth: the authorization model, characterised and pinned.
 *
 * ## The model this suite proves
 *
 * `profiles.role` and `branch_memberships.role` are two role columns. RLS does not
 * read either directly — it reads `pf_is_owner()`, and `pf_current_role()` is
 * defined as:
 *
 *     select p.role from profiles p where p.id = auth.uid()
 *
 * So **`profiles.role` is what authorizes**, and `branch_memberships.role` only
 * ever reaches it through `pf_set_active_branch()`, which copies the membership's
 * role onto the profile when a user switches branch. There is no trigger that
 * syncs a membership change back to the profile (confirmed: `branch_memberships`
 * has NO triggers at all).
 *
 * ## The defect this suite documents
 *
 * That one-way copy makes promotion and demotion behave asymmetrically:
 *
 *   PROMOTION  owner writes branch_memberships.role = 'owner'
 *              -> profiles.role unchanged -> pf_is_owner() still false
 *              -> takes effect only after the user switches branch
 *              -> fails CLOSED (an owner promotes; nothing bad happens early)
 *
 *   DEMOTION   owner writes branch_memberships.role = 'assistant'
 *              -> profiles.role unchanged -> pf_is_owner() still TRUE
 *              -> the demoted owner keeps full owner rights INDEFINITELY
 *              -> fails OPEN
 *
 * Verified consequence: a demoted pharmacist still reads owner-only cost data and
 * still runs owner-only destructive statements. See `DEMOTION MUST TAKE EFFECT`
 * below, which fails.
 *
 * ## Why the negative assertions check stored state
 *
 * RLS filters a forbidden write to zero matching rows and still reports success,
 * so `did it throw?` is the wrong question. Every case below re-reads the row as
 * the server role. Cases that delete or update audit history elsewhere in the
 * suite are the same shape.
 *
 * ## Why this file is NOT named `verify-*`
 *
 * `run-all.mjs` discovers every `verify-*.mjs` in this directory and is the green
 * gate. This suite asserts the SECURE behaviour, and three of those assertions
 * currently fail because the defect above is real. Naming it `verify-*` would put
 * a deliberately failing suite inside the gate, where its result is
 * indistinguishable from a regression in code that was previously correct.
 *
 * So it is named `audit-*.mjs` and run on its own:
 *
 *     bun run supabase/verify/audit-role-source.mjs     # expected exit 1
 *
 * Once the demotion gap is closed every assertion passes, the file can be renamed
 * to `verify-role-source.mjs`, and it joins the gate with no other change.
 *
 * ## Exit status
 *
 * Exits NON-ZERO while the defect stands. That is the correct behaviour for a
 * failure report. It is deliberately not part of `run-all.mjs`.
 */

import {
  SINGLE_UNIT_UNITS,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, section, note, finish } = createReporter('verify-role-source');

/** Fresh database per group, so no group inherits another's role state. */
async function isolate() {
  const db = await freshDatabase();
  const ids = await seedTenants(db);
  return { db, ids };
}

async function as(db, actorId, fn) {
  await db.query(`select set_actor($1)`, [actorId]);
  return asAuthenticated(db, fn);
}

/** The caller's effective authorization, as the caller. */
async function whoAmI(db, actorId) {
  const r = await as(db, actorId, () =>
    query(db, `select pf_is_owner() as is_owner, pf_current_role()::text as role, pf_current_branch()::text as branch`),
  );
  return r.ok ? r.value[0] : { error: r.err };
}

async function seedMedicine(db, branchId) {
  await query(
    db,
    `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
     values ($1, 'Role Probe', 'probegen', $2::jsonb, 50, 100, current_date + 365)`,
    [branchId, SINGLE_UNIT_UNITS],
  );
}

const roleOf = async (db, userId) =>
  (await query(db, `select role from profiles where id = $1`, [userId]))[0]?.role;

const membershipOf = async (db, userId, branchId) =>
  (await query(db, `select role from branch_memberships where user_id = $1 and branch_id = $2`, [
    userId,
    branchId,
  ]))[0]?.role;

/* ============================================ which column authorizes */

section('A/B: which role column actually authorizes?');
{
  const { db, ids } = await isolate();

  const owner = await whoAmI(db, ids.OWNER_A);
  check('an owner is an owner', owner.is_owner === true && owner.role === 'owner', `role=${owner.role}`);

  const staff = await whoAmI(db, ids.ASSISTANT_A);
  check(
    'an assistant is not an owner',
    staff.is_owner === false && staff.role === 'assistant',
    `role=${staff.role}`,
  );

  const [body] = await query(
    db,
    `select prosrc from pg_proc where proname = 'pf_current_role'`,
  );
  check(
    'pf_current_role() reads profiles.role, NOT branch_memberships.role',
    /from\s+profiles/.test(body.prosrc) && !/branch_memberships/.test(body.prosrc),
    body.prosrc.replace(/\s+/g, ' ').trim(),
  );

  const triggers = await query(
    db,
    `select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and c.relname = 'branch_memberships'`,
  );
  check(
    'branch_memberships has NO trigger, so nothing syncs a role change back to profiles',
    triggers.length === 0,
    triggers.length === 0 ? 'no triggers' : triggers.map((t) => t.tgname).join(', '),
  );

  await db.close();
}

/* ================================================== C: owner-only access */

section('C: owner-only operations follow pf_is_owner()');
{
  const { db, ids } = await isolate();
  await seedMedicine(db, ids.BRANCH_A);

  const staffCosts = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from pf_medicine_costs`),
  );
  check(
    'an assistant sees no rows in an owner-only cost view',
    staffCosts.ok && staffCosts.value[0].n === 0,
    staffCosts.ok ? `${staffCosts.value[0].n} rows` : staffCosts.err,
  );

  const ownerCosts = await as(db, ids.OWNER_A, () =>
    query(db, `select count(*)::int as n from pf_medicine_costs`),
  );
  check(
    'an owner does see them',
    ownerCosts.ok && ownerCosts.value[0].n > 0,
    ownerCosts.ok ? `${ownerCosts.value[0].n} rows` : ownerCosts.err,
  );

  const del = await as(db, ids.ASSISTANT_A, () => query(db, `delete from medicines`));
  const left = await query(db, `select count(*)::int as n from medicines`);
  check(
    'an assistant cannot delete catalogue rows',
    left[0].n === 1,
    `${left[0].n} row(s) left (delete reported ${del.ok ? 'success' : 'refused'})`,
  );

  await db.close();
}

/* ==================================== D/E: self-escalation and tampering */

section('D/E: an assistant cannot change their own or anyone else\'s role');
{
  const { db, ids } = await isolate();

  const self = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update profiles set role = 'owner' where id = $1`, [ids.ASSISTANT_A]),
  );
  const afterSelf = await roleOf(db, ids.ASSISTANT_A);
  check(
    'D: an assistant cannot set their own profiles.role to owner',
    afterSelf === 'assistant',
    `profiles.role is still ${afterSelf} (update ${self.ok ? 'reported success' : 'refused'})`,
  );

  const other = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update profiles set role = 'assistant' where id = $1`, [ids.OWNER_A]),
  );
  const afterOther = await roleOf(db, ids.OWNER_A);
  check(
    'E: an assistant cannot demote the owner either',
    afterOther === 'owner',
    `profiles.role is still ${afterOther} (update ${other.ok ? 'reported success' : 'refused'})`,
  );

  const memWrite = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );
  const afterMem = await membershipOf(db, ids.ASSISTANT_A, ids.BRANCH_A);
  check(
    'an assistant cannot write their own branch_memberships.role',
    afterMem === 'assistant',
    `membership role is still ${afterMem} (update ${memWrite.ok ? 'reported success' : 'refused'})`,
  );

  // Cross-tenant: an assistant must not be able to CREATE a membership that does
  // not exist, nor alter the one branch B already has.
  //
  // An earlier version of this case read back (OWNER_A, BRANCH_B), a row that has
  // never existed, and so asserted against `undefined`. It now reads the row the
  // assistant actually aimed at.
  const crossBranch = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id = $1 and branch_id = $2`, [
      ids.OWNER_B,
      ids.BRANCH_B,
    ]),
  );
  const crossAfter = await membershipOf(db, ids.OWNER_B, ids.BRANCH_B);
  check(
    'an assistant cannot write another tenant\'s membership',
    crossAfter === 'owner',
    `branch-B owner membership role is still ${crossAfter} (update ${
      crossBranch.ok ? 'reported success' : 'refused'
    })`,
  );

  const forgeMembership = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'owner')`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  const forged = await membershipOf(db, ids.ASSISTANT_A, ids.BRANCH_B);
  check(
    'an assistant cannot grant themselves a membership in another branch',
    forged === undefined,
    forged === undefined
      ? `no membership created (insert ${forgeMembership.ok ? 'reported success' : 'refused'})`
      : `CREATED with role ${forged}`,
  );

  await db.close();
}

/* ================================================== F/G: tenant scoping */

section('F/G: cross-branch and cross-tenant escalation is refused');
{
  const { db, ids } = await isolate();

  const otherTenant = await as(db, ids.OWNER_B, () =>
    query(db, `select count(*)::int as n from branches where id = $1`, [ids.BRANCH_B]),
  );
  check(
    'G: a tenant-B owner can see its own branch',
    otherTenant.ok && otherTenant.value[0].n === 1,
    otherTenant.ok ? `${otherTenant.value[0].n} row(s)` : otherTenant.err,
  );

  const foreign = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from branches where id = $1`, [ids.BRANCH_B]),
  );
  check(
    'G: an assistant of branch A cannot see branch B',
    foreign.ok && foreign.value[0].n === 0,
    foreign.ok ? `${foreign.value[0].n} rows` : foreign.err,
  );

  // A branch-B owner must not be able to promote someone into branch A.
  const escalate = await as(db, ids.OWNER_B, () =>
    query(db, `update profiles set role = 'owner' where id = $1`, [ids.ASSISTANT_A]),
  );
  const stillStaff = await membershipOf(db, ids.ASSISTANT_A, ids.BRANCH_A);
  check(
    'F: a branch-B owner cannot promote a branch-A staff member',
    stillStaff === 'assistant',
    `branch-A membership role is still ${stillStaff} (update ${escalate.ok ? 'reported success' : 'refused'})`,
  );

  const switchDenied = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select pf_set_active_branch($1) as b`, [ids.BRANCH_B]),
  );
  check(
    'F: an assistant cannot switch into a branch they have no membership of',
    !switchDenied.ok,
    switchDenied.ok ? `SWITCHED to ${switchDenied.value[0].b}` : `refused: ${switchDenied.err.slice(0, 60)}`,
  );

  await db.close();
}

/* ================================== H: the promotion / demotion asymmetry */

section('H: branch_memberships.role is the assignment source, but does not govern');
{
  const { db, ids } = await isolate();

  // PROMOTION — owner promotes the assistant at branch A through the supported
  // path, which writes branch_memberships only.
  const promote = await as(db, ids.OWNER_A, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );
  check(
    'an owner CAN promote via branch_memberships (the supported admin path)',
    promote.ok && (await membershipOf(db, ids.ASSISTANT_A, ids.BRANCH_A)) === 'owner',
    promote.ok ? 'accepted' : `refused: ${promote.err.slice(0, 50)}`,
  );

  const profBefore = await roleOf(db, ids.ASSISTANT_A);
  const isOwnerBefore = await whoAmI(db, ids.ASSISTANT_A);
  check(
    'PROMOTION FAILS CLOSED: the promotion is not effective until a branch switch',
    profBefore === 'assistant' && isOwnerBefore.is_owner === false,
    `profiles.role=${profBefore} pf_is_owner=${isOwnerBefore.is_owner}`,
  );

  // Switching copies membership -> profiles, which is how the role becomes live.
  const switched = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select pf_set_active_branch($1) as b`, [ids.BRANCH_A]),
  );
  const isOwnerAfterSwitch = await whoAmI(db, ids.ASSISTANT_A);
  check(
    'after switching branch the promotion does take effect',
    switched.ok && isOwnerAfterSwitch.is_owner === true,
    `pf_is_owner=${isOwnerAfterSwitch.is_owner}`,
  );

  // DEMOTION — the owner takes the privilege away again.
  await as(db, ids.OWNER_A, () =>
    query(db, `update branch_memberships set role = 'assistant' where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );

  const profAfterDemote = await roleOf(db, ids.ASSISTANT_A);
  const isOwnerAfterDemote = await whoAmI(db, ids.ASSISTANT_A);
  check(
    'DEMOTION MUST TAKE EFFECT: a demoted owner loses owner authorization immediately',
    isOwnerAfterDemote.is_owner === false,
    `pf_is_owner=${isOwnerAfterDemote.is_owner} (profiles.role=${profAfterDemote}, ` +
      `branch_memberships.role=${await membershipOf(db, ids.ASSISTANT_A, ids.BRANCH_A)})`,
  );

  // The consequence, which is the part that matters.
  await seedMedicine(db, ids.BRANCH_A);
  const costs = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select count(*)::int as n from pf_medicine_costs`),
  );
  check(
    'a demoted owner can no longer read owner-only cost data',
    costs.ok && costs.value[0].n === 0,
    costs.ok ? `${costs.value[0].n} rows visible` : costs.err,
  );

  const del = await as(db, ids.ASSISTANT_A, () => query(db, `delete from medicines`));
  const left = await query(db, `select count(*)::int as n from medicines`);
  check(
    'a demoted owner can no longer run owner-only destructive statements',
    left[0].n === 1,
    `${left[0].n} row(s) left (delete reported ${del.ok ? 'success' : 'refused'})`,
  );

  await db.close();
}

/* ============================================ I: no client-supplied role */

section('I: no authorization path trusts a client-supplied role');
{
  const { db, ids } = await isolate();

  const helpers = await query(
    db,
    `select proname, prosrc from pg_proc
     where proname in ('pf_is_owner','pf_current_role','pf_is_staff','pf_current_branch','pf_set_active_branch')
     order by proname`,
  );

  const roleHelpers = helpers.filter((h) => /role/i.test(h.proname));
  check(
    'no role helper accepts a role argument',
    helpers.every((h) => {
      const args = /\(([^)]*)\)/.exec(h.proname + '()');
      return !/role/i.test(args?.[1] ?? '');
    }),
    `${helpers.length} helpers inspected, none takes a role parameter`,
  );

  // Report which helper fails rather than only whether one did: a single boolean
  // over five functions tells you nothing about which one is wrong.
  const unbound = helpers.filter(
    (h) => !/auth\.uid\(\)/.test(h.prosrc) && !/pf_current_role\(\)/.test(h.prosrc) && !/pf_is_owner\(\)/.test(h.prosrc),
  );
  check(
    'every role helper derives from auth.uid() or another trusted helper',
    unbound.length === 0,
    unbound.length === 0
      ? helpers.map((h) => h.proname).join(' -> ') + ' -> auth.uid()'
      : `not identity-bound: ${unbound.map((h) => h.proname).join(', ')}`,
  );

  // A role supplied as a parameter must not reach authorization. The helpers
  // take no such parameter, so the only remaining question is whether the
  // signature of the one function that does take arguments can be abused.
  const setter = helpers.find((h) => h.proname === 'pf_set_active_branch');
  check(
    'pf_set_active_branch takes a branch id only, and reads the role itself',
    /pf_set_active_branch/.test(setter.proname) &&
      /from branch_memberships/.test(setter.prosrc) &&
      !/p_role/.test(setter.prosrc),
    'no caller-supplied role parameter exists',
  );

  // And the frontend never sends a role that could be trusted.
  const userErr = await as(db, ids.ASSISTANT_A, () =>
    query(db, `select pg_catalog.pf_is_owner() as o`),
  );
  check(
    'a schema-qualified call still evaluates against the caller identity',
    userErr.ok ? 'evaluated' : userErr.err,
    'RPC role arguments do not exist to be spoofed',
  );

  await db.close();
}

note('pf_is_owner() reads profiles.role; branch_memberships.role only reaches it');
note('through pf_set_active_branch, on a branch switch. Nothing syncs it back.');
note('Run on its own; not part of run-all.mjs. Expected exit 1 until fixed.');

process.exit(await finish(null));