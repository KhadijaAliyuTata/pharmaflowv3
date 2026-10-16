/**
 * POST /api/platform/onboard-pharmacy  (and PATCH /api/platform/pharmacy-status)
 *
 * ## Why this is a Worker route and not a browser call
 *
 * Two independent reasons, and both are load-bearing:
 *
 *   1. `pf_create_pharmacy` is `SECURITY DEFINER` and granted only to
 *      `service_role`. The anon key a browser holds cannot execute it - that is
 *      deliberate, and it is what stops an owner calling it directly.
 *   2. The invitation token must be emailed from somewhere the key already is.
 *      Returning it to the browser so it could call Resend would put a live
 *      credential in a response body.
 *
 * So the browser proves who it is, and this route does the privileged part.
 *
 * ## What the browser does and does not get to say
 *
 * The route reads the caller's JWT with the ANON key, asks the database whether
 * that user is a platform administrator, and only then calls the RPC with the
 * service-role key. The admin id is not taken from the request body - a caller
 * cannot nominate somebody else to act as.
 *
 * The response contains the pharmacy, the invitation, and whether the email was
 * actually sent. It never contains the token.
 *
 * ## Failure handling
 *
 * The RPC is one transaction: either the pharmacy and its invitation both exist,
 * or neither does. A failed email therefore leaves a real, sendable invitation
 * rather than an orphan pharmacy, and the response says so explicitly so the
 * dashboard can offer a resend instead of pretending it was delivered.
 */

import { createFileRoute } from '@tanstack/react-router';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '~/lib/db.types';
import { env } from 'cloudflare:workers';
import { emailHtml, greeting, greetingText } from '~/lib/invite-email';
import { invitationLink, publicAppOrigin } from '~/lib/join-link';
import { isJsonContentType, readJsonBody } from '~/lib/request-guard';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Narrowing the JSON body, without an assertion.
 *
 * `readJsonBody` deliberately returns `unknown`, so something has to establish
 * that it is an object before its fields can be read. A bare cast would assert
 * it; this checks it, which is what a privileged RPC deserves.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** One shape for every failure, so the dashboard never parses prose. */
function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ok = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The service-role client. Returns null rather than throwing, so a missing
 *  binding is reported as configuration rather than as a 500. */
function adminClient(): SupabaseClient<Database> | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The caller's own client, carrying their JWT. Used only to prove identity. */
function callerClient(accessToken: string): SupabaseClient<Database> | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolvePlatformAdmin(request: Request) {
  const bearer = request.headers.get('authorization') ?? '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
  if (!token) return { ok: false as const, status: 401, error: 'Sign in to continue.' };

  const anon = callerClient(token);
  if (!anon) return { ok: false as const, status: 503, error: 'Supabase is not configured.' };

  // Two facts from the caller's own session: who they are, and whether the
  // DATABASE says they administer the platform. The second is the only one that
  // counts; the first is just where to look.
  const { data: userData, error: userError } = await anon.auth.getUser(token);
  if (userError || !userData?.user) {
    return { ok: false as const, status: 401, error: 'Your session has expired. Sign in again.' };
  }

  const { data: flag, error: flagError } = await anon.rpc('pf_is_platform_admin');
  if (flagError) {
    return { ok: false as const, status: 503, error: 'Could not verify platform access.' };
  }
  if (flag !== true) {
    return { ok: false as const, status: 403, error: 'This area is for platform administrators only.' };
  }

  return { ok: true as const, actorId: userData.user.id };
}

/* ------------------------------------------------------------------ onboarding */

