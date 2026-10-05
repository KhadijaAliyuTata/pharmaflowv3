import { useEffect, useMemo, useRef, useState } from 'react';
import type { Supplier } from '~/domain/types';
import { listSuppliers } from '~/lib/supabase/parties';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';

/**
 * Suppliers, read from Supabase.
 *
 * This is the first screen off `localStorage`. The shape the screen already
 * consumes is `Supplier[]` from the domain store, so the read path maps a
 * `suppliers` row onto that type and the UI is unchanged.
 *
 * Three things worth being explicit about:
 *
 * 1. **It falls back to the store.** When Supabase is unconfigured, or the branch
 *    context is still resolving, the local data is used and `source` reports
 *    `'local'`. That is what keeps the demo build working with no backend at all,
 *    and it is the same fallback the login screen already describes.
 *
 * 2. **The fallback is not authoritative.** Local data is `localStorage`, which is
 *    editable. It is safe for rendering a list and unsafe for any access decision,
 *    so the real boundary stays `suppliers_read`:
 *    `branch_id = pf_current_branch()`. A branch the session cannot reach is not
 *    readable through the repository regardless of what is in storage.
 *
 * 3. **No write-back.** Results are not merged into the store. Suppliers are
 *    read-only for now (the screen says so), and writing a Supabase result into
 *    `localStorage` would create a second, editable copy of tenant data — the
 *    thing this migration exists to remove.
 */
export type SuppliersSource = 'supabase' | 'local';

export interface SuppliersState {
  suppliers: Supplier[];
  loading: boolean;
  /** Null unless the Supabase read failed. */
  error: string | null;
  source: SuppliersSource;
  /** The branch the list belongs to; null while unresolved or in fallback. */
  branchId: string | null;
}

/**
 * A `suppliers` row as the domain `Supplier`.
 *
 * `email`, `branch_id`, `created_at` and `updated_at` have no counterpart in the
 * frontend type and are dropped. `branch_id` is deliberately not carried on the
 * object: the list is already branch-scoped by RLS, so exposing it would suggest
 * the caller might filter on it — which would be a frontend check standing in for
 * the database's.
 */
function toSupplier(row: {
  id: string;
  name: string;
  contact_person: string;
  phone: string;
  address: string;
  lead_time_days: number;
  rating: number;
}): Supplier {
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    address: row.address,
    leadTimeDays: row.lead_time_days,
    rating: Number(row.rating),
  };
}

export function useSuppliers(): SuppliersState {
  const local = usePharmacy((state) => state.suppliers);
  const { status, currentBranchId, error: branchError } = useActiveBranch();

  const [remote, setRemote] = useState<{ branchId: string; suppliers: Supplier[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow response for a branch the user has since left
  // overwriting the list for the branch they are actually on.
  const inFlight = useRef<string | null>(null);

  const useRemote =
    !isDemoMode() &&
    isSupabaseConfigured() &&
    status === 'ready' &&
    currentBranchId !== null;

  useEffect(() => {
    if (!useRemote || !currentBranchId) return;

    const branch = currentBranchId;
    if (inFlight.current === branch) return;
    inFlight.current = branch;

    let cancelled = false;
    setLoading(true);

    void (async () => {
      const result = await listSuppliers();

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Kept for development. The screen shows a plain message; a raw PostgREST
        // error string means nothing to a pharmacist and can name internal
        // objects, so it is not put in front of one.
        console.error('[suppliers] read failed:', result.error, result.code ?? '');
        setError('Suppliers could not be loaded.');
        setRemote(null);
        setLoading(false);
        return;
      }

      setRemote({ branchId: branch, suppliers: result.data.map(toSupplier) });
      setError(null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [useRemote, currentBranchId]);

  return useMemo(() => {
    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        suppliers: remote.suppliers,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
      };
    }

    // Fallback. A branch that resolved to an error is reported as one rather than
    // quietly showing another pharmacy's cached rows.
    if (!isDemoMode() && isSupabaseConfigured() && status === 'error') {
      return {
        suppliers: [],
        loading: false,
        error: branchError ?? 'Suppliers could not be loaded.',
        source: 'local' as const,
        branchId: null,
      };
    }

    return {
      suppliers: local,
      loading,
      error,
      source: 'local' as const,
      branchId: currentBranchId,
    };
  }, [useRemote, remote, currentBranchId, local, loading, error, status, branchError]);
}