import type {
  BatchCostRow,
  BatchInsert,
  BatchRow,
  BatchUpdate,
  MedicineCostRow,
  MedicineRow,
} from '../db.types';
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

export type MedicineWithBatches = MedicineRow & { medicine_batches?: BatchRow[] };


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
 * Create one catalogue product through the receiving flow.
 *
 * The write is an RPC rather than a direct table insert because `branch_id` has
 * no default: letting the browser choose it would make tenant isolation a
 * frontend promise. `pf_create_medicine` derives the branch from the signed-in
 * profile, enforces the same duplicate/barcode rules as the form, writes the
 * audit event, and drops a non-owner's price exactly as `pf_receive_stock` does.
 *
 * The returned row is re-read with the explicit catalogue column list. A bare
 * `.select()` would expand to `cost_per_base_unit`, which `authenticated` cannot
 * read, so the product would appear to save and then fail to load.
 *
 * Stock is deliberately not created here. The receipt remains the only write
 * that adds a batch and moves quantity.
 */
export interface CreateMedicineInput {
  name: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  barcode: string | null;
  unitName: string;
  unitKey: string;
  prescriptionClass: 'otc' | 'prescription' | 'controlled';
  sellingPrice: number;
}

function createMedicineError(error: { message: string; code?: string }): string {
  if (error.code === '42883') {
    return 'The catalogue is not ready to accept new products yet. Apply the latest database migration.';
  }
  if (error.code === '23505' || error.code === 'P0001') return error.message;
  if (error.code === '42501') {
    return 'You do not have permission to add products to this pharmacy.';
  }
  return error.message;
}

export async function createMedicine(
  input: CreateMedicineInput,
): Promise<Result<MedicineWithBatches>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_create_medicine', {
    p_product: {
      name: input.name,
      generic_name: input.genericName,
      strength: input.strength,
      dosage_form: input.dosageForm,
      barcode: input.barcode,
      unit_name: input.unitName,
      unit_key: input.unitKey,
      prescription_class: input.prescriptionClass,
      selling_price: input.sellingPrice,
    },
  });

  if (error) return { ok: false, error: createMedicineError(error), code: error.code };

  const payload = (Array.isArray(data) ? data[0] : data) as { id?: string; medicine_id?: string } | null;
  const id = payload?.id ?? payload?.medicine_id;
  if (!id) return { ok: false, error: 'The product was not created.' };

  // Re-read rather than trusting the RPC's JSON: this is the same shape the
  // catalogue list uses, so the new row can be selected immediately.
  return getMedicine(id);
}

/**
 * Direct inserts and updates remain deliberately absent.
 *
 * A previous version exported `createMedicine` and `updateMedicine` that ended
 * in a bare `.select()` — which resolves to `*` and could never succeed against
 * the real grants. The single create above goes through the RPC; there is still
 * no general-purpose catalogue update path.
 */
export const NOT_IN_SCOPE = {
  ok: false,
  error: 'This catalogue write is not implemented',
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
export async function listBatchCosts(): Promise<Result<BatchCostRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('pf_batch_costs').select('*'));
}

/* ------------------------------------------------------- authoritative price */

export interface UpdateMedicinePriceInput {
  medicineId: string;
  unitKey: string;
  newPrice: number;
  /**
   * The price the form was rendered with. The server refuses the write if the
   * current price no longer matches, instead of silently overwriting a newer
   * edit made on another screen.
   */
  expectedPrice: number;
  reason?: string;
}

export interface UpdateMedicinePriceResult {
  medicineId: string;
  unitKey: string;
  oldPrice: number;
  newPrice: number;
  changedAt: string;
}

/**
 * Owner-only selling-price update.
 *
 * This is the single authoritative live write path for `medicines.units`.
 * It updates one unit's `sellingPrice`, mirrors the base unit into
 * `price_per_base_unit`, and leaves purchase cost, batches, expiry and stock
 * untouched. The database also writes an append-only `medicine_price_changes`
 * row and an audit event.
 *
 * Requires 20261020120000_returns_and_price_updates to be applied. Calling it
 * against an older database fails with "function ... does not exist", which the
 * screen surfaces rather than pretending the price changed.
 */
export async function updateMedicinePrice(
  input: UpdateMedicinePriceInput,
): Promise<Result<UpdateMedicinePriceResult>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_update_medicine_price', {
    p_medicine_id: input.medicineId,
    p_unit_key: input.unitKey,
    p_new_price: input.newPrice,
    p_expected_price: input.expectedPrice,
    p_reason: input.reason?.trim() ? input.reason.trim() : null,
  });

  if (error) return { ok: false, error: error.message, code: error.code };

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        medicine_id?: string;
        unit_key?: string;
        old_price?: number;
        new_price?: number;
        changed_at?: string;
      }
    | null;

  if (!row?.medicine_id || !row.unit_key) {
    return { ok: false, error: 'The price was not changed.' };
  }

  return ok({
    medicineId: row.medicine_id,
    unitKey: row.unit_key,
    oldPrice: Number(row.old_price ?? 0),
    newPrice: Number(row.new_price ?? 0),
    changedAt: row.changed_at ?? new Date().toISOString(),
  });
}