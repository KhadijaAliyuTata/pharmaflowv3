import { useEffect, useMemo, useRef, useState } from 'react';
import { listBatchCosts, listMedicineCosts } from '~/lib/supabase/catalog';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';

/**
 * Owner-only purchase costs, keyed for the catalogue and its lots.
 *
 * The cost columns are withheld from `authenticated`; these two views are the
 * sanctioned read path. The views filter on `pf_is_owner()` and the caller's
 * branch, so an assistant receives an empty result rather than another
 * pharmacy's costs. `enabled` is only a request-saving guard — the database
 * still decides.
 *
 * A failed read leaves the maps empty, which the UI already renders as cost
 * unavailable. It must not turn the catalogue into an error or poison stock.
 */
export interface CatalogueCosts {
  medicineCosts: ReadonlyMap<string, number>;
  batchCosts: ReadonlyMap<string, number>;
}

const EMPTY: CatalogueCosts = {
  medicineCosts: new Map<string, number>(),
  batchCosts: new Map<string, number>(),
};

interface RemoteCosts {
  branchId: string;
  medicineCosts: Map<string, number>;
  batchCosts: Map<string, number>;
}

export function useCatalogueCosts(enabled: boolean): CatalogueCosts {
  const { status, currentBranchId } = useActiveBranch();
  const [remote, setRemote] = useState<RemoteCosts | null>(null);
  const requestSeq = useRef(0);

  const active =
    enabled &&
    !isDemoMode() &&
    isSupabaseConfigured() &&
    status === 'ready' &&
    currentBranchId !== null;

  useEffect(() => {
    if (!active || !currentBranchId) return;

    const branch = currentBranchId;
    const seq = ++requestSeq.current;
    let cancelled = false;

    void (async () => {
      const [medicineResult, batchResult] = await Promise.all([
        listMedicineCosts(),
        listBatchCosts(),
      ]);

      if (cancelled || seq !== requestSeq.current) return;

      if (!medicineResult.ok) {
        console.error(
          '[medicine costs] read failed:',
          medicineResult.error,
          medicineResult.code ?? '',
        );
      }
      if (!batchResult.ok) {
        console.error('[batch costs] read failed:', batchResult.error, batchResult.code ?? '');
      }

      setRemote({
        branchId: branch,
        medicineCosts: new Map(
          medicineResult.ok
            ? medicineResult.data.map((row) => [row.id, Number(row.cost_per_base_unit)])
            : [],
        ),
        batchCosts: new Map(
          batchResult.ok
            ? batchResult.data.map((row) => [row.id, Number(row.cost_per_base_unit)])
            : [],
        ),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [active, currentBranchId]);

  return useMemo(() => {
    if (!active || !remote || remote.branchId !== currentBranchId) return EMPTY;
    return {
      medicineCosts: remote.medicineCosts,
      batchCosts: remote.batchCosts,
    };
  }, [active, remote, currentBranchId]);
}
