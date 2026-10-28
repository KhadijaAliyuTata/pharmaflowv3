import { money } from './money';
import type { Medicine, MedicineBatch } from './types';

/**
 * The supplier and purchase cost a received lot already carries.
 *
 * `pf_receive_stock` writes both terms onto the receipt and the batch, not onto
 * `medicines`. That is deliberate: the cost column is owner-only, the receipt is
 * the source document, and a product can have several lots at different costs.
 * Inventory, however, renders one product row. This module is the read-time
 * bridge: it uses the latest persisted lot for a term the product row does not
 * carry, without writing anything back.
 *
 * Nothing here is invented. A zero in the owner cost views means "no cost was
 * recorded", not "this product is free", so zero is treated as absent. The
 * supplier comes from the lot only when the product row has none; a supplier
 * already recorded on the product wins.
 */

export interface ReceiptTermCosts {
  /** `pf_medicine_costs.id` -> cost per base unit. Owner-only view. */
  medicineCosts: ReadonlyMap<string, number>;
  /** `pf_batch_costs.id` -> cost per base unit. Owner-only view. */
  batchCosts: ReadonlyMap<string, number>;
}

/** A recorded cost is positive and finite. Zero is "not recorded". */
function recordedCost(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return money(value);
}

/**
 * The most recently received lot, with a deterministic tie-break.
 *
 * `medicine_batches` has no `created_at` in the domain read model, and two
 * deliveries can share a date. Expiry then id keeps the choice stable across
 * reloads instead of depending on the order PostgREST happened to return.
 */
function latestBatch(medicine: Medicine): MedicineBatch | undefined {
  let latest: MedicineBatch | undefined;
  for (const batch of medicine.batches) {
    if (latest === undefined) {
      latest = batch;
      continue;
    }
    const received = batch.receivedDate.localeCompare(latest.receivedDate);
    if (received > 0) {
      latest = batch;
      continue;
    }
    if (received === 0) {
      const expiry = batch.expiryDate.localeCompare(latest.expiryDate);
      if (expiry > 0 || (expiry === 0 && batch.id.localeCompare(latest.id) > 0)) {
        latest = batch;
      }
    }
  }
  return latest;
}

/**
 * Add the persisted lot's supplier/cost to the catalogue read model.
 *
 * Display-only. It does not touch stock, prices, audit rows or the database.
 * The returned medicine keeps its existing cost when the product cost view has
 * no positive value and there is no recorded batch cost.
 */
export function withReceiptTerms(
  medicines: readonly Medicine[],
  costs: ReceiptTermCosts,
): Medicine[] {
  return medicines.map((medicine) => {
    const latest = latestBatch(medicine);
    const productCost = recordedCost(costs.medicineCosts.get(medicine.id));
    const latestBatchCost = latest ? recordedCost(costs.batchCosts.get(latest.id)) : undefined;
    const cost = productCost ?? latestBatchCost;
    const supplier = medicine.supplier || latest?.supplier || '';

    const batches = medicine.batches.map((batch) => {
      const batchCost = recordedCost(costs.batchCosts.get(batch.id));
      return batchCost === undefined ? batch : { ...batch, costPerBaseUnit: batchCost };
    });

    return {
      ...medicine,
      batches,
      supplier,
      ...(cost === undefined ? {} : { costPerBaseUnit: cost }),
    };
  });
}
