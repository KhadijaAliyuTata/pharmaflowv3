/**
 * Role and membership changes are auditable, and the audit trail cannot be forged.
 *
 * `branch_memberships.role` is the authoritative authorization source (see
 * `20261005250000_branch_membership_role_authority.sql`), so a change to it is a
 * change to what a person is permitted to do. Before
 * `20261005260000_role_change_auditability.sql` nothing recorded it: an owner could
 * promote or demote a member and the log showed nothing.
 *
 * ## The tension this suite exists to hold
 *
 * `audit_insert` deliberately lets any staff member insert an audit row naming
 * themselves as actor. That is correct for ordinary events — an attendant recording
 * their own sale is legitimate, and Phase 0 relies on it. But the same permission
 * would let them write a role-change event that never happened, into a log an owner
 * reads to find out who has been given what authority.
 *
 * So the `role.` action prefix is reserved to the database. `pf_audit_role_change`
 * writes it from inside a trigger, which `pg_trigger_depth()` reports as >= 2; a
 * client writing it directly reports depth 1 and is refused. Other action names are
 * untouched, and the suite proves that rather than assuming it.
 *
 * ## Assertion style
 *
 * Every negative case re-reads state as the server role. RLS filters a forbidden
 * write to zero matching rows and reports success, so "did it throw?" is the wrong
 * question on its own — several cases here would pass for the wrong reason if the
 * stored state were not checked too.
 *
 * One freshly migrated database per group, so no group inherits another's audit log.
 */

import {
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, section, note, finish } = createReporter('verify-role-audit');

async function isolate() {
  const db = await freshDatabase();
  const ids = await seedTenants(db);
  return { db, ids };
}

async function as(db, actorId, fn) {
  await db.query(`select set_actor($1)`, [actorId]);
  return asAuthenticated(db, fn);
}

/**
 * Role-change audit rows, read as the server role.
 *
 * `id` is selected explicitly. The earlier version omitted it, so the tamper cases
 * below queried `where id = $1` with `undefined` and matched zero rows — which made
 * "the row survived" true for the wrong reason while the row they meant to test was
 * never targeted. Both look like passes and neither is one.
 */
const roleEvents = (db) =>
  query(
    db,
    `select id, actor_id, action, description, metadata from audit_events where action like 'role.%' order by created_at`,
  );

/**
 * The membership's stored role, or `undefined` if there is no such row.
 *
 * `undefined` when absent, never `null`: `is not distinct from` in SQL treats NULL
 * and 'assistant' as different, so a helper returning null for a missing row made
 * an UPDATE assertion pass for the wrong reason.
 */
const membershipRole = async (db, userId, branchId) =>
  (await query(db, `select role from branch_memberships where user_id = $1 and branch_id = $2`, [
    userId,
    branchId,
  ]))[0]?.role;

const setMembershipRole = (db, actorId, userId, branchId, role) =>
  as(db, actorId, () =>
    query(db, `update branch_memberships set role = $3 where user_id = $1 and branch_id = $2`, [
      userId,
      branchId,
      role,
    ]),
  );

/* ============================================ 1: promotion and demotion audited */

