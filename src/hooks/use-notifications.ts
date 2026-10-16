import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppNotification } from '~/domain/types';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationSelect,
} from '~/lib/supabase/notifications';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';
import { toNotifications } from './notification-mapping';

/**
 * This caller's notifications, from Supabase in live mode.
 *
 * ## One source per mode, exactly as `useMedicines` and `useSales`
 *
 * In live mode there is no local fallback. A loading or failed read yields an
 * empty list with the state flagged, never the seeded alerts: showing an owner
 * "Ciprofloxacin out of stock" when the database holds no such row is the
 * failure this hook exists to avoid.
 *
 * In demo mode the seeded list *is* the data, and the store is read directly —
 * including for the two mutators, which dispatch to the store's own actions so
 * the demo build behaves exactly as it did before.
 *
 * ## Clearing spans less than reading
 *
 * The read returns the caller's rows *and* the branch-wide rows addressed to
 * nobody. Clearing does not: the UPDATE policy is `recipient_id = auth.uid()`,
 * so a branch-wide row stays unread on every screen. That is the database's rule
 * and this hook does not paper over it — the repository returns the ids it
 * actually changed, and only those are patched locally, so a "mark all read"
 * that clears three of five rows removes three badges rather than five.
 */

export type NotificationsSource = 'supabase' | 'demo';

export interface NotificationsState {
  notifications: AppNotification[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  source: NotificationsSource;
  branchId: string | null;
  unreadCount: number;
  /**
   * Clears one notification. A no-op for a branch-wide row the caller cannot
   * address — see the note above.
   */
  markRead: (id: string) => void;
  markAllRead: () => void;
  refresh: () => void;
}

export function useNotifications(limit = 50): NotificationsState {
  // Only consulted in demo mode. In live mode this selector is never read, so a
  // stale local list cannot reach the screen.
  const localNotifications = usePharmacy((state) => state.notifications);
  const { markNotificationRead: markReadLocal, markAllNotificationsRead: markAllLocal } =
    usePharmacyActions();
  const { status, currentBranchId, error: branchError } = useActiveBranch();

  const [remote, setRemote] = useState<{ branchId: string; rows: NotificationSelect[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow response for a branch the user has since left
  // overwriting the list for the branch they are actually on.
  const inFlight = useRef<string | null>(null);
  // Bumped by `refresh()`. In the effect's dependencies so a re-read actually
  // happens, rather than the hook returning the copy it already has.
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const demo = isDemoMode();
  const useRemote = !demo && isSupabaseConfigured() && status === 'ready' && currentBranchId !== null;

  useEffect(() => {
    if (!useRemote || !currentBranchId) return;

    const branch = currentBranchId;
    if (inFlight.current === branch) return;
    inFlight.current = branch;

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const result = await listNotifications(limit);

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Development detail to the console; a plain sentence to the pharmacist,
        // because a raw PostgREST error can name internal objects.
        console.error('[notifications] read failed:', result.error, result.code ?? '');
        setError('Your notifications could not be loaded.');
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

  /**
   * Patch only the rows the server confirmed it changed.
   *
   * Optimism is deliberately not used here. A branch-wide notification is
   * visible but not the caller's to clear, so a blind "this id is now read"
   * would show a badge disappear and then reappear on the next read. The
   * server's answer is the only thing that moves the state.
   */
  const applyRead = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const changed = new Set(ids);
    const now = new Date().toISOString();
    setRemote((previous) =>
      previous
        ? {
            ...previous,
            rows: previous.rows.map((row) =>
              changed.has(row.id) && row.read_at === null ? { ...row, read_at: now } : row,
            ),
          }
        : previous,
    );
  }, []);

  const markRead = useCallback(
    (id: string) => {
      if (demo) {
        markReadLocal(id);
        return;
      }
      void (async () => {
        const result = await markNotificationRead(id);
        if (!result.ok) {
          console.error('[notifications] mark read failed:', result.error, result.code ?? '');
          return;
        }
        applyRead(result.data);
      })();
    },
    [demo, markReadLocal, applyRead],
  );

  const markAllRead = useCallback(
    () => {
      if (demo) {
        markAllLocal();
        return;
      }
      void (async () => {
        const result = await markAllNotificationsRead();
        if (!result.ok) {
          console.error('[notifications] mark all read failed:', result.error, result.code ?? '');
          return;
        }
        applyRead(result.data);
      })();
    },
    [demo, markAllLocal, applyRead],
  );

  const mapped = useMemo(
    () => (remote && remote.branchId === currentBranchId ? toNotifications(remote.rows) : []),
    [remote, currentBranchId],
  );

  return useMemo(() => {
    const count = (list: AppNotification[]) => list.filter((n) => !n.read).length;

    // ---- demo / no backend. The seeded list is the data here. ----------------
    if (demo) {
      return {
        notifications: localNotifications,
        loading: false,
        error: null,
        source: 'demo' as const,
        branchId: null,
        unreadCount: count(localNotifications),
        markRead,
        markAllRead,
        refresh,
      };
    }

    // ---- live mode. No local data, ever. --------------------------------------
    // A branch that failed to resolve is an error, not a reason to show another
    // pharmacy's cached alerts.
    if (isSupabaseConfigured() && status === 'error') {
      return {
        notifications: [],
        loading: false,
        error: branchError ?? 'Your notifications could not be loaded.',
        source: 'supabase' as const,
        branchId: null,
        unreadCount: 0,
        markRead,
        markAllRead,
        refresh,
      };
    }

    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        notifications: mapped,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
        unreadCount: count(mapped),
        markRead,
        markAllRead,
        refresh,
      };
    }

    // Live and not yet resolved: empty, not stale.
    return {
      notifications: [],
      loading: true,
      error: null,
      source: 'supabase' as const,
      branchId: currentBranchId,
      unreadCount: 0,
      markRead,
      markAllRead,
      refresh,
    };
  }, [
    demo,
    localNotifications,
    useRemote,
    remote,
    mapped,
    currentBranchId,
    loading,
    error,
    status,
    branchError,
    markRead,
    markAllRead,
    refresh,
  ]);
}
