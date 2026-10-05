/**
 * Global search across this pharmacy's records.
 *
 * ## Tenant scoping
 *
 * There is no tenant filter in this file, and that is deliberate rather than an
 * oversight. Every collection it reads comes from the store, and the store only
 * ever holds the active branch's data — loaded through RLS-scoped repositories
 * that cannot return another pharmacy's rows. Searching the store is therefore
 * already tenant-scoped at the database boundary, which is a stronger guarantee
 * than a filter here could offer: a client-side predicate is a display concern,
 * whereas the RLS policy is the one that actually holds when the data is read.
 *
 * A search box cannot widen access. If a record is not in the store, this
 * module cannot surface it, regardless of the query.
 *
 * ## Cost safety
 *
 * No result carries `costPerBaseUnit` or any derived profit figure. Search
 * results are reachable by every role, so they must be safe to render for an
 * assistant. A cost field here would be a leak the moment a non-owner opened
 * the header search.
 */

import type { AppState } from './state';
import { searchMedicines } from './selectors';
import type { Customer, Medicine, Supplier, User } from './types';

/**
 * The only state this module reads.
 *
 * Narrower than `AppState` on purpose. Naming the four collections explicitly
 * means the search index cannot grow a dependency on cost, credit balances or
 * audit records by accident, and lets the component subscribe to four slices
 * instead of the whole store.
 */
export type SearchSources = Pick<AppState, 'medicines' | 'suppliers' | 'users' | 'customers'>;

export type SearchCategory = 'medicines' | 'suppliers' | 'staff' | 'customers';

export const CATEGORY_LABEL: Record<SearchCategory, string> = {
  medicines: 'Medicines',
  suppliers: 'Suppliers',
  staff: 'Staff',
  customers: 'Customers',
};

export interface SearchResult {
  id: string;
  category: SearchCategory;
  /** Primary line — the name a person would recognise. */
  title: string;
  /** Supporting line: strength, role, phone, category. Never a cost. */
  subtitle: string;
  /** Where clicking goes. An existing route, always. */
  to: string;
  score: number;
}

export interface SearchGroup {
  category: SearchCategory;
  label: string;
  results: SearchResult[];
}

export interface SearchResults {
  query: string;
  groups: SearchGroup[];
  total: number;
}

/** Per-category cap, so one huge category cannot bury the others. */
const PER_CATEGORY_LIMIT = 5;

const EMPTY: SearchResults = { query: '', groups: [], total: 0 };

/**
 * Rank a set of candidate strings against the query.
 *
 * Exact beat prefix beat substring, so typing "para" puts Paracetamol above
 * something merely containing those letters. Returns null when nothing matched.
 */
function score(needle: string, candidates: readonly (string | undefined)[]): number | null {
  let best: number | null = null;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = candidate.toLowerCase();
    let score: number;

    if (value === needle) score = 100;
    else if (value.startsWith(needle)) score = 70;
    else if (value.split(/\s+/).some((word) => word.startsWith(needle))) score = 55;
    else if (value.includes(needle)) score = 35;
    else continue;

    if (best === null || score > best) best = score;
  }

  return best;
}

/**
 * Search medicines, suppliers, staff and customers.
 *
 * An empty query returns nothing rather than the whole catalogue: a search box
 * that dumps every product the moment it opens is a list, not a search, and on
 * a large catalogue it would be slow enough to feel broken.
 */
export function globalSearch(state: SearchSources, rawQuery: string): SearchResults {
  const query = rawQuery.trim();
  if (query.length < 2) return EMPTY;

  const needle = query.toLowerCase();

  /* ------------------------------------------------------------- medicines */

  // The existing medicine ranker already encodes the exact/prefix/generic
  // ordering, so search results order identically to the inventory list rather
  // than inventing a second notion of "best match".
  const medicineResults: SearchResult[] = searchMedicines(state.medicines, query)
    .slice(0, PER_CATEGORY_LIMIT)
    .map((medicine, index) => ({
      id: medicine.id,
      category: 'medicines' as const,
      title: medicine.name,
      subtitle: [medicine.strength, medicine.genericName, medicine.category]
        .filter(Boolean)
        .join(' · '),
      to: `/inventory?q=${encodeURIComponent(medicine.name)}`,
      // Preserve the ranker's ordering; searchMedicines returns a score order we
      // do not see, so index is the tie-breaker.
      score: 100 - index,
    }));

  /* ------------------------------------------------------------- suppliers */

  const supplierResults: SearchResult[] = state.suppliers
    .map((supplier) => ({
      supplier,
      score: score(needle, [supplier.name, supplier.contactPerson, supplier.phone, supplier.address]),
    }))
    .filter((entry): entry is { supplier: Supplier; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.supplier.name.localeCompare(b.supplier.name))
    .slice(0, PER_CATEGORY_LIMIT)
    .map(({ supplier, score: value }) => ({
      id: supplier.id,
      category: 'suppliers' as const,
      title: supplier.name,
      subtitle: [supplier.contactPerson, supplier.phone].filter(Boolean).join(' · '),
      to: `/suppliers?q=${encodeURIComponent(supplier.name)}`,
      score: value,
    }));

  /* ----------------------------------------------------------------- staff */

  const staffResults: SearchResult[] = state.users
    .map((user) => ({
      user,
      score: score(needle, [user.name, user.email, user.phone]),
    }))
    .filter((entry): entry is { user: User; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.user.name.localeCompare(b.user.name))
    .slice(0, PER_CATEGORY_LIMIT)
    .map(({ user, score: value }) => ({
      id: user.id,
      category: 'staff' as const,
      title: user.name,
      subtitle: [user.role === 'owner' ? 'Owner' : 'Pharmacist / attendant', user.phone]
        .filter(Boolean)
        .join(' · '),
      to: `/staff?q=${encodeURIComponent(user.name)}`,
      score: value,
    }));

  /* ------------------------------------------------------------- customers */

  const customerResults: SearchResult[] = state.customers
    .map((customer) => ({
      customer,
      score: score(needle, [customer.name, customer.phone, customer.email]),
    }))
    .filter((entry): entry is { customer: Customer; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.customer.name.localeCompare(b.customer.name))
    .slice(0, PER_CATEGORY_LIMIT)
    .map(({ customer, score: value }) => ({
      id: customer.id,
      category: 'customers' as const,
      title: customer.name,
      subtitle: [customer.phone, customer.email].filter(Boolean).join(' · '),
      to: `/customers?q=${encodeURIComponent(customer.name)}`,
      score: value,
    }));

  const groups = (
    [
      { category: 'medicines', label: CATEGORY_LABEL.medicines, results: medicineResults },
      { category: 'suppliers', label: CATEGORY_LABEL.suppliers, results: supplierResults },
      { category: 'staff', label: CATEGORY_LABEL.staff, results: staffResults },
      { category: 'customers', label: CATEGORY_LABEL.customers, results: customerResults },
    ] satisfies SearchGroup[]
  ).filter((group) => group.results.length > 0);

  return {
    query,
    groups,
    total: groups.reduce((total, group) => total + group.results.length, 0),
  };
}
