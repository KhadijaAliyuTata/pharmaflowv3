import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StockMovement } from '~/domain/types';
import { listStockMovements, type StockMovementWithRefs } from '~/lib/supabase/stock';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';
import { toStockMovements } from './stock-mapping';

/**
 * The stock ledger, from Supabase in live mode.
 *
 * The last entry of the "one source per mode" family — `useSales`, `useMedicines`,
 * `useCustomers`, `useStockReceipts`. A loading or failed read yields
 * `movements: []` with the state flagged; the seeded prototype ledger is never
 * shown as if it were this pharmacy's.
 *
 * `stock_movements` is written only by `pf_record_stock_movement`, so a movement
 * is the honest record of a batch change: a sale deduction, a delivery, an
 * adjustment. Nothing here writes one.
 */

export type StockMovementsSource = 'supabase' | 'demo';

export interface StockMovementsState {
  movements: StockMovement[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  source: StockMovementsSource;
  branchId: string | null;
  /** Re-reads the ledger. Needed after a delivery is booked in. */
  refresh: () => void;
}

export function useStockMovements(limit = 50): StockMovementsState {
  // Only consulted in demo mode. In live mode this selector is never read.
  const localMovements = usePharmacy((state) => state.stockMovements);
  const { status, currentBranchId, error: branchError } = useActiveBranch();

  const [remote, setRemote] = useState<{ branchId: string; rows: StockMovementWithRefs[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow response for a branch the user has since left
  // overwriting the ledger for the branch they are actually on.
  const inFlight = useRef<string | null>(null);
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
      const result = await listStockMovements(limit);

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Development detail to the console; a plain sentence to the pharmacist.
        console.error('[stock movements] read failed:', result.error, result.code ?? '');
        setError('The stock ledger could not be loaded.');
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
    () => (remote && remote.branchId === currentBranchId ? toStockMovements(remote.rows) : []),
    [remote, currentBranchId],
  );

  return useMemo(() => {
    // ---- demo / no backend. The seeded ledger is the data here. ---------------
    if (demo) {
      return {
        movements: localMovements.slice(0, limit),
        loading: false,
        error: null,
        source: 'demo' as const,
        branchId: null,
        refresh,
      };
    }

    // ---- live mode. No local data, ever. --------------------------------------
    if (isSupabaseConfigured() && status === 'error') {
      return {
        movements: [],
        loading: false,
        error: branchError ?? 'The stock ledger could not be loaded.',
        source: 'supabase' as const,
        branchId: null,
        refresh,
      };
    }

    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        movements: mapped,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
        refresh,
      };
    }

    // Live and not yet resolved: empty, not stale.
    return {
      movements: [],
      loading: true,
      error: null,
      source: 'supabase' as const,
      branchId: currentBranchId,
      refresh,
    };
  }, [
    demo,
    localMovements,
    limit,
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
