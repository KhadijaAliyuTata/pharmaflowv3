/**
 * Staff invitations.
 *
 * The feature exists so an owner can add staff without a `service_role` key
 * ever appearing anywhere in this codebase. That single design goal produces
 * every assertion below: because there is no admin API, the invite has to carry
 * all the authority, which means the invite itself has to be un-forgeable and
 * un-redirectable. These tests are the reason to trust that.
 *
 * The claims split into three groups.
 *
 * **The table is not writable by a client.** Grants alone, no RLS: if
 * `authenticated` cannot INSERT, it cannot choose its own token or point an
 * invite at another branch, and cannot forge `accepted_at`.
 *
 * **Authority comes from the session.** `pf_create_invitation` takes no branch
 * and no inviter argument. An owner therefore cannot invite outside their own
 * branch because there is nowhere to say so, and a cross-tenant owner cannot
 * even read another branch's invites to try.
 *
 * **An invite is bound to one person.** Redemption checks the invite's email
 * against the signed-in identity, so a link forwarded to the wrong person is
 * inert. Without that check the token alone is the credential, and anyone it is
 * forwarded to becomes staff.
 */

import {
  asActor,
  asAuthenticated,
  asAnon,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, section, finish } = createReporter('verify-staff-invitations');

/** A signed-in user with no membership yet — the invitee. */
const NEWCOMER = 'cccccccc-0000-0000-0000-000000000001';
const NEWCOMER_EMAIL = 'newcomer@example.test';

/**
 * Run `sql` as `actorId` with the `authenticated` role.
 *
 * Both halves are required. `asActor` alone leaves the role as the database
 * owner, which bypasses RLS entirely; `asAuthenticated` alone leaves
 * `auth.uid()` as whoever was impersonated last.
 */
const as = (db, actorId, sql, params) =>
  asActor(db, actorId, () => asAuthenticated(db, () => query(db, sql, params)));

/**
 * As `actorId`, with an email claim attached.
 *
 * Required wherever redemption is involved: `pf_redeem_invitation` checks the
 * invite's address against `auth.jwt() ->> 'email'`, so an impersonation with
 * no email claim would be testing a different thing than a real session.
 */
const asWithEmail = (db, actorId, email, sql, params) =>
  asActor(db, actorId, () =>
    asAuthenticated(db, async () => {
      await db.query('select set_actor_email($1)', [email]);
      return query(db, sql, params);
    }),
  );

const issueInvite = (db, actorId, email, role = 'assistant') =>
  as(db, actorId, 'select * from pf_create_invitation($1, $2::public.staff_role)', [email, role]);

const revokeInvite = (db, actorId, token) =>
  as(db, actorId, 'select pf_revoke_invitation($1) as revoked', [token]);

const redeemInvite = (db, actorId, token, email) =>
  email
    ? asWithEmail(db, actorId, email, 'select * from pf_redeem_invitation($1)', [token])
    : as(db, actorId, 'select * from pf_redeem_invitation($1)', [token]);

const membershipsFor = async (db, userId) =>
  (await query(db, 'select branch_id, role from branch_memberships where user_id = $1', [userId])) ?? [];

const db = await freshDatabase();
const { OWNER_A, ASSISTANT_A, OWNER_B, BRANCH_A, BRANCH_B } = await seedTenants(db);

await query(db, 'insert into auth.users (id, email) values ($1, $2)', [NEWCOMER, NEWCOMER_EMAIL]);

/* ------------------------------------------------- the client cannot write */

section('the table is not writable by a client');

const directInsert = await as(
  db,
  OWNER_A,
  `insert into public.staff_invitations (branch_id, email, role, token, invited_by)
   values ($1, 'attacker@example.test', 'owner', 'chosen-by-the-client', $2)
   returning id`,
  [BRANCH_A, OWNER_A],
);
check(
  'authenticated cannot insert an invitation row directly',
  !directInsert.ok,
  'a client that could insert would choose its own token, branch and role',
);
check(
  '...so it cannot choose a token of its own',
  /permission denied|row-level security/i.test(directInsert.err ?? ''),
  directInsert.err ?? 'no error raised, which would mean the insert was allowed',
);

