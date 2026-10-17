import type {
  CreditLedgerInsert,
  SaleInsert,
  SaleItemInsert,
  SaleItemRow,
  SaleRow,
  SaleUpdate,
} from '../db.types';
import type { PaymentMethod } from '~/domain/types';
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

/**
 * The sale-line read model, as a PostgREST column list.
 *
 * `sale_items` is one of the four tables whose blanket grant is revoked from
 * `authenticated` and replaced with a column list (initial schema), because
 * `cost_per_base_unit_snapshot` must not be readable: the till writes it, but
 * only an owner reads it, through `pf_sale_item_costs`.
 *
 * A `sale_items(*)` embed expands to every column and therefore needs a privilege
 * on every column, so it fails with `42501 permission denied for table
 * sale_items` for every role — owner included. That is the bug this constant
 * fixes; the same reasoning is written up at the top of `catalog.ts`. Naming the
 * columns is what keeps the embed working, so adding `*` back re-breaks it.
 *
 * `batch_id` is granted separately by `20261005120000_unit_hierarchy`, after the
 * table was created; it carries no cost and is safe to select.
 */
export const SALE_ITEM_COLUMNS =
  'id,' +
  'sale_id,' +
  'batch_id,' +
  'medicine_id,' +
  'medicine_name,' +
  'generic_name,' +
  'unit_key,' +
  'unit_name,' +
  'unit_multiplier,' +
  'quantity,' +
  'base_units_total,' +
  'unit_price,' +
  'line_total';

/** A sale header with its lines embedded. What `listSales`/`getSale` return. */
export type SaleWithItems = SaleRow & { sale_items: SaleItemRow[] };

/** Recent sales with their lines, newest first. */
export async function listSales(limit = 50): Promise<Result<SaleWithItems[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('sales')
    .select(`*, sale_items(${SALE_ITEM_COLUMNS})`)
    .order('sold_at', { ascending: false })
    .limit(limit);

  return fromList<SaleWithItems>({
    data: (query.data ?? null) as SaleWithItems[] | null,
    error: query.error,
  });
}

export async function getSale(id: string): Promise<Result<SaleWithItems>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE } as const;
  if (!(await hasSession())) return { ok: false, error: NO_SESSION } as const;

  const { data, error } = await client()
    .from('sales')
    .select(`*, sale_items(${SALE_ITEM_COLUMNS})`)
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, code: error.code } as const;
  if (!data) return { ok: false, error: 'Sale not found' } as const;
  return ok(data as unknown as SaleWithItems);
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

/* -------------------------------------------------------- authoritative sale */

/**
 * One cart line as the server wants it.
 *
 * Deliberately three fields. The base-unit total, the unit multiplier and the
 * price are all derived in `pf_complete_sale` from the product's own packaging,
 * so a caller that sends them is ignored and a caller that forges them changes
 * nothing.
 */
export interface CompleteSaleLine {
  medicineId: string;
  unitKey: string;
  quantity: number;
}

export interface CompleteSaleInput {
  lines: CompleteSaleLine[];
  paymentMethod: PaymentMethod;
  amountPaid: number;
  discount?: number;
  discountReason?: string;
  customerId?: string;
  creditAccountId?: string;
  dispensedAgainstPrescription?: boolean;
  /**
   * A stable key for this attempt at this cart.
   *
   * The server returns the original sale rather than ringing up a second one if
   * the same key arrives twice, which is what makes a double-click, a retry after
   * a dropped connection, or a refresh mid-sale safe. Generate it once per cart
   * and reuse it across retries; generate a new one for the next sale.
   */
  idempotencyKey: string;
}

export interface CompleteSaleResult {
  saleId: string;
  receiptNumber: string;
  total: number;
  lineCount: number;
  /** True when this key had already been completed and nothing new was written. */
  alreadyCompleted: boolean;
}

/**
 * Ring up a sale through the database.
 *
 * ## Why this exists
 *
 * The POS used to call `ops.checkout`, which mutated `pharmaflow:state:v3` in
 * localStorage and validated the cart against the seeded prototype catalogue.
 * The catalogue it priced from comes from Postgres, so the ids never matched and
 * a real sale could not complete.
 *
 * ## What the caller does not get to decide
 *
 * Branch, actor, unit multipliers, unit prices, base-unit totals, subtotal,
 * total and outstanding are all resolved server-side. The function also refuses
 * to proceed at all unless the caller is staff on the branch it resolves itself.
 *
 * No cost-bearing value is returned. `sale_items.cost_per_base_unit_snapshot`
 * stays behind the owner-gated views, so this cannot become a way for an
 * attendant to read purchase costs.
 */
export async function completeSale(input: CompleteSaleInput): Promise<Result<CompleteSaleResult>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  if (input.lines.length === 0) return { ok: false, error: 'Cart is empty' };

  const { data, error } = await client().rpc('pf_complete_sale', {
    p_lines: input.lines.map((line) => ({
      medicine_id: line.medicineId,
      unit_key: line.unitKey,
      quantity: line.quantity,
    })),
    p_payment_method: input.paymentMethod,
    p_amount_paid: input.amountPaid,
    p_discount: input.discount ?? 0,
    p_discount_reason: input.discountReason ?? null,
    p_customer_id: input.customerId ?? null,
    p_credit_account_id: input.creditAccountId ?? null,
    p_dispensed_against_prescription: input.dispensedAgainstPrescription ?? false,
    p_idempotency_key: input.idempotencyKey,
  });

  // PostgREST surfaces a raised `raise exception` as 400 with the message in
  // `message`. It is a sentence written for an attendant, so it is passed
  // through rather than replaced with a generic failure.
  if (error) return { ok: false, error: error.message, code: error.code };

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        sale_id?: string;
        receipt_number?: string;
        total?: number;
        line_count?: number;
        already_completed?: boolean;
      }
    | null;

  if (!row?.sale_id || !row.receipt_number) {
    return { ok: false, error: 'The sale was not completed.' };
  }

  return ok({
    saleId: row.sale_id,
    receiptNumber: row.receipt_number,
    total: Number(row.total ?? 0),
    lineCount: Number(row.line_count ?? 0),
    alreadyCompleted: row.already_completed === true,
  });
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
 * The ledger invariant is enforced on both sides. `pf_check_credit_ledger_balance`
 * runs BEFORE INSERT on `credit_ledger` — the trigger is attached at
 * `20261004090000_stock_ledger_and_fefo_foundation.sql:39-41`, not merely defined
 * — and `pf_check_credit_account_ledger` runs BEFORE UPDATE on `credit_accounts`
 * (`:79-81`). Together they pin each account's `outstanding_balance` to its
 * latest ledger `balance_after`, so a `balance_after` sent from here must equal
 * the account's *current* balance, and the same insert cannot then move it.
 *
 * `20261012120000_authoritative_checkout.sql:167-191` redefines the first check
 * to return early only while the transaction-local `pharmaflow.credit_write`
 * setting is `'1'`, which only `pf_complete_sale` sets. That escape is not
 * reachable from this direct insert, so the invariant fully applies to anything
 * sent from here.
 *
 * This path is demo-only: no live screen calls it, and it cannot correctly move
 * a balance (a live payment needs an owner-scoped RPC that sets the flag and
 * writes ledger-then-account in that order, like `pf_complete_sale`).
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