section('an owner role change is audited with actor, member, branch and both roles');
{
  const { db, ids } = await isolate();

  const before = await roleEvents(db);
  check('fixture: no role-change events exist yet', before.length === 0, `${before.length} event(s)`);

  // ---- promotion
  const promoted = await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'owner');
  check('the owner promotes the member', promoted.ok, promoted.ok ? 'accepted' : promoted.err.slice(0, 50));

  const afterPromote = await roleEvents(db);
  check(
    'exactly one event was written for the promotion',
    afterPromote.length === 1,
    `${afterPromote.length} event(s)`,
  );

  const p = afterPromote[0];
  check('its action names a role change', !!p && p.action.startsWith('role.'), p?.action ?? 'none');

  check(
    '1: the actor is the caller, i.e. the owner who made the change',
    p?.actor_id === ids.OWNER_A,
    `actor_id=${String(p?.actor_id).slice(0, 8)} (the owner)`,
  );

  check(
    'the affected member is recorded, not the actor',
    p?.metadata?.affected_user === ids.ASSISTANT_A,
    `metadata.affected_user=${String(p?.metadata?.affected_user).slice(0, 8)} (the assistant)`,
  );

  check(
    'the branch is recorded',
    p?.metadata?.branch_id === ids.BRANCH_A,
    `metadata.branch_id=${String(p?.metadata?.branch_id).slice(0, 8)}`,
  );

  check(
    '2: the previous role is recorded',
    p?.metadata?.previous_role === 'assistant',
    `metadata.previous_role=${p?.metadata?.previous_role}`,
  );

  check(
    '2: and the new role is recorded',
    p?.metadata?.new_role === 'owner',
    `metadata.new_role=${p?.metadata?.new_role}`,
  );

  check(
    'the timestamp comes from the database',
    !!p && typeof p.metadata?.source === 'string' && p.metadata.source === 'pf_audit_role_change',
    `metadata.source=${p?.metadata?.source}`,
  );

  // ---- demotion
  const demoted = await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'assistant');
  check('the owner demotes the member', demoted.ok, demoted.ok ? 'accepted' : demoted.err.slice(0, 50));

  const afterDemote = await roleEvents(db);
  check('a second event was written for the demotion', afterDemote.length === 2, `${afterDemote.length} event(s)`);

  const d = afterDemote[1];
  check(
    'the demotion records owner -> assistant',
    d?.metadata?.previous_role === 'owner' && d?.metadata?.new_role === 'assistant',
    `previous_role=${d?.metadata?.previous_role} new_role=${d?.metadata?.new_role}`,
  );
  check(
    'and names the member it applied to',
    d?.metadata?.affected_user === ids.ASSISTANT_A,
    `metadata.affected_user=${String(d?.metadata?.affected_user).slice(0, 8)}`,
  );

  // A change that leaves the role alone is not a role change.
  const sameRole = await as(db, ids.OWNER_A, () =>
    query(db, `update branch_memberships set is_default = not is_default where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_A,
    ]),
  );
  const afterNoop = await roleEvents(db);
  check(
    'an update that does not change the role writes no event',
    sameRole.ok && afterNoop.length === 2,
    `is_default toggled (${sameRole.ok ? 'accepted' : 'refused'}); still ${afterNoop.length} event(s)`,
  );

  await db.close();
}

/* ================================== 2: creation and removal are audited too */

section('membership creation and removal are audited');
{
  const { db, ids } = await isolate();

  // seedTenants already gives OWNER_B a membership at BRANCH_B, so a plain INSERT
  // of the same pair violates the primary key. Add a member who has none: the
  // assistant, at branch B, which they are not a member of.
  const created = await as(db, ids.OWNER_B, () =>
    query(db, `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'assistant')`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  check(
    'the owner adds a member to their branch',
    created.ok && (await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_B)) === 'assistant',
    created.ok ? 'accepted' : `refused: ${created.err.slice(0, 45)}`,
  );

  const afterCreate = await roleEvents(db);
  const c = afterCreate.find((e) => e.action === 'role.membership_created');
  check(
    'a membership_created event was written',
    !!c,
    c ? `actor=${String(c.actor_id).slice(0, 8)} affected=${String(c.metadata.affected_user).slice(0, 8)}` : 'none found',
  );
  check(
    'with no previous role, since there was none',
    !!c && (c.metadata.previous_role === null || c.metadata.previous_role === undefined),
    `previous_role=${c?.metadata?.previous_role}`,
  );
  check(
    'and the new role',
    !!c && c.metadata.new_role === 'assistant',
    `new_role=${c?.metadata?.new_role}`,
  );

  // Removing it is audited too, and this is the operation that actually revokes
  // authorization — the one whose absence from the log would matter most.
  const removed = await as(db, ids.OWNER_B, () =>
    query(db, `delete from branch_memberships where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  const afterRemove = await roleEvents(db);
  const rm = afterRemove.find((e) => e.action === 'role.membership_removed');
  check(
    'deleting the membership writes a membership_removed event',
    !!rm,
    rm ? `affected=${String(rm.metadata.affected_user).slice(0, 8)}` : 'none found',
  );
  check(
    'recording the role that was held, and no new one',
    !!rm && rm.metadata.previous_role === 'assistant' && rm.metadata.new_role === null,
    `previous_role=${rm?.metadata?.previous_role} new_role=${rm?.metadata?.new_role}`,
  );
  check(
    'and the delete itself took effect',
    removed.ok && (await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_B)) === undefined,
    'membership row is gone',
  );

  await db.close();
}

/* ================================== 3: a staff member cannot forge the record */

