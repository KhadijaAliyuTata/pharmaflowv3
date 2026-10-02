import type { LucideIcon } from 'lucide-react';
import { Bell, House, Package, Search, User } from 'lucide-react';
import { usePharmacy } from '~/store/pharmacy';
import type { Branch } from '~/domain/state';
import type { Customer, Medicine, Sale, StockStatus } from '~/domain/types';
import { sellableQuantity, stockStatus } from '~/domain/selectors';
import { daysUntil, isoDate } from '~/domain/money';

/**
 * Everything the customer half of the app derives that the staff half does not.
 *
 * Two things are deliberately absent and must not be faked:
 *
 *   1. Authentication. There is no session, no customer login, no phone OTP.
 *      `usePortalCustomer` returns the first record in `state.customers` so the
 *      portal has something real to read, and every screen says plainly that
 *      per-customer sign-in is not built. Real auth would replace this one
 *      function and nothing else.
 *
 *   2. Multi-branch availability. `state` holds exactly one branch, so the
 *      availability list has exactly one entry. It is derived from real stock
 *      rather than padded out with invented pharmacies.
 */

/* -------------------------------------------------------------------- nav */

export interface PortalNavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

/**
 * The portal's URL scheme: everything under `/portal/*`.
 *
 * The staff app already owns `/`, `/orders` and `/settings`, so the customer
 * shell cannot be pathless-and-unprefixed without colliding with them. A
 * distinct prefix is the only scheme that cannot. `src/lib/nav.ts` stays
 * staff-only, so these items never reach the staff sidebar or ⌘K.
 */
export const PORTAL_NAV: PortalNavItem[] = [
  { label: 'Home', to: '/portal', icon: House },
  { label: 'Search', to: '/portal/search', icon: Search },
  { label: 'Orders', to: '/portal/orders', icon: Package },
  { label: 'Reminders', to: '/portal/reminders', icon: Bell },
  { label: 'Profile', to: '/portal/profile', icon: User },
];

export function portalNavItem(pathname: string): PortalNavItem | undefined {
  return PORTAL_NAV.find((item) => item.to === pathname);
}

/* ---------------------------------------------------------------- customer */

/**
 * The customer the portal is showing.
 *
 * NOT AUTH. There is no sign-in. This reads `state.customers[0]` so the portal
 * renders real records; every screen states that per-customer authentication
 * is not built. Do not present anything here as "your account is verified".
 */
export function usePortalCustomer(): Customer | null {
  return usePharmacy((state) => state.customers[0] ?? null);
}

/* ------------------------------------------------------------- availability */

export interface BranchAvailability {
  branch: Branch;
  status: StockStatus;
  /** Base units the shelf can actually sell. */
  sellable: number;
}

/**
 * Where a medicine can be collected, from real branch records.
 *
 * One branch exists in the state today, so this returns one row. It is written
 * as a list because that is the honest shape once a second branch is seeded —
 * adding data needs no code change.
 */
export function availabilityFor(medicine: Medicine, branch: Branch): BranchAvailability[] {
  return [
    {
      branch,
      status: stockStatus(medicine),
      sellable: sellableQuantity(medicine),
    },
  ];
}

/* ------------------------------------------------------------------ refills */

export interface RefillRow {
  medicine: Medicine;
  /** ISO timestamp of the last non-voided sale of this to this customer. */
  lastDispensedAt: string | null;
  daysSinceDispensed: number | null;
  /** Whole days of cover left at the medicine's recorded average daily rate. */
  daysOfCover: number;
  /** ISO date the shelf is projected to empty. */
  estimatedRefillDate: string;
  /** Countdown to that date, straight from `daysUntil`. */
  daysUntilRefill: number;
  status: StockStatus;
}

/**
 * The most recent non-voided, non-refunded sale of `medicineId` to this
 * customer. Null when the pharmacy has no record of dispensing it to them,
 * which the reminders screen says rather than guessing a date.
 */
export function lastDispensedAt(
  customerId: string,
  medicineId: string,
  sales: Sale[],
): string | null {
  let latest: string | null = null;

  for (const sale of sales) {
    if (sale.customerId !== customerId) continue;
    if (sale.status === 'voided' || sale.status === 'refunded') continue;
    if (!sale.items.some((item) => item.medicineId === medicineId)) continue;
    if (latest === null || sale.date > latest) latest = sale.date;
  }

  return latest;
}

/**
 * Refill estimates for a customer's chronic medications, most urgent first.
 *
 * The estimate is shelf cover, not a dosing schedule: `sellable / averageDaily
 * Sales` gives the days until the branch runs out at its own recorded rate.
 * A customer cannot be told when *they* should reorder from stock data alone,
 * and this app does not pretend to.
 */
export function refillRows(
  customer: Customer,
  medicines: Medicine[],
  sales: Sale[],
): RefillRow[] {
  const rows: RefillRow[] = [];

  for (const medicineId of customer.chronicMedications) {
    const medicine = medicines.find((entry) => entry.id === medicineId);
    if (!medicine) continue;

    const daily = medicine.averageDailySales;
    const sellable = sellableQuantity(medicine);
    const daysOfCover = daily > 0 ? Math.floor(sellable / daily) : 0;
    const estimatedRefillDate = isoDate(new Date(Date.now() + daysOfCover * 86_400_000));
    const dispensed = lastDispensedAt(customer.id, medicine.id, sales);

    rows.push({
      medicine,
      lastDispensedAt: dispensed,
      daysSinceDispensed: dispensed === null ? null : -daysUntil(dispensed.slice(0, 10)),
      daysOfCover,
      estimatedRefillDate,
      daysUntilRefill: daysUntil(estimatedRefillDate),
      status: stockStatus(medicine),
    });
  }

  const rank: Record<StockStatus, number> = {
    out_of_stock: 0,
    expired: 0,
    low_stock: 1,
    expiring_soon: 2,
    in_stock: 3,
  };

  return rows.sort(
    (a, b) => rank[a.status] - rank[b.status] || a.daysUntilRefill - b.daysUntilRefill,
  );
}
