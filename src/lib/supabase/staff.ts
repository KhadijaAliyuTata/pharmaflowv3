import type { BranchMembershipRow, ProfileRow, StaffInvitationRow, StaffRole } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fail, fromList, ok, type Result } from './result';

/**
 * Staff management: who works here, and how that changes.
 *
 * Adding someone and removing someone are asymmetric on purpose.
 *
 * **Removing** is a `branch_memberships` DELETE. `memberships_owner_write`
 * already permits it for an owner inside their own branch, RLS filters it, and
 * `pf_audit_role_change` records it. Access ends the moment the row goes: every
 * policy resolves the caller through `pf_current_branch()` and `pf_current_role()`,
 * both of which read that table.
 *
 * **Adding** cannot be a DELETE's mirror image. A membership row needs a
 * `user_id` that already exists in `auth.users`, and creating one needs Supabase's
 * admin API, which needs the `service_role` key — a credential that must never
 * reach a browser bundle or a Worker. So addition goes through an invitation
 * instead: the owner issues a code, the invitee signs up with their own password
 * and redeems it, and the membership is created for them. Nothing in this file
 * handles anybody's password.
 *
 * Every mutation goes through a `SECURITY DEFINER` RPC. There is no `.insert()` or
 * `.update()` on `staff_invitations` anywhere below, and that is not an oversight —
 * the table has no client write grant, so such a call could only ever fail.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/**
 * Named, not `*`, for the reason every other read in this codebase names its columns.
 *
 * Note what is absent: `branch_id` and `invited_by` are not fetched. The list is
 * already scoped to the caller's branch by RLS, and the inviter is always the
 * current owner, so neither tells this screen anything it does not already know.
 */
const INVITATION_COLUMNS = 'id,email,role,token,created_at,accepted_at,revoked_at';

/**
 * `profiles` carries no email column, and `auth.users` is not readable through
 * PostgREST. A staff member is therefore identified by name, role, phone and
 * licence rather than by address — the seed data's emails were fiction and
 * showing them next to a real database would be the misleading option.
 */
const PROFILE_COLUMNS = 'id,full_name,phone,license_number';

/** A member of staff, joined with the profile that carries their display details. */
export type StaffMember = {
  userId: string;
  role: StaffRole;
  isDefault: boolean;
  joinedAt: string;
  fullName: string;
  phone: string | null;
  licenseNumber: string | null;
};

/** An invitation, with a flag for whether the code is still usable. */
export type StaffInvitation = {
  id: string;
  email: string;
  role: StaffRole;
  token: string;
  createdAt: string;
  status: 'pending' | 'accepted' | 'revoked';
};

type InvitationSelect = Pick<
  StaffInvitationRow,
  'id' | 'email' | 'role' | 'token' | 'created_at' | 'accepted_at' | 'revoked_at'
>;

function mapInvitation(row: InvitationSelect): StaffInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    token: row.token,
    createdAt: row.created_at,
    status: row.revoked_at ? 'revoked' : row.accepted_at ? 'accepted' : 'pending',
  };
}

/* ------------------------------------------------------------------ reading */

/**
 * Everyone with a membership in the caller's branch.
 *
 * `memberships_branch_read` is what scopes this — there is no `.eq('branch_id', …)`
 * on purpose. A client-side filter would be a second, weaker statement of the same
 * rule, and the one place it matters most is a removal, where the UI must not
 * offer an action the database would refuse.
 *
 * PostgREST cannot join `branch_memberships` to `profiles`, so the profiles are
 * fetched alongside and paired here. A membership with no readable profile still
 * appears, under their user id, rather than vanishing from the team list.
 */
export async function listStaff(): Promise<Result<StaffMember[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const memberships = await client()
    .from('branch_memberships')
    .select('user_id,branch_id,role,is_default,created_at')
    .order('created_at');

  if (memberships.error) {
    return fail(memberships.error.message, memberships.error.code);
  }

  const rows = (memberships.data ?? []) as BranchMembershipRow[];
  const userIds = rows.map((row) => row.user_id);

  // `in` with an empty list is a PostgREST syntax error, so a team of one person
  // with no readable profile still has to take the other branch.
  const profiles = userIds.length
    ? await client().from('profiles').select(PROFILE_COLUMNS).in('id', userIds)
    : { data: [], error: null };

  if (profiles.error) return fail(profiles.error.message, profiles.error.code);

  const byId = new Map(
    ((profiles.data ?? []) as ProfileRow[]).map((profile) => [profile.id, profile]),
  );

  return ok(
    rows.map((row) => {
      const profile = byId.get(row.user_id);
      return {
        userId: row.user_id,
        role: row.role,
        isDefault: row.is_default,
        joinedAt: row.created_at,
        fullName: profile?.full_name ?? 'Unknown',
        phone: profile?.phone ?? null,
        licenseNumber: profile?.license_number ?? null,
      } satisfies StaffMember;
    }),
  );
}

