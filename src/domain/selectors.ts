import type { AppState } from './state';
import { EXPIRY_WARNING_DAYS, type ExpiryBucket, type Medicine, type ReorderSuggestion, type Sale, type SaleSummary, type StockStatus } from './types';
import { add, daysUntil, money, multiply, percentOf, subtract, sum } from './money';

/* ------------------------------------------------------------- stock status */

/** Batches that are usable: not recalled, not past expiry. */
export function liveBatches(medicine: Medicine) {
  return medicine.batches.filter(
    (batch) => !batch.isRecalled && daysUntil(batch.expiryDate) >= 0,
  );
}

/** Stock a pharmacist could actually sell right now. */
export function sellableQuantity(medicine: Medicine): number {
  return sum(liveBatches(medicine).map((batch) => batch.quantity));
}

/**
 * The single definition of a medicine's stock state. Every screen reads this
 * rather than re-deriving it — v2 recomputed status in each screen, which is
 * how "expired" and "in stock" could disagree between the POS and the list.
 *
 * Order matters: a hard block outranks a soft warning.
 */
export function stockStatus(medicine: Medicine): StockStatus {
  const sellable = sellableQuantity(medicine);

  if (medicine.batches.length > 0 && sellable === 0) return 'expired';
  if (sellable === 0) return 'out_of_stock';
  if (daysUntil(medicine.expiryDate) < 0) return 'expired';
  if (daysUntil(medicine.expiryDate) <= EXPIRY_WARNING_DAYS) return 'expiring_soon';
  if (sellable <= medicine.lowStockThreshold) return 'low_stock';
  return 'in_stock';
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
};

/**
 * Can this medicine be sold at all? Three independent reasons to say no:
 * a safety lock, a product-level expiry, or no live batches.
 */
export function saleBlock(medicine: Medicine): string | null {
  if (medicine.doNotSell.active) {
    return medicine.doNotSell.reason ?? 'Locked from sale';
  }
  if (daysUntil(medicine.expiryDate) < 0) return 'Past expiry date';
  if (sellableQuantity(medicine) === 0) return 'No sellable stock';
  return null;
}

export function canSell(medicine: Medicine): boolean {
  return saleBlock(medicine) === null;
}

/* -------------------------------------------------------------- unit history */

/**
 * Unit keys this medicine has already been transacted in.
 *
 * A unit that has appeared on a sale line or a stock receipt is part of the
 * historical record, and both snapshot `unit_key` and `unit_multiplier` — so the
 * past does not need the current configuration to stay readable. What it does
 * need is for the configuration not to *claim* something different: retyping a
 * box from 100 to 120 pieces would make every old receipt say "5 boxes" and mean
 * 600. History is never rewritten to accommodate that.
 *
 * The UI reads this to explain why a control is locked rather than letting the
 * owner discover it by being refused on save.
 *
 * Takes only the two slices it reads rather than the whole `AppState`, so a
 * caller holding just those does not have to fabricate a full store.
 */
export function unitsUsedInHistory(
  history: Pick<AppState, 'sales' | 'stockReceipts'>,
  medicineId: string,
): Set<string> {
  const used = new Set<string>();

  for (const sale of history.sales) {
    for (const item of sale.items) {
      if (item.medicineId === medicineId) used.add(item.unitKey);
    }
  }

  for (const receipt of history.stockReceipts) {
    if (receipt.medicineId !== medicineId) continue;
    // Receipts predating the unit-audit columns carry no key. They were counted
    // in base units, which is the base unit's own key — never removable anyway.
    if (receipt.receivedUnitKey !== undefined) used.add(receipt.receivedUnitKey);
  }

  return used;
}

/* ------------------------------------------------------------------ margins */

/**
 * Whether this medicine's purchase cost is known to this session.
 *
 * The single guard every cost calculation must pass first. Cost is owner-only in
 * the database, so an assistant's `Medicine` has no `costPerBaseUnit` at all.
 * Everything below returns `null` rather than 0 in that case, because 0 would be
 * indistinguishable from a genuinely free product and would flow straight into a
 * margin report as a confident wrong number.
 */
export function hasCost(medicine: Medicine): medicine is Medicine & { costPerBaseUnit: number } {
  return typeof medicine.costPerBaseUnit === 'number';
}

