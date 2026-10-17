import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StockReceipt } from '~/domain/types';
import { listStockReceipts, type ReceiptWithRefs } from '~/lib/supabase/stock';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';
import { toStockReceipts } from './stock-mapping';

/**
 * The receiving history, from Supabase in live mode.
 *
 * ## One source per mode, exactly as `useSales` and `useMedicines`
 *
 * In live mode there is no local fallback. A loading or failed read yields
 * `receipts: []` with the state flagged, never the seeded prototype receipts: an
 * owner shown deliveries their pharmacy never booked is the failure this hook
 * exists to avoid.
 *
 * In demo mode the seeded history *is* the data, and the store is read directly.
 *
 * ## The product and receiver names arrive with the row
 *
 * Unlike `useSales`, which joins the attendant name against `state.users`, the
 * product name and the receiver's name and role come from `listStockReceipts`'s
 * embeds. The mapper turns an unreadable `profiles` embed into a blank, not a
 * placeholder — see `stock-mapping.ts`.
 */

export type StockReceiptsSource = 'supabase' | 'demo';

export interface StockReceiptsState {
  receipts: StockReceipt[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  source: StockReceiptsSource;
  branchId: string | null;
  /** Re-reads the history. Needed after a delivery is booked in. */
  refresh: () => void;
}

export function useStockReceipts(limit = 50): StockReceiptsState {
  // Only consulted in demo mode. In live mode this selector is never read, so a
  // stale local history cannot reach the screen.
  const localReceipts = usePharmacy((state) => state.stockReceipts);
  const { status, currentBranchId, error: branchError } = useActiveBranch();

  const [remote, setRemote] = useState<{ branchId: string; rows: ReceiptWithRefs[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow response for a branch the user has since left
  // overwriting the history for the branch they are actually on.
  const inFlight = useRef<string | null>(null);
  // Bumped by `refresh()`. In the effect's dependencies so a post-delivery
  // re-read actually happens.
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
      const result = await listStockReceipts(limit);

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Development detail to the console; a plain sentence to the pharmacist,
        // because a raw PostgREST error can name internal objects.
        console.error('[stock receipts] read failed:', result.error, result.code ?? '');
        setError('The receiving history could not be loaded.');
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
    () => (remote && remote.branchId === currentBranchId ? toStockReceipts(remote.rows) : []),
    [remote, currentBranchId],
  );

  return useMemo(() => {
    // ---- demo / no backend. The seeded history is the data here. --------------
    if (demo) {
      return {
        receipts: localReceipts,
        loading: false,
        error: null,
        source: 'demo' as const,
        branchId: null,
        refresh,
      };
    }

    // ---- live mode. No local data, ever. --------------------------------------
    // A branch that failed to resolve is an error, not a reason to show another
    // pharmacy's cached deliveries.
    if (isSupabaseConfigured() && status === 'error') {
      return {
        receipts: [],
        loading: false,
        error: branchError ?? 'The receiving history could not be loaded.',
        source: 'supabase' as const,
        branchId: null,
        refresh,
      };
    }

    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        receipts: mapped,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
        refresh,
      };
    }

    // Live and not yet resolved: empty, not stale.
    return {
      receipts: [],
      loading: true,
      error: null,
      source: 'supabase' as const,
      branchId: currentBranchId,
      refresh,
    };
  }, [
    demo,
    localReceipts,
    useRemote,
    remote,
    mapped,
    currentBranchId,
    loading,
    error,
    status,
    branchError,
    refresh,
  ]);
}