/** Invitations this owner has issued, newest first. `accepted` ones are included deliberately. */
export async function listInvitations(): Promise<Result<StaffInvitation[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const result = await fromList<InvitationSelect>(
    await client()
      .from('staff_invitations')
      .select(INVITATION_COLUMNS)
      .order('created_at', { ascending: false }),
  );

  return result.ok ? ok(result.data.map(mapInvitation)) : result;
}

/* ------------------------------------------------------------------ writing */

/**
 * Issue an invitation. Owner-only; the database decides the branch and the
 * inviter, and refuses an assistant outright.
 */
export async function issueInvitation(
  email: string,
  role: StaffRole = 'assistant',
): Promise<Result<StaffInvitation>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_create_invitation', {
    p_email: email,
    p_role: role,
  });

  if (error) return fail(error.message, error.code);

  const row = (data as StaffInvitationRow[] | null)?.[0];
  if (!row) return fail('The invitation was not created');

  return ok(mapInvitation(row));
}

/** Withdraw an invitation that has not been used. */
export async function revokeInvitation(token: string): Promise<Result<boolean>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_revoke_invitation', { p_token: token });

  if (error) return fail(error.message, error.code);

  return ok(data === true);
}

/**
 * Remove someone from the branch.
 *
 * A membership DELETE, which is what actually revokes access. Two things worth
 * being explicit about:
 *
 *  - The account is not deleted. Their `auth.users` row survives; what is gone is
 *    their place at this branch. If they are later re-invited they come back with
 *    the same identity. Deleting the account itself would need the admin API, and
 *    would destroy the audit trail that ties their past actions to a person.
 *  - An RLS-filtered DELETE reports success while matching zero rows. So this
 *    cannot report "removed" on its own; the caller re-reads the team to confirm,
 *    which is what the hook does.
 */
export async function removeStaffMember(userId: string): Promise<Result<boolean>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { error } = await client()
    .from('branch_memberships')
    .delete()
    .eq('user_id', userId);

  if (error) return fail(error.message, error.code);

  return ok(true);
}

/* --------------------------------------------------------------- redeeming */

/**
 * Exchange an invitation code for a membership, then claim the branch on the
 * caller's own profile.
 *
 * Two steps because they are two authorities. Redemption inserts the membership,
 * which only a `SECURITY DEFINER` function may do. The profile update then sets
 * `branch_id`, and it is permitted *because* that membership now exists —
 * `pf_guard_profile_privileges` has an explicit escape hatch for a member moving
 * to a branch they belong to. Without this second step the account would sign in
 * successfully and then see nothing, because `pf_current_branch()` reads
 * `profiles.branch_id`.
 *
 * `profiles.role` is written from the membership's role rather than trusted from
 * the client, so the cache cannot disagree with the authority.
 */
export async function redeemInvitation(token: string): Promise<Result<{ branchId: string; role: StaffRole }>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_redeem_invitation', { p_token: token.trim() });

  if (error) return fail(error.message, error.code);

  const grant = (data as { branch: string; granted_role: StaffRole }[] | null)?.[0];
  if (!grant) return fail('That invitation could not be redeemed');

  const { error: profileError } = await client()
    .from('profiles')
    .update({ branch_id: grant.branch, role: grant.granted_role })
    .eq('id', (await client().auth.getUser()).data.user?.id ?? '');

  if (profileError) {
    // The membership exists at this point, so the account is already usable and
    // this is a cache problem, not a failed redemption. Saying so is the
    // difference between "try again" and "your place is not saved".
    return fail(
      `You have been added to this pharmacy, but your profile could not be updated: ${profileError.message}. Sign out and back in to finish.`,
      profileError.code,
    );
  }

  return ok({ branchId: grant.branch, role: grant.granted_role });
}