import { useCallback, useEffect, useRef, useState } from 'react';
import type { StaffRole } from '~/lib/db.types';
import {
  issueInvitation as repoIssueInvitation,
  listInvitations,
  listStaff,
  redeemInvitation as repoRedeemInvitation,
  removeStaffMember,
  sendInvitationEmail as repoSendInvitationEmail,
  revokeInvitation,
  type StaffInvitation,
  type StaffMember,
} from '~/lib/supabase/staff';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';

/**
 * Staff and invitations, from Supabase in live mode.
 *
 * Follows `use-medicines`: one source in live mode, one failure mode, and no path
 * that quietly falls back to the store.
 *
 *   * loading -> `members: []`, `loading: true`
 *   * loaded  -> what Supabase returned
 *   * failed  -> `members: []`, `error` set
 *
 * ## Why the demo branch is different on purpose
 *
 * In demo mode there is no backend at all, so the team list comes from the seeded
 * store and both mutations are refused. That is not a fallback bolted on later —
 * it is the honest answer, because in demo mode there is no account to create and
 * no membership to delete. A demo build that appeared to add staff would be
 * showing a success for something it did not do.
 *
 * ## Why a removal re-reads the team instead of trusting the response
 *
 * An RLS-filtered DELETE reports success while matching zero rows. If an assistant
 * (or an owner reaching outside their branch) called `removeStaffMember`, Supabase
 * would return `ok` and nothing would have happened. So every mutation is followed
 * by a fresh `listStaff`, and the UI reports success only if the person is actually
 * gone from the result.
 */

export type StaffSource = 'supabase' | 'demo';

export interface StaffState {
  members: StaffMember[];
  invitations: StaffInvitation[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  /** Set by a mutation, and cleared when the next one starts. */
  notice: string | null;
  source: StaffSource;
  /** False in demo mode, and false whenever the session is not an owner. */
  canManage: boolean;
  /**
   * Two independent outcomes, so the caller cannot collapse "the invitation was
   * created" into "everything worked". `notice` always describes which happened.
   */
  invite: (
    email: string,
    role: StaffRole,
    fullName?: string,
  ) => Promise<{ created: boolean; emailed: boolean }>;
  revoke: (token: string) => Promise<boolean>;
  remove: (userId: string, name: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const DEMO_REFUSAL =
  'Staff changes need a live backend. Demo mode has no accounts to create or remove.';

export function useStaff(isOwner: boolean): StaffState {
  // Consulted only in demo mode. In live mode this selector is never read, so a
  // stale local team list cannot reach the screen.
  const demoUsers = usePharmacy((state) => state.users);

  const [members, setMembers] = useState<StaffMember[]>([]);
  const [invitations, setInvitations] = useState<StaffInvitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Guards against a slow response overwriting a newer one.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    const [staff, invites] = await Promise.all([listStaff(), listInvitations()]);

    // A newer request started while these were in flight.
    if (id !== requestId.current) return;

    if (!staff.ok) {
      setError(staff.error);
      setMembers([]);
      setInvitations([]);
    } else {
      setMembers(staff.data);
      // An invitation list is owner-only by RLS, so an assistant legitimately
      // cannot read it. That is a refusal of a permission, not a broken screen,
      // and it must not replace the team list with an error.
      setInvitations(invites.ok ? invites.data : []);
      if (!invites.ok) setError(invites.error);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    if (isDemoMode()) return;
    void load();
  }, [load]);

  const demo = isDemoMode();
  const live = isSupabaseConfigured() && !demo;

  /**
   * Run a mutation, then confirm the outcome by re-reading.
   *
   * Returns whether the change actually took effect, so the caller can raise a
   * failure instead of a false success.
   */
  const run = useCallback(
    async (
      action: () => Promise<{ ok: true } | { ok: false; error: string }>,
      successMessage: string,
    ): Promise<boolean> => {
      setNotice(null);

      if (!live) {
        setNotice(DEMO_REFUSAL);
        return false;
      }

      const result = await action();
      if (!result.ok) {
        setNotice(result.error);
        return false;
      }

      await load();
      setNotice(successMessage);
      return true;
    },
    [live, load],
  );

  /**
   * Create the invitation, then try to email it.
   *
   * Two steps, deliberately not one, because they fail independently and the
   * owner has to be able to tell which happened:
   *
   *   1. The invitation fails  -> nothing was created; `run` reports why.
   *   2. The email fails       -> the invitation EXISTS and is usable. This is
   *      the case that used to be indistinguishable from success, because the
   *      message fired the instant the row was saved.
   *
   * So the invitation is created first and the send is attempted second, and the
   * message names which one happened. Nothing here reports that an email was
   * sent unless the server confirmed Resend accepted it.
   */
  const invite = useCallback(
    async (email: string, role: StaffRole, fullName?: string) => {
      setNotice(null);

      if (!live) {
        setNotice(DEMO_REFUSAL);
        return { created: false, emailed: false };
      }

      const created = await repoIssueInvitation(email, role, fullName);
      if (!created.ok) {
        setNotice(created.error);
        return { created: false, emailed: false };
      }

      // Re-read so the invitations list shows the new row either way.
      await load();

      const sent = await repoSendInvitationEmail(created.data.token);
      if (!sent.ok) {
        // The invitation is real and working. Say so, and say the email did not
        // go, rather than implying it did — the code and link are still usable.
        setNotice(
          `Invitation created for ${email}, but the email was not sent: ${sent.error} ` +
            `The code and link below still work — share them manually.`,
        );
        return { created: true, emailed: false };
      }

      setNotice(`Invitation created and emailed to ${email}.`);
      return { created: true, emailed: true };
    },
    [live, load],
  );

  const revoke = useCallback(
    async (token: string) =>
      run(async () => {
        const revoked = await revokeInvitation(token);
        return revoked.ok ? { ok: true } : { ok: false, error: revoked.error };
      }, 'Invitation withdrawn.'),
    [run],
  );

  const remove = useCallback(
    async (userId: string, name: string) =>
      run(async () => {
        const result = await removeStaffMember(userId);
        if (!result.ok) return result;

        // The DELETE reports success even when RLS matched nothing, so the only
        // trustworthy confirmation is that they are absent from the re-read.
        const still = await listStaff();
        if (!still.ok) return { ok: false, error: still.error };
        if (still.data.some((m) => m.userId === userId)) {
          return {
            ok: false,
            error: 'That person was not removed. Only an owner can remove staff at their own pharmacy.',
          };
        }
        return { ok: true };
      }, `${name} no longer has access.`),
    [run],
  );

  // In demo mode the seeded team is the whole story, and nothing may be changed.
  const shownMembers = demo
    ? demoUsers.map((user) => ({
        userId: user.id,
        role: user.role,
        isDefault: false,
        // `User` carries no join date, so this is only ever shown in demo mode
        // where there is no database to read one from.
        joinedAt: new Date(0).toISOString(),
        fullName: user.name,
        phone: user.phone ?? null,
        licenseNumber: user.licenseNumber ?? null,
      }))
    : members;

  return {
    members: shownMembers,
    invitations,
    loading,
    error,
    notice,
    source: demo ? 'demo' : 'supabase',
    // Owner gating is display only. `useIsOwner` asks `pf_is_owner()`; the
    // database refuses a non-owner regardless of what this returns.
    canManage: live && isOwner,
    invite,
    revoke,
    remove,
    refresh: load,
  };
}

/** Redeeming is one-shot and belongs to the joining screen, not to a hook. */
export async function redeemInvitation(token: string) {
  return repoRedeemInvitation(token);
}