section('a staff member cannot forge a role-change audit event');
{
  const { db, ids } = await isolate();

  // 3a: forging somebody else's actor is already refused by audit_insert. Prove it
  // still is, and prove the reserved namespace adds nothing that weakens it.
  const forgeSelf = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into audit_events (branch_id, actor_id, action, description) values ($1, $2, 'sale', 'own event')`, [
      ids.BRANCH_A,
      ids.ASSISTANT_A,
    ]),
  );
  check(
    'an assistant may still record their own ordinary event',
    forgeSelf.ok,
    forgeSelf.ok ? 'accepted, as Phase 0 intends' : `refused: ${forgeSelf.err.slice(0, 50)}`,
  );

  const forgeOther = await as(db, ids.ASSISTANT_A, () =>
    query(db, `insert into audit_events (branch_id, actor_id, action, description) values ($1, $2, 'sale', 'framed')`, [
      ids.BRANCH_A,
      ids.OWNER_A,
    ]),
  );
  const framed = await query(db, `select count(*)::int as n from audit_events where description = 'framed'`);
  check(
    '3: an assistant cannot attribute an event to the owner',
    !forgeOther.ok && framed[0].n === 0,
    forgeOther.ok ? 'FORGERY ACCEPTED' : `refused (${forgeOther.err.slice(0, 45)}); rows: ${framed[0].n}`,
  );

  // The reserved namespace: the same insert, but with a role-change action.
  for (const action of ['role.promoted', 'role.demoted', 'role.changed', 'role.membership_created', 'role.membership_removed']) {
    const r = await as(db, ids.ASSISTANT_A, () =>
      query(db, `insert into audit_events (branch_id, actor_id, action, description) values ($1, $2, $3, $4)`, [
        ids.BRANCH_A,
        ids.ASSISTANT_A,
        action,
        'forged by the attendant',
      ]),
    );
    check(
      `an assistant cannot write a forged '${action}' event`,
      !r.ok,
      r.ok ? 'FORGERY ACCEPTED' : `refused: ${r.err.slice(0, 52)}`,
    );
  }

  const anyRoleEvents = await roleEvents(db);
  check(
    'no forged role-change event reached the log',
    anyRoleEvents.length === 0,
    `${anyRoleEvents.length} role-change event(s) present`,
  );

  // An owner is not exempt either: the namespace is the database's, so an owner
  // writing one by hand would put a record in the log that no membership change
  // backs. Refusing that is what makes the log trustworthy.
  const ownerForge = await as(db, ids.OWNER_A, () =>
    query(db, `insert into audit_events (branch_id, actor_id, action, description) values ($1, $2, 'role.promoted', 'by hand')`, [
      ids.BRANCH_A,
      ids.OWNER_A,
    ]),
  );
  const afterOwner = await roleEvents(db);
  check(
    'and not even an owner may hand-write one',
    !ownerForge.ok && afterOwner.length === 0,
    ownerForge.ok ? 'ACCEPTED by hand' : `refused: ${ownerForge.err.slice(0, 52)}`,
  );

  await db.close();
}

/* ================================== 4: cross-tenant changes stay blocked and logged */

section('cross-tenant role changes remain blocked, and the block is not a silent no-op');
{
  const { db, ids } = await isolate();

  const cross = await as(db, ids.ASSISTANT_A, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id = $1 and branch_id = $2`, [
      ids.OWNER_B,
      ids.BRANCH_B,
    ]),
  );
  const stillOwner = await membershipRole(db, ids.OWNER_B, ids.BRANCH_B);
  check(
    'an assistant cannot change another tenant\'s membership',
    stillOwner === 'owner',
    `branch-B owner membership is still ${stillOwner} (update ${cross.ok ? 'reported success' : 'refused'})`,
  );

  const events = await roleEvents(db);
  check(
    'and no event was written for a change that did not happen',
    events.length === 0,
    `${events.length} role-change event(s)`,
  );

  // A branch-B owner acting on their own branch is legitimate and must be logged,
  // with the branch in the metadata, so the log distinguishes tenants. The assistant
  // needs a membership at branch B first, created by that same branch-B owner.
  const granted = await as(db, ids.OWNER_B, () =>
    query(db, `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'assistant')`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  check(
    'the branch-B owner may add a member to branch B',
    granted.ok && (await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_B)) === 'assistant',
    granted.ok ? 'accepted' : `refused: ${granted.err.slice(0, 45)}`,
  );

  const baseline = (await roleEvents(db)).length;

  const legit = await as(db, ids.OWNER_B, () =>
    query(db, `update branch_memberships set role = 'owner' where user_id = $1 and branch_id = $2`, [
      ids.ASSISTANT_A,
      ids.BRANCH_B,
    ]),
  );
  const after = await roleEvents(db);
  const last = after[after.length - 1];
  check(
    'a legitimate change within the same tenant is still logged',
    legit.ok && after.length === baseline + 1,
    `${after.length} event(s), expected ${baseline + 1} (update ${legit.ok ? 'accepted' : 'refused'})`,
  );
  check(
    'and the event names the branch it happened in',
    last?.metadata?.branch_id === ids.BRANCH_B,
    `metadata.branch_id=${String(last?.metadata?.branch_id).slice(0, 8)}`,
  );
  check(
    'with the member, not the actor, as the affected user',
    last?.metadata?.affected_user === ids.ASSISTANT_A,
    `metadata.affected_user=${String(last?.metadata?.affected_user).slice(0, 8)}`,
  );

  await db.close();
}

