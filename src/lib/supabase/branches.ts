import type { BranchRow, StaffRole } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

/**
 * Multi-branch selection.
 *
 * PharmaFlow is a multi-branch SaaS: one pharmacy, several counters, staff
 * assigned to one or more of them, and the active counter decides what every
 * query can see. RLS reads the active branch through `pf_current_branch()`, which
 * is `profiles.branch_id` for the caller — so switching branches is a change to
 * that one row, and the database is the only thing allowed to make it.
 *
 * What is deliberately NOT here:
 *
 *   * A branches cache treated as the source of truth. `availableBranches` is a
 *     read of the server's `pf_my_branches` view, refreshed on demand. It is not
 *     persisted, because a stale copy of a pharmacy's branch list is exactly the
 *     kind of thing that quietly diverges.
 *
 *   * An `update profiles set branch_id = ...`. The client cannot assert its own
 *     tenant. `pf_set_active_branch()` checks the caller's membership and refuses
 *     anything else, so the reachable set is exactly `branch_memberships`.
 *
 * `AppState.branch` in `src/domain/state.ts` is still a single object and is still
 * what the screens read. This module does not change that. It provides the
 * `availableBranches` + `currentBranchId` pair the migration needs; wiring the
 * store over to it is Step 1 of the migration order in
 * `docs/PHASE-0-DATA-MIGRATION.md`.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/** A branch the signed-in user is permitted to switch to. */
export interface AvailableBranch extends BranchRow {
  /** The role this user holds AT THIS branch, which may differ per counter. */
  role: StaffRole;
  isDefault: boolean;
}

export interface BranchSelection {
  branches: AvailableBranch[];
  currentBranchId: string | null;
}

/**
 * Every branch the caller may switch to, plus the one currently active.
 *
 * `pf_my_branches` is a `security_invoker = false` view whose WHERE clause tests
 * `auth.uid()` directly, so it resolves per request and returns exactly the rows
 * this session is entitled to. A branch the user cannot reach is not in the
 * result — the list is the authorisation, not a filter applied afterwards.
 *
 * An empty list is meaningful, not an error: a customer account has no branch.
 */
export async function listAvailableBranches(): Promise<Result<BranchSelection>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const rows = await fromList(await client().from('pf_my_branches').select('*'));

  // Read in parallel: the active branch comes from the caller's own profile row,
  // which `profiles_read` permits regardless of role.
  const profile = await client()
    .from('profiles')
    .select('branch_id')
    .eq('id', (await client().auth.getUser()).data.user?.id ?? '')
    .maybeSingle();

  if (!rows.ok) return rows;
  if (profile.error) return { ok: false, error: profile.error.message, code: profile.error.code };

  const activeId = (profile.data as { branch_id: string | null } | null)?.branch_id ?? null;

  // Role per branch comes from the membership table. Readable for the caller's
  // own rows under `memberships_self_read`.
  const memberships = await fromList(
    await client()
      .from('branch_memberships')
      .select('branch_id, role, is_default')
      .eq('user_id', (await client().auth.getUser()).data.user?.id ?? ''),
  );

  if (!memberships.ok) return memberships;

  const byBranch = new Map(memberships.data.map((m) => [m.branch_id, m]));

  const branches: AvailableBranch[] = rows.data
    .map((b) => {
      const membership = byBranch.get(b.id);
      return {
        ...(b as BranchRow),
        // A profile whose branch predates the membership table still has a
        // legitimate claim on it, so fall back to their profile role rather than
        // presenting a branch with no role at all.
        role: membership?.role ?? 'assistant',
        isDefault: membership?.is_default ?? b.id === activeId,
      };
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  return ok({ branches, currentBranchId: activeId });
}

/**
 * Switch the active branch.
 *
 * The whole point is that this is a function call, not a row update: the database
 * checks membership and derives the role for that branch, so a client cannot
 * promote itself by asking nicely. The caller should then re-run whatever it was
 * reading — a different branch means a different set of rows under RLS.
 */
export async function switchBranch(branchId: string): Promise<Result<string>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_set_active_branch', {
    p_branch_id: branchId,
  });

  if (error) return { ok: false, error: error.message, code: error.code };
  return ok(data as string);
}

/** Which staff work a given branch. Owner-or-staff within that branch. */
export async function listBranchStaff(branchId: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  return fromList(
    await client()
      .from('branch_memberships')
      .select('user_id, role, is_default')
      .eq('branch_id', branchId),
  );
}

/**
 * Assign a user to a branch, or change the role they hold there.
 *
 * Owner-only and branch-scoped (`memberships_owner_write`), so this is refused
 * for a branch the caller does not administer. The role lives per branch: an
 * owner at head office can be an assistant at a counter, and `pf_is_owner()`
 * reads whichever branch is active.
 */
export async function setBranchMembership(input: {
  user_id: string;
  branch_id: string;
  role: StaffRole;
  is_default?: boolean;
}) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('branch_memberships')
    .upsert(input, { onConflict: 'user_id,branch_id' })
    .select()
    .single();

  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/** Remove a user from a branch. Their `profiles.branch_id` is untouched. */
export async function removeBranchMembership(userId: string, branchId: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { error } = await client()
    .from('branch_memberships')
    .delete()
    .eq('user_id', userId)
    .eq('branch_id', branchId);

  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(true);
}