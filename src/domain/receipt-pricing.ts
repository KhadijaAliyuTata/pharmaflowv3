import { money } from './money';
import type { TradeUnit } from './types';

/**
 * What a completed receipt should do to the product's selling price.
 *
 * `pf_receive_stock` stores `price_per_base_unit` on the receipt, not on the
 * medicine. The owner-only `pf_update_medicine_price` RPC is the authoritative
 * way to mirror it onto the catalogue. This function decides whether that call
 * is needed using only values persisted in the catalogue row, never the
 * `createdProduct` copy held by the Stock Receiving page. A reload between
 * creating the product and receiving it therefore loses nothing.
 *
 * The receipt price is per base unit. Keeping the update on the base unit is
 * what stops "2 boxes at ₦500 each" from writing ₦500 as the price of a box.
 */
export interface ReceiptPriceSyncPlan {
  unitKey: string;
  /** Current base-unit price from the catalogue; the server's optimistic lock. */
  expectedPrice: number;
  newPrice: number;
}

export interface ReceiptPriceSyncInput {
  /** Owner, resolved by `pf_is_owner()`, not by the display role cache. */
  canPrice: boolean;
  /** True when this receipt number was already recorded before this submit. */
  alreadyReceived: boolean;
  /** Receipts awaiting pricing do not own the catalogue price yet. */
  receiptConfirmed: boolean;
  /** The price typed on the delivery note, per base unit. */
  pricePerBaseUnit: number;
  /**
   * The base unit read from the persisted catalogue row. This is intentionally
   * not the unit the delivery was counted in: its `sellingPrice` is per pack.
   */
  baseUnit: TradeUnit | null | undefined;
}

export function planReceiptPriceSync(
  input: ReceiptPriceSyncInput,
): ReceiptPriceSyncPlan | null {
  const { canPrice, alreadyReceived, receiptConfirmed, pricePerBaseUnit, baseUnit } = input;

  if (!canPrice || alreadyReceived || !receiptConfirmed || !baseUnit) return null;
  if (baseUnit.multiplier !== 1) return null;
  if (!Number.isFinite(pricePerBaseUnit) || pricePerBaseUnit <= 0) return null;
  if (!Number.isFinite(baseUnit.sellingPrice)) return null;

  const newPrice = money(pricePerBaseUnit);
  const expectedPrice = money(baseUnit.sellingPrice);

  // The RPC refuses an unchanged price, and calling it would only produce a
  // warning after a successful delivery. Skip the no-op.
  if (newPrice === expectedPrice) return null;

  return { unitKey: baseUnit.key, expectedPrice, newPrice };
}
