import type { BranchRow } from './db.types';
import type { Branch } from '~/domain/state';
import type { User } from '~/domain/types';
import { isDemoMode } from './build-mode';
import { listStaff, type StaffMember } from './supabase/staff';
import { loadCurrentBranch } from './supabase/tenant';
import { setPharmacyBranch, setPharmacyUsers } from '~/store/pharmacy';

/**
 * Mirror the live tenant — the active branch and its team — into the store.
 *
 * ## Why this exists
 *
 * `createEmptyState()` deliberately leaves `state.branch` and `state.users` empty
 * in a live build, so nothing shows seeded rows before a query resolves. But the
 * header and the settings screen read `state.branch` for a display label, and the
 * dashboard team table reads `state.users`. Empty is honest on the first paint and
 * wrong one moment later, so this fills both from the database.
 *
 * ## What is authoritative and what is not
 *
 * Neither value is a security input. `state.branch` is a label, and `state.users`
 * is a directory; ownership is decided by `useIsOwner()` → `pf_is_owner()`, and
 * every row is scoped by RLS at the query. This module only decides what a screen
 * *shows*. That is why it is allowed to write the store directly, the same way
 * `setPharmacyCurrentUser` does.
 *
 * ## Why it is not in `session.ts`
 *
 * `session.ts` imports the store, so anything it imports that imports the store
 * back would be a cycle. `isDemoMode` comes from the leaf `~/lib/build-mode` for
 * the same reason the store reads it there. Callers run this once, after the
 * session and the active branch have resolved.
 */

/** `branches` row → the `Branch` the screens render. `null` optionals stay absent. */
function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    state: row.state,
    phone: row.phone,
    openingHours: row.opening_hours,
    isOpenNow: row.is_open_now,
    rating: row.rating,
    reviewsCount: row.reviews_count,
    isMainHub: row.is_main_hub,
    pcnNumber: row.pcn_number ?? undefined,
    premisesNumber: row.premises_number ?? undefined,
  };
}

/**
 * `StaffMember` → `User`.
 *
 * `profiles` carries no email (see `supabase/staff.ts#PROFILE_COLUMNS`), so `email`
 * is empty rather than invented. The team table renders name and role; no screen
 * shows a staff email.
 */
function toUser(member: StaffMember): User {
  return {
    id: member.userId,
    name: member.fullName,
    email: '',
    role: member.role,
    phone: member.phone ?? '',
    licenseNumber: member.licenseNumber ?? undefined,
    // Only an owner approves pricing — the same rule `can(role, 'approve_pricing')`
    // applies. Display only; `pf_is_owner()` is the authority.
    canApprovePricing: member.role === 'owner',
  };
}

/**
 * Resolve and mirror the branch and team. A no-op in demo mode, where the seeded
 * store already holds both and is the correct source. Never throws: a failed read
 * leaves the previous value in place rather than blanking a working screen.
 */
export async function syncLiveTenant(): Promise<void> {
  if (isDemoMode()) return;

  const branch = await loadCurrentBranch();
  if (branch.ok && branch.data) setPharmacyBranch(toBranch(branch.data));

  const staff = await listStaff();
  if (staff.ok) setPharmacyUsers(staff.data.map(toUser));
}
