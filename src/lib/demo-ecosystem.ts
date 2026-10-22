/**
 * The one fictional ecosystem the four investor demos share.
 *
 * ## Why one module
 *
 * The owner/attendant demos run the real product against `src/domain/seed.ts`
 * (the seeded demo store). The supplier and customer demos are self-contained
 * prototypes with no backend at all - THEY never import the store, so they can
 * neither read nor write real pharmacy data. This module is the small, pure
 * constants file that keeps the second pair consistent with the first: the same
 * pharmacy, the same suppliers, the same medicines, the same customers show up
 * across all four experiences, so an investor sees one ecosystem rather than
 * four unrelated screens.
 *
 * ## Deliberate divergence from the seeded store
 *
 * Wholesale prices and per-pharmacy retail prices below are INVENTED for the
 * prototypes; the seed's `sellingPrice` is the retail anchor the owner and
 * attendant demos display. Nothing here is live data, a real supplier price
 * list, or a real order. Every email is an `example.com` address on purpose:
 * shipped builds carry this file only when the prototypes carry it, and the
 * demo-gate verifier (`verify-auth-modes.ts`) greps built artefacts for the SEEDED
 * staff addresses - these are not them.
 *
 * The owner/attendant demos read the store directly and are gated on
 * `isDemoMode()` (development server + explicit flag). These constants are
 * static data, so the two prototype routes can import them in any build; the
 * routes themselves are properties labelled as prototypes and grant no
 * privileges.
 */

/**
 * The onboarding wait list the customer finder shows: pharmacies joining the
 * network. Each one carries an "onboarding" status and NO prices, stock or
 * address — a customer can find it by name, but cannot place an order through
 * it yet. None of these are live tenants and nothing in the demo claims
 * otherwise.
 *
 * EVERY name here is FICTIONAL and suffixed "(demo)" on purpose. This file
 * ships inside a PUBLIC prototype route in every build, so real onboarding
 * records must never be hard-coded here: the real list belongs in the
 * authenticated platform-admin surface, not in a page anyone can open.
 */
export interface DemoWaitlistPharmacy {
  id: string;
  name: string;
}

export const DEMO_WAITLIST: DemoWaitlistPharmacy[] = [
  { id: 'wl-01', name: 'Sunrise Community Pharmacy (demo)' },
  { id: 'wl-02', name: 'Greenleaf Pharmacy (demo)' },
  { id: 'wl-03', name: 'Bluegate Chemists (demo)' },
  { id: 'wl-04', name: 'Harmony Health Pharmacy (demo)' },
  { id: 'wl-05', name: 'Evergreen Pharmacy (demo)' },
  { id: 'wl-06', name: 'Northstar Pharmacy (demo)' },
  { id: 'wl-07', name: 'Wellcare Chemists (demo)' },
  { id: 'wl-08', name: 'Cornerstone Pharmacy (demo)' },
  { id: 'wl-09', name: 'Silverline Pharmacy (demo)' },
  { id: 'wl-10', name: 'Meadow Pharmacy (demo)' },
  { id: 'wl-11', name: 'Brightpoint Chemists (demo)' },
  { id: 'wl-12', name: 'Riverside Pharmacy (demo)' },
  { id: 'wl-13', name: 'Crescent Pharmacy (demo)' },
  { id: 'wl-14', name: 'Hillside Chemists (demo)' },
  { id: 'wl-15', name: 'Lakeside Pharmacy (demo)' },
  { id: 'wl-16', name: 'Willow Pharmacy (demo)' },
  { id: 'wl-17', name: 'Palmgrove Chemists (demo)' },
  { id: 'wl-18', name: 'Rosewood Pharmacy (demo)' },
  { id: 'wl-19', name: 'Coastal Pharmacy (demo)' },
  { id: 'wl-20', name: 'Horizon Pharmacy (demo)' },
];

/** Base unit indicative retail price anchor, in naira. */
export interface DemoMedicine {
  id: string;
  name: string;
  genericName: string;
  /** Tradeable packs, matching the seed's unit shapes. */
  packs: { label: string; indicativePrice: number };
  /**
   * Pharmacy-only (dispensable) items. A customer demo cannot add these to an
   * order - the restriction is part of the story, not an omission.
   */
  requiresPharmacist: boolean;
  note?: string;
}

