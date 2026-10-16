/**
 * Platform administration ? the browser's client for it.
 *
 * ## What the browser is allowed to do
 *
 * Exactly two things, and both are sends to this app's own Worker:
 *
 *   * **read** the `pf_platform_*` views with the anon key, which RLS and the
 *     view predicates already restrict to platform administrators;
 *   * **call** `/api/platform/*` with this session's access token, so the Worker
 *     can re-verify the caller before acting with the service-role key.
 *
 * The service-role key is never referenced here, or anywhere else in browser
 * code. Neither is an invitation token: the Worker emails it and does not put it
 * in a response, so there is nothing for this module to hold.
 *
 * ## Empty is not the same as zero
 *
 * `listOrders` deliberately distinguishes "no orders" from "orders are not
 * recorded yet". The customer-order workflow still writes to `localStorage`, so
 * an empty table means the database has never been written to - not that the
 * platform has taken no orders. Reporting that as `0` would be a false claim,
 * so the repository reports the difference and the screen says so.
 */

import type { PharmacyStatus } from '~/lib/db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/* ------------------------------------------------------------------- shapes */

export interface PlatformPharmacy {
  id: string;
  name: string;
  status: PharmacyStatus;
  address: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  created_at: string;
  activated_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  member_count: number;
  owner_name: string | null;
  owner_id: string | null;
  owner_invitation_email: string | null;
  owner_invited_at: string | null;
  owner_accepted_at: string | null;
  /**
   * Last ADMINISTRATION activity for this pharmacy: role changes, onboarding,
   * status changes. Kept for backward compatibility.
   *
   * This is NOT adoption. A pharmacy taking a hundred sales a day with no role
   * changes reports a stale date here.
   */
  last_activity_at: string | null;
  /** Last PRODUCT activity: a sale, or a stock receipt/movement. Null = never transacted. */
  last_business_activity_at: string | null;
}

export interface PlatformActivity {
  id: string;
  branch_id: string;
  pharmacy_name: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  description: string;
  created_at: string;
}

export interface PlatformOrder {
  id: string;
  branch_id: string;
  pharmacy_name: string;
  order_number: string;
  state: string;
  payment_state: string;
  delivery_type: string;
  created_at: string;
  updated_at: string;
  item_count: number;
}

/* ---------------------------------------------------------------- predicates */

/**
 * Whether this session administers the platform.
 *
 * Asks the database. A false or failed answer resolves to `false`, which is the
 * direction to fail in: a wrong `true` would only be a cosmetic problem, since
 * every privileged operation is checked again server-side.
 */
export async function isPlatformAdmin(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  if (!(await hasSession())) return false;
  const { data, error } = await client().rpc('pf_is_platform_admin');
  if (error) return false;
  return data === true;
}

/* -------------------------------------------------------------------- reads */

/**
 * Pharmacies, newest first.
 *
 * Paginated in the query rather than in the browser: the platform list is the
 * one screen that grows without limit, so loading every pharmacy to filter it
 * would be the wrong shape from the first hundred rows onward.
 */
export async function listPharmacies(
  limit = 25,
  offset = 0,
): Promise<Result<{ rows: PlatformPharmacy[]; count: number }>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  // Two statements: the page, and the unpaginated total for the page control.
  // `count: 'exact'` on its own would ship every id to count them in the browser.
  const page = await client()
    .from('pf_platform_pharmacies')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const total = await client().from('pf_platform_pharmacies').select('id', { count: 'exact', head: true });

  if (page.error) return { ok: false, error: page.error.message, code: page.error.code };

  return ok({
    rows: (page.data ?? []) as PlatformPharmacy[],
    count: total.count ?? (page.data?.length ?? 0),
  });
}

export async function listActivity(limit = 50): Promise<Result<PlatformActivity[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };
  return fromList<PlatformActivity>(
    await client()
      .from('pf_platform_activity')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

export async function listOrders(limit = 50): Promise<Result<PlatformOrder[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };
  return fromList<PlatformOrder>(
    await client()
      .from('pf_platform_orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

/* ------------------------------------------------------------------- writes */

async function postPlatform<T>(
  path: string,
  payload: Record<string, unknown>,
): Promise<Result<T>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };

  const session = await client().auth.getSession();
  const accessToken = session.data.session?.access_token;
  if (!accessToken) return { ok: false, error: NO_SESSION };

  let response: Response;
  try {
    response = await fetch(path, {
      method: path.includes('status') ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // A network failure is not a refusal, and saying so is more useful than
    // reporting that the pharmacy was created or suspended.
    return { ok: false, error: 'Could not reach the platform service. Check your connection.' };
  }

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;

  if (!response.ok || body?.ok !== true) {
    // The Worker's own sentence, which distinguishes a refusal (403) from a
    // conflict (409) from a missing binding (503).
    return { ok: false, error: body?.error ?? `The platform service refused the request (HTTP ${response.status}).` };
  }

  return ok(body as unknown as T);
}

/* eslint-disable-next-line */
export interface OnboardPharmacyInput {
  pharmacyName: string;
  ownerName: string;
  ownerEmail: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
}

export interface OnboardPharmacyResult {
  branchId: string;
  pharmacyName: string;
  invitationId: string | null;
  emailSent: boolean;
  emailError?: string;
}

/**
 * Onboard a pharmacy.
 *
 * `emailSent: false` with an `emailError` is a real outcome, not a failure: the
 * pharmacy and its invitation both exist, and the operator can resend. The
 * screen must say so rather than implying the email went out.
 */
export function onboardPharmacy(input: OnboardPharmacyInput): Promise<Result<OnboardPharmacyResult>> {
  return postPlatform<OnboardPharmacyResult>('/api/platform/onboard-pharmacy', { ...input });
}

export interface SetPharmacyStatusResult {
  branchId: string;
  status: PharmacyStatus;
  changed: boolean;
}

export function setPharmacyStatus(
  branchId: string,
  status: PharmacyStatus,
  reason?: string,
): Promise<Result<SetPharmacyStatusResult>> {
  return postPlatform<SetPharmacyStatusResult>('/api/platform/pharmacy-status', {
    branchId,
    status,
    reason: reason ?? null,
  });
}