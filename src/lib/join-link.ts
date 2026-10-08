/**
 * The public address of an invitation link.
 *
 * ## Why this exists
 *
 * An invitation is shared with the person being invited, and they open it on their
 * own phone. A link built from whatever the owner's browser happens to be showing
 * is therefore only correct by accident: it works while the owner is on the same
 * machine that generated it, and is wrong the moment it is opened anywhere else —
 * `localhost` names the reader's own device, not this one.
 *
 * So the base address is configuration, not a guess:
 *
 *   1. `PUBLIC_APP_URL` when it is set. This is what a production build should
 *      have, and it makes the link correct even when the owner is looking at a
 *      development machine while sending a real invitation.
 *   2. The browser's own origin otherwise. On a local dev server that is
 *      `http://localhost:5173`, which is the correct answer *for that machine*,
 *      and on a real deployment it is the deployment's own address. This is a
 *      fallback, not a hardcoded default.
 *
 * There is no literal `localhost` anywhere in this file. A local address is only
 * ever produced by a browser that is genuinely running on a local address, which
 * is the one case where it is right.
 *
 * ## What this deliberately does not do
 *
 * It does not send anything. There is no email provider in this deployment, and
 * adding one is a separate piece of work — the invitation link is something the
 * owner copies into whatever channel they already use.
 *
 * `PUBLIC_APP_URL` is a public value and is safe in the browser bundle. It is not,
 * and must never become, a place to keep the Supabase service key or a database
 * password: everything under the `PUBLIC_` prefix is shipped to the client.
 */

/** Trailing slashes stripped so joining a path never yields a doubled separator. */
function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * The base address links should be built from, or `''` when nothing is knowable.
 */
export function publicAppOrigin(): string {
  const configured = import.meta.env.PUBLIC_APP_URL;

  if (typeof configured === 'string' && configured.trim() !== '') {
    return normaliseOrigin(configured);
  }

  // Browser fallback. Absent during SSR, where a link cannot be built at all —
  // which is correct, because a server-rendered link would be rendered for the
  // server's own host rather than the reader's.
  if (typeof window !== 'undefined' && window.location?.origin) {
    return normaliseOrigin(window.location.origin);
  }

  return '';
}

/**
 * The full `/join` link for an invitation code.
 *
 * The code is a real credential — `pf_redeem_invitation` will not accept it from a
 * different email address — so it is percent-encoded, and callers should treat the
 * result as sensitive. It goes in a query parameter because that is what
 * `src/routes/join.tsx` already reads; the redemption logic is unchanged by this
 * module.
 */
export function invitationLink(token: string): string {
  const path = `/join?token=${encodeURIComponent(token)}`;
  const origin = publicAppOrigin();

  // With no origin at all, a relative link is more useful than a broken absolute
  // one. It resolves against wherever the owner is actually looking.
  return origin ? `${origin}${path}` : path;
}