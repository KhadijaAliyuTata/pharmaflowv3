import type { BatchInsert, BatchRow, BatchUpdate, MedicineCostRow, MedicineRow } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

/**
 * Product catalogue, batches and stock levels.
 *
 * ## Why every read names its columns
 *
 * An earlier version of this file used `select('*')` throughout, and **every
 * function in it failed** against the real project with
 * `42501 permission denied for table medicines`.
 *
 * That is not a bug to work around by loosening grants. `cost_per_base_unit` is
 * deliberately not selectable by `authenticated`, so a `*` expansion — which
 * requires a privilege on every column — cannot succeed for anyone. The owner is
 * no exception: they read cost through the owner-gated views below. The
 * constraints below are therefore load-bearing, and `MEDICINE_COLUMNS` exists so
 * they cannot be lost by an edit:
 *
 *   * `cost_per_base_unit`      read only via `pf_medicine_costs` / `pf_batch_costs`
 *   * `do_not_sell_locked_by`   who applied the safety lock
 *   * `do_not_sell_locked_at`   when they applied it
 *
 * The same applies to `RETURNING`: `.insert().select()` and `.update().select()`
 * default to `*`, so they fail the same way. There is no write path here at all
 * — see the note above `NOT_IN_SCOPE`.
 *
 * ## Three more things that are deliberate
 *
 * 1. `total_quantity` is never written. `pf_guard_total_quantity` recomputes it
 *    from `medicine_batches` on every insert and update, so a value sent by the
 *    client is overwritten. There is no "set stock" write.
 *
 * 2. No query filters on `branch_id`. RLS already scopes every row to
 *    `pf_current_branch()`, and a client-supplied filter would be a check a
 *    hostile caller could simply omit.
 *
 * 3. Search happens client-side, over the whole branch-scoped result. The
 *    repository fetches the catalogue; `searchMedicines` in
 *    `src/domain/selectors.ts` ranks it. See the note on `searchMedicines` below.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/**
 * The catalogue read model, as a PostgREST column list.
 *
 * Every column here is one `authenticated` can select. Adding a column is
 * deliberate and should be justified: adding `*` back breaks every read in this
 * module, and adding a withheld column breaks them just as thoroughly.
 */
export const MEDICINE_COLUMNS =
  'id,' +
  'branch_id,' +
  'barcode,' +
  'name,' +
  'generic_name,' +
  'strength,' +
  'dosage_form,' +
  'category,' +
  'supplier_id,' +
  'units,' +
  'total_quantity,' +
  'low_stock_threshold,' +
  'average_daily_sales,' +
  'price_per_base_unit,' +
  'expiry_date,' +
  'purchase_date,' +
  'common_use,' +
  'storage,' +
  'prescription_class,' +
  'warnings,' +
  'is_brand,' +
  'generic_equivalent_id,' +
  'do_not_sell,' +
  'do_not_sell_reason,' +
  'nafdac_reg_number,' +
  'manufacturer,' +
  'state,' +
  'created_at,' +
  'updated_at';

/** Batch read model. `cost_per_base_unit` is withheld; see `listBatchCosts`. */
export const BATCH_COLUMNS =
  'id,' +
  'branch_id,' +
  'medicine_id,' +
  'batch_number,' +
  'expiry_date,' +
  'quantity,' +
  'supplier_id,' +
  'received_date,' +
  'is_recalled,' +
  'recall_reason,' +
  'created_at';

type MedicineWithBatches = MedicineRow & { medicine_batches?: BatchRow[] };


/**
 * Catalogue, with each product's batches embedded.
 *
 * The embed replaces a per-product query, and `medicine_batches` needs its own
 * explicit column list: `medicine_batches(*)` expands to include batch cost,
 * which `authenticated` cannot select, so it fails exactly like `*` on the parent.
 *
 * Branch scope is RLS's job. No `branch_id` filter appears here.
 */
export async function listMedicines(): Promise<Result<MedicineWithBatches[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('medicines')
    .select(`${MEDICINE_COLUMNS}, medicine_batches(${BATCH_COLUMNS})`)
    .order('name', { ascending: true });

  return fromList<MedicineWithBatches>({
    data: (query.data ?? null) as MedicineWithBatches[] | null,
    error: query.error,
  });
}

export async function getMedicine(id: string): Promise<Result<MedicineWithBatches>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('medicines')
    .select(`${MEDICINE_COLUMNS}, medicine_batches(${BATCH_COLUMNS})`)
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  if (!data) return { ok: false, error: 'Product not found' } as const;
  return ok(data as unknown as MedicineWithBatches);
}

/**
 * Server-side text filter across name, generic name and barcode.
 *
 * **This is not the search path.** Ranking lives client-side in
 * `src/domain/selectors.ts` (`searchMedicines`, an eight-tier scored ranker over
 * name, generic, strength, barcode and category). That ranker is the behaviour
 * the UI has always had, and Phase 1 keeps it: the catalogue is fetched whole,
 * already branch-scoped by RLS, and ranked in the browser.
 *
 * An earlier comment here claimed this function preserved ranking behaviour "the
 * same shape". It did not — it returns rows in whatever order Postgres chooses
 * and matches none of strength or category. It is kept for the case where the
 * catalogue outgrows fetching it whole, and it must not be presented as a
 * drop-in replacement for the client ranker.
 */
