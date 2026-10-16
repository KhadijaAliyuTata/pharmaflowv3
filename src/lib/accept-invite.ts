/**
 * Deciding whether a staff invitation may be accepted.
 *
 * Split out of the Worker route for the same reason `invite-email.ts` was split
 * out: this is the part of acceptance that decides whether an account gets
 * created, and it must be testable without a Worker, a Supabase connection, or a
 * session. Every function here is pure.
 *
 * ## What this file is allowed to decide
 *
 * Only whether an invitation is still usable. It cannot choose an email address,
 * a branch or a role — the email comes from the invitation row, and the branch and
 * role come from that same row inside `pf_redeem_invitation`. There is no input to
 * this module that could name a different address, and that is deliberate: it is
 * what stops the acceptance endpoint from being an account factory for arbitrary
 * addresses.
 */

/** The columns acceptance needs. Nothing else is read, and nothing else exists here. */
import { MAX_TOKEN_LENGTH } from './request-guard';

export type AcceptableInvitation = {
  email: string;
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
};

export type AcceptVerdict =
  | { ok: true; email: string }
  | { ok: false; code: AcceptCode; error: string };

/**
 * Machine-readable reasons.
 *
 * `already_registered` is separated from every other failure because it is the
 * one case with a different next step: the person already has a password, so they
 * sign in and redeem instead of creating an account.
 *
 * `claimed` is separated for the same reason, and its message has to name waiting
 * rather than retrying immediately — the invitation is live, another attempt holds
 * the four-minute reservation on it, and a second submission inside that window
 * would be refused again for the same reason.
 */
export type AcceptCode =
  | 'not_found'
  | 'revoked'
  | 'accepted'
  | 'expired'
  | 'already_registered'
  | 'claimed'
  | 'weak_password'
  | 'bad_request';

/** How long one acceptance attempt may hold an invitation, in minutes. */
export const CLAIM_LEASE_MINUTES = 4;

/**
 * The minimum password length accepted for a new staff account.
 *
 * Eight, not Supabase's default six. A pharmacy till password is often six digits
 * and a shoulder-surfed four more, so the floor is raised at the one moment the
 * password is created. Existing accounts are unaffected: nothing here runs for a
 * person who is signing in with a password they already have.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Long enough to be unguessable by anything but a dictionary, short enough to type twice. */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Whether an invitation row may still be used, and for which address.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the expiry boundary is
 * testable exactly, including the instant of expiry itself.
 *
 * Order matters and is the order a person would want to hear about: a withdrawn
 * invitation reports "withdrawn" even if it has also expired, because "your owner
 * took this back" is the actionable half.
 */
export function evaluateInvitation(
  invitation: AcceptableInvitation | null,
  now: number = Date.now(),
): AcceptVerdict {
  if (!invitation) {
    return {
      ok: false,
      code: 'not_found',
      error: 'That invitation code is not valid, or has already been used.',
    };
  }

  if (invitation.revoked_at) {
    return {
      ok: false,
      code: 'revoked',
      error: 'That invitation was withdrawn. Ask your owner to send a new one.',
    };
  }

  if (invitation.accepted_at) {
    return {
      ok: false,
      code: 'accepted',
      error: 'That invitation has already been accepted. Sign in with your password.',
    };
  }

  // Strictly greater, so an invitation is dead at the instant it expires rather
  // than for the following instant.
  if (invitation.expires_at && Date.parse(invitation.expires_at) <= now) {
    return {
      ok: false,
      code: 'expired',
      error: 'That invitation has expired. Ask your owner to send a new one.',
    };
  }

  // The address is read from the row and returned, never taken from the caller.
  // This is the single line that makes the endpoint safe to expose unauthenticated.
  return { ok: true, email: invitation.email };
}

/**
 * Password policy for a new staff account.
 *
 * Rejects on length only. Composition rules ("one capital, one symbol") push people
 * towards `Password1!` and are security theatre; length is what actually costs an
 * attacker time.
 */
export function checkPassword(password: string): { ok: true } | { ok: false; error: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // Bcrypt truncates at 72 bytes, so anything past this is silently ignored.
    // Refusing is clearer than accepting a password whose tail does nothing.
    return { ok: false, error: 'That password is too long.' };
  }
  return { ok: true };
}

/**
 * Pull `{ token, password }` out of an untrusted request body.
 *
 * Note what is absent: there is no `email` field. The address is not something the
 * caller supplies, so accepting one here would only create the illusion that it is
 * negotiable.
 *
 * The token is length-bounded here rather than at the database, so an oversized value
 * never becomes a parameter in a privileged lookup. The limit is the token's real
 * length — see `MAX_TOKEN_LENGTH` in `./request-guard`.
 */
export function parseAcceptBody(
  body: unknown,
): { ok: true; token: string; password: string } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Send the invitation code and a password.' };
  }

  const { token, password } = body as { token?: unknown; password?: unknown };

  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, error: 'No invitation code was supplied.' };
  }

  const trimmed = token.trim();
  if (trimmed.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: 'That invitation code is not the right length.' };
  }

  if (typeof password !== 'string' || password === '') {
    return { ok: false, error: 'Choose a password.' };
  }

  return { ok: true, token: trimmed, password };
}
