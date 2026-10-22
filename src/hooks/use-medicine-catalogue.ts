import { useCallback, useEffect, useState } from 'react';
import type { MedicineSubmissionRow } from '~/lib/db.types';
import {
  CATALOGUE_PAGE_SIZE,
  normaliseCatalogueFilters,
  type CatalogueFilters,
} from '~/domain/medicine-catalogue';
import {
  getMedicineProduct,
  listMedicineSubmissions,
  searchMedicineCatalogue,
  type CatalogueDetail,
  type CatalogueProductSummary,
} from '~/lib/supabase/medicine-catalogue';
import { useCurrentBranchId } from '~/lib/supabase/branch-context';
import { canReviewClinical } from '~/lib/supabase/tenant';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';

/**
 * Server-paged shared catalogue search.
 *
 * The debounce is for typing, not for the network: a user typing "paracet"
 * would otherwise issue seven queries. Results are replaced when the query
 * changes rather than shown stale under a spinner, because an old result under a
 * new search term is a small but real misinformation risk.
 */
export interface CatalogueSearchState {
  items: CatalogueProductSummary[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMedicineCatalogueSearch(
  filters: CatalogueFilters,
  pageSize: number = CATALOGUE_PAGE_SIZE,
  enabled: boolean = true,
): CatalogueSearchState {
  const [items, setItems] = useState<CatalogueProductSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(filters.page);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const { query, dosageForm, strength, route, category, prescriptionClass, verification } =
    filters;
  const requestedPage = filters.page;

  useEffect(() => {
    if (!enabled || isDemoMode() || !isSupabaseConfigured()) {
      setItems([]);
      setTotal(0);
      setPage(requestedPage);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const normalized = normaliseCatalogueFilters({
          query,
          dosageForm,
          strength,
          route,
          category,
          prescriptionClass,
          verification,
          page: requestedPage,
        });

        const result = await searchMedicineCatalogue(normalized, pageSize);
        if (cancelled) return;

        if (!result.ok) {
          console.error('[medicine-catalogue] search failed:', result.error, result.code ?? '');
          setItems([]);
          setTotal(0);
          setPage(normalized.page);
          setError('The shared medicine catalogue could not be searched.');
          setLoading(false);
          return;
        }

        setItems(result.data.items);
        setTotal(result.data.total);
        setPage(result.data.page);
        setError(null);
        setLoading(false);
      })();
    }, 220);

    setLoading(true);
    setError(null);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    query,
    dosageForm,
    strength,
    route,
    category,
    prescriptionClass,
    verification,
    requestedPage,
    pageSize,
    enabled,
    reloadToken,
  ]);

  return { items, total, page, pageSize, loading, error, refresh };
}

/* ------------------------------------------------------------------ detail */

export interface CatalogueDetailState {
  detail: CatalogueDetail | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMedicineProduct(id: string | null): CatalogueDetailState {
  const [detail, setDetail] = useState<CatalogueDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!id || isDemoMode() || !isSupabaseConfigured()) {
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      const result = await getMedicineProduct(id);
      if (cancelled) return;

      if (!result.ok) {
        console.error('[medicine-catalogue] detail failed:', result.error, result.code ?? '');
        setDetail(null);
        setError('This medicine record could not be loaded.');
        setLoading(false);
        return;
      }

      setDetail(result.data);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [id, reloadToken]);

  return { detail, loading, error, refresh };
}

/* ------------------------------------------------------------- submissions */

export interface MedicineSubmissionsState {
  submissions: MedicineSubmissionRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The current pharmacy's submissions, as the database decides visibility.
 *
 * A reviewer sees the branch queue; a submitter sees their own rows. This hook
 * does not filter by author in the browser, because that would repeat a policy
 * and eventually disagree with it.
 */
export function useMedicineSubmissions(): MedicineSubmissionsState {
  const branchId = useCurrentBranchId();
  const [submissions, setSubmissions] = useState<MedicineSubmissionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (isDemoMode() || !isSupabaseConfigured() || !branchId) {
      setSubmissions([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      const result = await listMedicineSubmissions();
      if (cancelled) return;

      if (!result.ok) {
        console.error('[medicine-catalogue] submissions failed:', result.error, result.code ?? '');
        setSubmissions([]);
        setError('Your pharmacy submissions could not be loaded.');
        setLoading(false);
        return;
      }

      setSubmissions(result.data);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [branchId, reloadToken]);

  return { submissions, loading, error, refresh };
}

/* ---------------------------------------------------------------- reviewer */

/**
 * Display gating for the submission/reviewer affordances. Never an authority:
 * the insert policy and `pf_guard_medicine_submission` both re-check.
 */
export function useCanReviewClinical(): boolean {
  const branchId = useCurrentBranchId();
  const [can, setCan] = useState(false);

  useEffect(() => {
    if (isDemoMode() || !isSupabaseConfigured() || !branchId) {
      setCan(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const allowed = await canReviewClinical();
      if (!cancelled) setCan(allowed);
    })();

    return () => {
      cancelled = true;
    };
  }, [branchId]);

  return can;
}