export async function searchMedicines(term: string): Promise<Result<MedicineRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const needle = term.trim();
  if (!needle) {
    const all = await client().from('medicines').select(MEDICINE_COLUMNS);
    return fromList<MedicineRow>({ data: (all.data ?? null) as MedicineRow[] | null, error: all.error });
  }

  // Escape the LIKE metacharacters so a barcode containing % is a literal search.
  const safe = needle.replace(/[%_]/g, (c) => `\\${c}`);
  const pattern = `%${safe}%`;

  const filtered = await client()
    .from('medicines')
    .select(MEDICINE_COLUMNS)
    .or(`name.ilike.${pattern},generic_name.ilike.${pattern},barcode.ilike.${pattern}`);

  return fromList<MedicineRow>({
    data: (filtered.data ?? null) as MedicineRow[] | null,
    error: filtered.error,
  });
}

/* ------------------------------------------------------------- write paths */

/**
 * Catalogue writes are not part of the read-only migration and are deliberately
 * absent rather than present-and-broken.
 *
 * A previous version of this file exported `createMedicine` and
 * `updateMedicine`. Both ended in a bare `.select()`, which resolves to `*` and
 * therefore could never succeed against the real grants — a function that looks
 * usable, type-checks, and fails on first call is worse than one that is not
 * there. They also had no callers.
 *
 * They return in the write phase, where the shapes need deciding first: whether
 * a create supplies `branch_id` or lets `pf_current_branch()` decide, and what a
 * partial update is permitted to contain given the column grants.
 */
export const NOT_IN_SCOPE = {
  ok: false,
  error: 'Catalogue writes are not implemented in the read-only migration',
} as const satisfies Result<never>;

/* ------------------------------------------------------------------ stock */

/** Live batches for a product, soonest expiry first — the order FEFO needs. */
export async function listBatches(medicineId: string): Promise<Result<BatchRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('medicine_batches')
    .select(BATCH_COLUMNS)
    .eq('medicine_id', medicineId)
    .order('expiry_date', { ascending: true });

  return fromList<BatchRow>({ data: (query.data ?? null) as BatchRow[] | null, error: query.error });
}

/**
 * Add a batch.
 *
 * Not called by any screen. Retained with an explicit column list so it is
 * usable when Stock Receiving is migrated; note that `batchNumber`, `medicine_id`
 * and `branch_id` are required and `branch_id` must come from the session.
 */
export async function addBatch(input: BatchInsert) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  // `.select(BATCH_COLUMNS)` rather than a bare `.select()`: returning a row needs
  // a privilege on each returned column, and batch cost is withheld.
  const { data, error } = await client()
    .from('medicine_batches')
    .insert(input)
    .select(BATCH_COLUMNS)
    .single();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/**
 * Flag or release a batch recall. Excludes recalled lots from the live batch sum,
 * so a recall removes stock from sale without changing any quantity.
 *
 * Owner-only in the database (`pf_is_owner()` inside the policy); not called yet.
 */
export async function setBatchRecalled(
  batchId: string,
  recalled: boolean,
  reason?: string,
): Promise<Result<BatchUpdate>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('medicine_batches')
    .update({ is_recalled: recalled, recall_reason: recalled ? reason ?? null : null })
    .eq('id', batchId)
    .select(BATCH_COLUMNS)
    .single();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data as unknown as BatchUpdate);
}

/**
 * Batches by expiry date.
 *
 * **Left exactly as it was, and flagged.** The query is `.gt('expiry_date',
 * now)`, which selects lots expiring in the *future* and silently omits lots
 * already past date — while `expiryBuckets` in `src/domain/selectors.ts` shows
 * expired lots as a first-class bucket, and `expiry.tsx` gives them a write-off
 * action. So one of the two is wrong.
 *
 * It was not corrected here because the intent is genuinely ambiguous: the
 * function comment says "within the expiry warning window", which reads either as
 * upcoming-only or as "past and upcoming", and the function has no callers to
 * disambiguate it. Nothing should depend on it until that is settled. Tracked as
 * a follow-up, not silently reinterpreted.
 */
export async function listExpiring() {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('medicine_batches')
    .select(BATCH_COLUMNS)
    .gt('expiry_date', new Date().toISOString().slice(0, 10))
    .order('expiry_date', { ascending: true });

  return fromList<BatchRow>({ data: (query.data ?? null) as BatchRow[] | null, error: query.error });
}

/* ------------------------------------------------------- owner-only costs */

/**
 * Purchase cost per product, for the owner only.
 *
 * Returns an empty array for an assistant — the view filters on `pf_is_owner()`
 * rather than raising, so this is safe to call unconditionally on a screen both
 * roles can see. Do not treat an empty result as an error.
 *
 * This is the ONLY sanctioned way to read `cost_per_base_unit`.
 */
export async function listMedicineCosts(): Promise<Result<MedicineCostRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('pf_medicine_costs').select('*'));
}

/** Batch purchase cost, owner only. Same rule as `listMedicineCosts`. */
export async function listBatchCosts() {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('pf_batch_costs').select('*'));
}