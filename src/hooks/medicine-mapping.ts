import type { BatchRow, MedicineRow, PrescriptionClass } from '~/lib/db.types';
import type { Medicine, MedicineBatch, PrescriptionStatus, TradeUnit } from '~/domain/types';

/**
 * `medicines` row -> domain `Medicine`.
 *
 * The screens are not being rewritten to understand database rows, so the row is
 * translated once, here. The alternative — making every screen read snake_case and
 * Postgres enums — would touch thirteen route files to express the same thing.
 *
 * The mapping is a translation, not an interpretation. Nothing is invented:
 *
 *   * **Identity is the database id.** `id` is the real `uuid`. Seed ids like
 *     `med-paracetamol` exist only in the demo build and are never mapped onto a
 *     row, because there is no row to map from.
 *
 *   * **Cost is absent, not zero.** `costPerBaseUnit` is *omitted* from the
 *     object rather than defaulted to 0, because the column is not selectable and
 *     "unknown cost" and "free" must not look alike. `types.ts` makes the field
 *     optional for exactly this reason, and `updatePrice` / `updateUnitPrice` /
 *     `updateUnits` all fail closed when it is missing. An assistant therefore
 *     cannot read cost here — not because it was filtered, but because the bytes
 *     never arrive. The owner reads it separately through `listMedicineCosts`.
 *
 *   * **`branch_id` is dropped.** The row is already branch-scoped by RLS; carrying
 *     the id would suggest a caller might filter on it, which would be a frontend
 *     check standing in for the database's. Same reasoning as `toSupplier`.
 *
 *   * **Lock attribution is dropped.** `do_not_sell_locked_by` and
 *     `do_not_sell_locked_at` are not selectable, so `lockedBy` / `lockedAt` are
 *     left undefined. The lock's `active` flag and `reason` do come through,
 *     which is what the UI actually reads to decide whether a product is blocked.
 */

const PRESCRIPTION_STATUS: Record<PrescriptionClass, PrescriptionStatus> = {
  otc: 'OTC',
  prescription: 'Prescription',
  controlled: 'Controlled',
};

/** `jsonb` units -> `TradeUnit[]`, defensively. */
function toUnits(value: unknown): TradeUnit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const u = raw as Record<string, unknown>;
    const key = typeof u.key === 'string' ? u.key : '';
    const name = typeof u.name === 'string' ? u.name : '';
    if (!key || !name) return [];
    return [
      {
        key,
        name,
        multiplier: Number(u.multiplier ?? 1),
        sellingPrice: Number(u.sellingPrice ?? 0),
      },
    ];
  });
}

function toBatch(row: BatchRow): MedicineBatch {
  return {
    id: row.id,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date,
    quantity: row.quantity,
    // Withheld by the column grants and therefore absent, not zero. `batchNumber`,
    // quantity and recall state are what the UI needs to render a lot.
    supplier: row.supplier_id ?? '',
    receivedDate: row.received_date,
    isRecalled: row.is_recalled,
    ...(row.recall_reason ? { recallReason: row.recall_reason } : {}),
  };
}

export type MedicineRowWithBatches = MedicineRow & { medicine_batches?: BatchRow[] };

export function toMedicine(row: MedicineRowWithBatches): Medicine {
  const batches = Array.isArray(row.medicine_batches) ? row.medicine_batches : [];

  return {
    id: row.id,
    ...(row.barcode ? { barcode: row.barcode } : {}),
    name: row.name,
    genericName: row.generic_name,
    strength: row.strength,
    dosageForm: row.dosage_form,
    category: row.category,
    units: toUnits(row.units),
    totalQuantity: row.total_quantity,
    lowStockThreshold: row.low_stock_threshold,
    expiryDate: row.expiry_date,
    // Holds a supplier id in the database. Seed data stores ids here too, so this
    // stays an id rather than a name.
    supplier: row.supplier_id ?? '',
    purchaseDate: row.purchase_date,
    // No costPerBaseUnit. See the note above.
    pricePerBaseUnit: Number(row.price_per_base_unit),
    batches: batches.map(toBatch),
    commonUse: row.common_use,
    storage: row.storage,
    prescriptionStatus: PRESCRIPTION_STATUS[row.prescription_class] ?? 'OTC',
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    isBrand: row.is_brand,
    ...(row.generic_equivalent_id ? { genericEquivalentId: row.generic_equivalent_id } : {}),
    doNotSell: {
      active: row.do_not_sell,
      ...(row.do_not_sell_reason ? { reason: row.do_not_sell_reason } : {}),
    },
    ...(row.nafdac_reg_number ? { nafdacRegNumber: row.nafdac_reg_number } : {}),
    ...(row.manufacturer ? { manufacturer: row.manufacturer } : {}),
    averageDailySales: Number(row.average_daily_sales),
  };
}

/** Wholesale list→domain mapping, keeping order. */
export function toMedicines(rows: MedicineRowWithBatches[]): Medicine[] {
  return rows.map(toMedicine);
}
