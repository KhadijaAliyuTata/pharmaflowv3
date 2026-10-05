import type { BatchInsert, BatchUpdate, MedicineCostRow, MedicineInsert, MedicineUpdate } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

/**
 * Product catalogue, batches and stock levels.
 *
 * Two things about this module are load-bearing.
 *
 * 1. `total_quantity` is never written from here. `pf_guard_total_quantity`
 *    recomputes it from `medicine_batches` on every insert and update, so a
 *    value sent by the client is overwritten. There is no "set stock" write.
 *
 * 2. Purchase cost is not selectable on `medicines` or `medicine_batches`. The
 *    column grants withhold `cost_per_base_unit` from `authenticated`, because a
 *    Postgres grant cannot be conditional on which user is signed in. Cost is
 *    read through the owner-gated `pf_medicine_costs` / `pf_batch_costs` views
 *    below, which return zero rows for anyone who is not an owner.
 *
 * No query in this file filters on `branch_id`. That is deliberate: RLS already
 * scopes every row to `pf_current_branch()`, and a client-supplied filter would
 * be a check a hostile caller could simply omit.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/**
 * The product list for the caller's pharmacy.
 *
 * Batches are fetched in the same round trip with an embedded select rather than
 * one query per product — `medicine_batches` has no `branch_id` of its own, but
 * its RLS policy is branch-scoped, so the embed is filtered correctly.
 */
export async function listMedicines() {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(
    await client()
      .from('medicines')
      .select('*, medicine_batches(*)')
      .order('name', { ascending: true }),
  );
}

export async function getMedicine(id: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('medicines')
    .select('*, medicine_batches(*)')
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  if (!data) return { ok: false, error: 'Product not found' } as const;
  return ok(data);
}

/**
 * Search across the catalogue.
 *
 * `ilike` on two columns rather than the existing GIN full-text index: the index
 * is on `to_tsvector('english', name || ' ' || generic_name)` and would need a
 * `tsquery` built from the term, which is worth doing once the catalogue is large
 * enough for it to matter. This is the same shape the client-side
 * `searchMedicines` selector uses, so ranking behaviour does not change.
 */
export async function searchMedicines(term: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const needle = term.trim();
  if (!needle) return fromList(await client().from('medicines').select('*'));

  // Escape the LIKE metacharacters so a barcode containing % is a literal search.
  const safe = needle.replace(/[%_]/g, (c) => `\\${c}`);
  const pattern = `%${safe}%`;

  return fromList(
    await client()
      .from('medicines')
      .select('*')
      .or(`name.ilike.${pattern},generic_name.ilike.${pattern},barcode.ilike.${pattern}`),
  );
}

/**
 * Create a product.
 *
 * `total_quantity` and `state` are deliberately absent — the database owns both.
 * `cost_per_base_unit` is included but `pf_guard_cost_write` rejects it unless
 * the caller is an owner, so an assistant gets an error rather than a silent
 * zero.
 */
export async function createMedicine(input: MedicineInsert) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client().from('medicines').insert(input).select().single();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/** Edit a product's descriptive and pricing fields. Never touches stock. */
export async function updateMedicine(id: string, patch: MedicineUpdate) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client().from('medicines').update(patch).eq('id', id).select().single();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/* ------------------------------------------------------------------ stock */

/** Live batches for a product, newest expiry first — the order FEFO needs. */
export async function listBatches(medicineId: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(
    await client()
      .from('medicine_batches')
      .select('*')
      .eq('medicine_id', medicineId)
      .order('expiry_date', { ascending: true }),
  );
}

/**
 * Add a batch.
 *
 * This is the only way stock enters the system. It is the write that makes
 * `pf_guard_total_quantity` and `pf_sync_total_quantity` recompute the medicine's
 * total, so the aggregate can never drift from the ledger beneath it.
 */
export async function addBatch(input: BatchInsert) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('medicine_batches')
    .insert(input)
    .select()
    .single();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/**
 * Flag or release a batch recall. Excludes recalled lots from `liveBatches`, so
 * a recall removes stock from sale without changing any quantity.
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
    .select()
    .single();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/** Products within the expiry warning window, soonest first. */
export async function listExpiring() {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(
    await client()
      .from('medicine_batches')
      .select('*')
      .gt('expiry_date', new Date().toISOString().slice(0, 10))
      .order('expiry_date', { ascending: true }),
  );
}

/* ------------------------------------------------------- owner-only costs */

/**
 * Purchase cost per product, for the owner only.
 *
 * Returns an empty array for an assistant — the view filters on `pf_is_owner()`
 * rather than raising, so this is safe to call unconditionally on a screen both
 * roles can see. Do not treat an empty result as an error.
 */
export async function listMedicineCosts(): Promise<Result<MedicineCostRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('pf_medicine_costs').select('*'));
}

export async function listBatchCosts() {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('pf_batch_costs').select('*'));
}