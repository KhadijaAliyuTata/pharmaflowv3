import type {
  CreditLedgerInsert,
  MedicineReturnItemRow,
  MedicineReturnReason,
  MedicineReturnRow,
  SaleInsert,
  SaleItemInsert,
  SaleItemRow,
  SaleRow,
  SaleUpdate,
} from '../db.types';
import type { PaymentMethod, SaleReturnMethod } from '~/domain/types';
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

/**
 * The return embed, as a PostgREST column list.
 *
 * Naming the columns keeps the read honest against the grant list. The child
 * embed is the per-line value/restock/quarantine record; the batch allocation
 * rows are intentionally not loaded for the ledger, because the ledger only
 * needs "how much went back and how much was held". Batch detail is available
 * to an owner from the database/audit trail if a dispute needs it.
 */
export const SALE_RETURN_COLUMNS =
  'id,' +
  'return_number,' +
  'status,' +
  'reason,' +
  'note,' +
  'created_at,' +
  'reviewed_at,' +
  'completed_at,' +
  'review_note,' +
  'refund_value,' +
  'credit_applied,' +
  'refund_amount,' +
  'refund_method,' +
  'medicine_return_items(' +
    'sale_item_id,' +
    'medicine_id,' +
    'quantity,' +
    'base_units_total,' +
    'return_value,' +
    'restocked_units,' +
    'quarantined_units' +
  ')';

export type SaleReturnWithItems = MedicineReturnRow & {
  medicine_return_items: MedicineReturnItemRow[];
};

/** A sale header with its lines and linked returns embedded. */
export type SaleWithItems = SaleRow & {
  sale_items: SaleItemRow[];
  medicine_returns: SaleReturnWithItems[];
};

/** One pending return with the few sale fields the owner queue needs. */
export interface PendingReturnQueueRow {
  id: string;
  return_number: string;
  sale_id: string;
  reason: MedicineReturnReason;
  note: string;
  created_at: string;
  refund_value: number;
  medicine_return_items: {
    quantity: number;
    return_value: number;
  }[];
  sales: {
    receipt_number: string;
    total: number;
    outstanding: number;
    returned_credit: number;
  } | null;
}

/**
 * Every pending return in the branch, independent of how many recent sales the
 * ledger has loaded. The review action still re-reads the full sale before it
 * opens, so this queue cannot show a stale or unauthorised sale.
 */
export async function listPendingReturns(limit = 100): Promise<Result<PendingReturnQueueRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client()
    .from('medicine_returns')
    .select(
      'id,return_number,sale_id,reason,note,created_at,refund_value,' +
        'medicine_return_items(quantity,return_value),' +
        'sales(receipt_number,total,outstanding,returned_credit)',
    )
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true })
    .limit(limit);

  return fromList<PendingReturnQueueRow>({
    data: (data ?? null) as unknown as PendingReturnQueueRow[] | null,
    error,
  });
}

