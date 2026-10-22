/**
 * Selling-price validation shared by the owner dialog and its offline checks.
 *
 * The database is the authority: `pf_update_medicine_price` repeats every rule
 * below under a medicine row lock, refuses a stale expected price, and writes the
 * audit row. This function exists so the dialog can explain a problem before a
 * round trip, and so the rules have one testable definition in the client.
 *
 * It deliberately does not decide anything about cost secrecy. `costPerBaseUnit`
 * is absent for an assistant's medicine; when it is absent the cost floor is
 * skipped here and still enforced by the database for an owner.
 */

export type SellingPriceCheck =
  | { ok: true; value: number }
  | { ok: false; error: string };

export interface SellingPriceInput {
  /** The price typed into the form, as a number. */
  price: number;
  /** Base units in one of the unit being priced. */
  unitMultiplier: number;
  /** Purchase cost per base unit. Absent means this session cannot see it. */
  costPerBaseUnit?: number;
  /** The current price of the selected unit, from the catalogue. */
  currentPrice: number;
  /** The price the form was rendered with. */
  expectedPrice: number;
}

export function validateSellingPrice(input: SellingPriceInput): SellingPriceCheck {
  const {
    price,
    unitMultiplier,
    costPerBaseUnit,
    currentPrice,
    expectedPrice,
  } = input;

  if (!Number.isFinite(price)) {
    return { ok: false, error: 'Selling price must be a finite number.' };
  }
  if (!Number.isFinite(unitMultiplier) || !Number.isInteger(unitMultiplier) || unitMultiplier < 1) {
    return { ok: false, error: 'That unit has an invalid conversion factor.' };
  }
  if (price <= 0) {
    return { ok: false, error: 'Selling price must be greater than zero.' };
  }

  const rounded = Math.round(price * 100) / 100;
  if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-8) {
    return { ok: false, error: 'Selling price supports at most two decimal places.' };
  }

  if (!Number.isFinite(expectedPrice)) {
    return { ok: false, error: 'The current price is unavailable. Reload before saving.' };
  }
  if (Math.abs(currentPrice - expectedPrice) > 0.01) {
    return {
      ok: false,
      error:
        'This price changed while the form was open. Reload to see the newer price before saving.',
    };
  }
  if (rounded === currentPrice) {
    return { ok: false, error: 'The price is unchanged.' };
  }

  if (costPerBaseUnit !== undefined && costPerBaseUnit > 0) {
    const unitCost = Math.round(costPerBaseUnit * unitMultiplier * 100) / 100;
    if (rounded <= unitCost) {
      return {
        ok: false,
        error: `Price must be above the cost of one unit (${unitCost.toLocaleString('en-NG', {
          style: 'currency',
          currency: 'NGN',
          maximumFractionDigits: 2,
        })}).`,
      };
    }
  }

  return { ok: true, value: rounded };
}