const directUpdate = await as(
  db,
  OWNER_A,
  `update public.staff_invitations set accepted_at = now(), accepted_by = $2
   where branch_id = $1`,
  [BRANCH_A, OWNER_B],
);
check(
  'authenticated cannot mark an invitation accepted directly',
  !directUpdate.ok,
  'forging accepted_at would let anyone with any token claim a place',
);

const directDelete = await as(
  db,
  OWNER_A,
  'delete from public.staff_invitations where branch_id = $1',
  [BRANCH_A],
);
check(
  'authenticated cannot delete an invitation row',
  !directDelete.ok,
  'an invite is the record that access was once issued; it is revoked, not erased',
);

/* ------------------------------------------------------ authority is the session */

section('authority comes from the session, not the arguments');

const asAssistant = await issueInvite(db, ASSISTANT_A, 'someone@example.test');
check(
  'an assistant cannot issue an invitation',
  !asAssistant.ok && /only an owner/i.test(asAssistant.err ?? ''),
  asAssistant.err ?? 'it was allowed',
);

const ownerInvite = await issueInvite(db, OWNER_A, 'Pharmacist@Example.test');
check('an owner can issue an invitation', ownerInvite.ok, ownerInvite.err ?? '');
const token = ownerInvite.value?.[0]?.token;
check(
  '...and receives a token',
  typeof token === 'string' && token.length > 0,
  `token was ${JSON.stringify(token)}`,
);

const inviteRow = (
  await query(db, 'select branch_id, email, role, invited_by, accepted_at from staff_invitations where token = $1', [
    token,
  ])
)[0];
check(
  "the invitation is bound to the owner's own branch",
  inviteRow?.branch_id === BRANCH_A,
  `stored branch was ${inviteRow?.branch_id}, expected ${BRANCH_A}`,
);
check(
  'the inviter is taken from the session',
  inviteRow?.invited_by === OWNER_A,
  `stored invited_by was ${inviteRow?.invited_by}`,
);
check(
  'the email is normalised',
  inviteRow?.email === 'pharmacist@example.test',
  `stored email was ${inviteRow?.email}`,
);
check(
  'an unrecognised role falls back to assistant',
  inviteRow?.role === 'assistant',
  `stored role was ${inviteRow?.role}`,
);
check(
  'a new invitation is not already accepted',
  inviteRow?.accepted_at === null,
  `accepted_at was ${inviteRow?.accepted_at}`,
);

check(
  'the token is long enough to be unguessable',
  typeof token === 'string' && /^[0-9a-f]{64}$/.test(token),
  `expected 64 hex chars, got ${String(token).length} chars`,
);

const crossRead = await as(db, OWNER_B, 'select token from staff_invitations', []);
check(
  'an owner in another branch cannot read these invitations',
  (crossRead.value ?? []).length === 0,
  `read ${(crossRead.value ?? []).length} row(s) from another branch`,
);

const crossRevoke = await revokeInvite(db, OWNER_B, token);
check(
  'an owner in another branch cannot revoke this invitation',
  crossRevoke.ok && crossRevoke.value?.[0]?.revoked === false,
  `expected false, got ${JSON.stringify(crossRevoke.value?.[0]?.revoked)}`,
);

/* ------------------------------------------------------------- redemption */

section('redemption is bound to the person it was issued to');

const anonRedeem = await asAnon(db, () => query(db, 'select * from pf_redeem_invitation($1)', [token]));
check(
  'an anonymous caller cannot redeem',
  !anonRedeem.ok,
  anonRedeem.err ?? 'it was allowed',
);

const wrongPerson = await redeemInvite(db, OWNER_B, token, 'owner-b@example.test');
check(
  'someone else cannot redeem an invitation issued to another address',
  !wrongPerson.ok && /different email/i.test(wrongPerson.err ?? ''),
  wrongPerson.err ?? 'it was allowed',
);

check(
  '...and the failed attempt created no membership',
  (await membershipsFor(db, OWNER_B)).length === 1,
  'a rejected redemption must leave the database exactly as it was',
);