export const DEMO_MEDICINES: DemoMedicine[] = [
  { id: 'demo-paracetamol', name: 'Paracetamol Tablets', genericName: 'Paracetamol', packs: { label: 'Card of 10', indicativePrice: 200 }, requiresPharmacist: false },
  { id: 'demo-vitamin-c', name: 'Vitamin C Tablets', genericName: 'Ascorbic Acid', packs: { label: 'Card of 10', indicativePrice: 250 }, requiresPharmacist: false },
  { id: 'demo-cough-syrup', name: 'Cough Syrup', genericName: 'Expectorant', packs: { label: '100 ml bottle', indicativePrice: 1500 }, requiresPharmacist: false },
  { id: 'demo-coartem', name: 'Coartem Tablets', genericName: 'Artemether / Lumefantrine', packs: { label: 'Course of 6', indicativePrice: 2700 }, requiresPharmacist: false },
  { id: 'demo-omeprazole', name: 'Omeprazole Capsules', genericName: 'Omeprazole', packs: { label: 'Pack of 14', indicativePrice: 1100 }, requiresPharmacist: false },
  { id: 'demo-amoxicillin', name: 'Amoxicillin Capsules', genericName: 'Amoxicillin', packs: { label: 'Pack of 21', indicativePrice: 7000 }, requiresPharmacist: true, note: 'Antibiotic - dispensed by the pharmacist after a prescription' },
  { id: 'demo-ciprofloxacin', name: 'Ciprofloxacin Tablets', genericName: 'Ciprofloxacin', packs: { label: 'Card of 10', indicativePrice: 900 }, requiresPharmacist: true, note: 'Antibiotic - dispensed by the pharmacist after a prescription' },
  { id: 'demo-diazepam', name: 'Diazepam Tablets', genericName: 'Diazepam', packs: { label: 'Card of 10', indicativePrice: 800 }, requiresPharmacist: true, note: 'Controlled medicine' },
];

/**
 * The pharmacies a customer can order from. The first one is literally the
 * seeded store's branch (the owner/attendant dashes show the same medicine
 * names) - that is the "one ecosystem" connection, priced slightly differently
 * per pharmacy so price comparison reads naturally.
 */
export interface DemoPharmacy {
  id: string;
  name: string;
  address: string;
  rating: number;
  reviewsCount: number;
  openNow: boolean;
  openingHours: string;
  /** Multiplier applied to the indicative price. Slight variation by pharmacy. */
  priceFactor: number;
  /** The stock hints the availability badge shows. */
  outOfStock: string[];
}

export const DEMO_PHARMACIES: DemoPharmacy[] = [
  {
    id: 'br-endline',
    name: 'Endline Pharmacy - PharmaFlow Demo Pharmacy',
    address: '12 Murtala Muhammad Way, Kano',
    rating: 4.7,
    reviewsCount: 212,
    openNow: true,
    openingHours: '8:00 - 22:00 daily',
    priceFactor: 1,
    outOfStock: ['demo-diazepam'],
  },
  {
    id: 'demo-surulere',
    name: 'Surulere Family Pharmacy (demo)',
    address: '16 Ojuelegba Road, Surulere, Lagos',
    rating: 4.4,
    reviewsCount: 96,
    openNow: true,
    openingHours: '8:30 - 21:00 daily',
    priceFactor: 0.94,
    outOfStock: ['demo-diazepam', 'demo-omeprazole'],
  },
  {
    id: 'demo-yaba',
    name: 'Yaba Community Pharmacy (demo)',
    address: '40 Herbert Macaulay Way, Yaba, Lagos',
    rating: 4.1,
    reviewsCount: 58,
    openNow: false,
    openingHours: '9:00 - 19:00 Mon-Sat',
    priceFactor: 1.06,
    outOfStock: [],
  },
];

/** The supplier the prototype is "logged in" as. `sup-medplus` is a seeded store supplier. */
export const DEMO_SUPPLIER = {
  id: 'sup-medplus',
  name: 'MedPlus Distributors (demo)',
  contactPerson: 'Fatima Sani',
  phone: '+234 803 444 5566',
  address: '22 Awolowo Road, Ikoyi, Lagos',
  leadTimeDays: 5,
  rating: 4.2,
  licences: ['PCN wholesale licence (demo)', 'NAFDAC-compliant storage (demo)'],
};

/** Wholesale catalogue: pack + indicative trade price + fictional stock on hand. */
export interface DemoWholesaleItem {
  medicineId: string;
  name: string;
  packLabel: string;
  wholesalePrice: number;
  stockOnHand: number;
}