/** Recent sales with their lines, newest first. */
export async function listSales(limit = 50): Promise<Result<SaleWithItems[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('sales')
    .select(`*, sale_items(${SALE_ITEM_COLUMNS}), medicine_returns(${SALE_RETURN_COLUMNS})`)
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
    .select(`*, sale_items(${SALE_ITEM_COLUMNS}), medicine_returns(${SALE_RETURN_COLUMNS})`)
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
  /**
   * An offline sale's occurrence time (ISO 8601), stamped on the device the
   * moment the sale was recorded. The server validates both edges (≤ 5 minutes
   * future, ≤ 30 days past) — the client never dictates ledger time. Omit (or
   * pass null) for an ordinary online sale, and the column default `now()`
   * stamps it exactly as before. Replays are unaffected: an idempotency-key hit
   * returns the original sale before any timestamp is consulted.
   */
  soldAt?: string | null;
  /**
   * The split-payment parts for a sale paid with more than one method. The
   * server validates them again (sum must equal `amountPaid`, at least two
   * parts for a `split` sale), then writes one `sale_payments` row per part
   * inside the same transaction as the sale. Omitted for every other payment
   * type. The method travels as a string because the offline intent does; the
   * RPC casts and refuses an unknown kind.
   */
  paymentBreakdown?: { method: string; amount: number }[];
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
    // `undefined`, not null: undefined keys are dropped from the request body,
    // so an ordinary sale works against BOTH the current nine-argument function
    // and the ten-argument one — the parameter is only sent when an offline
    // sale actually carries an occurrence time (which requires the M1
    // migration to be applied first; deployment order matters).
    p_sold_at: input.soldAt ?? undefined,
    // Same rule, one layer later: the breakdown is only sent when a split
    // sale carries parts, so this client keeps working against the ten-
    // argument function too. Requires 20261018120000 when actually used.
    p_payment_breakdown: input.paymentBreakdown?.length
      ? input.paymentBreakdown.map((part) => ({ method: part.method, amount: part.amount }))
      : undefined,
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

/* --------------------------------------------------------------- returns */

export interface ReturnableLine {
  saleItemId: string;
  medicineId: string;
  medicineName: string;
  unitKey: string;
  unitName: string;
  unitMultiplier: number;
  quantitySold: number;
  quantityReturned: number;
  quantityPending: number;
  quantityRemaining: number;
  unitPrice: number;
  lineTotal: number;
  returnValuePerUnit: number;
}

/**
 * Server-authoritative returnable quantities for one sale.
 *
 * `quantityRemaining` excludes both accepted and pending returns, so an
 * attendant cannot reserve the same unit twice while an owner is reviewing.
 * This is a read-only RPC; the create path revalidates under a row lock.
 */
export async function listSaleReturnable(saleId: string): Promise<Result<ReturnableLine[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_sale_returnable', { p_sale_id: saleId });
  if (error) return { ok: false, error: error.message, code: error.code };

  const rows = (Array.isArray(data) ? data : []) as {
    sale_item_id: string;
    medicine_id: string;
    medicine_name: string;
    unit_key: string;
    unit_name: string;
    unit_multiplier: number;
    quantity_sold: number;
    quantity_returned: number;
    quantity_pending: number;
    quantity_remaining: number;
    unit_price: number;
    line_total: number;
    return_value_per_unit: number;
  }[];

  return ok(
    rows.map((row) => ({
      saleItemId: row.sale_item_id,
      medicineId: row.medicine_id,
      medicineName: row.medicine_name,
      unitKey: row.unit_key,
      unitName: row.unit_name,
      unitMultiplier: Number(row.unit_multiplier),
      quantitySold: Number(row.quantity_sold),
      quantityReturned: Number(row.quantity_returned),
      quantityPending: Number(row.quantity_pending),
      quantityRemaining: Number(row.quantity_remaining),
      unitPrice: Number(row.unit_price),
      lineTotal: Number(row.line_total),
      returnValuePerUnit: Number(row.return_value_per_unit),
    })),
  );
}

export interface CreateSaleReturnInput {
  saleId: string;
  items: { saleItemId: string; quantity: number }[];
  reason: MedicineReturnReason;
  note?: string;
  refundMethod?: SaleReturnMethod | null;
  idempotencyKey: string;
}

export interface CreateSaleReturnResult {
  returnId: string;
  returnNumber: string;
  status: 'pending_review' | 'completed' | 'rejected';
  refundValue: number;
  creditApplied: number;
  refundAmount: number;
  alreadyExists: boolean;
}

/**
 * Create a return. Owners complete it immediately; attendants create a
 * pending-review record. The original sale and its lines are never edited.
 */
export async function createSaleReturn(
  input: CreateSaleReturnInput,
): Promise<Result<CreateSaleReturnResult>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  if (input.items.length === 0) return { ok: false, error: 'Choose at least one item to return' };

  const { data, error } = await client().rpc('pf_create_return', {
    p_sale_id: input.saleId,
    p_items: input.items.map((item) => ({
      sale_item_id: item.saleItemId,
      quantity: item.quantity,
    })),
    p_reason: input.reason,
    p_note: input.note?.trim() ? input.note.trim() : null,
    p_refund_method: input.refundMethod ?? null,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) return { ok: false, error: error.message, code: error.code };

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        return_id?: string;
        return_number?: string;
        status?: CreateSaleReturnResult['status'];
        refund_value?: number;
        credit_applied?: number;
        refund_amount?: number;
        already_exists?: boolean;
      }
    | null;

  if (!row?.return_id || !row.return_number) {
    return { ok: false, error: 'The return was not recorded.' };
  }

  return ok({
    returnId: row.return_id,
    returnNumber: row.return_number,
    status: row.status ?? 'pending_review',
    refundValue: Number(row.refund_value ?? 0),
    creditApplied: Number(row.credit_applied ?? 0),
    refundAmount: Number(row.refund_amount ?? 0),
    alreadyExists: row.already_exists === true,
  });
}