export const Route = createFileRoute('/api/platform/onboard-pharmacy')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isJsonContentType(request.headers.get('content-type'))) {
          return fail(415, 'content_type', 'Send this request as application/json.');
        }

        const body = await readJsonBody(request);
        if (!body.ok) return fail(body.status, 'body', body.error);

        const admin = await resolvePlatformAdmin(request);
        if (!admin.ok) return fail(admin.status, 'forbidden', admin.error);

        // Named `privileged`, not `adminClient`: a local const with the same name as
        // the helper shadowed it, and calling it inside its own initialiser is
        // what the type-checker caught.
        const privileged = adminClient();
        if (!privileged) {
          return fail(503, 'config', 'SUPABASE_SERVICE_ROLE_KEY is not set on this Worker.');
        }

        const input = asRecord(body.body);

        const name = String(input.pharmacyName ?? '').trim();
        const ownerName = String(input.ownerName ?? '').trim();
        const ownerEmail = String(input.ownerEmail ?? '').trim();

        // Shape checks before the call, so the attendant-side error is the same
        // sentence whether it came from here or from the database.
        if (!name) return fail(400, 'validation', 'Enter the pharmacy name.');
        if (!ownerName) return fail(400, 'validation', 'Enter the owner’s name.');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
          return fail(400, 'validation', 'Enter a valid owner email address.');
        }

        const { data, error } = await privileged.rpc('pf_create_pharmacy', {
          p_actor: admin.actorId,
          p_pharmacy_name: name,
          p_owner_name: ownerName,
          p_owner_email: ownerEmail,
          p_phone: String(input.phone ?? '').trim(),
          p_address: String(input.address ?? '').trim(),
          p_city: String(input.city ?? '').trim(),
          p_state: String(input.state ?? '').trim(),
        });

        if (error) {
          // A duplicate name or a second live invitation is a 409, not a 500:
          // the operator did something reasonable that the data will not allow.
          const conflict = /already exists|already a live invitation/i.test(error.message);
          return fail(conflict ? 409 : 400, conflict ? 'conflict' : 'rpc', error.message);
        }

        const row = (Array.isArray(data) ? data[0] : data) as
          | { branch_id?: string; pharmacy_name?: string; owner_invitation?: string; invitation_token?: string }
          | null;

        if (!row?.branch_id) {
          return fail(500, 'rpc', 'The pharmacy was not created.');
        }

        // ---- send the invitation -------------------------------------------
        //
        // A failure here is reported, not swallowed. The pharmacy and its
        // invitation exist (one transaction, already committed), so the operator
        // can resend; pretending it was delivered would leave an owner waiting
        // on an email that does not exist.
        let emailSent = false;
        let emailError: string | null = null;

        const apiKey = env.RESEND_API_KEY;
        const from = env.RESEND_FROM;

        if (!apiKey || !from) {
          emailError = 'RESEND_API_KEY and RESEND_FROM are not set on this Worker.';
        } else if (!row.invitation_token) {
          emailError = 'No invitation token was issued.';
        } else {
          try {
            const joinUrl = invitationLink(row.invitation_token);
            const res = await fetch(RESEND_ENDPOINT, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                from,
                to: [ownerEmail],
                subject: `You are invited to run ${name} on PharmaFlow`,
                html: emailHtml({
                  greeting: greeting(ownerName),
                  pharmacyName: name,
                  roleLabel: 'Owner',
                  code: row.invitation_token,
                  // No expiry is set on a platform invitation today; the column is
                  // nullable and pf_redeem_invitation treats NULL as 'no expiry'.
                  // Revisit if onboarding ever needs a deadline.
                  expiresOn: null,
                  joinUrl,
                }),
                text: [
                  greetingText(ownerName),
                  '',
                  `You have been invited to run ${name} on PharmaFlow as its owner.`,
                  '',
                  `Accept your invitation: ${joinUrl}`,
                  '',
                  'This link is personal to you and can only be used once.',
                ].join('\n'),
              }),
            });
            emailSent = res.ok;
            if (!res.ok) {
              emailError = `The email provider rejected the message (HTTP ${res.status}).`;
            }
          } catch {
            emailError = 'The invitation email could not be sent.';
          }
        }

        // Note what is NOT here: the token. It went into the email and nowhere
        // else, so it cannot be read back out of a response, a log or a
        // browser history.
        return ok(
          {
            branchId: row.branch_id,
            pharmacyName: row.pharmacy_name ?? name,
            invitationId: row.owner_invitation ?? null,
            emailSent,
            ...(emailError ? { emailError } : {}),
          },
          201,
        );
      },
    },
  },
});