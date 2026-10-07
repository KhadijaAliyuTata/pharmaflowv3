import type { ProfileRow, StaffRole } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromQuery, ok, type Result } from './result';

/**
 * Who the signed-in user is, and which pharmacy they belong to.
 *
 * This is the tenant/session foundation. Two things are read here, and they are
 * not equally authoritative:
 *
 *   * `profiles.branch_id` is the isolation unit. Every RLS policy resolves it
 *     through `pf_current_branch()`, so it is the tenant boundary.
 *
 *   * `profiles.role` is a **display cache**, not an authorization input. Migration
 *     `20261005250000_branch_membership_role_authority` made
 *     `branch_memberships.role` authoritative: `pf_current_role()` reads the
 *     membership row for `auth.uid()` in the active branch, and `profiles.role` is
 *     written only by `pf_sync_profile_membership` with `on conflict do nothing`,
 *     which means the cache is never repaired from the source. A user demoted at
 *     their branch keeps `profiles.role = 'owner'` until something rewrites it.
 *
 * An earlier version of this note claimed the opposite - that `profiles.role` was
 * "the only thing `pf_is_owner()` consults". That was true before migration 8 and
 * false after it, and it was exactly the kind of stale comment that leads someone
 * to gate a permission on the cache.
 *
 * For an authoritative ownership check call `isOwner()` below, which RPCs
 * `pf_is_owner()`. For the effective role per branch, read `branch_memberships.role`.
 * The `role` on `TenantContext` is carried because the UI needs something to
 * display; screens gating affordances should prefer `useIsOwner()` over it.
 *
 * `profiles` also holds customer rows (`is_customer = true`) that have no branch
 * and no staff role. Those are returned with a null branch, which is why the
 * tenant helpers below all fail closed rather than defaulting to something.
 */

/** What the app needs to know about the caller, resolved from `profiles`. */
export interface TenantContext {
  /** `profiles.id` — the `auth.uid()` the policies evaluate against. */
  userId: string;
  fullName: string;
  phone: string;
  role: StaffRole | null;
  isCustomer: boolean;
  /** The pharmacy this session operates in. Null for a customer or a new signup. */
  branchId: string | null;
  licenseNumber: string | null;
}

const NOT_CONFIGURED = 'Supabase is not configured';

export async function loadTenantContext(): Promise<Result<TenantContext>> {
  if (!isSupabaseConfigured()) return { ok: false, error: NOT_CONFIGURED };
  if (!(await hasSession())) return { ok: false, error: 'Not signed in' };

  const { data: userData, error: userError } = await client().auth.getUser();
  if (userError) return { ok: false, error: userError.message, code: userError.code };
  if (!userData.user) return { ok: false, error: 'Not signed in' };

  // A single row: the caller's own. `profiles_read` permits it by `id = auth.uid()`
  // regardless of role, so this works for an assistant, an owner and a customer.
  const { data, error } = await client()
    .from('profiles')
    .select('id, full_name, phone, role, branch_id, license_number, is_customer')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (error) return { ok: false, error: error.message, code: error.code };

  const row = data as Pick<
    ProfileRow,
    'id' | 'full_name' | 'phone' | 'role' | 'branch_id' | 'license_number' | 'is_customer'
  > | null;

  if (!row) {
    // The `on_auth_user_created` trigger creates this row, so absence means the
    // trigger did not run — worth saying plainly rather than showing an empty app.
    return { ok: false, error: 'No profile row for this account' };
  }

  return ok({
    userId: row.id,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    isCustomer: row.is_customer,
    branchId: row.branch_id,
    licenseNumber: row.license_number,
  });
}

/**
 * The caller's branch id, read from the database rather than from localStorage.
 *
 * Repositories deliberately do NOT take a branchId argument. Passing one invites
 * a caller to filter on the wrong tenant, and the filter would be a frontend
 * check that a hostile client simply omits. `pf_current_branch()` already scopes
 * every query to the caller's own branch, so the absence of a parameter is the
 * guarantee.
 */
export async function currentBranchId(): Promise<Result<string>> {
  const tenant = await loadTenantContext();
  if (!tenant.ok) return tenant;
  if (!tenant.data.branchId) {
    return {
      ok: false,
      error: 'This account is not assigned to a pharmacy yet',
    };
  }
  return ok(tenant.data.branchId);
}

/** True when the database itself considers this session an owner. */
export async function isOwner(): Promise<boolean> {
  if (!isSupabaseConfigured() || !(await hasSession())) return false;
  const { data, error } = await client().rpc('pf_is_owner');
  return !error && data === true;
}

/** True when the database considers this session staff (not a customer). */
export async function isStaff(): Promise<boolean> {
  if (!isSupabaseConfigured() || !(await hasSession())) return false;
  const { data, error } = await client().rpc('pf_is_staff');
  return !error && data === true;
}

/**
 * The caller's own branch record. Used for the header and settings screens.
 * `branches_read` returns the caller's branch, plus the whole directory for a
 * customer — so filter rather than assuming one row.
 */
export async function loadCurrentBranch() {
  const branch = await currentBranchId();
  if (!branch.ok) return branch;
  return fromQuery(
    await client().from('branches').select('*').eq('id', branch.data).maybeSingle(),
  );
}