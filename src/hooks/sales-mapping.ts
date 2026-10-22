import type { SaleItemRow } from '~/lib/db.types';
import type { Sale } from '~/domain/types';
import type { SaleItem, SaleReturn } from '~/domain/types';
import type { SaleReturnWithItems, SaleWithItems } from '~/lib/supabase/sales';

/**
 * `sales` + `sale_items` rows -> the domain `Sale` the screens already render.
 *
 * The same translation as `medicine-mapping.ts`: the screens are not rewritten to
 * read snake_case, so the rows are converted once, here.
 *
 * Two omissions are deliberate and load-bearing:
 *
 *   * **Cost is absent, not zero.** `sale_items.cost_per_base_unit_snapshot` is
 *     not selectable (it is withheld from `authenticated` and read only through
 *     `pf_sale_item_costs`), so `costPerBaseUnitSnapshot` is left off rather than
 *     defaulted to 0. `summariseSales` then reports margin as `null`, which the
 *     screens render as "—" and "cost of goods not captured" rather than as a
 *     fabricated 100% margin.
 *
 *   * **`branch_id` is dropped.** The rows are already branch-scoped by RLS;
 *     carrying the id would suggest a caller might filter on it.
 *
 * The attendant's name is not on the row either — `attendant_id` is a foreign key
 * to `profiles`, and the branch's staff list is already loaded into the store (and
 * kept live by `~/lib/tenant-sync`). `toSales` joins against it, exactly as
 * `teamMembers` in `domain/dashboard.ts` does. No embed is used: the codebase's
 * pattern for a name join is a second read (`supabase/staff.ts` does this too),
 * not a PostgREST embedding.
 */

function toSaleItem(row: SaleItemRow): SaleItem {
  return {
    id: row.id,
    medicineId: row.medicine_id,
    unitKey: row.unit_key,
    unitName: row.unit_name,
    unitMultiplier: row.unit_multiplier,
    unitPrice: Number(row.unit_price),
    quantity: row.quantity,
    baseUnitsTotal: row.base_units_total,
    lineTotal: Number(row.line_total),
    medicineName: row.medicine_name,
    genericName: row.generic_name,
    // No `costPerBaseUnitSnapshot`. See the note above.
    ...(row.batch_id ? { batchId: row.batch_id } : {}),
  };
}

function toSaleReturn(
  row: SaleReturnWithItems,
  saleItems: Map<string, SaleItemRow>,
): SaleReturn {
  return {
    id: row.id,
    returnNumber: row.return_number,
    status: row.status,
    reason: row.reason,
    note: row.note,
    createdAt: row.created_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.review_note ? { reviewNote: row.review_note } : {}),
    refundValue: Number(row.refund_value),
    creditApplied: Number(row.credit_applied),
    refundAmount: Number(row.refund_amount),
    ...(row.refund_method ? { refundMethod: row.refund_method } : {}),
    items: (row.medicine_return_items ?? []).map((item) => {
      const line = saleItems.get(item.sale_item_id);
      return {
        saleItemId: item.sale_item_id,
        medicineId: item.medicine_id,
        medicineName: line?.medicine_name ?? 'Product',
        quantity: item.quantity,
        baseUnitsTotal: item.base_units_total,
        returnValue: Number(item.return_value),
        restockedUnits: item.restocked_units,
        quarantinedUnits: item.quarantined_units,
      };
    }),
  };
}

export function toSale(row: SaleWithItems, attendantName: string): Sale {
  const saleItems = row.sale_items ?? [];
  const linesById = new Map(saleItems.map((line) => [line.id, line]));
  const returnedCredit = Number(row.returned_credit ?? 0);

  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    date: row.sold_at,
    attendantId: row.attendant_id,
    attendantName,
    items: saleItems.map(toSaleItem),
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    ...(row.discount_reason ? { discountReason: row.discount_reason } : {}),
    total: Number(row.total),
    paymentMethod: row.payment_method,
    // `state` is nullable in the database — it has a default but no NOT NULL — so
    // a null is read as the default the column documents, `paid`, not as unknown.
    status: row.state ?? 'paid',
    amountPaid: Number(row.amount_paid),
    // Accepted return credit is a separate, linked adjustment. The amount still
    // owed is the original outstanding less that credit; it is never negative.
    outstandingBalance: Math.max(Number(row.outstanding) - returnedCredit, 0),
    ...(returnedCredit > 0 ? { returnedCredit } : {}),
    returns: (row.medicine_returns ?? [])
      .map((entry) => toSaleReturn(entry, linesById))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ...(row.customer_id ? { customerId: row.customer_id } : {}),
    ...(row.credit_account_id ? { creditAccountId: row.credit_account_id } : {}),
    ...(row.dispensed_against_prescription ? { dispensedAgainstPrescription: true } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    ...(row.status_changed_by ? { statusChangedBy: row.status_changed_by } : {}),
    ...(row.status_changed_at ? { statusChangedAt: row.status_changed_at } : {}),
  };
}

/**
 * Wholesale row -> domain mapping, keeping order.
 *
 * `attendantNames` maps `profiles.id` -> display name. A name missing from it is
 * left blank rather than replaced with a placeholder: a sale whose attendant is no
 * longer on the branch is a real, rare case, and the ledger should show the gap
 * rather than a name that may belong to someone else.
 */
export function toSales(rows: SaleWithItems[], attendantNames: Map<string, string>): Sale[] {
  return rows.map((row) => toSale(row, attendantNames.get(row.attendant_id) ?? ''));
}
