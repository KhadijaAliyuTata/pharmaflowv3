import { useEffect, useMemo, useRef, useState } from 'react';
import type { Medicine } from '~/domain/types';
import { listMedicines } from '~/lib/supabase/catalog';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';
import { toMedicines } from './medicine-mapping';

/**
 * The catalogue, from Supabase in live mode.
 *
 * ## This is deliberately NOT `useSuppliers`
 *
 * `useSuppliers` falls back to `state.suppliers` whenever the remote result is not
 * ready, and reports `source: 'local'`. That is acceptable for a read-only list
 * that has no write path — but copying it here would mean that on a real
 * deployment, the catalogue briefly renders **seeded** medicines from
 * `pharmaflow:state:v3` while Supabase is loading, and renders them *again* on any
 * failure. An owner would see fifteen demo products that do not exist in their
 * pharmacy, with no indication that none of it came from the database.
 *
 * So in live mode this hook has exactly one source and one failure mode:
 *
 *   * loading        -> `medicines: []`, `loading: true`
 *   * loaded         -> the rows Supabase returned
 *   * failed         -> `medicines: []`, `error` set
 *
 * There is no path in live mode that returns local or seed medicines. The store is
 * consulted only when `isDemoMode()` is true, which cannot happen in a production
 * build at all — `DEMO_ALLOWED` folds to `false` there, so the branch is dead code
 * and `demo-fixtures` is tree-shaken out of the bundle.
 *
 * ## The database still decides everything
 *
 * Nothing here filters by branch. `medicines_read` scopes every row to
 * `pf_current_branch()`, so another pharmacy's catalogue is unreachable regardless
 * of what the client asks for. Ownership is a separate question with its own hook,
 * `useIsOwner`, which asks `pf_is_owner()` — it resolves `branch_memberships.role`
 * and drives UI gating only, never a substitute for the policy.
 *
 * ## Ranking is unchanged
 *
 * Fetching returns the whole branch catalogue, and callers keep passing it to
 * `searchMedicines` in `src/domain/selectors.ts` — the existing eight-tier scored
 * ranker. Nothing about search, filter or sort behaviour has moved.
 */

export type MedicinesSource = 'supabase' | 'demo';

export interface MedicinesState {
  medicines: Medicine[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  source: MedicinesSource;
  branchId: string | null;
}

export function useMedicines(): MedicinesState {
  // Only consulted in demo mode. In live mode this selector is never read, so a
  // stale local catalogue cannot reach the screen.
  const localMedicines = usePharmacy((state) => state.medicines);
  const { status, currentBranchId, error: branchError } = useActiveBranch();

  const [remote, setRemote] = useState<{ branchId: string; medicines: Medicine[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow response for a branch the user has since left
  // overwriting the list for the branch they are actually on.
  const inFlight = useRef<string | null>(null);

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
      const result = await listMedicines();

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Kept for development. A raw PostgREST error can name internal objects,
        // so the pharmacist gets a plain sentence and the detail goes to console.
        console.error('[medicines] read failed:', result.error, result.code ?? '');
        setError('The product catalogue could not be loaded.');
        setRemote(null);
        setLoading(false);
        return;
      }

      setRemote({ branchId: branch, medicines: toMedicines(result.data) });
      setError(null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [useRemote, currentBranchId]);

  return useMemo(() => {
    // ---- demo / no backend. The seed catalogue is the product here. -------------
    if (demo) {
      return {
        medicines: localMedicines,
        loading: false,
        error: null,
        source: 'demo' as const,
        branchId: null,
      };
    }

    // ---- live mode. No local data, ever. --------------------------------------
    // A branch that failed to resolve is an error, not a reason to show another
    // pharmacy's cached rows.
    if (isSupabaseConfigured() && status === 'error') {
      return {
        medicines: [],
        loading: false,
        error: branchError ?? 'The product catalogue could not be loaded.',
        source: 'supabase' as const,
        branchId: null,
      };
    }

    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        medicines: remote.medicines,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
      };
    }

    // Live and not yet resolved: empty, not stale.
    return {
      medicines: [],
      loading: true,
      error: null,
      source: 'supabase' as const,
      branchId: currentBranchId,
    };
  }, [
    demo,
    localMedicines,
    useRemote,
    remote,
    currentBranchId,
    loading,
    error,
    status,
    branchError,
  ]);
}
