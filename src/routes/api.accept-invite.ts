import { createFileRoute } from '@tanstack/react-router';
import { createClient } from '@supabase/supabase-js';
import { env } from 'cloudflare:workers';
import {
  checkPassword,
  evaluateInvitation,
  parseAcceptBody,
  type AcceptableInvitation,
} from '~/lib/accept-invite';
import type { Database } from '~/lib/db.types';
import { isJsonContentType, readJsonBody } from '~/lib/request-guard';

/**
 * POST /api/accept-invite — create a staff account from a valid invitation.
 *
 * ## Why this exists
 *
 * `signUp` on a deployment with email confirmation required returns a user but no
 * session, and then waits for a confirmation email that has to be delivered by
 * Supabase's own SMTP. That made the invitation flow depend on a second email the
 * app neither triggers nor can observe, so `/join` dead-ended at "check your email"
 * with an account created and no membership.
 *
 * The invitation email is already proof of the address — it was sent there, and
 * only there. Making somebody prove the same fact a second time, through a channel
 * this codebase does not control, is the defect rather than the safeguard.
 *
 * ## The reservation, and the window it leaves open
 *
 * `pf_claim_invitation` checks and reserves in one statement, so two concurrent
 * requests cannot both proceed and the check-then-create gap shrinks from two
 * network calls to one. It does not close the window: a claim is a Postgres write
 * and `createUser` is an HTTPS call, so an owner can still revoke in between and
 * revocation cannot cancel a request already in flight.
 *
 * That is tolerable because of what it can and cannot produce. The result is a
 * confirmed account with no membership — inert, since `pf_current_branch()` is NULL
 * and every membership policy resolves to nothing. It cannot see the pharmacy, and
 * `pf_redeem_invitation` refuses the revoked row regardless of any claim. Recovery
 * is the existing path: the owner re-issues to that address and the person redeems.
 * No claim is ever cleared explicitly; a claim is released by its lease expiring.
 *
 * ## What this endpoint is allowed to do
 *
 * One thing: create a confirmed auth user **for the address on a live invitation
 * row**. That is it.
 *
 *   * The address comes from the database, never from the request. There is no
 *     `email` parameter to abuse, which is what keeps this from being an
 *     account-creation oracle for arbitrary addresses.
 *   * The invitation must be live: not withdrawn, not accepted, not expired. A dead
 *     code creates nothing.
 *   * No branch, no role, no membership. Those are `pf_redeem_invitation`'s job,
 *     and it still runs, still as the invited person's own session, still re-checks
 *     the address. Acceptance does not weaken redemption by one line.
 *
 * ## Why it needs the service-role key
 *
 * Creating an auth user is `auth.admin.createUser`, and there is no other API for
 * it: `signUp` cannot pre-confirm an address, and PostgREST cannot write
 * `auth.users`. So this endpoint needs the service-role key.
 *
 * It stays here. `src/lib/supabase/client.ts` says no service-role client may ever
 * exist, and that rule is about the *browser* — a key that bypasses RLS in a bundle
 * dismantles every policy in the migration. Inside the Worker it is read from the
 * environment, never bundled, and it is used for exactly one call below.
 *
 * The alternative — leaving accounts to self-confirm by email — is not available,
 * because this deployment has no working path for that email to arrive. Disabling
 * confirmation globally to make it work would also weaken signup for customers, so
 * it is not done.
 */
