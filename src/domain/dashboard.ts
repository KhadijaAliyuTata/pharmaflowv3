/**
 * Owner dashboard aggregates.
 *
 * Pure functions over `AppState`. Everything here reads existing domain helpers
 * rather than re-deriving them, so a change to `summariseSales`, to
 * `stockValue`, or to the cost-absence rule moves these too:
 *
 *  - `summariseSales` for revenue, cost of goods and gross profit (already
 *    returns `null` for any cost-derived figure it cannot know);
 *  - `salesSince` for "today";
 *  - `stockValue` / `retailValue` for what a medicine's stock is worth — the same
 *    functions the expiry screen and the dashboard snapshot already use, so the
 *    stock-value view cannot disagree with the rest of the app about what a
 *    product is worth;
 *  - `expiryBuckets` for the expiring-stock summary, so the dashboard count
 *    matches the expiry screen instead of running a second, drifting window.
 *
 * ## The one rule these all obey
 *
 * Purchase cost is owner-only in the database. An assistant's `Medicine` has no
 * `costPerBaseUnit` at all, and the same is true of a `SaleItem` rung up by an
 * attendant. So every cost-derived figure below is `number | null`, and `null`
 * means "not knowable for this session" — never `0`. A stock valuation that
 * quietly priced every tablet at ₦0 would tell an owner their entire shelf is
 * worthless, and an assistant's "potential profit" of the full retail value would
 * be worse still. See `docs/PHASE-0-DATA-MIGRATION.md` §3.1.
 */

import type {
  AuditEvent,
  Medicine,
  MedicineRequest,
  Sale,
  SaleItem,
  User,
} from './types';

/**
 * The only state the sales-side aggregates read.
 *
 * Narrower than `AppState` on purpose: today's sales and today's gross profit
 * are functions of the sale ledger and nothing else. Naming the one field they
 * need means a caller cannot be tempted to pass a wider object, and it documents
 * at the signature that no cost-bearing input is involved.
 */
export type SalesSource = { sales: Sale[] };

/** Stock valuation and expiry both read the catalogue and nothing else. */
export type CatalogueSource = { medicines: Medicine[] };

/** Demand radar reads recorded requests. Nothing is derived from stock. */
export type RequestSource = { medicineRequests: MedicineRequest[] };

/** Team accountability needs the roster and the ledger it is measured against. */
export type TeamSource = { users: User[]; sales: Sale[] };
import {
  expiringValue,
  expiryBuckets,
  hasCost,
  retailValue,
  salesSince,
  stockValue,
  summariseSales,
} from './selectors';
import { findBaseUnit, formatStockQuantity } from './units';
import { formatDate, money, subtract, sum, sumKnown } from './money';

/* ------------------------------------------------------------------ periods */

export type ReportPeriod = 'today' | 'week' | 'month' | 'all';

export const PERIOD_LABEL: Record<ReportPeriod, string> = {
  today: 'Today',
  week: 'Last 7 days',
  month: 'Last 30 days',
  all: 'All time',
};

export const REPORT_PERIODS: ReportPeriod[] = ['today', 'week', 'month', 'all'];

/** Hours of history each period covers. `all` is unbounded. */
const PERIOD_HOURS: Record<Exclude<ReportPeriod, 'all'>, number> = {
  today: 24,
  week: 24 * 7,
  month: 24 * 30,
};

/**
 * Sales in a period, newest first, voided sales excluded.
 *
 * "Today" is a rolling 24 hours because that is what the POS has always counted
 * as today; it is the same definition `dashboardSnapshot` uses, so the dashboard
 * tile and this view can never disagree about the figure.
 */