export const DEMO_WHOLESALE: DemoWholesaleItem[] = DEMO_MEDICINES.filter(
  (m) => m.id !== 'demo-diazepam',
).map((m, index) => ({
  medicineId: m.id,
  name: m.name,
  // A label that already begins with its own quantity ("100 ml bottle") is used
  // as-is; only countable pack units ("Card of 10") take a leading "1 ". Without
  // this the volume label rendered as the nonsensical "1 100 ml bottle".
  packLabel: /^\d/.test(m.packs.label) ? m.packs.label : `1 ${m.packs.label}`,
  wholesalePrice: Math.round(m.packs.indicativePrice * 0.78),
  stockOnHand: [820, 415, 96, 240, 130, 60, 210][index] ?? 100,
}));

/**
 * The competing supplier the comparison view names. `sup-abc` is the seeded
 * store's other supplier (ABC Pharmacy Supplies), so the comparison reads as
 * two suppliers the owner already buys from.
 */
export const DEMO_COMPETITOR = {
  id: 'sup-abc',
  name: 'ABC Pharmacy Supplies',
};

/** One line of the side-by-side quote: the same pack, quoted by both suppliers. */
export interface DemoSupplierComparisonRow {
  medicineId: string;
  name: string;
  /** The pack BOTH quotes are for - identical to the catalogue pack above. */
  packLabel: string;
  /** MedPlus's own indicative trade price, taken from `DEMO_WHOLESALE`. */
  medplus: number;
  /** The fictional competing quotation for that same pack. */
  abc: number;
}

/**
 * The same four anchor items, each quoted PER PACK so the catalogue tab and the
 * comparison tab line up like for like. Only the ABC figure is invented; the
 * MedPlus column is READ FROM `DEMO_WHOLESALE` rather than retyped, so the two
 * tabs cannot quote different prices or different package sizes for the same
 * medicine. Sample quotations only - no live market pricing.
 */
const DEMO_ANCHOR_COMPETITOR_PRICES: { medicineId: string; abc: number }[] = [
  { medicineId: 'demo-paracetamol', abc: 170 },
  { medicineId: 'demo-coartem', abc: 2_050 },
  { medicineId: 'demo-amoxicillin', abc: 5_580 },
  { medicineId: 'demo-vitamin-c', abc: 210 },
];

export const DEMO_SUPPLIER_COMPARISON: DemoSupplierComparisonRow[] =
  DEMO_ANCHOR_COMPETITOR_PRICES.flatMap(({ medicineId, abc }) => {
    const item = DEMO_WHOLESALE.find((w) => w.medicineId === medicineId);
    return item
      ? [
          {
            medicineId,
            name: item.name,
            packLabel: item.packLabel,
            medplus: item.wholesalePrice,
            abc,
          },
        ]
      : [];
  });

/** Enquiries "received" from pharmacies - the Endline Pharmacy ties the demos together. */
export const DEMO_ENQUIRIES = [
  { id: 'enq-1', from: 'Endline Pharmacy - PharmaFlow Demo Pharmacy', at: 'Today, 09:40', items: ['Paracetamol Tablets x 200 cards', 'Coartem Tablets x 40 courses'], urgency: 'restock' as const },
  { id: 'enq-2', from: 'Surulere Family Pharmacy (demo)', at: 'Yesterday, 15:02', items: ['Vitamin C Tablets x 100 cards'], urgency: 'routine' as const },
  { id: 'enq-3', from: 'Yaba Community Pharmacy (demo)', at: 'Tue, 11:18', items: ['Omeprazole Capsules x 25 packs', 'Ciprofloxacin Tablets x 80 cards'], urgency: 'routine' as const },
];

/** Supplied today: sample fulfilment states the prototype shows. */
export const DEMO_SAMPLE_ORDERS = [
  { id: 'ord-1', pharmacy: 'Endline Pharmacy', number: 'MP-2026-0188', state: 'Delivered', note: 'Received by Aisha Yusuf, 11:05', value: 184_200 },
  { id: 'ord-2', pharmacy: 'Yaba Community Pharmacy (demo)', number: 'MP-2026-0187', state: 'In transit', note: 'Dispatch van MP-02, today 08:40', value: 96_750 },
  { id: 'ord-3', pharmacy: 'Endline Pharmacy (demo)', number: 'MP-2026-0186', state: 'Awaiting confirmation', note: 'Quotation sent, waiting for approval', value: 42_000 },
];

/** The fictional customer persona the prototype session represents. */
export const DEMO_CUSTOMER = {
  name: 'Grace Adeyemi',
  phone: '+234 802 111 2233',
};

export function demoPriceFor(priceFactor: number, indicativePrice: number): number {
  return Math.round((indicativePrice * priceFactor) / 10) * 10;
}

export function demoNaira(amount: number): string {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 })
    .format(amount)
    .replace('NGN', '\u20A6');
}