/**
 * Margin per base unit, or null when cost is unavailable.
 *
 * null, not 0: "we cannot tell you" and "this item has no margin" are different
 * answers, and an owner needs to be able to tell them apart.
 */
export function unitMargin(medicine: Medicine & { costPerBaseUnit: number }): number;
export function unitMargin(medicine: Medicine): number | null;
export function unitMargin(medicine: Medicine): number | null {
  if (!hasCost(medicine)) return null;
  return subtract(medicine.pricePerBaseUnit, medicine.costPerBaseUnit);
}

export function marginPercent(medicine: Medicine & { costPerBaseUnit: number }): number;
export function marginPercent(medicine: Medicine): number | null;
export function marginPercent(medicine: Medicine): number | null {
  if (!hasCost(medicine)) return null;
  return percentOf(
    subtract(medicine.pricePerBaseUnit, medicine.costPerBaseUnit),
    medicine.pricePerBaseUnit,
  );
}

/** Stock value at cost, or null when cost is unavailable. */
export function stockValue(medicine: Medicine & { costPerBaseUnit: number }): number;
export function stockValue(medicine: Medicine): number | null;
export function stockValue(medicine: Medicine): number | null {
  if (!hasCost(medicine)) return null;
  return multiply(medicine.costPerBaseUnit, medicine.totalQuantity);
}

export function retailValue(medicine: Medicine): number {
  return multiply(medicine.pricePerBaseUnit, medicine.totalQuantity);
}

/**
 * Total stock value at cost across the catalogue, or null if any product's cost is
 * unknown to this session.
 *
 * Null rather than a partial total on purpose. A figure that quietly omitted the
 * unpriced rows would understate what the pharmacy has tied up in stock, and an
 * owner acting on it would be wrong by an unknown amount with no way to tell.
 */
export function portfolioValue(medicines: Medicine[]): number | null {
  const values: number[] = [];
  for (const medicine of medicines) {
    if (!hasCost(medicine)) return null;
    values.push(multiply(medicine.costPerBaseUnit, medicine.totalQuantity));
  }
  return sum(values);
}

/**
 * True when every medicine carries cost, so a portfolio total is trustworthy.
 *
 * `every` rather than `some`: a single unpriced product makes the whole total
 * untrustworthy, so "some are known" is not good enough.
 */
export function allCostsKnown(medicines: Medicine[]): boolean {
  return medicines.every(hasCost);
}

export function portfolioRetail(medicines: Medicine[]): number {
  return sum(medicines.map(retailValue));
}

/* ------------------------------------------------------------------ expiry */