export function salesInPeriod(sales: Sale[], period: ReportPeriod): Sale[] {
  const scoped =
    period === 'all' ? sales : salesSince(sales, PERIOD_HOURS[period]);
  return scoped
    .filter((sale) => sale.status !== 'voided')
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ------------------------------------------------- A. today's sales detail */

/** One sale line, flattened for the sales table. */
export interface SaleLineRow {
  saleId: string;
  receiptNumber: string;
  medicineId: string;
  product: string;
  /** How many were sold, in the unit the attendant chose. */
  quantity: number;
  unitName: string;
  /** Canonical base units, so the quantity column means one thing across units. */
  baseUnits: number;
  /** The unit's own price at the time of sale — a snapshot, not today's price. */
  unitPrice: number;
  lineTotal: number;
  staffName: string;
  /** Local wall-clock time of the sale. */
  time: string;
  paymentMethod: string;
  /** The whole sale's total, repeated per line for context. */
  saleTotal: number;
  status: string;
}

/**
 * Sale lines for a period, one row per line.
 *
 * Exposes only what a cashier already saw when they rang the sale up. Nothing
 * here reads `costPerBaseUnitSnapshot`, so this view cannot leak cost to an
 * attendant — it is not gated behind a role check, it simply does not carry the
 * field.
 *
 * `period` defaults to `today` for the dashboard card, but takes the same period
 * as the surrounding screen so a ledger filtered to 30 days shows 30 days of
 * lines rather than today's lines under a 30-day total.
 */
export function saleLines(state: SalesSource, period: ReportPeriod = 'today'): SaleLineRow[] {
  const rows: SaleLineRow[] = [];

  for (const sale of salesInPeriod(state.sales, period)) {
    for (const item of sale.items) {
      rows.push(toSaleLineRow(sale, item));
    }
  }

  return rows;
}

function toSaleLineRow(sale: Sale, item: SaleItem): SaleLineRow {
  return {
    saleId: sale.id,
    receiptNumber: sale.receiptNumber,
    medicineId: item.medicineId,
    product: item.medicineName,
    quantity: item.quantity,
    unitName: item.unitName,
    baseUnits: item.baseUnitsTotal,
    unitPrice: item.unitPrice,
    lineTotal: item.lineTotal,
    staffName: sale.attendantName,
    time: localTime(sale.date),
    paymentMethod: sale.paymentMethod,
    saleTotal: sale.total,
    status: sale.status,
  };
}

/** `new Date(iso)` rendered as HH:MM in the viewer's own timezone. */
function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------ B. gross profit today */

export interface GrossProfitToday {
  /** Takings, always knowable — money taken in is not a secret. */
  sales: number;
  /** Cost of goods sold, or null when any sale line has no cost snapshot. */
  costOfGoods: number | null;
  /** `sales - costOfGoods`, or null when cost is unknown. */
  grossProfit: number | null;
  /** Gross margin percent, or null. Never 0-as-a-substitute. */
  grossMarginPercent: number | null;
  transactionCount: number;
  lineCount: number;
}

/**
 * Today's gross profit, from the existing cost logic.
 *
 * Deliberately not `sales - 0`: `summariseSales` already returns `null` when any
 * sale line lacks a cost snapshot, and that null is carried straight through. An
 * attendant's shift produces no cost snapshot, so for a non-owner session this
 * reads "not available" rather than a fabricated profit.
 */
export function grossProfitToday(state: SalesSource): GrossProfitToday {
  const sales = salesInPeriod(state.sales, 'today');
  const summary = summariseSales(sales);

  return {
    sales: summary.net,
    costOfGoods: summary.cost,
    grossProfit: summary.margin,
    grossMarginPercent: summary.marginPercent,
    transactionCount: summary.count,
    lineCount: sales.reduce((total, sale) => total + sale.items.length, 0),
  };
}

/* ------------------------------------------------------- C. stock valuation */

export interface StockValuationRow {
  medicineId: string;
  name: string;
  genericName: string;
  strength: string;
  /** Quantity in stock, in base units. */
  quantity: number;
  /** The base unit's name, so the quantity is never ambiguous. */
  baseUnit: string;
  /** Same quantity broken into packaging, e.g. "2 boxes · 10 tablets". */
  inPackaging: string;
  /** Cost per base unit, or null when this session cannot read cost. */
  costPerBaseUnit: number | null;
  /** Selling price per base unit — always knowable. */
  pricePerBaseUnit: number;
  /** quantity × cost, or null. */
  costValue: number | null;
  /** quantity × price. Always a number. */
  sellingValue: number;
  /** `sellingValue - costValue`, or null. */
  potentialProfit: number | null;
  /** True when cost is unavailable for this row. */
  costUnavailable: boolean;
}

/**
 * Stock valued at CURRENT INVENTORY COST.
 *
 * At cost, not at retail: the question an owner is asking is "what is my money
 * sitting on the shelf worth", and valuing it at selling price would answer a
 * different and more flattering question.
 *
 * The values come from the existing `stockValue` / `retailValue` helpers rather
 * than a fresh multiplication, so this view and the expiry screen can never
 * quote different numbers for the same product.
 *
 * Rows are sorted by cost value where known, then by selling value, so the
 * products actually tying up money come first.
 */
export function stockValuation(state: CatalogueSource): StockValuationRow[] {
  const rows: StockValuationRow[] = [];

  for (const medicine of state.medicines) {
    // Matches the app-wide convention: `stockValue`/`retailValue`/`expiryBuckets`
    // all quantify on `totalQuantity`, so a row here adds up with what the rest
    // of the app already displays.
    if (medicine.totalQuantity <= 0) continue;

    const costValue = stockValue(medicine);
    const sellingValue = retailValue(medicine);
    const baseUnit = findBaseUnit(medicine.units);

    rows.push({
      medicineId: medicine.id,
      name: medicine.name,
      genericName: medicine.genericName,
      strength: medicine.strength,
      quantity: medicine.totalQuantity,
      baseUnit: baseUnit?.name ?? 'unit',
      inPackaging: formatStockQuantity(medicine.units, medicine.totalQuantity, {
        fallback: '—',
      }),
      costPerBaseUnit: hasCost(medicine) ? medicine.costPerBaseUnit : null,
      pricePerBaseUnit: medicine.pricePerBaseUnit,
      costValue,
      sellingValue,
      potentialProfit: costValue === null ? null : subtract(sellingValue, costValue),
      costUnavailable: costValue === null,
    });
  }

  return rows.sort(
    (a, b) =>
      (b.costValue ?? -1) - (a.costValue ?? -1) ||
      b.sellingValue - a.sellingValue ||
      a.name.localeCompare(b.name),
  );
}

export interface StockValuationTotals {
  productCount: number;
  baseUnits: number;
  costValue: number | null;
  sellingValue: number;
  potentialProfit: number | null;
  /** How many rows could not be costed for this session. */
  uncostedCount: number;
}

/**
 * Totals for the stock-value header.
 *
 * `costValue` and `potentialProfit` go through `sumKnown`, so a single product
 * with no readable cost makes the whole total null rather than a partial figure
 * wearing a total's label.
 */
export function stockValuationTotals(rows: StockValuationRow[]): StockValuationTotals {
  return {
    productCount: rows.length,
    baseUnits: rows.reduce((total, row) => total + row.quantity, 0),
    costValue: sumKnown(rows.map((row) => row.costValue)),
    sellingValue: sum(rows.map((row) => row.sellingValue)),
    potentialProfit: sumKnown(rows.map((row) => row.potentialProfit)),
    uncostedCount: rows.filter((row) => row.costUnavailable).length,
  };
}

/* --------------------------------------------------------- D. demand radar */

/**
 * What customers asked for that this pharmacy could not supply.
 *
 * Powered by the existing `medicineRequests` — real recorded requests with a
 * quantity, an urgency and a timestamp. Nothing here is synthesised: if there
 * are no requests, the radar is empty and says so.
 */
export interface DemandRadarRow {
  medicineName: string;
  genericName?: string;
  /** How many times this product has been asked for. */
  requestCount: number;
  /** Units asked for across those requests. */
  unitsRequested: number;
  lastRequestedAt: string;
  lastRequestedLabel: string;
  /** Highest urgency seen, so the owner sees emergencies first. */
  urgency: 'routine' | 'urgent' | 'emergency';
  /** Still waiting to be restocked. */
  open: boolean;
  customerNames: string[];
}

const URGENCY_RANK = { emergency: 3, urgent: 2, routine: 1 } as const;

/**
 * Unmet demand, aggregated per product.
 *
 * `withinDays` bounds the window; requests with an unparseable timestamp are kept
 * rather than dropped, because losing a customer's ask over a bad date is the
 * wrong failure for a restocking signal.
 */
export function demandRadar(state: RequestSource, withinDays = 30): DemandRadarRow[] {
  const cutoff = Date.now() - withinDays * 86_400_000;
  const rows = new Map<string, DemandRadarRow>();

  for (const request of state.medicineRequests) {
    const recorded = Date.parse(request.recordedAt);
    if (Number.isFinite(recorded) && recorded < cutoff) continue;

    const key = request.medicineName.trim().toLowerCase();
    const existing = rows.get(key);

    if (!existing) {
      rows.set(key, {
        medicineName: request.medicineName,
        genericName: request.genericName,
        requestCount: 1,
        unitsRequested: request.quantityRequested,
        lastRequestedAt: request.recordedAt,
        lastRequestedLabel: formatDate(request.recordedAt),
        urgency: request.urgency,
        open: request.status === 'pending_restock',
        customerNames: request.customerName ? [request.customerName] : [],
      });
      continue;
    }

    existing.requestCount += 1;
    existing.unitsRequested += request.quantityRequested;
    existing.open = existing.open || request.status === 'pending_restock';
    if (request.genericName && !existing.genericName) existing.genericName = request.genericName;
    if (URGENCY_RANK[request.urgency] > URGENCY_RANK[existing.urgency]) {
      existing.urgency = request.urgency;
    }
    if (request.customerName && !existing.customerNames.includes(request.customerName)) {
      existing.customerNames.push(request.customerName);
    }
    if (request.recordedAt > existing.lastRequestedAt) {
      existing.lastRequestedAt = request.recordedAt;
      existing.lastRequestedLabel = formatDate(request.recordedAt);
    }
  }

  return [...rows.values()].sort(
    (a, b) =>
      URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] ||
      b.requestCount - a.requestCount ||
      b.unitsRequested - a.unitsRequested,
  );
}