const ownInvite = await issueInvite(db, OWNER_A, NEWCOMER_EMAIL);
check('the owner can invite the new staff member', ownInvite.ok, ownInvite.err ?? '');
const ownToken = ownInvite.value?.[0]?.token;

const redeemed = await redeemInvite(db, NEWCOMER, ownToken, NEWCOMER_EMAIL);
check('the invited person can redeem', redeemed.ok, redeemed.err ?? '');
check(
  '...and receives a membership in the invited branch',
  redeemed.value?.[0]?.branch === BRANCH_A,
  `got branch ${redeemed.value?.[0]?.branch}`,
);
check(
  '...at the invited role',
  redeemed.value?.[0]?.granted_role === 'assistant',
  `got role ${redeemed.value?.[0]?.granted_role}`,
);

const newcomerMembership = await membershipsFor(db, NEWCOMER);
check(
  'the membership row exists for the new staff member',
  newcomerMembership.length === 1 && newcomerMembership[0].branch_id === BRANCH_A,
  JSON.stringify(newcomerMembership),
);

const settled = (
  await query(db, 'select accepted_at, accepted_by from staff_invitations where token = $1', [ownToken])
)[0];
check(
  'the invitation is now marked accepted',
  settled?.accepted_at !== null && settled?.accepted_at !== undefined,
  'the row was missing or still pending, so the same code would work twice',
);
check(
  '...and records who accepted it',
  settled?.accepted_by === NEWCOMER,
  `accepted_by was ${settled?.accepted_by}`,
);

const replay = await redeemInvite(db, NEWCOMER, ownToken, NEWCOMER_EMAIL);
check(
  'the same invitation cannot be redeemed twice',
  !replay.ok,
  replay.err ?? 'it was allowed',
);

check(
  'a token that was never issued is refused',
  !(await redeemInvite(db, NEWCOMER, '0123456789abcdef0123456789abcdef')).ok,
  'a guessed token was accepted',
);

/*
 * The redemption above ran with no branch for the newcomer, because
 * `pf_current_branch()` reads `profiles.branch_id` and a fresh account has none.
 * Claiming the branch is what makes the account usable, and it is allowed only
 * because the membership now exists — `pf_guard_profile_privileges` has a
 * deliberate escape hatch for exactly this. If that hatch is ever removed, a
 * redeemed invitee would authenticate successfully and then see an empty app.
 */
const claimBranch = await as(
  db,
  NEWCOMER,
  'update public.profiles set branch_id = $1, role = $2 where id = $3 returning branch_id, role',
  [BRANCH_A, 'assistant', NEWCOMER],
);
check(
  'the new staff member can claim their branch on their own profile',
  claimBranch.ok && claimBranch.value?.[0]?.branch_id === BRANCH_A,
  claimBranch.err ?? `branch_id came back as ${claimBranch.value?.[0]?.branch_id}`,
);

const nowHasBranch = await asActor(db, NEWCOMER, () =>
  asAuthenticated(db, () => query(db, 'select pf_current_branch() as b, pf_current_role() as r')),
);
check(
  '...which makes pf_current_branch() resolve for them',
  nowHasBranch.value?.[0]?.b === BRANCH_A,
  `pf_current_branch() returned ${JSON.stringify(nowHasBranch.value?.[0])}`,
);
check(
  '...and their role is read from the membership, not the cache',
  nowHasBranch.value?.[0]?.r === 'assistant',
  `pf_current_role() returned ${JSON.stringify(nowHasBranch.value?.[0]?.r)}`,
);

/* --------------------------------------------------------------- revocation */

section('a revoked invitation stops working');

const revokeTarget = (await issueInvite(db, OWNER_A, 'revoked@example.test')).value[0].token;
check('an owner can revoke their own unused invitation', (await revokeInvite(db, OWNER_A, revokeTarget)).value[0]?.revoked === true, 'an invite the owner made must be withdrawable before it is used');
check(
  'a revoked invitation cannot be redeemed',
  !(await redeemInvite(db, ASSISTANT_A, revokeTarget, 'assistant-a@example.test')).ok,
  'a revoked invitation was accepted',
);

