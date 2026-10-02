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

/* ------------------------------------------------------------------ margins */

export function unitMargin(medicine: Medicine) {
  return subtract(medicine.pricePerBaseUnit, medicine.costPerBaseUnit);
}

export function marginPercent(medicine: Medicine): number {
  return percentOf(unitMargin(medicine), medicine.pricePerBaseUnit);
}

export function stockValue(medicine: Medicine): number {
  return multiply(medicine.costPerBaseUnit, medicine.totalQuantity);
}

export function retailValue(medicine: Medicine): number {
  return multiply(medicine.pricePerBaseUnit, medicine.totalQuantity);
}

export function portfolioValue(medicines: Medicine[]): number {
  return sum(medicines.map(stockValue));
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

export function expiringValue(medicines: Medicine[]): number {
  return sum(expiryBuckets(medicines).map((bucket) => bucket.valueAtCost));
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
        estimatedCost: multiply(medicine.costPerBaseUnit, recommendedQuantity),
        reason: buildReason(priority, daysUntilStockout, leadTime, daily),
      } satisfies ReorderSuggestion & { supplierName?: string } & Record<string, unknown>;
    })
    .filter((item): item is ReorderSuggestion => item !== null)
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

export function saleCost(sale: Sale): number {
  return sum(
    sale.items.map((item) => multiply(item.costPerBaseUnitSnapshot, item.baseUnitsTotal)),
  );
}

/** Summarises sales. v2 recalculated this in four different components. */
export function summariseSales(sales: Sale[]): SaleSummary {
  const counted = sales.filter((sale) => sale.status !== 'voided');
  const gross = sum(counted.map((sale) => sale.subtotal));
  const discount = sum(counted.map((sale) => sale.discount));
  const net = sum(counted.map((sale) => sale.total));
  const cost = sum(counted.map(saleCost));
  const profit = subtract(net, cost);
  const outstanding = sum(
    counted
      .filter((sale) => sale.status === 'credit' || sale.status === 'part_paid')
      .map((sale) => sale.outstandingBalance),
  );

  return {
    count: counted.length,
    gross,
    discount,
    net,
    cost,
    margin: profit,
    marginPercent: percentOf(profit, net),
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
  todayMargin: number;
  stockCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  expiringValueAtCost: number;
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
