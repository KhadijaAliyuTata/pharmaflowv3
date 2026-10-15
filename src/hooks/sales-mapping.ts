import type { SaleItemRow } from '~/lib/db.types';
import type { Sale } from '~/domain/types';
import type { SaleItem } from '~/domain/types';
import type { SaleWithItems } from '~/lib/supabase/sales';

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

export function toSale(row: SaleWithItems, attendantName: string): Sale {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    date: row.sold_at,
    attendantId: row.attendant_id,
    attendantName,
    items: (row.sale_items ?? []).map(toSaleItem),
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    ...(row.discount_reason ? { discountReason: row.discount_reason } : {}),
    total: Number(row.total),
    paymentMethod: row.payment_method,
    // `state` is nullable in the database — it has a default but no NOT NULL — so
    // a null is read as the default the column documents, `paid`, not as unknown.
    status: row.state ?? 'paid',
    amountPaid: Number(row.amount_paid),
    outstandingBalance: Number(row.outstanding),
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