/** Anything past date, or inside the warning window, most urgent first. */
export function expiryBuckets(medicines: Medicine[]): ExpiryBucket[] {
  return medicines
    .map((medicine) => ({
      medicine,
      daysRemaining: daysUntil(medicine.expiryDate),
      quantity: medicine.totalQuantity,
      valueAtCost: stockValue(medicine),
    }))
    .filter((bucket) => bucket.daysRemaining <= EXPIRY_WARNING_DAYS)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Value of everything expiring, at cost.
 *
 * Null when any bucket lacks cost, rather than summing whatever happens to be
 * known. A partial total labelled as a total is how an owner understates their
 * exposure; returning null lets the caller say "cost unavailable" instead.
 */
export function expiringValue(medicines: Medicine[]): number | null {
  const values: number[] = [];
  for (const bucket of expiryBuckets(medicines)) {
    if (bucket.valueAtCost === null) return null;
    values.push(bucket.valueAtCost);
  }
  return sum(values);
}

/* ----------------------------------------------------------------- reorder */

/**
 * Reorder suggestions.
 *
 * The lead-time cover is the honest number: `daysOfStock - supplierLeadTime`
 * is when the shelf actually empties, not when stock hits zero. v2 reported
 * days-until-stockout, which reads as comfortable when the supplier cannot
 * deliver in time.
 */
export function reorderSuggestions(
  medicines: Medicine[],
  suppliers: AppState['suppliers'],
): ReorderSuggestion[] {
  return medicines
    .map((medicine) => {
      const daily = medicine.averageDailySales;
      if (daily <= 0) return null;

      const sellable = sellableQuantity(medicine);
      const daysOfStock = sellable / daily;
      const leadTime =
        suppliers.find((supplier) => supplier.id === medicine.supplier)?.leadTimeDays ?? 3;

      // Target roughly one month of cover, rounded up to the nearest 50 units.
      const target = Math.ceil((daily * 30) / 50) * 50;
      const recommendedQuantity = Math.max(0, target - sellable);
      const daysUntilStockout = daysOfStock - leadTime;

      let priority: ReorderSuggestion['priority'] = 'watch';
      if (sellable === 0) priority = 'urgent';
      else if (daysUntilStockout <= 0) priority = 'urgent';
      else if (daysUntilStockout <= leadTime) priority = 'soon';
      else if (daysOfStock > daily * 90) priority = 'overstock';

      // Overstock is a problem but the opposite one, so it never displaces
      // a real shortage in the same list.
      if (recommendedQuantity === 0) priority = 'overstock';

      const supplier = suppliers.find((s) => s.id === medicine.supplier);

      return {
        medicine,
        priority,
        daysUntilStockout: Math.round(daysUntilStockout),
        recommendedQuantity,
        // What restocking costs. Null when this session cannot read cost — the
        // reorder *quantity* is still correct, only its price is unknown, so the
        // row is kept rather than dropped.
        estimatedCost: hasCost(medicine)
          ? multiply(medicine.costPerBaseUnit, recommendedQuantity)
          : null,
        reason: buildReason(priority, daysUntilStockout, leadTime, daily),
      } satisfies ReorderSuggestion;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => {
      const rank = { urgent: 0, soon: 1, watch: 2, overstock: 3 } as const;
      return rank[a.priority] - rank[b.priority] || a.daysUntilStockout - b.daysUntilStockout;
    });
}

function buildReason(
  priority: ReorderSuggestion['priority'],
  days: number,
  leadTime: number,
  daily: number,
): string {
  switch (priority) {
    case 'urgent':
      return days <= 0
        ? `Out of cover in ${Math.abs(days)} days — supplier lead time is ${leadTime} days.`
        : 'No stock left.';
    case 'soon':
      return `${Math.round(days)} days of cover left after a ${leadTime}-day lead time.`;
    case 'overstock':
      return `Over ${Math.round(90 / Math.max(daily, 0.01) / 1)} days of cover. Selling ${daily}/day.`;
    default:
      return `Selling ${daily} a day, ${leadTime}-day lead time.`;
  }
}

/* -------------------------------------------------------------------- sales */

/**
 * What a sale cost the pharmacy.
 *
 * Null when any line has no cost snapshot. A snapshot is missing whenever the
 * attendant who rang it up could not read cost — which, now that cost is
 * owner-only in the database, is most sales. Summing the known lines would
 * report a *lower* cost and therefore a *higher* margin, so the honest answer is
 * that the cost of this sale is not known from the client.
 */
export function saleCost(sale: Sale): number | null {
  const values: number[] = [];
  for (const item of sale.items) {
    if (typeof item.costPerBaseUnitSnapshot !== 'number') return null;
    values.push(multiply(item.costPerBaseUnitSnapshot, item.baseUnitsTotal));
  }
  return sum(values);
}

/**
 * Summarises sales.
 *
 * `cost`, `margin` and `marginPercent` are null when the cost of any counted sale
 * is unknown. `gross`, `discount`, `net` and `outstanding` never depend on cost
 * and are always real — revenue is not a secret. That distinction is the whole
 * point of splitting them: an assistant can be shown takings without being shown
 * what the stock cost.
 */
export function summariseSales(sales: Sale[]): SaleSummary {
  const counted = sales.filter((sale) => sale.status !== 'voided');
  const gross = sum(counted.map((sale) => sale.subtotal));
  const discount = sum(counted.map((sale) => sale.discount));
  const net = sum(counted.map((sale) => sale.total));
  const outstanding = sum(
    counted
      .filter((sale) => sale.status === 'credit' || sale.status === 'part_paid')
      .map((sale) => sale.outstandingBalance),
  );

  const costs = counted.map(saleCost);
  const costKnown = costs.every((value): value is number => value !== null);
  const cost = costKnown ? sum(costs) : null;
  const profit = cost === null ? null : subtract(net, cost);

  return {
    count: counted.length,
    gross,
    discount,
    net,
    cost,
    margin: profit,
    marginPercent: profit === null ? null : percentOf(profit, net),
    outstanding,
  };
}

export function salesSince(sales: Sale[], hours: number): Sale[] {
  const cutoff = Date.now() - hours * 3_600_000;
  return sales.filter((sale) => Date.parse(sale.date) >= cutoff);
}

/** Counts sales per day for the last `days`, oldest first. */
export function dailyRevenue(sales: Sale[], days = 7): { date: string; value: number }[] {
  const buckets = new Map<string, number>();

  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    buckets.set(day, 0);
  }

  for (const sale of sales) {
    if (sale.status === 'voided') continue;
    const day = sale.date.slice(0, 10);
    const bucket = buckets.get(day);
    if (bucket !== undefined) {
      buckets.set(day, money(bucket + sale.total));
    }
  }

  return Array.from(buckets, ([date, value]) => ({ date, value }));
}

/* ---------------------------------------------------------------- searching */

/**
 * Ranks medicines against a free-text query. Exact name beats a prefix, which
 * beats a generic match — searching "coartem" should not surface paracetamol
 * because both contain the letter sequence somewhere.
 */
export function searchMedicines(medicines: Medicine[], query: string): Medicine[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return medicines;

  const scored: { medicine: Medicine; score: number }[] = [];

  for (const medicine of medicines) {
    const name = medicine.name.toLowerCase();
    const generic = medicine.genericName.toLowerCase();
    const strength = medicine.strength.toLowerCase();
    const barcode = medicine.barcode?.toLowerCase() ?? '';

    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 80;
    else if (name.includes(needle)) score = 60;
    else if (generic.startsWith(needle)) score = 55;
    else if (generic.includes(needle)) score = 40;
    else if (strength.includes(needle)) score = 30;
    else if (barcode.includes(needle)) score = 70;
    else if (medicine.category.toLowerCase().includes(needle)) score = 20;

    if (score > 0) scored.push({ medicine, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.medicine.name.localeCompare(b.medicine.name))
    .map((entry) => entry.medicine);
}

/* ----------------------------------------------------------- dashboard tiles */

export interface DashboardSnapshot {
  todayRevenue: number;
  todayTransactions: number;
  /**
   * Margin on today's takings, or null when the cost of any sale is unknown.
   * Revenue is always knowable; cost is owner-only, so margin is not.
   */
  todayMargin: number | null;
  stockCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  /** Value at risk from expiring stock, or null when this session cannot read cost. */
  expiringValueAtCost: number | null;
  expiringCount: number;
  pendingPricing: number;
  outstandingCredit: number;
  openRequests: number;
  unreadNotifications: number;
  topSellers: { medicine: Medicine; sold: number; revenue: number }[];
}

export function dashboardSnapshot(state: AppState): DashboardSnapshot {
  const todaySales = salesSince(state.sales, 24);
  const today = summariseSales(todaySales);
  const statuses = state.medicines.map(stockStatus);

  const soldByMedicine = new Map<string, { sold: number; revenue: number }>();
  for (const sale of todaySales) {
    if (sale.status === 'voided') continue;
    for (const item of sale.items) {
      const entry = soldByMedicine.get(item.medicineId) ?? { sold: 0, revenue: 0 };
      entry.sold += item.quantity;
      entry.revenue = money(entry.revenue + item.lineTotal);
      soldByMedicine.set(item.medicineId, entry);
    }
  }

  const topSellers = Array.from(soldByMedicine.entries())
    .map(([medicineId, stats]) => {
      const medicine = state.medicines.find((m) => m.id === medicineId);
      return medicine ? { medicine, ...stats } : null;
    })
    .filter((entry): entry is { medicine: Medicine; sold: number; revenue: number } => entry !== null)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return {
    todayRevenue: today.net,
    todayTransactions: today.count,
    todayMargin: today.margin,
    stockCount: state.medicines.length,
    lowStockCount: statuses.filter((s) => s === 'low_stock').length,
    outOfStockCount: statuses.filter((s) => s === 'out_of_stock').length,
    expiringValueAtCost: expiringValue(state.medicines),
    expiringCount: expiryBuckets(state.medicines).length,
    pendingPricing: state.stockReceipts.filter((r) => r.status === 'pending_pricing').length,
    outstandingCredit: add(
      sum(state.creditAccounts.map((account) => account.outstandingBalance)),
      sum(state.customers.map((customer) => customer.outstandingDebt)),
    ),
    openRequests: state.medicineRequests.filter((r) => r.status === 'pending_restock').length,
    unreadNotifications: state.notifications.filter((n) => !n.read).length,
    topSellers,
  };
}
