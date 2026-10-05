/**
 * Multi-unit inventory: the one place unit arithmetic happens.
 *
 * ## The canonical base unit
 *
 * Every quantity in PharmaFlow — batches, `totalQuantity`, stock movements,
 * thresholds, reorder maths — is an integer count of **base units**. Packaging
 * is a conversion layer on top and never a second source of truth. Selling two
 * pieces deducts 2 base units whether the attendant picked "Piece" or the
 * customer said "just two of the tablets".
 *
 * ## Why the factors are flat, not a chain
 *
 * A unit stores `multiplier` = how many base units are in one of it, so
 * `card = 10`, `box = 100`. A chain (`box = 10 cards`, `card = 10 pieces`) was
 * considered and rejected:
 *
 *  - it cannot be circular or ambiguous once flattened, so §6's cycle and
 *    ambiguity rules hold by construction rather than by careful validation;
 *  - it is what `medicines.units` already stores and what `pf_check_base_unit`
 *    already enforces, so nothing has to be re-derived or migrated;
 *  - it is integer-exact. A chain multiplies factors together; a flat factor is
 *    stored once.
 *
 * The hierarchy is therefore *presentational*: `convertFromBaseUnits` walks the
 * factors largest-first to render "4 Boxes · 9 Cards · 8 Pieces" from 498. The
 * canonical number never changes.
 *
 * ## Purity
 *
 * Everything here is pure and synchronous — no Supabase, no store, no clock.
 * Offline and online must agree exactly, so the same
 * `(units, unitKey, quantity)` always yields the same base quantity.
 */

import type { Medicine, TradeUnit } from './types';
import { multiply, subtract } from './money';

/* -------------------------------------------------------------- validation */

/** One thing wrong with one unit. Keyed so the UI can point at the right row. */
export interface UnitValidationIssue {
  /** `''` when the problem is the list as a whole rather than one unit. */
  unitKey: string;
  unitName: string;
  problem: string;
}

export type UnitValidation =
  | { ok: true; units: TradeUnit[] }
  | { ok: false; issues: UnitValidationIssue[] };

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Checks a packaging hierarchy before it is stored.
 *
 * The rules that matter are the ones whose violation would corrupt stock:
 * a zero or fractional multiplier makes base quantities non-integer, and a
 * second unit claiming `multiplier = 1` makes "the base unit" ambiguous, which
 * silently doubles or halves every deduction.
 *
 * Element 0 must be the base unit. That is not a stylistic preference — it is
 * the contract `pf_check_base_unit` enforces in the database, and the client
 * refusing the same shape is what stops a value the server would reject from
 * ever reaching it.
 */
