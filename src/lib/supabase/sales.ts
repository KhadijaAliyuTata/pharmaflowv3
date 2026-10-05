import type {
  CreditLedgerInsert,
  SaleInsert,
  SaleUpdate,
  SaleItemInsert,
} from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

/**
 * Sales, sale lines, and customer credit.
 *
 * A sale is two tables. `sales` is the header (money, attendant, state) and
 * `sale_items` the immutable lines. `sale_items` has no `branch_id`: it inherits
 * isolation from its parent through `sale_items_read`, which is
 * `exists (select 1 from sales s where s.id = sale_id)` and therefore evaluated
 * under `sales_read`'s branch predicate. So a line is visible exactly when its
 * sale is.
 *
 * `cost_per_base_unit_snapshot` is writable by any staff member — the till has to
 * record what it dispensed at — but it is not selectable. Owners read it through
 * `pf_sale_item_costs`.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/** Recent sales with their lines, newest first. */
export async function listSales(limit = 50) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(
    await client()
      .from('sales')
      .select('*, sale_items(*)')
      .order('sold_at', { ascending: false })
      .limit(limit),
  );
}

export async function getSale(id: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('sales')
    .select('*, sale_items(*)')
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  if (!data) return { ok: false, error: 'Sale not found' } as const;
  return ok(data);
}

/**
 * Ring up a sale.
 *
 * The header and its lines are written together. PostgREST has no transaction
 * across two requests, so the header goes first and the lines follow; if a line
 * insert fails the caller receives the error and the sale is left without lines,
 * which the reconciliation step in `docs/PHASE-0-DATA-MIGRATION.md` flags as
 * needing a database function rather than two round trips.
 *
 * Money is NOT recomputed here. `subtotal`, `total`, `amount_paid` and
 * `outstanding` are sent as calculated by `src/domain/money.ts` and then checked
 * by the `sales_paid_plus_outstanding` and `sales_discount_within_subtotal`
 * constraints. Those constraints catch an inconsistent sale but they do not prove
 * `subtotal` equals the sum of the lines — a server-side total belongs in an RPC,
 * which is listed as a Phase 1 item.
 */
export async function createSale(input: SaleInsert & { items: Omit<SaleItemInsert, 'sale_id'>[] }) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  if (input.items.length === 0) return { ok: false, error: 'A sale needs at least one line' };

  const header = await client()
    .from('sales')
    .insert({
      branch_id: input.branch_id,
      receipt_number: input.receipt_number,
      attendant_id: input.attendant_id,
      customer_id: input.customer_id ?? null,
      credit_account_id: input.credit_account_id ?? null,
      subtotal: input.subtotal,
      discount: input.discount,
      discount_reason: input.discount_reason ?? null,
      total: input.total,
      payment_method: input.payment_method,
      amount_paid: input.amount_paid,
      outstanding: input.outstanding,
      dispensed_against_prescription: input.dispensed_against_prescription ?? false,
    })
    .select()
    .single();

  if (header.error) return { ok: false, error: header.error.message, code: header.error.code };

  const sale = header.data;
  const lines = await client()
    .from('sale_items')
    .insert(input.items.map((item) => ({ ...item, sale_id: sale.id })));

  if (lines.error) {
    return {
      ok: false,
      error: `Sale ${sale.receipt_number} was saved but its line items failed: ${lines.error.message}`,
      code: lines.error.code,
    };
  }

  return ok(sale);
}

/**
 * Void or refund a sale. Owner-only: `sales_owner_void` checks `pf_is_owner()`
 * and the caller's branch, so an assistant is refused by the database regardless
 * of what the client sends.
 */
export async function voidSale(
  saleId: string,
  state: 'voided' | 'refunded',
  reason: string,
  changedBy: string,
): Promise<Result<SaleUpdate>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('sales')
    .update({
      state,
      status_reason: reason,
      status_changed_by: changedBy,
      status_changed_at: new Date().toISOString(),
    })
    .eq('id', saleId)
    .select()
    .single();

  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}

/**
 * Cost snapshot per sale line, owner only. Empty for anyone else.
 *
 * This is what a margin report reads. `summariseSales` in the client needs it and
 * cannot have it as an assistant, which is the correct outcome.
 */
export async function listSaleItemCosts(saleId?: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  let query = client().from('pf_sale_item_costs').select('*');
  if (saleId) query = query.eq('sale_id', saleId);
  return fromList(await query);
}

/* ---------------------------------------------------------- credit ledger */

/** Credit accounts for the caller's branch. `credit_read` is owner-only. */
export async function listCreditAccounts() {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(await client().from('credit_accounts').select('*').order('name'));
}

export async function listCreditLedger(accountId: string) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList(
    await client()
      .from('credit_ledger')
      .select('*')
      .eq('account_id', accountId)
      .order('entry_at', { ascending: false }),
  );
}

/**
 * Record a credit payment.
 *
 * `balance_after` is checked by `pf_check_credit_ledger_balance` against the
 * account's current `outstanding_balance` — but note that trigger is defined in
 * the migration and never attached, so the invariant is currently unenforced.
 * The client must therefore send a correct `balance_after`. See the migration map.
 */
export async function recordCreditPayment(input: CreditLedgerInsert) {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('credit_ledger')
    .insert(input)
    .select()
    .single();

  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}