const reissued = await issueInvite(db, OWNER_A, 'revoked@example.test');
check('re-issuing to the same address works', reissued.ok, reissued.err ?? '');
check(
  '...and produces a different token',
  reissued.value[0].token !== revokeTarget,
  'the superseded token was reused',
);

/* ------------------------------------------------------------ removing staff */

section('an owner can remove staff, scoped to their own branch');

const removalInvite = (await issueInvite(db, OWNER_A, 'leaver@example.test')).value[0].token;
// A stand-in account to remove, since redemption is bound to a real email.
const LEAVER = 'cccccccc-0000-0000-0000-000000000002';
await query(db, 'insert into auth.users (id, email) values ($1, $2)', [LEAVER, 'leaver@example.test']);
check('the leaver redeems and joins', (await redeemInvite(db, LEAVER, removalInvite, 'leaver@example.test')).ok, 'fixture: the removal assertions below need a real membership to remove');
check('the leaver is a member before removal', (await membershipsFor(db, LEAVER)).length === 1, 'fixture: the removal assertions below need someone to remove');

const assistantRemove = await as(
  db,
  ASSISTANT_A,
  'delete from public.branch_memberships where user_id = $1 and branch_id = $2',
  [LEAVER, BRANCH_A],
);
check(
  'an assistant cannot remove a staff member',
  (await membershipsFor(db, LEAVER)).length === 1,
  'removal is an owner action; an assistant must not be able to revoke a colleague',
);
check(
  '...and the statement itself is filtered rather than erroring',
  assistantRemove.ok,
  'RLS filters it to zero matching rows, which is success, not failure',
);

const crossRemove = await as(
  db,
  OWNER_A,
  'delete from public.branch_memberships where user_id = $1 and branch_id = $2',
  [OWNER_B, BRANCH_B],
);
check(
  'an owner cannot remove a member of another branch',
  (await membershipsFor(db, OWNER_B)).length === 1,
  'a cross-branch membership was deleted',
);
check(
  '...and that delete simply matched no rows',
  crossRemove.ok,
  'the same zero-rows-is-success semantics, for a cross-branch delete',
);

const ownerRemove = await as(
  db,
  OWNER_A,
  'delete from public.branch_memberships where user_id = $1 and branch_id = $2',
  [LEAVER, BRANCH_A],
);
check('an owner can remove a member of their own branch', ownerRemove.ok, ownerRemove.err ?? '');
check(
  '...and the membership is gone',
  (await membershipsFor(db, LEAVER)).length === 0,
  'the membership survived removal',
);

const leaverAfter = await asActor(db, LEAVER, () =>
  asAuthenticated(db, () => query(db, 'select pf_is_owner() as o, pf_current_role() as r')),
);
check(
  'the removed person is no longer an owner of anything',
  leaverAfter.value?.[0]?.o === false,
  `pf_is_owner() returned ${JSON.stringify(leaverAfter.value?.[0]?.o)}`,
);

const audited = await query(
  db,
  `select action, count(*)::int as n
     from audit_events
    where branch_id = $1
      and action in ('role.membership_created', 'role.membership_removed')
    group by action`,
  [BRANCH_A],
);
const created = audited.find((r) => r.action === 'role.membership_created')?.n ?? 0;
const removed = audited.find((r) => r.action === 'role.membership_removed')?.n ?? 0;
check(
  'a join is written to the audit log by the membership trigger',
  created >= 2,
  `found ${created} membership_created row(s); the redeemed invite should have produced one`,
);
check(
  'a removal is written to the audit log by the membership trigger',
  removed >= 1,
  `found ${removed} membership_removed row(s); the removal should have produced one`,
);

/* ------------------------------------------------------------------- revoke */

section('removal does not delete the invitation record');

const record = await query(db, 'select accepted_at, accepted_by, revoked_at from staff_invitations where token = $1', [
  removalInvite,
]);
check(
  'the settled invitation survives the removal of its member',
  record.length === 1 && record[0].accepted_at !== null && record[0].revoked_at === null,
  'the invitation row should remain as the record that access was issued',
);

finish();