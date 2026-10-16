import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Customer } from '~/domain/types';
import { listCustomers } from '~/lib/supabase/parties';
import { useActiveBranch } from '~/lib/supabase/branch-context';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';
import { toCustomers } from './customer-mapping';

/**
 * The customer list, from Supabase in live mode.
 *
 * ## One source per mode, exactly as `useMedicines` and `useSales`
 *
 * In live mode there is no local fallback. A loading or failed read yields
 * `customers: []` with the state flagged, never the seeded prototype customers:
 * an owner seeing fifteen demo customers with wallet balances and debts that do
 * not exist in their pharmacy is the failure this hook exists to avoid.
 *
 * In demo mode the seeded list *is* the data, and the store is read directly.
 *
 * ## The read is whole-row, and that is safe
 *
 * `listCustomers` selects `*`. Unlike `medicines` and `sale_items`, no column on
 * `customers` is withheld from `authenticated`, so `*` reaches nothing the policy
 * did not already grant. The wallet balance, outstanding debt and lifetime spend
 * that a customer must not see across the branch are gated by `customers_read`
 * itself — for a signed-in customer it returns only their own row (`auth_user_id
 * = auth.uid()`), so the same query that lists the branch for staff returns one
 * record for a customer.
 *
 * ## No branch filter here
 *
 * Nothing in this hook filters by branch. `customers_read` scopes every row to
 * `pf_current_branch()`, so another pharmacy's customers are unreachable no
 * matter what the client asks for. Ownership is a separate question with its own
 * hook, `useIsOwner`, which asks `pf_is_owner()`.
 */

export type CustomersSource = 'supabase' | 'demo';

export interface CustomersState {
  customers: Customer[];
  loading: boolean;
  /** Null unless the Supabase read failed. Never masked by local data. */
  error: string | null;
  source: CustomersSource;
  branchId: string | null;
  /** Re-reads the list from the server. */
  refresh: () => void;
}

export function useCustomers(): CustomersState {
  // Only consulted in demo mode. In live mode this selector is never read, so a
  // stale local list cannot reach the screen.
  const localCustomers = usePharmacy((state) => state.customers);
  const { status, currentBranchId, error: branchError } = useActiveBranch();

  const [remote, setRemote] = useState<{ branchId: string; customers: Customer[] } | null>(null);
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
      const result = await listCustomers();

      if (cancelled) return;
      inFlight.current = null;

      if (!result.ok) {
        // Development detail to the console; a plain sentence to the pharmacist,
        // because a raw PostgREST error can name internal objects.
        console.error('[customers] read failed:', result.error, result.code ?? '');
        setError('The customer list could not be loaded.');
        setRemote(null);
        setLoading(false);
        return;
      }

      setRemote({ branchId: branch, customers: toCustomers(result.data) });
      setError(null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [useRemote, currentBranchId, reloadToken]);

  return useMemo(() => {
    // ---- demo / no backend. The seeded list is the data here. ----------------
    if (demo) {
      return {
        customers: localCustomers,
        loading: false,
        error: null,
        source: 'demo' as const,
        branchId: null,
        refresh,
      };
    }

    // ---- live mode. No local data, ever. --------------------------------------
    // A branch that failed to resolve is an error, not a reason to show another
    // pharmacy's cached rows.
    if (isSupabaseConfigured() && status === 'error') {
      return {
        customers: [],
        loading: false,
        error: branchError ?? 'The customer list could not be loaded.',
        source: 'supabase' as const,
        branchId: null,
        refresh,
      };
    }

    if (useRemote && remote && remote.branchId === currentBranchId) {
      return {
        customers: remote.customers,
        loading,
        error,
        source: 'supabase' as const,
        branchId: currentBranchId,
        refresh,
      };
    }

    // Live and not yet resolved: empty, not stale.
    return {
      customers: [],
      loading: true,
      error: null,
      source: 'supabase' as const,
      branchId: currentBranchId,
      refresh,
    };
  }, [
    demo,
    localCustomers,
    useRemote,
    remote,
    currentBranchId,
    loading,
    error,
    status,
    branchError,
    refresh,
  ]);
}