export interface DemandRadarSummary {
  /** Distinct products asked for. */
  productCount: number;
  /** Total recorded requests in the window. */
  requestCount: number;
  unitsRequested: number;
  /** Requests still waiting to be restocked. */
  openCount: number;
  emergencies: number;
}

export function demandRadarSummary(rows: DemandRadarRow[]): DemandRadarSummary {
  return {
    productCount: rows.length,
    requestCount: rows.reduce((total, row) => total + row.requestCount, 0),
    unitsRequested: rows.reduce((total, row) => total + row.unitsRequested, 0),
    openCount: rows.reduce((total, row) => total + (row.open ? row.requestCount : 0), 0),
    emergencies: rows.reduce(
      (total, row) => total + (row.urgency === 'emergency' ? row.requestCount : 0),
      0,
    ),
  };
}

/* ------------------------------------------------------- E. expiring stock */

export interface ExpiringStockSummary {
  /** Products with a batch inside the warning window. */
  productCount: number;
  /** Quantity affected across those products. */
  unitsAffected: number;
  /** Already past date. */
  expiredCount: number;
  /** Inside the critical window. */
  criticalCount: number;
  /** Expiring stock valued at cost, or null when any product lacks cost. */
  valueAtCost: number | null;
}

/**
 * Concise expiring-stock summary for the dashboard.
 *
 * Built on the existing `expiryBuckets` / `expiringValue`, so the count here and
 * the table on the expiry screen are the same calculation. The per-batch detail
 * stays on the expiry screen — duplicating it here is how a dashboard becomes a
 * second, divergent source of truth.
 */
