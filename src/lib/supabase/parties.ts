import type { CustomerInsert, CustomerRow, SupplierRow } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

/**
 * Customers and suppliers.
 *
 * `customers_read` returns the caller's own row plus, for staff, every row in the
 * caller's branch. A signed-in customer therefore sees only themselves — the
 * wallet balance, outstanding debt and lifetime spend of the whole customer list
 * are not exposed, because that policy does not grant a customer-wide read.
 *
 * The audit trail lives in `./audit`, which is where its own, much narrower read
 * policy (`audit_read`, owner-only) is documented.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/* -------------------------------------------------------------- customer identity */

export async function isCustomer(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  if (!(await hasSession())) return false;
  const { data, error } = await client().rpc('pf_is_customer');
  if (error) return false;
  return data === true;
}

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