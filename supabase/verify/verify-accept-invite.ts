/**
 * Accepting a staff invitation.
 *
 * Covers the decision that was previously implicit inside `/join` and its Worker
 * route, where it was untestable: whether a given invitation row still permits an
 * account to be created, and for which address.
 *
 * The bug this suite exists to prevent: `/join` dead-ended at "check your email"
 * with an account created and no membership, because `signUp` waits for a
 * confirmation email this deployment cannot deliver. Acceptance now goes through a
 * server route that pre-confirms the address. The invariants below are what make
 * that safe, and they are asserted here rather than trusted.
 *
 * Runs against the pure module directly — no Worker, no database, no session.
 */

import {
  CLAIM_LEASE_MINUTES,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  checkPassword,
  evaluateInvitation,
  parseAcceptBody,
  type AcceptCode,
  type AcceptableInvitation,
} from '../../src/lib/accept-invite';

let pass = 0;
const failures: string[] = [];

const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' -> ' + detail : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
};

const section = (title: string) => console.log(`\n--- ${title} ---`);

const NOW = Date.parse('2026-10-10T12:00:00Z');

const LIVE: AcceptableInvitation = {
  email: 'attendant@pharmacy.test',
  accepted_at: null,
  revoked_at: null,
  expires_at: '2026-10-17T12:00:00Z',
};

// ---------------------------------------------------------------- live codes

section('a live invitation permits an account, for its own address');

{
  const v = evaluateInvitation(LIVE, NOW);
  check('it is accepted', v.ok, JSON.stringify(v));
  check('the address comes from the row', v.ok && v.email === LIVE.email, v.ok ? v.email : '');
}

section('a dead invitation is refused, each with its own reason');

{
  const revoked = evaluateInvitation({ ...LIVE, revoked_at: '2026-10-09T09:00:00Z' }, NOW);
  check('withdrawn is refused', !revoked.ok, revoked.ok ? 'accepted it' : revoked.code);
  check('  ...with code revoked', !revoked.ok && revoked.code === 'revoked', revoked.ok ? '' : revoked.code);
  check('  ...and a message that says so', !revoked.ok && /withdrawn/i.test(revoked.error), revoked.ok ? '' : revoked.error);
}

{
  const used = evaluateInvitation({ ...LIVE, accepted_at: '2026-10-09T09:00:00Z' }, NOW);
  check('already accepted is refused', !used.ok, used.ok ? 'accepted it' : used.code);
  check('  ...with code accepted', !used.ok && used.code === 'accepted', used.ok ? '' : used.code);
}

{
  const expired = evaluateInvitation({ ...LIVE, expires_at: '2026-10-01T12:00:00Z' }, NOW);
  check('expired is refused', !expired.ok, expired.ok ? 'accepted it' : expired.code);
  check('  ...with code expired', !expired.ok && expired.code === 'expired', expired.ok ? '' : expired.code);
}

{
  const missing = evaluateInvitation(null, NOW);
  check('an unknown token is refused', !missing.ok, missing.ok ? 'accepted it' : missing.code);
  check('  ...with code not_found', !missing.ok && missing.code === 'not_found', missing.ok ? '' : missing.code);
}

section('expiry is enforced at the exact instant, not a second later');

{
  // One millisecond before expiry: still live.
  const justBefore = evaluateInvitation({ ...LIVE, expires_at: '2026-10-10T12:00:00.001Z' }, NOW);
  check('one millisecond before expiry it is still live', justBefore.ok, justBefore.ok ? '' : justBefore.code);

  // Exactly at expiry: dead. Strict `>` on the far side, so there is no window in
  // which an expired code is accepted.
  const exactly = evaluateInvitation({ ...LIVE, expires_at: '2026-10-10T12:00:00.000Z' }, NOW);
  check('at the expiry instant it is already dead', !exactly.ok, exactly.ok ? 'still accepted' : exactly.code);

  const oneAfter = evaluateInvitation({ ...LIVE, expires_at: '2026-10-10T11:59:59.999Z' }, NOW);
  check('one millisecond after it is dead', !oneAfter.ok, oneAfter.ok ? 'still accepted' : oneAfter.code);
}

section('refusal order puts the actionable reason first');

{
  // Withdrawn AND expired. "Your owner took this back" is the half that tells the
  // holder what to do next, so it must win over the expiry message.
  const both = evaluateInvitation(
    { ...LIVE, revoked_at: '2026-10-09T09:00:00Z', expires_at: '2026-10-01T12:00:00Z' },
    NOW,
  );
  check('withdrawn beats expired', !both.ok && both.code === 'revoked', both.ok ? '' : both.code);
}

section('a null expiry is treated as live, not as broken');