export function expiringStockSummary(state: CatalogueSource): ExpiringStockSummary {
  const buckets = expiryBuckets(state.medicines);

  return {
    productCount: buckets.length,
    unitsAffected: sum(buckets.map((bucket) => bucket.quantity)),
    expiredCount: buckets.filter((bucket) => bucket.daysRemaining < 0).length,
    criticalCount: buckets.filter((bucket) => bucket.daysRemaining >= 0).length,
    valueAtCost: expiringValue(state.medicines),
  };
}

/* ------------------------------------------------------- F. team / staff */

export interface TeamMemberRow {
  userId: string;
  name: string;
  phone: string;
  roleLabel: string;
  /** Takings this member rang up, all time. Voided sales excluded. */
  salesTotal: number;
  transactionCount: number;
  /** Discount value this member authorised, all time. */
  discountTotal: number;
  /** Live access in this store. */
  active: boolean;
}

/**
 * Per-member accountability, for the owner's team view.
 *
 * Reads recorded sales rather than anything an owner could edit about a person,
 * so the numbers are the same ones the audit log already proves. Discounts are
 * summed from the sale records rather than from an audit tally, because a
 * discount that was voided was never given.
 *
 * Sales by someone no longer in `state.users` are skipped rather than inventing a
 * row for them — the audit log still holds the record.
 */
