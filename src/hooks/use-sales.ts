import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Sale } from '~/domain/types';
import { listSales, type SaleWithItems } from '~/lib/supabase/sales';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';
import { toSales } from './sales-mapping';

/**
 * The sales ledger, from Supabase in live mode.
 *
 * ## One source per mode, exactly as `useMedicines`
 *
 * In live mode there is no local fallback. A loading or failed read yields
 * `sales: []` with the state flagged, never the seeded prototype ledger: showing
 * fifteen demo receipts to an owner whose pharmacy has recorded none is the
 * failure this hook exists to avoid.
 *
 * In demo mode the seeded ledger *is* the data, and the store is read directly.
 *
 * ## Why the read is one query and the names are not
 *
 * `listSales` fetches each sale with its lines embedded, naming the `sale_items`
 * columns so the embed survives the column grants. The attendant's *name* is not
 * on the row — only `attendant_id` — and the branch's staff list is already in the
 * store and kept live by `~/lib/tenant-sync`. So the name join happens here,
 * against `state.users`, rather than as a second network read per render. When the
 * staff list arrives after the sales, `attendantNames` changes identity and the
 * memoised mapping re-runs, so names fill in without a refetch.
 *
 * ## Cost is absent, not zero
 *
 * `cost_per_base_unit_snapshot` is not selectable, so `summariseSales` reports
 * margin as `null`. The screens treat that as "not captured" rather than as a
 * fabricated profit — see `sales-mapping.ts`.
 */

export type SalesSource = 'supabase' | 'demo';

export interface SalesState {
  sales: Sale[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  source: SalesSource;
  branchId: string | null;
  /** Re-reads the ledger. Needed after a sale is completed on the POS. */
  refresh: () => void;
}

export function useSales(limit = 50): SalesState {
  // Only consulted in demo mode. In live mode this selector is never read, so a
  // stale local ledger cannot reach the screen.
  const localSales = usePharmacy((state) => state.sales);
  const users = usePharmacy((state) => state.users);
  const { status, currentBranchId, error: branchError } = useActiveBranch();

  const [remote, setRemote] = useState<{ branchId: string; rows: SaleWithItems[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow response for a branch the user has since left
  // overwriting the ledger for the branch they are actually on.
  const inFlight = useRef<string | null>(null);
  // Bumped by `refresh()`. In the effect's dependencies so a post-sale re-read
  // actually happens.
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
      const result = await listSales(limit);

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Development detail to the console; a plain sentence to the pharmacist,
        // because a raw PostgREST error can name internal objects.
        console.error('[sales] read failed:', result.error, result.code ?? '');
        setError('The sales ledger could not be loaded.');
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

  /** `profiles.id` -> display name, from the branch's staff list. */
  const attendantNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const user of users) names.set(user.id, user.name);
    return names;
  }, [users]);

  const mapped = useMemo(
    () => (remote && remote.branchId === currentBranchId ? toSales(remote.rows, attendantNames) : []),
    [remote, currentBranchId, attendantNames],
  );

  return useMemo(() => {
    // ---- demo / no backend. The seeded ledger is the data here. ----------------
    if (demo) {
      return {
        sales: localSales,
        loading: false,
        error: null,
        source: 'demo' as const,
        branchId: null,
        refresh,
      };
    }

    // ---- live mode. No local data, ever. --------------------------------------
    // A branch that failed to resolve is an error, not a reason to show another
    // pharmacy's cached receipts.
    if (isSupabaseConfigured() && status === 'error') {
      return {
        sales: [],
        loading: false,
        error: branchError ?? 'The sales ledger could not be loaded.',
        source: 'supabase' as const,
        branchId: null,
        refresh,
      };
    }

    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        sales: mapped,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
        refresh,
      };
    }

    // Live and not yet resolved: empty, not stale.
    return {
      sales: [],
      loading: true,
      error: null,
      source: 'supabase' as const,
      branchId: currentBranchId,
      refresh,
    };
  }, [
    demo,
    localSales,
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
