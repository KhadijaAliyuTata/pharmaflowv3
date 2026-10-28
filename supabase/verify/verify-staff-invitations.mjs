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

const issueInvite = (db, actorId, email, role = 'assistant', fullName = null) =>
  as(
    db,
    actorId,
    'select * from pf_create_invitation($1, $2::public.staff_role, $3, $4::interval)',
    [email, role, fullName, '7 days'],
  );

const revokeInvite = (db, actorId, token) =>
  as(db, actorId, 'select pf_revoke_invitation($1) as revoked', [token]);

const redeemInvite = (db, actorId, token, email) =>
  email
    ? asWithEmail(db, actorId, email, 'select * from pf_redeem_invitation($1)', [token])
    : as(db, actorId, 'select * from pf_redeem_invitation($1)', [token]);

const membershipsFor = async (db, userId) =>
  (await query(db, 'select branch_id, role from branch_memberships where user_id = $1', [userId])) ?? [];

/**
 * `pf_claim_invitation` reserves a code for one acceptance attempt.
 *
 * The Worker calls this as `service_role`, which holds BYPASSRLS; `query` runs as the
 * database owner, which also bypasses RLS, so calling it directly exercises the same
 * code path. What is asserted here is the function's own logic, not its caller.
 */
const claimInvite = (db, token) =>
  query(db, 'select email, claim_expires_at from public.pf_claim_invitation($1)', [token]);

const claimState = async (db, token) =>
  (
    await query(
      db,
      'select claimed_at, claim_expires_at from staff_invitations where token = $1',
      [token],
    )
  )[0] ?? null;

/**
 * Timestamps come back as `Date` objects, so two reads of an unchanged column are
 * different objects. Comparing them with `===` would fail on identity rather than
 * value and turn a passing assertion red. Everything that asserts "this column was
 * not touched" compares ISO strings instead.
 */
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

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

/*
 * Expiry and the invited name arrived with migration
 * 20261006150000_staff_invitation_expiry, once the invitation stopped being read
 * aloud across a counter and started being emailed. An emailed code that never
 * expires is a permanent credential sitting in someone's inbox.
 */
section('an emailed invitation expires, and says who it is for');

const namedInvite = await issueInvite(db, OWNER_A, 'named@example.test', 'assistant');
check('an invitation can still be issued', namedInvite.ok, namedInvite.err ?? '');
const namedRow = (
  await query(
    db,
    `select full_name, expires_at, created_at
       from staff_invitations
      where token = $1`,
    [namedInvite.value?.[0]?.token],
  )
)[0];

check(
  "the invited name is stored on the invitation",
  namedRow?.full_name === null,
  'a two-argument call sends no name, so it must be NULL rather than an empty string',
);

check(
  'a new invitation carries an expiry',
  !!namedRow?.expires_at,
  'expires_at was null, so the code would never expire',
);

const windowDays =
  namedRow?.expires_at && namedRow?.created_at
    ? (new Date(namedRow.expires_at) - new Date(namedRow.created_at)) / 86_400_000
    : null;

check(
  'the default window is about a week',
  windowDays !== null && windowDays > 6 && windowDays < 8,
  `window was ${windowDays} days`,
);

const namedWithName = await issueInvite(db, OWNER_A, 'named2@example.test', 'assistant', 'Aisha Yusuf');
check(
  "the owner's name is carried through",
  namedWithName.ok,
  namedWithName.err ?? '',
);
const named2Row = (
  await query(
    db,
    'select full_name from staff_invitations where token = $1',
    [namedWithName.value?.[0]?.token],
  )
)[0];
check(
  'a supplied name is stored verbatim',
  named2Row?.full_name === 'Aisha Yusuf',
  `stored ${JSON.stringify(named2Row?.full_name)}`,
);

const NAME = 'cccccccc-0000-0000-0000-000000000003';
await query(db, 'insert into auth.users (id, email) values ($1, $2)', [NAME, 'named@example.test']);

const expiryRedeem = await redeemInvite(db, NAME, namedInvite.value?.[0]?.token, 'named@example.test');
check(
  'a live invitation still redeems after the schema change',
  expiryRedeem.ok,
  expiryRedeem.err ?? 'the new expiry column broke the happy path',
);