export function teamMembers(state: TeamSource): TeamMemberRow[] {
  const rows = new Map<string, TeamMemberRow>();

  for (const user of state.users) {
    rows.set(user.id, {
      userId: user.id,
      name: user.name,
      phone: user.phone,
      roleLabel: user.role === 'owner' ? 'Owner' : 'Pharmacist / attendant',
      salesTotal: 0,
      transactionCount: 0,
      discountTotal: 0,
      active: true,
    });
  }

  for (const sale of state.sales) {
    if (sale.status === 'voided') continue;
    const row = rows.get(sale.attendantId);
    if (!row) continue;
    row.salesTotal = money(row.salesTotal + sale.total);
    row.transactionCount += 1;
    row.discountTotal = money(row.discountTotal + sale.discount);
  }

  return [...rows.values()].sort(
    (a, b) => b.salesTotal - a.salesTotal || a.name.localeCompare(b.name),
  );
}

/* ------------------------------------------- G. operational activities */

export interface LedgerFilter {
  /** Actor name, or null for everyone. */
  actorName: string | null;
  /** Audit action, or null for every type. */
  action: string | null;
  /** Free-text over the description. */
  query: string;
}

export const EMPTY_LEDGER_FILTER: LedgerFilter = {
  actorName: null,
  action: null,
  query: '',
};

/**
 * The audit ledger, filtered. Newest first.
 *
 * Reads `state.auditEvents` — the single audit record the whole app already
 * writes to. There is deliberately no second log: a second one would be a second
 * answer to "who did what", and the two would drift.
 */
export function operationalActivities(
  events: AuditEvent[],
  filter: LedgerFilter,
): AuditEvent[] {
  const needle = filter.query.trim().toLowerCase();

  return events
    .filter((event) => {
      if (filter.actorName !== null && event.actorName !== filter.actorName) return false;
      if (filter.action !== null && event.action !== filter.action) return false;
      if (needle !== '') {
        const haystack = `${event.actorName} ${event.description}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    })
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Distinct actor names present in the log, for the staff filter. */
export function ledgerActors(events: AuditEvent[]): string[] {
  return [...new Set(events.map((event) => event.actorName))].sort((a, b) =>
    a.localeCompare(b),
  );
}