export interface ReviewSaleReturnInput {
  returnId: string;
  approve: boolean;
  note?: string;
  refundMethod?: SaleReturnMethod | null;
}

/**
 * Owner-only approval or rejection of a pending return.
 *
 * A rejection moves no stock and no money. An approval restores the accepted
 * units to their original lots (or quarantines them) and applies the credit /
 * refund split under the same transaction.
 */
export async function reviewSaleReturn(
  input: ReviewSaleReturnInput,
): Promise<Result<CreateSaleReturnResult>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_review_return', {
    p_return_id: input.returnId,
    p_approve: input.approve,
    p_note: input.note?.trim() ? input.note.trim() : null,
    p_refund_method: input.refundMethod ?? null,
  });

  if (error) return { ok: false, error: error.message, code: error.code };

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        return_id?: string;
        return_number?: string;
        status?: CreateSaleReturnResult['status'];
        refund_value?: number;
        credit_applied?: number;
        refund_amount?: number;
      }
    | null;

  if (!row?.return_id || !row.return_number) {
    return { ok: false, error: 'The return review was not recorded.' };
  }

  return ok({
    returnId: row.return_id,
    returnNumber: row.return_number,
    status: row.status ?? 'rejected',
    refundValue: Number(row.refund_value ?? 0),
    creditApplied: Number(row.credit_applied ?? 0),
    refundAmount: Number(row.refund_amount ?? 0),
    alreadyExists: false,
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

/* --------------------------------------------------- customer debt repayment */

export interface CustomerPaymentInput {
  saleId: string;
  amount: number;
  method: Exclude<PaymentMethod, 'split'>;
  note?: string;
}

export interface CustomerPaymentResult {
  saleId: string;
  receiptNumber: string;
  amountPaid: number;
  outstanding: number;
  state: 'paid' | 'part_paid' | 'credit';
  customerOutstandingDebt: number;
}

/**
 * Record a repayment against a customer's outstanding balance on one sale.
 *
 * One atomic server call (`pf_record_customer_payment`,
 * 20261018120000_pos_payments_split): the sale row is locked, voided/refunded
 * and walk-in sales are refused, an overpayment is refused, and the sale, the
 * customer's debt and the `sale_payments` audit row all move together. The
 * audit row carries the paying method and the staff member — owner or
 * attendant — who recorded it.
 *
 * Requires 20261018120000 to be applied; calling this against an older
 * database fails with "function ... does not exist", which callers surface.
 */
export async function recordCustomerPayment(
  input: CustomerPaymentInput,
): Promise<Result<CustomerPaymentResult>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_record_customer_payment', {
    p_sale_id: input.saleId,
    p_amount: input.amount,
    p_method: input.method,
    p_note: input.note?.trim() ? input.note.trim() : undefined,
  });

  if (error) return { ok: false, error: error.message, code: error.code };

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        sale_id?: string;
        receipt_number?: string;
        amount_paid?: number;
        outstanding?: number;
        state?: CustomerPaymentResult['state'];
        customer_outstanding_debt?: number;
      }
    | null;

  if (!row?.sale_id || !row.receipt_number) {
    return { ok: false, error: 'The repayment was not recorded.' };
  }

  return ok({
    saleId: row.sale_id,
    receiptNumber: row.receipt_number,
    amountPaid: Number(row.amount_paid ?? 0),
    outstanding: Number(row.outstanding ?? 0),
    state: row.state ?? 'paid',
    customerOutstandingDebt: Number(row.customer_outstanding_debt ?? 0),
  });
}

export interface SalePaymentRow {
  id: string;
  sale_id: string;
  method: PaymentMethod;
  amount: number;
  recorded_by: string | null;
  recorded_at: string;
  note: string | null;
}

/**
 * The branch's recent payment records — the repayment history the customers
 * screen reads. Amounts and methods only; no cost-bearing column exists here.
 * Requires 20261018120000 to be applied.
 */
export async function listSalePayments(limit = 200): Promise<Result<SalePaymentRow[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client()
    .from('sale_payments')
    .select('id, sale_id, method, amount, recorded_by, recorded_at, note')
    .order('recorded_at', { ascending: false })
    .limit(limit);

  if (error) return { ok: false, error: error.message, code: error.code };
  return fromList({ data, error });
}