check(
  'the redeeming member got the branch',
  expiryRedeem.value?.[0]?.branch === BRANCH_A,
  `got ${expiryRedeem.value?.[0]?.branch}`,
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

/*
 * Expired invitations are what make the emailed flow safe, so it is asserted by
 * moving a real row's deadline into the past rather than by trusting the WHERE
 * clause. The redemption path and the email path both check it, and only the
 * redemption path can actually grant a membership.
 */
const EXPIRED = 'cccccccc-0000-0000-0000-000000000004';
await query(db, 'insert into auth.users (id, email) values ($1, $2)', [EXPIRED, 'expired@example.test']);
const staleInvite = await issueInvite(db, OWNER_A, 'expired@example.test');
await query(db, 'update staff_invitations set expires_at = now() - interval \'1 hour\' where token = $1', [
  staleInvite.value?.[0]?.token,
]);

const expiredRedeem = await redeemInvite(db, EXPIRED, staleInvite.value?.[0]?.token, 'expired@example.test');
check(
  'an expired invitation cannot be redeemed',
  !expiredRedeem.ok && /expired/i.test(expiredRedeem.err ?? ''),
  expiredRedeem.err ?? 'it was allowed',
);
check(
  '...and it created no membership',
  (await membershipsFor(db, EXPIRED)).length === 0,
  'an expired code granted a place at the pharmacy',
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

/*
 * The same person, redeeming the same code again.
 *
 * This is a returning member: a reload, a second device, a retried flow. The
 * invitation has already done its job, so redemption is idempotent — it returns
 * the membership they already hold and writes nothing at all, rather than
 * turning them away from a pharmacy they are already part of.
 */
const replay = await redeemInvite(db, NEWCOMER, ownToken, NEWCOMER_EMAIL);
check(
  'redeeming the same invitation again succeeds',
  replay.ok,
  replay.err ?? 'a returning member was turned away',
);
check(
  '...and returns the membership they already had',
  replay.value?.[0]?.branch === BRANCH_A && replay.value?.[0]?.granted_role === 'assistant',
  JSON.stringify(replay.value?.[0]),
);
check(
  '...without creating a second membership',
  (await membershipsFor(db, NEWCOMER)).length === 1,
  JSON.stringify(await membershipsFor(db, NEWCOMER)),
);

const settledAgain = (
  await query(db, 'select accepted_at from staff_invitations where token = $1', [ownToken])
)[0];
check(
  '...and the accepted row is not re-stamped',
  String(settledAgain?.accepted_at) === String(settled?.accepted_at),
  `accepted_at moved from ${settled?.accepted_at} to ${settledAgain?.accepted_at}`,
);

check(
  'a token that was never issued is refused',
  !(await redeemInvite(db, NEWCOMER, '0123456789abcdef0123456789abcdef')).ok,
  'a guessed token was accepted',
);

/*
 * An account that already existed before the invitation.
 *
 * This is the path `/join` sends someone to when they type an address that is
 * already registered: they sign in with the password they have, then redeem. It
 * has to keep working after the acceptance endpoint was added, because that
 * endpoint deliberately creates a *new* account and reports `already_registered`
 * rather than touching an existing one. If acceptance ever grew the power to
 * change somebody's existing account, this is the assertion that would notice.
 */
section('an invitation works for someone who already had an account');

const RETURNING = 'cccccccc-0000-0000-0000-000000000005';
await query(db, 'insert into auth.users (id, email) values ($1, $2)', [
  RETURNING,
  'returning@example.test',
]);

const returningInvite = await issueInvite(db, OWNER_A, 'returning@example.test', 'assistant');
check('an existing account can be invited', returningInvite.ok, returningInvite.err ?? '');
const returningToken = returningInvite.value?.[0]?.token;

// The account predates the invitation: it already has a profile, which is the state
// a returning staff member is actually in.
await as(
  db,
  RETURNING,
  'update public.profiles set full_name = $1 where id = $2 returning id',
  ['A Returning Colleague', RETURNING],
);
const beforeAccept = await query(
  db,
  'select full_name, branch_id from public.profiles where id = $1',
  [RETURNING],
);
check(
  '...and that account exists independently of the invitation',
  beforeAccept[0]?.full_name === 'A Returning Colleague',
  JSON.stringify(beforeAccept[0]),
);

const returningRedeem = await redeemInvite(
  db,
  RETURNING,
  returningToken,
  'returning@example.test',
);
check(
  'the existing account redeems the invitation',
  returningRedeem.ok,
  returningRedeem.err ?? 'a pre-existing account could not redeem',
);
check(
  '...and receives the invited branch',
  returningRedeem.value?.[0]?.branch === BRANCH_A,
  `got branch ${returningRedeem.value?.[0]?.branch}`,
);
check(
  '...at the invited role',
  returningRedeem.value?.[0]?.granted_role === 'assistant',
  `got role ${returningRedeem.value?.[0]?.granted_role}`,
);

const returningMembership = await membershipsFor(db, RETURNING);
check(
  '...exactly one membership, and it is the invited one',
  returningMembership.length === 1 && returningMembership[0].branch_id === BRANCH_A,
  JSON.stringify(returningMembership),
);

check(
  'the existing account was not given a second membership by redeeming',
  (await membershipsFor(db, RETURNING)).length === 1,
  'redeeming twice created a duplicate',
);

/*
 * The same account, redeeming its own settled code again — the returning-member
 * case once more, this time for an account that already existed before it was
 * invited. Idempotent for them too: the membership they hold comes back and
 * nothing is written.
 */
const returningReplay = await redeemInvite(db, RETURNING, returningToken, 'returning@example.test');
check(
  'the settled code is idempotent for the account it was issued to',
  returningReplay.ok,
  returningReplay.err ?? 'the account was turned away from a membership it already holds',
);
check(
  '...and it is still the only membership that account holds',
  (await membershipsFor(db, RETURNING)).length === 1,
  JSON.stringify(await membershipsFor(db, RETURNING)),
);

/*
 * The address binding, kept intact.
 *
 * A code is bound to the address it was issued to, and that check runs before the
 * idempotent path — so it applies to members of the branch as well as to
 * strangers. Both callers below present a code issued to `returning@example.test`:
 * `OUTSIDER` holds no membership anywhere, and `NEWCOMER` is already a member of
 * `BRANCH_A`. Both must be refused on the binding rather than greeted with a
 * membership that was never theirs.
 */
const OUTSIDER = 'cccccccc-0000-0000-0000-000000000010';
await query(db, 'insert into auth.users (id, email) values ($1, $2)', [
  OUTSIDER,
  'outsider@example.test',
]);

const crossAddress = await redeemInvite(db, OUTSIDER, returningToken, 'outsider@example.test');
check(
  'a code cannot be redeemed by an account it was not issued to',
  !crossAddress.ok && /different email/i.test(crossAddress.err ?? ''),
  crossAddress.err ?? 'a code issued to another address was accepted',
);
check(
  '...and the refused attempt created no membership',
  (await membershipsFor(db, OUTSIDER)).length === 0,
  'a refused redemption granted a place at the pharmacy',
);

const memberCrossAddress = await redeemInvite(db, NEWCOMER, returningToken, NEWCOMER_EMAIL);
check(
  'a member cannot redeem a code issued to another address either',
  !memberCrossAddress.ok && /different email/i.test(memberCrossAddress.err ?? ''),
  memberCrossAddress.err ?? 'a member redeemed a code issued to another address',
);

/* ------------------------------------------------------------------ claiming */

section('a claim reserves a live invitation for one attempt');

const claimableInvite = await issueInvite(db, OWNER_A, 'claimant@example.test');
check('an invitation can be issued', claimableInvite.ok, claimableInvite.err ?? '');
const claimableToken = claimableInvite.value?.[0]?.token;

const emptyToken = await claimInvite(db, '');
check('an empty token is refused', (emptyToken ?? []).length === 0, JSON.stringify(emptyToken));

const nullToken = await claimInvite(db, null);
check('a null token is refused', (nullToken ?? []).length === 0, JSON.stringify(nullToken));

const unknownToken = await claimInvite(db, 'f'.repeat(64));
check('an unknown token is refused', (unknownToken ?? []).length === 0, JSON.stringify(unknownToken));

const firstClaim = await claimInvite(db, claimableToken);
check('a live invitation can be claimed', (firstClaim ?? []).length === 1, JSON.stringify(firstClaim));
check(
  "...and it returns the row's own address",
  firstClaim?.[0]?.email === 'claimant@example.test',
  firstClaim?.[0]?.email,
);

section('a live claim cannot be taken over by a second request');

{
  // This is the concurrency property, asserted sequentially because the guarantee is
  // that the predicate is false while a lease is live — not that two statements
  // interleave safely. Two concurrent callers produce one update and one zero-row
  // update, and the loser sees this same empty result.
  const second = await claimInvite(db, claimableToken);
  check('a second claim on a live lease is refused', (second ?? []).length === 0, JSON.stringify(second));
  check(
    '...and it is refused repeatedly, not just once',
    (await claimInvite(db, claimableToken) ?? []).length === 0,
    'a third caller got through',
  );
}

section('the claim lease is four minutes and expires unambiguously');

{
  const state = await claimState(db, claimableToken);
  check('claimed_at was written', !!state?.claimed_at, JSON.stringify(state));
  check('claim_expires_at was written', !!state?.claim_expires_at, JSON.stringify(state));

  const leaseMinutes =
    state?.claimed_at && state?.claim_expires_at
      ? (new Date(state.claim_expires_at) - new Date(state.claimed_at)) / 60_000
      : null;
  check(
    'the lease is four minutes',
    leaseMinutes !== null && Math.abs(leaseMinutes - 4) < 0.05,
    `${leaseMinutes} minutes`,
  );

  // Strict `<` in the claim predicate: the lease is released at the instant it
  // expires, so there is no window where a claim is simultaneously live and free.
  const stillHeld = await claimInvite(db, claimableToken);
  check('...and while the lease is live the code stays held', (stillHeld ?? []).length === 0, JSON.stringify(stillHeld));

  await query(db, "update staff_invitations set claim_expires_at = now() - interval '1 second' where token = $1", [
    claimableToken,
  ]);

  const afterExpiry = await claimInvite(db, claimableToken);
  check('an expired lease can be claimed again', (afterExpiry ?? []).length === 1, JSON.stringify(afterExpiry));
  check(
    "...and it returns the same address",
    afterExpiry?.[0]?.email === 'claimant@example.test',
    afterExpiry?.[0]?.email,
  );

  const reclaimedState = await claimState(db, claimableToken);
  check(
    'the lease was pushed forward, not left expired',
    reclaimedState?.claim_expires_at && new Date(reclaimedState.claim_expires_at) > new Date(),
    JSON.stringify(reclaimedState),
  );
}

section('a dead invitation cannot be claimed');

{
  const revokedInvite = await issueInvite(db, OWNER_A, 'revoked-claim@example.test');
  const revokedToken = revokedInvite.value?.[0]?.token;
  check('an invitation to be revoked can be issued', revokedInvite.ok, revokedInvite.err ?? '');

  const revoked = await revokeInvite(db, OWNER_A, revokedToken);
  check('the owner revokes it', revoked.ok && revoked.value?.[0]?.revoked === true, revoked.err ?? '');

  check(
    'a withdrawn invitation cannot be claimed',
    (await claimInvite(db, revokedToken) ?? []).length === 0,
    'a withdrawn code was claimed',
  );
  check(
    '...and cannot be redeemed either',
    !(await redeemInvite(db, NEWCOMER, revokedToken, 'revoked-claim@example.test')).ok,
    'a withdrawn code redeemed',
  );
}

{
  const settledInvite = await issueInvite(db, OWNER_A, 'settled-claim@example.test');
  const settledToken = settledInvite.value?.[0]?.token;

  const settleUser = 'cccccccc-0000-0000-0000-000000000006';
  await query(db, 'insert into auth.users (id, email) values ($1, $2)', [
    settleUser,
    'settled-claim@example.test',
  ]);

  check(
    'a live invitation can be claimed first',
    (await claimInvite(db, settledToken) ?? []).length === 1,
    'the fixture could not be claimed',
  );
  check(
    'the invitee can still redeem it while a claim is live',
    (await redeemInvite(db, settleUser, settledToken, 'settled-claim@example.test')).ok,
    'a claim blocked redemption',
  );
  check(
    '...which means the claim never gated the membership',
    (await membershipsFor(db, settleUser)).length === 1,
    'redemption did not produce a membership',
  );
  check(
    'an accepted invitation cannot then be claimed',
    (await claimInvite(db, settledToken) ?? []).length === 0,
    'a settled code was claimed again',
  );
}

{
  const staleInvite = await issueInvite(db, OWNER_A, 'stale-claim@example.test');
  await query(db, "update staff_invitations set expires_at = now() - interval '1 hour' where token = $1", [
    staleInvite.value?.[0]?.token,
  ]);
  check(
    'an expired invitation cannot be claimed',
    (await claimInvite(db, staleInvite.value?.[0]?.token) ?? []).length === 0,
    'an expired code was claimed',
  );
}

section('revocation ends an active claim, so a dead code reports as dead');

{
  const raceInvite = await issueInvite(db, OWNER_A, 'race@example.test');
  const raceToken = raceInvite.value?.[0]?.token;

  const claimed = await claimInvite(db, raceToken);
  check('the fixture claims cleanly', (claimed ?? []).length === 1, JSON.stringify(claimed));

  const revoked = await revokeInvite(db, OWNER_A, raceToken);
  check('the owner revokes while the claim is live', revoked.ok && revoked.value?.[0]?.revoked === true, revoked.err ?? '');

  const afterRevoke = await claimInvite(db, raceToken);
  check(
    'the claim is released by the revocation, not left to expire',
    (afterRevoke ?? []).length === 0,
    'a revoked code was claimable again',
  );

  // The load-bearing assertion of the whole design. A claim was live when the owner
  // withdrew the invitation, and the redemption path must still refuse.
  const revokedActor = 'cccccccc-0000-0000-0000-000000000008';
  await query(db, 'insert into auth.users (id, email) values ($1, $2)', [
    revokedActor,
    'race@example.test',
  ]);
  check(
    'and the revoked invitation still cannot be redeemed',
    !(await redeemInvite(db, revokedActor, raceToken, 'race@example.test')).ok,
    'a claim overrode the revocation',
  );
  check(
    '...leaving no membership behind',
    (await membershipsFor(db, revokedActor)).length === 0,
    'a revoked invitation granted a membership',
  );
}

section('a claim grants nothing on its own');

{
  // Only pf_redeem_invitation creates a membership. This asserts that claiming an
  // invitation, and letting its lease expire with no redemption, leaves the invited
  // person with nothing.
  const orphanInvite = await issueInvite(db, OWNER_A, 'orphan@example.test');
  const orphanToken = orphanInvite.value?.[0]?.token;
  check('the fixture claims cleanly', (await claimInvite(db, orphanToken) ?? []).length === 1, '');

  const orphanUser = 'cccccccc-0000-0000-0000-000000000007';
  await query(db, 'insert into auth.users (id, email) values ($1, $2)', [
    orphanUser,
    'orphan@example.test',
  ]);
  check(
    'a claimed-but-unredeemed invitation grants no membership',
    (await membershipsFor(db, orphanUser)).length === 0,
    'claiming created a membership',
  );
  check(
    '...and the invitee can still redeem it afterwards, which is the recovery path',
    (await redeemInvite(db, orphanUser, orphanToken, 'orphan@example.test')).ok,
    'a claim permanently blocked redemption',
  );
  check(
    '...producing exactly one membership',
    (await membershipsFor(db, orphanUser)).length === 1,
    JSON.stringify(await membershipsFor(db, orphanUser)),
  );
}

/*
 * Regression coverage for the revocation guard.
 *
 * 20261007130000 guarded the claim-clearing with `claim_expires_at is distinct from
 * now()` and documented it as excluding never-claimed rows. It did not:
 * `IS DISTINCT FROM` is NULL-safe, so `null is distinct from now()` is true and the
 * UPDATE fired on rows that had never been claimed, stamping a claim timestamp onto
 * them.
 *
 * The assertions below pin the corrected behaviour: a claim timestamp is written
 * only when a claim exists and its lease is still running, and revocation never
 * depends on claim state.
 */
section('revocation writes a claim only when a claim is actually active');

{
  // Case 1: never claimed. This is what the old guard got wrong.
  const unclaimed = await issueInvite(db, OWNER_A, 'unclaimed-revoke@example.test');
  const unclaimedToken = unclaimed.value?.[0]?.token;
  check('an unclaimed invitation can be issued', unclaimed.ok, unclaimed.err ?? '');

  const unclaimedBefore = await claimState(db, unclaimedToken);
  check('...and starts with no claim at all', unclaimedBefore?.claimed_at == null && unclaimedBefore?.claim_expires_at == null, JSON.stringify(unclaimedBefore));

  const unclaimedRevoke = await revokeInvite(db, OWNER_A, unclaimedToken);
  check(
    'it can be revoked all the same — withdrawal must not depend on claim state',
    unclaimedRevoke.ok && unclaimedRevoke.value?.[0]?.revoked === true,
    unclaimedRevoke.err ?? 'revoking an unclaimed invitation failed',
  );

  const unclaimedAfter = await claimState(db, unclaimedToken);
  check('...and the revocation took effect', (await query(db, 'select revoked_at from staff_invitations where token = $1', [unclaimedToken]))[0]?.revoked_at != null, JSON.stringify(unclaimedAfter));
  check(
    '...but no claim timestamp was invented for it',
    unclaimedAfter?.claim_expires_at == null,
    `claim_expires_at became ${JSON.stringify(unclaimedAfter?.claim_expires_at)} on a never-claimed row`,
  );
  check(
    '...and no claim start was invented either',
    unclaimedAfter?.claimed_at == null,
    `claimed_at became ${JSON.stringify(unclaimedAfter?.claimed_at)}`,
  );
}

{
  // Case 2: claimed with a live lease. The behaviour the original migration intended.
  const liveClaim = await issueInvite(db, OWNER_A, 'live-claim-revoke@example.test');
  const liveClaimToken = liveClaim.value?.[0]?.token;
  check('a claim can be taken', (await claimInvite(db, liveClaimToken) ?? []).length === 1, '');

  const liveBefore = await claimState(db, liveClaimToken);
  const liveRevoked = await revokeInvite(db, OWNER_A, liveClaimToken);
  check('the owner revokes while the lease is running', liveRevoked.ok && liveRevoked.value?.[0]?.revoked === true, liveRevoked.err ?? '');

  const liveAfter = await claimState(db, liveClaimToken);
  check(
    'the running lease is collapsed',
    liveAfter?.claim_expires_at != null && new Date(liveAfter.claim_expires_at) <= new Date(),
    `claim_expires_at is ${JSON.stringify(liveAfter?.claim_expires_at)}, still in the future`,
  );
  check(
    '...so the code can no longer be claimed',
    (await claimInvite(db, liveClaimToken) ?? []).length === 0,
    'a revoked code was claimable again',
  );
  check(
    '...while claimed_at is kept as the record that acceptance began',
    iso(liveAfter?.claimed_at) === iso(liveBefore?.claimed_at),
    `claimed_at changed from ${JSON.stringify(liveBefore?.claimed_at)} to ${JSON.stringify(liveAfter?.claimed_at)}`,
  );
}

{
  // Case 3: claimed, but the lease already lapsed. Revoking must still work, and
  // must not rewrite a timestamp that is already in the past.
  const lapsed = await issueInvite(db, OWNER_A, 'lapsed-revoke@example.test');
  const lapsedToken = lapsed.value?.[0]?.token;
  check('the fixture claims cleanly', (await claimInvite(db, lapsedToken) ?? []).length === 1, '');

  await query(db, "update staff_invitations set claim_expires_at = now() - interval '2 minutes' where token = $1", [
    lapsedToken,
  ]);
  const lapsedBefore = await claimState(db, lapsedToken);
  check('the lease has lapsed', new Date(lapsedBefore?.claim_expires_at) < new Date(), JSON.stringify(lapsedBefore));

  const lapsedRevoke = await revokeInvite(db, OWNER_A, lapsedToken);
  check(
    'an invitation with a lapsed claim can be revoked safely',
    lapsedRevoke.ok && lapsedRevoke.value?.[0]?.revoked === true,
    lapsedRevoke.err ?? 'revoking a lapsed-claim invitation failed',
  );

  const lapsedAfter = await claimState(db, lapsedToken);
  check(
    'its already-lapsed timestamp is left as it was, not rewritten',
    iso(lapsedAfter?.claim_expires_at) === iso(lapsedBefore?.claim_expires_at),
    `claim_expires_at moved from ${JSON.stringify(lapsedBefore?.claim_expires_at)} to ${JSON.stringify(lapsedAfter?.claim_expires_at)}`,
  );
}

section('a revoked invitation stays dead, whichever claim state it had');

for (const [label, email] of [
  ['revoked after being claimed', 'dead-claimed@example.test'],
  ['revoked while unclaimed', 'dead-unclaimed@example.test'],
  ['revoked after its lease lapsed', 'dead-lapsed@example.test'],
]) {
  const invite = await issueInvite(db, OWNER_A, email);
  const token = invite.value?.[0]?.token;

  if (label === 'revoked after being claimed') {
    await claimInvite(db, token);
  } else if (label === 'revoked after its lease lapsed') {
    await claimInvite(db, token);
    await query(db, "update staff_invitations set claim_expires_at = now() - interval '2 minutes' where token = $1", [token]);
  }

  await revokeInvite(db, OWNER_A, token);

  check(`${label}: it cannot be claimed`, (await claimInvite(db, token) ?? []).length === 0, 'a revoked code was claimable');

  const actor = `cccccccc-0000-0000-0000-${String(9 + label.length).padStart(12, '0')}`;
  await query(db, 'insert into auth.users (id, email) values ($1, $2)', [actor, email]);
  check(
    `${label}: it cannot be redeemed`,
    !(await redeemInvite(db, actor, token, email)).ok,
    'a revoked code redeemed',
  );
  check(
    `${label}: and no membership exists`,
    (await membershipsFor(db, actor)).length === 0,
    'a revoked invitation granted a membership',
  );
}

section('revocation authorization and grants are unchanged');

{
  const authInvite = await issueInvite(db, OWNER_A, 'authz-revoke@example.test');
  const authToken = authInvite.value?.[0]?.token;

  const anonRevoke = await asAnon(db, () => query(db, 'select pf_revoke_invitation($1)', [authToken]));
  check('anon cannot revoke', !anonRevoke.ok, anonRevoke.err ?? 'anon revoked an invitation');

  const assistantRevoke = await revokeInvite(db, ASSISTANT_A, authToken);
  check(
    'an assistant cannot revoke',
    !assistantRevoke.ok,
    assistantRevoke.err ?? 'an assistant revoked an invitation',
  );
  check(
    '...and their attempt changed nothing',
    (await query(db, 'select revoked_at from staff_invitations where token = $1', [authToken]))[0]
      ?.revoked_at == null,
    'a refused revocation still withdrew the code',
  );

  const crossBranch = await revokeInvite(db, OWNER_B, authToken);
  check(
    'an owner cannot revoke another branch\'s invitation',
    !crossBranch.ok || crossBranch.value?.[0]?.revoked === false,
    crossBranch.err ?? 'a cross-branch revocation succeeded',
  );
  check(
    '...leaving it revocable by its own owner',
    (await revokeInvite(db, OWNER_A, authToken)).value?.[0]?.revoked === true,
    'the rightful owner could not revoke it',
  );

  check(
    'a second revoke of an already-revoked invitation reports false',
    (await revokeInvite(db, OWNER_A, authToken)).value?.[0]?.revoked === false,
    'revoking twice reported success',
  );

  check(
    'an accepted invitation cannot be revoked',
    (await claimInvite(db, authToken) ?? []).length === 0,
    'fixture was claimable',
  );
}

section('only service_role may claim');

{
  const asAnonClaim = await asAnon(db, () =>
    query(db, 'select email from public.pf_claim_invitation($1)', [claimableToken]),
  );
  check('anon cannot claim', !asAnonClaim.ok, asAnonClaim.err ?? 'anon claimed an invitation');

  const asAuthClaim = await asAuthenticated(db, () =>
    query(db, 'select email from public.pf_claim_invitation($1)', [claimableToken]),
  );
  check(
    'authenticated cannot claim either',
    !asAuthClaim.ok,
    asAuthClaim.err ?? 'a signed-in browser session claimed an invitation',
  );

  // A code of its own, so this checks the grant rather than the state of a fixture
  // that three blocks above deliberately left holding a live lease.
  const svcInvite = await issueInvite(db, OWNER_A, 'svc-claim@example.test');
  check(
    '...while service_role can, which is how the Worker calls it',
    (await claimInvite(db, svcInvite.value?.[0]?.token) ?? []).length === 1,
    'the service_role path is broken',
  );
}

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

const leaverActivation = await query(
  db,
  `select count(*)::int as n
     from audit_events
    where branch_id = $1
      and action = 'pharmacy_activated'
      and actor_id = $2`,
  [BRANCH_A, LEAVER],
);
check(
  'an assistant acceptance is not recorded as an owner activation',
  leaverActivation[0]?.n === 0,
  'only an owner invitation may activate the pharmacy or claim an owner arrived',
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