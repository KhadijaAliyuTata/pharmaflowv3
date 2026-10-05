import type { AuditEventRow, CustomerInsert, CustomerRow, Json, SupplierRow } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

/**
 * Customers, suppliers and the audit trail.
 *
 * `customers_read` returns the caller's own row plus, for staff, every row in the
 * caller's branch. A signed-in customer therefore sees only themselves — the
 * wallet balance, outstanding debt and lifetime spend of the whole customer list
 * are not exposed, because that policy does not grant a customer-wide read.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/* -------------------------------------------------------------- customers */

export async function listCustomers(): Promise<Result<CustomerRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('customers').select('*').order('name'));
}

/**
 * The signed-in customer's own record.
 *
 * The portal hardcodes `state.customers[0]` today because there is no customer
 * identity in the app yet. This is the real equivalent: match on
 * `auth_user_id`, which `pf_handle_new_user` leaves null for a walk-in and which
 * `customers_read` additionally permits via `auth_user_id = auth.uid()`.
 */
export async function getMyCustomerRecord(): Promise<Result<CustomerRow | null>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client()
    .from('customers')
    .select('*')
    .eq('auth_user_id', (await client().auth.getUser()).data.user?.id ?? '')
    .maybeSingle();

  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

export async function createCustomer(input: CustomerInsert) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client().from('customers').insert(input).select().single();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/* -------------------------------------------------------------- suppliers */

export async function listSuppliers(): Promise<Result<SupplierRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('suppliers').select('*').order('name'));
}

/* ------------------------------------------------------------------ audit */

/**
 * The audit trail. `audit_read` is owner-only AND branch-scoped, so an
 * assistant gets zero rows rather than an error — and, unlike the cost views,
 * there is no owner-gated view to fall back on, because the policy already
 * enforces the restriction at the row level.
 */
export async function listAuditEvents(limit = 100): Promise<Result<AuditEventRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(
    await client()
      .from('audit_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

/**
 * Append an audit event.
 *
 * `audit_insert` requires `actor_id = auth.uid()`, so the actor is not a choice
 * the caller can make — an assistant cannot forge an event against somebody
 * else's name. The argument is still taken so the repository has an explicit
 * signature, and it is cross-checked against the session before sending.
 */
export async function recordAuditEvent(input: {
  branch_id: string;
  action: string;
  description: string;
  metadata?: Json;
}): Promise<Result<AuditEventRow>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data: userData, error: userError } = await client().auth.getUser();
  if (userError || !userData.user) return { ok: false, error: 'Not signed in' };

  const { data, error } = await client()
    .from('audit_events')
    .insert({
      branch_id: input.branch_id,
      actor_id: userData.user.id,
      action: input.action,
      description: input.description,
      metadata: input.metadata ?? {},
    })
    .select()
    .single();

  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}