export function validateUnitHierarchy(units: readonly TradeUnit[]): UnitValidation {
  const issues: UnitValidationIssue[] = [];

  if (units.length === 0) {
    return {
      ok: false,
      issues: [{ unitKey: '', unitName: '', problem: 'A medicine needs at least one unit' }],
    };
  }

  const seenKeys = new Set<string>();
  let baseCount = 0;

  units.forEach((unit, index) => {
    const where = { unitKey: unit.key, unitName: unit.name };

    if (unit.key.trim() === '') {
      issues.push({ ...where, problem: 'Unit needs an identifier' });
    } else if (seenKeys.has(unit.key)) {
      issues.push({ ...where, problem: `Duplicate unit identifier "${unit.key}"` });
    } else {
      seenKeys.add(unit.key);
    }

    if (unit.name.trim() === '') {
      issues.push({ ...where, problem: 'Unit needs a name' });
    }

    if (!isPositiveInteger(unit.multiplier)) {
      issues.push({
        ...where,
        problem: `"${unit.multiplier}" is not a whole number of base units — it must be a positive integer`,
      });
    }

    if (!Number.isFinite(unit.sellingPrice) || unit.sellingPrice < 0) {
      issues.push({ ...where, problem: 'Selling price must be zero or more' });
    }

    if (unit.multiplier === 1) {
      baseCount += 1;
      if (index !== 0) {
        issues.push({
          ...where,
          problem: 'The base unit (1 base unit) must be listed first',
        });
      }
    }
  });

  if (baseCount === 0) {
    issues.push({
      unitKey: units[0]?.key ?? '',
      unitName: units[0]?.name ?? '',
      problem: 'No unit converts to exactly 1 base unit — one unit must be the base unit',
    });
  } else if (baseCount > 1) {
    issues.push({
      unitKey: '',
      unitName: '',
      problem: `${baseCount} units claim to be the base unit — exactly one may convert to 1`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, units: [...units] };
}

/* ------------------------------------------------------------------ lookup */

/**
 * The base unit: the one that converts to exactly 1.
 *
 * Total by design — returns `null` rather than throwing, because a malformed
 * hierarchy read back from storage must not take a screen down. Anything that
 * *writes* a hierarchy runs `validateUnitHierarchy` first.
 */
export function findBaseUnit(units: readonly TradeUnit[]): TradeUnit | null {
  return units.find((unit) => unit.multiplier === 1) ?? null;
}

/** Looks up one unit by key. `null` when absent. */
export function findUnit(units: readonly TradeUnit[], unitKey: string): TradeUnit | null {
  return units.find((unit) => unit.key === unitKey) ?? null;
}

/** Units ordered smallest first. Never mutates the input. */
export function unitsBySize(units: readonly TradeUnit[]): TradeUnit[] {
  return [...units].sort((a, b) => a.multiplier - b.multiplier);
}

/* --------------------------------------------------------------- conversion */

/** A quantity expressed one way, with the canonical base count alongside. */
export interface UnitAmount {
  unitKey: string;
  unitName: string;
  /** How many of `unitKey`. */
  quantity: number;
  /** `multiplier` at the moment of conversion — a snapshot, not a live join. */
  baseUnitsPerUnit: number;
  /** Canonical integer count. */
  baseUnits: number;
}

export type ConversionResult =
  | { ok: true; amount: UnitAmount }
  | { ok: false; error: string };

/**
 * `quantity` of `unitKey` → canonical base units.
 *
 * Refuses anything that would put a fraction into inventory: a non-integer
 * quantity, a quantity that is not positive, or a product outside safe-integer
 * range. Silently rounding here is how a pharmacy ends up owning 3.5 tablets.
 */
export function convertToBaseUnits(
  units: readonly TradeUnit[],
  unitKey: string,
  quantity: number,
): ConversionResult {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      error: `Quantity must be a whole number greater than zero (received ${quantity})`,
    };
  }

  const unit = findUnit(units, unitKey);
  if (!unit) {
    return { ok: false, error: `"${unitKey}" is not a unit of this medicine` };
  }
  if (!isPositiveInteger(unit.multiplier)) {
    return {
      ok: false,
      error: `${unit.name} has an invalid conversion (${unit.multiplier})`,
    };
  }

  const baseUnits = unit.multiplier * quantity;
  if (!Number.isSafeInteger(baseUnits)) {
    return { ok: false, error: 'That quantity is too large to track in base units' };
  }

  return {
    ok: true,
    amount: {
      unitKey: unit.key,
      unitName: unit.name,
      quantity,
      baseUnitsPerUnit: unit.multiplier,
      baseUnits,
    },
  };
}

/**
 * Canonical base units → the largest whole units that fit, largest first.
 *
 * Greedy and therefore a *presentation* concern: 498 base units with factors
 * 1 / 10 / 100 reads as 4 boxes, 9 cards, 8 pieces. The remainder is always
 * carried down, so the parts always sum back to the original total exactly.
 */