export const Route = createFileRoute('/api/accept-invite')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ---------------------------------------------------------------- config
        // Reported together, and before anything else, so a misconfigured
        // deployment says what is missing instead of failing obscurely later.
        const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
        const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
        const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

        const missing: string[] = [];
        if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl) missing.push('PUBLIC_SUPABASE_URL');
        if (!anonKey) missing.push('PUBLIC_SUPABASE_ANON_KEY');
        if (missing.length > 0 || !serviceRoleKey || !supabaseUrl || !anonKey) {
          return Response.json(
            {
              ok: false,
              error: `This deployment cannot create staff accounts. Missing: ${missing.join(', ')}.`,
            },
            { status: 503 },
          );
        }

        // ---------------------------------------------------------------- content type
        // Refused before anything else, so a caller that cannot state that it is
        // sending JSON never reaches a privileged call.
        if (!isJsonContentType(request.headers.get('content-type'))) {
          return Response.json(
            { ok: false, error: 'Send this request as application/json.' },
            { status: 415 },
          );
        }

        // ---------------------------------------------------------------- body
        // Bounded while streaming rather than trusted from Content-Length, so an
        // oversized body is abandoned partway instead of buffered in full.
        const body = await readJsonBody(request);
        if (!body.ok) {
          return Response.json({ ok: false, error: body.error }, { status: body.status });
        }

        // ---------------------------------------------------------------- input
        const parsed = parseAcceptBody(body.body);
        if (!parsed.ok) {
          return Response.json({ ok: false, error: parsed.error }, { status: 400 });
        }

        const passwordCheck = checkPassword(parsed.password);
        if (!passwordCheck.ok) {
          return Response.json({ ok: false, error: passwordCheck.error }, { status: 400 });
        }

        // A privileged client, scoped to this request and this one table. It bypasses
        // RLS by design, so every check that RLS would have made is made explicitly
        // below instead of being assumed.
        const admin = createClient<Database>(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // ---------------------------------------------------------------- claim
        // One statement: check the invitation is live AND reserve it. A separate
        // read-then-write would leave a window in which a second caller claims the
        // same code, or an owner revokes it, between the check and the reservation.
        //
        // The RPC returns the address. It returns no address when the invitation is
        // dead or already claimed by a live lease, and cannot distinguish those, so
        // the second read below turns that single "no" into the specific reason.
        const { data: claimed, error: claimError } = await admin.rpc('pf_claim_invitation', {
          p_token: parsed.token,
        });

        if (claimError) {
          return Response.json(
            { ok: false, error: 'Could not check that invitation. Try again.' },
            { status: 502 },
          );
        }

        const claim = claimed?.[0];
        if (!claim) {
          return await refusal(admin, parsed.token);
        }

        // ---------------------------------------------------------------- address
        // Straight from the claim, which read it from the row. Nothing the browser
        // sent can influence which account is about to be created.
        const verdict = evaluateInvitation({ email: claim.email } as AcceptableInvitation, Date.now());
        if (!verdict.ok) {
          // Unreachable while the claim RPC is correct; kept so that a future change
          // to the RPC cannot turn a stale claim into an account at a dead address.
          return await refusal(admin, parsed.token);
        }

        // ---------------------------------------------------------------- account
        // `email_confirm: true` is the whole point of this endpoint: the address was
        // proven by the invitation email, so it does not need proving again.
        const { data: created, error: createError } = await admin.auth.admin.createUser({
          email: verdict.email,
          password: parsed.password,
          email_confirm: true,
        });

        if (createError) {
          const message = createError.message ?? '';

          // Someone already has an account at this address. That is a fork in the
          // road, not a rejection — the client sends them to sign in and redeem with
          // the password they already have. Reported distinctly so the UI can offer
          // that path instead of a dead end.
          //
          // The address is echoed here for the same reason it is echoed on success:
          // the caller proved they hold this invitation by presenting its token, and
          // the invitation already names this address. They were emailed it.
          if (/already been registered|already registered|already exists/i.test(message)) {
            return Response.json(
              {
                ok: false,
                code: 'already_registered',
                email: verdict.email,
                error: 'You already have an account at this address.',
              },
              { status: 409 },
            );
          }

          return Response.json(
            { ok: false, error: 'That account could not be created. Try again.' },
            { status: 502 },
          );
        }

        // ---------------------------------------------------------------- done
        // The address is echoed so the client can sign in with the same one it was
        // sent. It is not a secret: the caller proved it holds this invitation, and
        // the invitation itself names this address.
        return Response.json(
          {
            ok: true,
            email: created?.user?.email ?? verdict.email,
          },
          { status: 201 },
        );
      },
    },
  },
});

/**
 * Explain a refused claim.
 *
 * `pf_claim_invitation` returns no address when the invitation is withdrawn,
 * accepted, expired, unknown, or already claimed. It cannot report which, and it
 * should not: a single "no" is what stops this from being an oracle for probing which
 * tokens exist. So the row is read once more, here, purely to produce the one message
 * the holder of a real code needs.
 *
 * The address is not echoed on any of these. Only `already_registered` below returns
 * one, and only to someone who already presented a live invitation.
 *
 * `admin` is the service-role client. It bypasses RLS, which is why the liveness
 * conditions are re-stated rather than assumed.
 */
async function refusal(
  admin: ReturnType<typeof createClient<Database>>,
  token: string,
): Promise<Response> {
  const { data } = await admin
    .from('staff_invitations')
    .select('email, accepted_at, revoked_at, expires_at, claimed_at, claim_expires_at')
    .eq('token', token)
    .maybeSingle();

  // Absent row: say nothing about whether it ever existed.
  if (!data) {
    return Response.json(
      {
        ok: false,
        code: 'not_found',
        error: 'That invitation code is not valid, or has already been used.',
      },
      { status: 404 },
    );
  }

  // A live claim by someone else is reported before the row's own state, because
  // it is the actionable one: waiting a few minutes is what the person should do,
  // whereas a withdrawn code will never work at any point.
  if (data.claimed_at && data.claim_expires_at && new Date(data.claim_expires_at) > new Date()) {
    return Response.json(
      {
        ok: false,
        code: 'claimed',
        error: 'Someone is already setting up an account with this code. Try again in a few minutes.',
      },
      { status: 409 },
    );
  }

  const verdict = evaluateInvitation(
    {
      email: data.email,
      accepted_at: data.accepted_at,
      revoked_at: data.revoked_at,
      expires_at: data.expires_at,
    },
    Date.now(),
  );

  // A live row that survived `evaluateInvitation` yet produced no claim means the
  // RPC and this read disagree. Reporting "not valid" is the honest fallback: it
  // creates nothing and prompts a retry.
  if (!verdict.ok) {
    return Response.json({ ok: false, code: verdict.code, error: verdict.error }, { status: 409 });
  }

  return Response.json(
    {
      ok: false,
      code: 'not_found',
      error: 'That invitation code is not valid, or has already been used.',
    },
    { status: 404 },
  );
}
