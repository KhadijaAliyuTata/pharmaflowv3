import { createFileRoute } from '@tanstack/react-router';
import { createClient } from '@supabase/supabase-js';
import { env } from 'cloudflare:workers';
import type { Database } from '~/lib/db.types';
import { emailHtml, greeting, greetingText } from '~/lib/invite-email';

/**
 * POST /api/send-invite — send a staff invitation email.
 *
 * ## Why a server route rather than the browser
 *
 * Resend is reached with an API key. A key in browser code is a key anyone can
 * read out of the bundle and use to send as this pharmacy, so the send has to
 * happen here, inside workerd, where `RESEND_API_KEY` lives in the Worker
 * environment and is never emitted into any bundle.
 *
 * ## Why this does not use the service-role key
 *
 * It does not need one. The caller's own access token is forwarded, so
 * PostgREST evaluates `auth.uid()` exactly as it would for the browser and the
 * existing policies do the authorizing:
 *
 *   - `pf_is_owner()` decides whether this caller may send at all.
 *   - `staff_invitations_owner_read` (`pf_is_owner() AND branch_id =
 *     pf_current_branch()`) decides which invitation rows are visible to them.
 *
 * So an assistant is refused, and an owner can only ever read an invitation
 * belonging to their own branch. `client.ts` states the rule this follows: the
 * service-role key bypasses RLS by design, and a copy of it anywhere in the app
 * would silently dismantle every policy in the migration.
 *
 * ## Why it cannot be used as a mail relay
 *
 * The recipient is never taken from the request body. The body carries only the
 * invitation token, and the address is read from the invitation row *after* RLS
 * has decided this caller may see it. There is no field in which a caller could
 * name an arbitrary address, so there is nothing to relay to.
 *
 * ## What makes it safe to send
 *
 * The invitation must already exist, must be pending, and must be visible to
 * this caller. A withdrawn or already-accepted invitation is refused rather than
 * mailed, so the address cannot receive a link that will not work.
 *
 * The Supabase URL and publishable key are read from `import.meta.env`, which
 * Vite substituted at build time — the same two public values the browser
 * already has. Only `RESEND_API_KEY` comes from the Worker environment.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const Route = createFileRoute('/api/send-invite')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ---------------------------------------------------------------- config
        // Reported as a configuration problem rather than thrown, because "email
        // silently did not arrive" is the failure mode this whole route exists
        // to prevent.
        const apiKey = env.RESEND_API_KEY;
        const from = env.RESEND_FROM;

        const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
        const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

        const missing: string[] = [];
        if (!apiKey) missing.push('RESEND_API_KEY');
        if (!from) missing.push('RESEND_FROM');
        if (!supabaseUrl) missing.push('PUBLIC_SUPABASE_URL');
        if (!anonKey) missing.push('PUBLIC_SUPABASE_ANON_KEY');
        if (missing.length > 0) {
          return Response.json(
            {
              ok: false,
              error: `Email is not configured on this deployment. Missing: ${missing.join(', ')}.`,
            },
            { status: 503 },
          );
        }

        // ---------------------------------------------------------------- caller
        const header = request.headers.get('authorization') ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token) {
          return Response.json(
            { ok: false, error: 'You must be signed in to send an invitation.' },
            { status: 401 },
          );
        }

        const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
        const inviteToken = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!inviteToken) {
          return Response.json(
            { ok: false, error: 'No invitation code was supplied.' },
            { status: 400 },
          );
        }

        // The caller's own token authorizes the query, so RLS applies.
        const supabase = createClient<Database>(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data: isOwner, error: ownerError } = await supabase.rpc('pf_is_owner');
        if (ownerError) {
          return Response.json(
            { ok: false, error: `Could not confirm your permissions: ${ownerError.message}` },
            { status: 502 },
          );
        }
        if (isOwner !== true) {
          return Response.json(
            { ok: false, error: 'Only an owner can send a staff invitation.' },
            { status: 403 },
          );
        }

        // RLS scopes this to the caller's own branch; an invitation belonging to
        // another pharmacy is simply not found.
        const { data: invitation, error: inviteError } = await supabase
          .from('staff_invitations')
          .select('email, role, full_name, branch_id, expires_at, accepted_at, revoked_at')
          .eq('token', inviteToken)
          .maybeSingle();

        if (inviteError) {
          return Response.json(
            { ok: false, error: `Could not read the invitation: ${inviteError.message}` },
            { status: 502 },
          );
        }
        if (!invitation) {
          return Response.json(
            { ok: false, error: 'That invitation was not found at your pharmacy.' },
            { status: 404 },
          );
        }
        if (invitation.revoked_at) {
          return Response.json(
            { ok: false, error: 'That invitation was withdrawn. Create a new one before sending.' },
            { status: 409 },
          );
        }
        if (invitation.accepted_at) {
          return Response.json(
            { ok: false, error: 'That invitation has already been accepted.' },
            { status: 409 },
          );
        }
        // Refused here as well as in redemption, so a link that is already dead is
        // never put in an inbox in the first place.
        if (invitation.expires_at && new Date(invitation.expires_at).getTime() <= Date.now()) {
          return Response.json(
            { ok: false, error: 'That invitation has expired. Create a new one before sending.' },
            { status: 409 },
          );
        }

        // The pharmacy's own name, read under the same RLS as everything else and scoped
        // to the branch the invitation belongs to. Used only as display text in the
        // greeting; nothing about the send depends on it.
        const { data: branch } = await supabase
          .from('branches')
          .select('name')
          .eq('id', invitation.branch_id)
          .maybeSingle();

        // ---------------------------------------------------------------- message
        // Prefer an explicitly configured public address; otherwise link to
        // wherever this request actually arrived, which is right on the
        // workers.dev host and on a custom domain alike.
        const origin = (env.PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/+$/, '');
        const joinUrl = `${origin}/join?token=${encodeURIComponent(inviteToken)}`;
        const roleLabel = invitation.role === 'owner' ? 'Owner' : 'Assistant';
        const pharmacyName = branch?.name ?? 'the pharmacy';
        // Two forms of the salutation, because one body is HTML and the other is
        // not. See ~/lib/invite-email for why they must not be the same string.
        const salutation = greeting(invitation.full_name);
        const salutationText = greetingText(invitation.full_name);

        const expiresOn = invitation.expires_at
          ? new Date(invitation.expires_at).toUTCString()
          : null;

        const resend = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [invitation.email],
            subject: `${pharmacyName} invited you to join PharmaFlow`,
            html: emailHtml({
              greeting: salutation,
              pharmacyName,
              roleLabel,
              code: inviteToken,
              joinUrl,
              expiresOn,
            }),
            text:
              `${salutationText}\n\n` +
              `${pharmacyName} has invited you to join their team on PharmaFlow as a ${roleLabel}.\n\n` +
              `Invitation code: ${inviteToken}\n` +
              `Open ${joinUrl} to accept it and choose your own password.\n` +
              (expiresOn ? `This invitation expires on ${expiresOn}.\n` : '') +
              `\nThis link only works for ${invitation.email}.`,
          }),
        });

        // Resend's own status and message, not an assumption.
        if (!resend.ok) {
          const detail = await resend.text().catch(() => '');
          return Response.json(
            {
              ok: false,
              error: `Resend refused the message (HTTP ${resend.status})${detail ? `: ${detail}` : ''}`,
            },
            { status: 502 },
          );
        }

        const result = (await resend.json().catch(() => ({}))) as { id?: string };

        return Response.json({
          ok: true,
          id: result.id ?? null,
          to: invitation.email,
        });
      },
    },
  },
});