export function convertFromBaseUnits(
  units: readonly TradeUnit[],
  baseUnits: number,
): UnitAmount[] {
  if (!Number.isFinite(baseUnits)) return [];

  const usable = units.filter((unit) => isPositiveInteger(unit.multiplier));
  const descending = [...usable].sort((a, b) => b.multiplier - a.multiplier);

  const parts: UnitAmount[] = [];
  let remainder = Math.max(0, Math.trunc(baseUnits));

  for (const unit of descending) {
    const quantity = Math.floor(remainder / unit.multiplier);
    if (quantity <= 0) continue;
    remainder -= quantity * unit.multiplier;
    parts.push({
      unitKey: unit.key,
      unitName: unit.name,
      quantity,
      baseUnitsPerUnit: unit.multiplier,
      baseUnits: quantity * unit.multiplier,
    });
  }

  // A hierarchy with no base unit cannot represent the remainder. Saying so is
  // better than silently reporting a smaller total than is actually on hand.
  if (remainder > 0) {
    const base = findBaseUnit(usable);
    if (!base) {
      throw new Error(
        `${remainder} base units cannot be expressed: no unit converts to 1 base unit`,
      );
    }
    parts.push({
      unitKey: base.key,
      unitName: base.name,
      quantity: remainder,
      baseUnitsPerUnit: 1,
      baseUnits: remainder,
    });
  }

  return parts;
}

/**
 * "4 Boxes · 9 Cards · 8 Pieces" for a canonical base-unit count.
 *
 * Read-only. Nothing here can change what is in stock; it is the same number
 * written a way a pharmacist would say it out loud.
 */
export function formatStockQuantity(
  units: readonly TradeUnit[],
  baseUnits: number,
  options: { separator?: string; fallback?: string } = {},
): string {
  const { separator = ' · ', fallback = '0' } = options;

  if (!Number.isFinite(baseUnits) || baseUnits <= 0) return fallback;

  let parts: UnitAmount[];
  try {
    parts = convertFromBaseUnits(units, baseUnits);
  } catch {
    return fallback;
  }

  if (parts.length === 0) return fallback;

  // `4 × Box (100)` rather than "4 Boxes": unit names legitimately carry their
  // own count ("Bottle (100ml)", "Card (10)"), and no pluralisation rule
  // survives those — "Bottle (100ml)s" is worse than no plural at all. The
  // multiplication form is unambiguous and never grammatically wrong.
  return parts.map((part) => `${part.quantity} × ${part.unitName}`).join(separator);
}

/* -------------------------------------------------------------------- money */

/**
 * Selling price for one of `unitKey`, as configured by the owner.
 *
 * Deliberately **not** derived from the base price. A pharmacy sells a box for
 * whatever a box costs them; charging exactly 100x the tablet price is a
 * decision, not an identity.
 */
export function calculateUnitPrice(
  medicine: Medicine,
  unitKey: string,
): number | null {
  const unit = findUnit(medicine.units, unitKey);
  if (!unit) return null;
  if (!Number.isFinite(unit.sellingPrice) || unit.sellingPrice < 0) return null;
  return unit.sellingPrice;
}

/**
 * What one of `unitKey` cost the pharmacy: base cost × conversion.
 *
 * `null` when cost is unavailable, which for any attendant is always. Cost is
 * owner-only in the database and is genuinely absent rather than zero — see the
 * cost-absence rule in `docs/PHASE-0-DATA-MIGRATION.md` §3.1. Substituting 0
 * would report a box as free to buy.
 */
export function calculateUnitCost(
  medicine: Medicine,
  unitKey: string,
): number | null {
  const unit = findUnit(medicine.units, unitKey);
  if (!unit) return null;
  if (typeof medicine.costPerBaseUnit !== 'number') return null;
  return multiply(medicine.costPerBaseUnit, unit.multiplier);
}

/** Cost of one of `unitKey`, per unit. Same absence rule as `calculateUnitCost`. */
export function calculateUnitMargin(
  medicine: Medicine,
  unitKey: string,
): number | null {
  const price = calculateUnitPrice(medicine, unitKey);
  if (price === null) return null;
  const cost = calculateUnitCost(medicine, unitKey);
  if (cost === null) return null;
  return subtract(price, cost);
}