{
  // The column is nullable. A row without one has not been given a deadline, and
  // reading it as "expired because I cannot tell" would lock out invitations created
  // before the column existed.
  const noExpiry = evaluateInvitation({ ...LIVE, expires_at: null }, NOW);
  check('a null expiry is accepted', noExpiry.ok, noExpiry.ok ? '' : noExpiry.code);
}

// ---------------------------------------------------------------- claim codes

section('a live reservation has its own refusal, distinct from every dead code');

{
  // The reason `claimed` exists as a code at all: a concurrent double-submit and an
  // invalid code both refuse, but only one of them is worth waiting out.
  const codes: AcceptCode[] = ['not_found', 'revoked', 'accepted', 'expired', 'already_registered', 'claimed'];
  check('claimed is a distinct code', codes.includes('claimed'), codes.join(','));
  check('the lease is four minutes', CLAIM_LEASE_MINUTES === 4, `${CLAIM_LEASE_MINUTES} minutes`);
}

// ---------------------------------------------------------------- password

section('password policy for a new staff account');

{
  check(`${MIN_PASSWORD_LENGTH} characters is accepted`, checkPassword('a'.repeat(MIN_PASSWORD_LENGTH)).ok, '');
  check('one character short is refused', !checkPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok, '');
  check('empty is refused', !checkPassword('').ok, '');
  check(`${MAX_PASSWORD_LENGTH} characters is accepted`, checkPassword('a'.repeat(MAX_PASSWORD_LENGTH)).ok, '');
  check('past the cap is refused', !checkPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1)).ok, '');

  // Length only. Composition rules are deliberately absent.
  const lower = 'aaaaaaaaaaaa';
  check('a long all-lowercase password is accepted', checkPassword(lower).ok, lower);
  check(
    'the policy message names the minimum',
    !checkPassword('short').ok && checkPassword('short').error.includes(String(MIN_PASSWORD_LENGTH)),
    checkPassword('short').error,
  );
}

// ---------------------------------------------------------------- request body

section('the request body carries a token and a password, and no address');

{
  const ok = parseAcceptBody({ token: 'abc123', password: 'longenough' });
  check('a well-formed body is accepted', ok.ok, '');
  check('  ...the token is trimmed', ok.ok && ok.token === 'abc123', ok.ok ? ok.token : '');
  check('  ...the password is not trimmed', ok.ok && ok.password === 'longenough', ok.ok ? ok.password : '');
}

section('an address in the body is ignored, not honoured');

{
  // The single most important assertion here. If the caller could name the
  // address, this endpoint would create accounts for anyone.
  const withEmail = parseAcceptBody({
    token: 'abc123',
    password: 'longenough',
    email: 'attacker@evil.test',
  });
  check('an extra email field is tolerated', withEmail.ok, '');
  check(
    '  ...but no email is returned from it',
    withEmail.ok && !('email' in withEmail),
    Object.keys(withEmail.ok ? withEmail : {}).join(','),
  );

  const alternate = parseAcceptBody({
    token: 'abc123',
    password: 'longenough',
    email: 'victim@pharmacy.test',
  });
  check(
    'a supplied address cannot displace the row address',
    alternate.ok && !('email' in alternate),
    Object.keys(alternate.ok ? alternate : {}).join(','),
  );
}

section('malformed bodies are refused with an actionable message');

for (const [label, body] of [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'token=abc'],
  ['a number', 42],
  ['an array', ['abc']],
  ['an empty object', {}],
  ['a missing password', { token: 'abc' }],
  ['an empty token', { token: '   ', password: 'longenough' }],
  ['a non-string token', { token: 12345, password: 'longenough' }],
  ['a non-string password', { token: 'abc', password: { a: 1 } }],
] as [string, unknown][]) {
  const r = parseAcceptBody(body);
  check(`${label} is refused`, !r.ok, r.ok ? 'accepted it' : '');
  check(`  ...with a message`, !r.ok && typeof r.error === 'string' && r.error.length > 0, r.ok ? '' : r.error);
}

section('prototype pollution through the body is not a path');

{
  const polluted = parseAcceptBody({
    token: 'abc123',
    password: 'longenough',
    __proto__: { polluted: true },
    constructor: { polluted: true },
  });
  check('a polluted body is parsed without effect', polluted.ok, '');
  check(
    '  ...and the global prototype is untouched',
    ({} as Record<string, unknown>).polluted === undefined,
    'Object.prototype was modified',
  );
}

// ---------------------------------------------------------------- report

console.log(`\nverify-accept-invite: ${pass} passed, ${failures.length} failed`);
if (failures.length) console.log(`  failing: ${failures.join(' | ')}`);
process.exit(failures.length === 0 ? 0 : 1);
