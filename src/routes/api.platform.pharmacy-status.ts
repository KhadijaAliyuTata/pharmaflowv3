/**
 * PATCH /api/platform/pharmacy-status
 *
 * Suspend or reactivate a pharmacy. Same trust model as the onboarding route:
 * the browser proves who it is with its own JWT, the database says whether that
 * user is a platform administrator, and only then does the service-role key act.
 *
 * Suspending deletes nothing. `pf_current_branch()` returns NULL for a suspended
 * branch, so every RLS policy stops matching and access is withdrawn at once.
 */

import { createFileRoute } from '@tanstack/react-router';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, PharmacyStatus } from '~/lib/db.types';
import { env } from 'cloudflare:workers';
import { isJsonContentType, readJsonBody } from '~/lib/request-guard';

/**
 * Narrowing the JSON body, and the status enum, without an assertion.
 *
 * `readJsonBody` deliberately returns `unknown`, so something has to establish
 * that it is an object before its fields can be read. A bare cast would assert
 * it; this checks it. It matters here because the result is handed to a
 * privileged RPC.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const STATUSES: ReadonlySet<PharmacyStatus> = new Set<PharmacyStatus>([
  'pending',
  'active',
  'suspended',
]);

/** A type guard rather than a cast, so `rawStatus` narrows on its own. */
function isPharmacyStatus(value: string): value is PharmacyStatus {
  return STATUSES.has(value as PharmacyStatus);
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function adminClient(): SupabaseClient<Database> | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function callerClient(accessToken: string): SupabaseClient<Database> | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const Route = createFileRoute('/api/platform/pharmacy-status')({
  server: {
    handlers: {
      PATCH: async ({ request }) => {
        if (!isJsonContentType(request.headers.get('content-type'))) {
          return fail(415, 'content_type', 'Send this request as application/json.');
        }

        const body = await readJsonBody(request);
        if (!body.ok) return fail(body.status, 'body', body.error);

        const bearer = request.headers.get('authorization') ?? '';
        const accessToken = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
        if (!accessToken) return fail(401, 'forbidden', 'Sign in to continue.');

        const anon = callerClient(accessToken);
        if (!anon) return fail(503, 'config', 'Supabase is not configured.');

        const { data: userData, error: userError } = await anon.auth.getUser(accessToken);
        if (userError || !userData?.user) {
          return fail(401, 'forbidden', 'Your session has expired. Sign in again.');
        }

        const { data: flag, error: flagError } = await anon.rpc('pf_is_platform_admin');
        if (flagError) return fail(503, 'config', 'Could not verify platform access.');
        if (flag !== true) {
          return fail(403, 'forbidden', 'This area is for platform administrators only.');
        }

        const input = asRecord(body.body);
        const branchId = String(input.branchId ?? '').trim();
        const rawStatus = String(input.status ?? '').trim();
        const reason = input.reason === undefined || input.reason === null
          ? null
          : String(input.reason).trim();

        if (!branchId) return fail(400, 'validation', 'Which pharmacy?');
        if (!isPharmacyStatus(rawStatus)) {
          return fail(400, 'validation', 'That is not a valid pharmacy status.');
        }
        if (rawStatus === 'suspended' && !reason) {
          return fail(400, 'validation', 'Give a reason for suspending a pharmacy.');
        }

        const privileged = adminClient();
        if (!privileged) {
          return fail(503, 'config', 'SUPABASE_SERVICE_ROLE_KEY is not set on this Worker.');
        }

        const { data, error } = await privileged.rpc('pf_set_pharmacy_status', {
          p_actor: userData.user.id,
          p_branch_id: branchId,
          p_status: rawStatus,
          p_reason: reason,
        });

        if (error) {
          const missing = /Pharmacy not found/i.test(error.message);
          return fail(missing ? 404 : 400, missing ? 'not_found' : 'rpc', error.message);
        }

        return new Response(
          JSON.stringify({ ok: true, branchId, status: rawStatus, changed: data === true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  },
});
