import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEvent } from '~/domain/types';
import { listAuditEvents, type AuditEventWithActor } from '~/lib/supabase/audit';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';
import { toAuditEvents } from './audit-mapping';
import { useIsOwner } from './use-is-owner';

/**
 * The audit trail, from Supabase in live mode.
 *
 * ## One source per mode, exactly as `useSales` and `useNotifications`
 *
 * In live mode there is no local fallback. A loading or failed read yields
 * `events: []` with the state flagged, never the seeded audit log: an owner
 * shown the prototype's approvals and voidings is the failure this hook exists
 * to avoid.
 *
 * In demo mode the seeded log *is* the data, and the store is read directly.
 *
 * ## Owner-only: no query at all for a non-owner
 *
 * `audit_read` is `pf_is_owner() and branch_id = pf_current_branch()`, so an
 * assistant's read would return zero rows rather than an error. Rather than
 * spend that round trip to learn nothing, the hook asks `useIsOwner()` — the
 * same source the screens gate on, not a second opinion — and, when the caller
 * is not an owner, returns the empty shape without querying. The database is
 * still what enforces the rule; this only avoids asking a question whose answer
 * is already known.
 *
 * ## The actor's name is resolved by the repository, not here
 *
 * Unlike `useSales`, which joins the attendant name client-side against
 * `state.users`, the actor name and role arrive with the row: `listAuditEvents`
 * embeds `profiles`. An actor the caller may not read (see `audit-mapping`) is
 * a `null` embed, which the mapper turns into a named gap.
 */

export type AuditEventsSource = 'supabase' | 'demo';

export interface AuditEventsState {
  events: AuditEvent[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  source: AuditEventsSource;
  branchId: string | null;
  refresh: () => void;
}

export function useAuditEvents(limit = 100): AuditEventsState {
  // Only consulted in demo mode. In live mode this selector is never read, so a
  // stale local log cannot reach the screen.
  const localEvents = usePharmacy((state) => state.auditEvents);
  const { status, currentBranchId, error: branchError } = useActiveBranch();
  // The same authoritative check the screens gate on. Read here so a non-owner
  // never issues the read at all.
  const isOwner = useIsOwner();

  const [remote, setRemote] = useState<{ branchId: string; rows: AuditEventWithActor[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow response for a branch the user has since left
  // overwriting the log for the branch they are actually on.
  const inFlight = useRef<string | null>(null);
  // Bumped by `refresh()`. In the effect's dependencies so a re-read actually
  // happens, rather than the hook returning the copy it already has.
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const demo = isDemoMode();
  const useRemote =
    !demo && isSupabaseConfigured() && isOwner && status === 'ready' && currentBranchId !== null;

  useEffect(() => {
    if (!useRemote || !currentBranchId) return;

    const branch = currentBranchId;
    if (inFlight.current === branch) return;
    inFlight.current = branch;

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const result = await listAuditEvents(limit);

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Development detail to the console; a plain sentence to the owner,
        // because a raw PostgREST error can name internal objects.
        console.error('[audit] read failed:', result.error, result.code ?? '');
        setError('The audit log could not be loaded.');
        setRemote(null);
        setLoading(false);
        return;
      }

      setRemote({ branchId: branch, rows: result.data });
      setError(null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [useRemote, currentBranchId, reloadToken, limit]);

  const mapped = useMemo(
    () => (remote && remote.branchId === currentBranchId ? toAuditEvents(remote.rows) : []),
    [remote, currentBranchId],
  );

  return useMemo(() => {
    // ---- demo / no backend. The seeded log is the data here. ----------------
    if (demo) {
      return {
        events: localEvents,
        loading: false,
        error: null,
        source: 'demo' as const,
        branchId: null,
        refresh,
      };
    }

    // ---- live mode. No local data, ever. ------------------------------------
    // Not an owner: `audit_read` would return nothing, so there is no query and
    // no round trip. Empty, not an error — an assistant is not missing anything
    // they are allowed to see.
    if (!isOwner) {
      return {
        events: [],
        loading: false,
        error: null,
        source: 'supabase' as const,
        branchId: currentBranchId,
        refresh,
      };
    }

    // A branch that failed to resolve is an error, not a reason to show another
    // pharmacy's cached log.
    if (isSupabaseConfigured() && status === 'error') {
      return {
        events: [],
        loading: false,
        error: branchError ?? 'The audit log could not be loaded.',
        source: 'supabase' as const,
        branchId: null,
        refresh,
      };
    }

    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        events: mapped,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
        refresh,
      };
    }

    // Live and not yet resolved: empty, not stale.
    return {
      events: [],
      loading: true,
      error: null,
      source: 'supabase' as const,
      branchId: currentBranchId,
      refresh,
    };
  }, [
    demo,
    localEvents,
    isOwner,
    useRemote,
    remote,
    currentBranchId,
    mapped,
    loading,
    error,
    branchError,
    refresh,
  ]);
}
