import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  BarChart3,
  Bell,
  Building2,
  ClipboardList,
  Coins,
  CreditCard,
  FileText,
  LayoutDashboard,
  Package,
  Pill,
  Radio,
  Receipt,
  ScanBarcode,
  Settings,
  ShoppingCart,
  Sparkles,
  Stethoscope,
  Truck,
  Users,
} from 'lucide-react';

/**
 * `Role` is re-exported from the domain rather than redeclared. This file used
 * to carry its own copy of the union, which is only a problem until a third
 * role lands and the two drift apart. Every consumer that imported it from
 * here still works.
 */
import type { Role } from '~/domain/types';
import { isDemoMode } from '~/lib/build-mode';

export type { Role };

export type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Omit for screens every role can open. */
  roles?: Role[];
  /** Rendered as a count pill in the sidebar and listed first in ⌘K. */
  badge?: number;
  /** Words ⌘K should match beyond the label. */
  keywords?: string[];
  /**
   * Withheld from the sidebar and ⌘K in a live build.
   *
   * The route itself still exists and renders a `PilotNotice`, so a bookmark or
   * a typed URL gets a sentence rather than a redirect — this flag only keeps the
   * link out of navigation, where an entry that leads to "not part of this pilot"
   * is worse than no entry at all. Ignored in demo mode, where the seeded screens
   * behind these items do work.
   */
  pilotHidden?: true;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

/**
 * The only place navigation is declared.
 *
 * The sidebar, the ⌘K palette and the breadcrumb all read from here, so
 * adding a screen is a one-line change. v2 kept this in three places — a nav
 * array, a 22-entry `breadcrumbMap`, and a separate route union — which is how
 * they drifted apart.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Counter',
    items: [
      {
        label: 'Dashboard',
        // The app dashboard moved off `/` when the public landing page took
        // that URL. Every other reference to the old path follows this one.
        to: '/dashboard',
        icon: LayoutDashboard,
        keywords: ['home', 'overview', 'summary'],
      },
      {
        label: 'Point of Sale',
        to: '/pos',
        icon: ShoppingCart,
        keywords: ['pos', 'sale', 'checkout', 'billing', 'receipt', 'cashier'],
      },
      {
        label: 'Stock Receiving',
        to: '/stock-receiving',
        icon: ScanBarcode,
        roles: ['owner', 'assistant'],
        keywords: ['receive', 'delivery', 'inbound', 'barcode', 'scan'],
      },
    ],
  },
  {
    label: 'Inventory',
    items: [
      {
        label: 'Products',
        to: '/inventory',
        icon: Package,
        keywords: ['stock', 'medicine', 'product', 'catalog', 'items'],
      },
      {
        label: 'Online Orders',
        to: '/orders',
        icon: ClipboardList,
        keywords: ['orders', 'delivery', 'ecommerce'],
        pilotHidden: true,
      },
      {
        label: 'Pricing',
        to: '/pricing',
        icon: CreditCard,
        keywords: ['price', 'cost', 'margin'],
        pilotHidden: true,
      },
      {
        label: 'Expiry',
        to: '/expiry',
        icon: Activity,
        keywords: ['expiry', 'expiration', 'expiring', 'shelf life'],
      },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      {
        label: 'Stock Intelligence',
        to: '/stock-intelligence',
        icon: BarChart3,
        keywords: ['forecast', 'demand', 'analytics', 'reorder'],
        pilotHidden: true,
      },
      {
        label: 'Demand Radar',
        to: '/demand-radar',
        icon: Radio,
        keywords: ['demand', 'request', 'unmet', 'restock', 'wanted'],
        pilotHidden: true,
      },
      {
        label: 'Medicine Info',
        to: '/medicine-info',
        icon: Pill,
        keywords: ['drug', 'nafdac', 'interaction', 'dosage', 'verify'],
      },
    ],
  },
  {
    label: 'Business',
    items: [
      {
        label: 'Customers',
        to: '/customers',
        icon: Users,
        keywords: ['customer', 'patient', 'client'],
      },
      {
        label: 'Credit Accounts',
        to: '/credit-accounts',
        icon: CreditCard,
        roles: ['owner'],
        keywords: ['credit', 'debt', 'repayment', 'owe'],
        pilotHidden: true,
      },
      {
        label: 'Suppliers',
        to: '/suppliers',
        icon: Truck,
        roles: ['owner'],
        keywords: ['supplier', 'vendor', 'distributor'],
      },
      {
        label: 'Staff & Audit',
        to: '/staff',
        icon: Stethoscope,
        roles: ['owner'],
        keywords: ['staff', 'employee', 'audit', 'log', 'permission'],
      },
      {
        label: 'Sales Ledger',
        to: '/sales',
        icon: Receipt,
        keywords: ['sales', 'transaction', 'receipt', 'today', 'ledger'],
      },
      {
        label: 'Stock Value',
        to: '/stock-value',
        icon: Coins,
        keywords: ['stock value', 'valuation', 'inventory value', 'worth', 'cost'],
      },
      {
        label: 'Reports',
        to: '/reports',
        icon: FileText,
        keywords: ['report', 'sales', 'export', 'profit', 'revenue', 'gross'],
        pilotHidden: true,
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        label: 'Notifications',
        to: '/notifications',
        icon: Bell,
        keywords: ['alert', 'notification', 'inbox'],
      },
      {
        label: 'Settings',
        to: '/settings',
        icon: Settings,
        keywords: ['settings', 'preferences', 'configuration', 'printer'],
      },
    ],
  },
];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  assistant: 'Assistant',
};

/** Icons used by the header, kept beside the nav icons for consistency. */
export const HEADER_ICONS = {
  branch: Building2,
  sparkles: Sparkles,
} as const;

export function sectionsForRole(role: Role): NavSection[] {
  // A live build hides the items whose screens are withheld (see `pilotHidden`);
  // demo mode keeps them, because there the screens render. Sections left with no
  // items are dropped so the sidebar does not print a heading over nothing.
  const live = !isDemoMode();

  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => (!item.roles || item.roles.includes(role)) && !(live && item.pilotHidden),
    ),
  })).filter((section) => section.items.length > 0);
}

/** Flat list for ⌘K, filtered the same way. */
export function itemsForRole(role: Role): NavItem[] {
  return sectionsForRole(role).flatMap((section) => section.items);
}

export function findNavItem(to: string): NavItem | undefined {
  return NAV_SECTIONS.flatMap((section) => section.items).find((item) => item.to === to);
}

/* ------------------------------------------------------------------- brand */

/**
 * What the sidebar header shows. Only reachable from inside `_app`, which is
 * session-guarded, so these are never rendered signed out — the sidebar is
 * simply not on the page. Kept here so the brand has one home, next to the
 * nav that leads away from it.
 */
export const BRAND = {
  mark: 'PF',
  name: 'PharmaFlow',
  /** Rendered as the primary action in the header. */
  newSaleLabel: 'New Sale',
  newSaleTo: '/pos',
} as const;