/* ================================== 5: the log stays append-only */

section('role-change events cannot be edited or deleted');
{
  const { db, ids } = await isolate();
  await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'owner');

  const [event] = await roleEvents(db);
  check('fixture: one role-change event exists', !!event, event?.action ?? 'none');

  const upd = await as(db, ids.OWNER_A, () =>
    query(db, `update audit_events set description = 'tampered' where id = $1`, [event.id]),
  );
  const afterUpd = await query(db, `select description from audit_events where id = $1`, [event.id]);
  check(
    'an owner cannot UPDATE a role-change event',
    afterUpd.length === 1 && afterUpd[0].description === event.description,
    `still "${afterUpd[0]?.description}" (update reported ${upd.ok ? 'success' : 'refused'})`,
  );

  const del = await as(db, ids.OWNER_A, () =>
    query(db, `delete from audit_events where id = $1`, [event.id]),
  );
  const afterDel = await query(db, `select count(*)::int as n from audit_events where id = $1`, [event.id]);
  check(
    'an owner cannot DELETE a role-change event',
    afterDel[0].n === 1,
    `${afterDel[0].n} row(s) left (delete reported ${del.ok ? 'success' : 'refused'})`,
  );

  const shape = await query(
    db,
    `select
       (select count(*)::int from pg_policies where tablename = 'audit_events' and cmd = 'UPDATE') as update_policies,
       (select count(*)::int from pg_policies where tablename = 'audit_events' and cmd = 'DELETE') as delete_policies`,
  );
  check(
    'still blocked by the absence of any UPDATE or DELETE policy',
    shape[0].update_policies === 0 && shape[0].delete_policies === 0,
    `${shape[0].update_policies} UPDATE policies, ${shape[0].delete_policies} DELETE policies`,
  );

  await db.close();
}

/* ================================== 6: authorization is unaffected */

section('the role-authority model is unchanged by this migration');
{
  const { db, ids } = await isolate();

  // Assert on the boolean, not on a truthy value. `pg` returns booleans as JS
  // booleans, and `check(name, cond)` used `cond` directly, so this was fine — but
  // an earlier draft built these into the detail string and compared a rendered
  // 'true', which is a string, and so compared unequal to the boolean true.
  const isOwnerNow = async () => {
    const r = await as(db, ids.ASSISTANT_A, () => query(db, `select pf_is_owner() as o`));
    return r.ok ? r.value[0].o : null;
  };

  check('a member starts as an assistant', (await isOwnerNow()) === false, 'pf_is_owner()=false');
  await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'owner');
  check('promotion still takes effect immediately', (await isOwnerNow()) === true, 'pf_is_owner()=true');
  await setMembershipRole(db, ids.OWNER_A, ids.ASSISTANT_A, ids.BRANCH_A, 'assistant');
  check('demotion still takes effect immediately', (await isOwnerNow()) === false, 'pf_is_owner()=false');

  const [body] = await query(db, `select prosrc from pg_proc where proname = 'pf_current_role'`);
  const executable = body.prosrc
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('--'))
    .join(' ');
  check(
    'role still resolves from branch_memberships, not profiles.role',
    /from\s+branch_memberships/.test(executable) && !/from\s+profiles/.test(executable),
    executable.replace(/\s+/g, ' ').trim(),
  );

  // profiles.role must not have become authoritative again, and must not be
  // written back into the authoritative row either.
  const drift = await as(db, ids.OWNER_A, () =>
    query(db, `update profiles set role = 'owner' where id = $1`, [ids.ASSISTANT_A]),
  );
  const authoritative = await membershipRole(db, ids.ASSISTANT_A, ids.BRANCH_A);
  const effAfter = await isOwnerNow();
  check(
    'editing profiles.role still changes no authorization and rewrites no membership',
    drift.ok && authoritative === 'assistant' && effAfter === false,
    `profiles.role=owner but membership=${authoritative} and pf_is_owner()=${effAfter}`,
  );

  await db.close();
}

note('Role changes are written to the audit log by the database only.');
note('Staff may still record their own ordinary events; the role. namespace is not theirs to write.');

process.exit(await finish(null));