import type { MedicineRef, ReceiptWithRefs, StockMovementWithRefs } from '~/lib/supabase/stock';
import type { StockMovement, StockReceipt } from '~/domain/types';

/**
 * `stock_receipts` / `stock_movements` rows -> the domain objects the screens
 * already render.
 *
 * The same translation as `sales-mapping.ts`: the screens keep reading camelCase
 * domain objects, and the snake_case row is converted once, here.
 *
 * Three omissions are deliberate:
 *
 *   * **Cost is absent, not zero.** `cost_per_base_unit` is not selectable, so it
 *     is left off rather than defaulted to 0. The receipt is shown by its state —
 *     `pending_pricing` means "nobody has said what this cost" — instead of
 *     inventing a purchase price.
 *
 *   * **`branch_id` is dropped.** Rows are already branch-scoped by the read
 *     policies; carrying the id would suggest a caller might filter on it.
 *
 *   * **A missing name is blank, not a placeholder.** `medicines` and `profiles`
 *     are embeds, and either may be `null`: the product is always readable, but a
 *     receiver who has since left the branch is not. A blank reads as a gap the
 *     ledger honestly has, where a made-up name would point at the wrong person.
 *
 * The stock movement's `kind` is the same six-value union as the domain
 * `StockMovementType`, so it is passed through rather than mapped.
 */

function medicineName(ref: MedicineRef | null): string {
  return ref?.name ?? '';
}

/** `profiles.role` is the same `owner | assistant` union the domain uses. */
function toStockReceipt(row: ReceiptWithRefs): StockReceipt {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    medicineId: row.medicine_id,
    medicineName: medicineName(row.medicines),
    batchNumber: row.batch_number,
    baseUnitsReceived: row.base_units_received,
    // The screen resolves the id against the branch's supplier list and falls
    // back to the raw value, exactly as it did for the seeded receipts.
    supplier: row.supplier_id ?? '',
    expiryDate: row.expiry_date,
    dateReceived: row.received_at,
    receivedBy: row.profiles?.full_name ?? '',
    receivedByRole: row.profiles?.role ?? 'assistant',
    status: row.state,
    ...(row.price_per_base_unit !== null ? { pricePerBaseUnit: Number(row.price_per_base_unit) } : {}),
    ...(row.priced_by ? { pricedBy: row.priced_by } : {}),
    ...(row.priced_at ? { pricedAt: row.priced_at } : {}),
    ...(row.received_quantity !== null ? { receivedQuantity: row.received_quantity } : {}),
    ...(row.received_unit_key ? { receivedUnitKey: row.received_unit_key } : {}),
    ...(row.received_unit_name ? { receivedUnitName: row.received_unit_name } : {}),
    ...(row.received_unit_multiplier !== null
      ? { receivedUnitMultiplier: row.received_unit_multiplier }
      : {}),
  };
}

export function toStockReceipts(rows: ReceiptWithRefs[]): StockReceipt[] {
  return rows.map(toStockReceipt);
}

function toStockMovement(row: StockMovementWithRefs): StockMovement {
  return {
    id: row.id,
    timestamp: row.created_at,
    medicineId: row.medicine_id,
    medicineName: medicineName(row.medicines),
    type: row.kind,
    quantityChanged: row.quantity_changed,
    resultingQuantity: row.resulting_quantity,
    performedBy: row.profiles?.full_name ?? '',
    performedByRole: row.profiles?.role ?? 'assistant',
    notes: row.note,
    ...(row.reference_id ? { referenceId: row.reference_id } : {}),
  };
}

export function toStockMovements(rows: StockMovementWithRefs[]): StockMovement[] {
  return rows.map(toStockMovement);
}
