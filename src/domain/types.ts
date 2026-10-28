/**
 * PharmaFlow domain types.
 *
 * Ported from the v2 codebase with these deliberate changes:
 *   - `auditLogs` / `auditEvents` were the same array stored twice. One shape now.
 *   - `MedicineUnits` used optional `cardUnit` / `boxUnit` with a separate
 *     `baseUnit`, so "which units does this sell in" was a three-field
 *     question. It is now an array of tradeable units.
 *   - `Sale` had seven payment methods for what is really two questions
 *     (how paid, and was anything left outstanding). Split into those.
 *   - Money is a plain number of naira, but MUST go through `money.ts` helpers.
 *     Never do arithmetic on it inline.
 */

export type Role = 'owner' | 'assistant' | 'customer' | 'supplier';

/** Staff roles only (for pharmacy staff users). */
export type StaffRole = 'owner' | 'assistant';

export type UserId = string;
export type MedicineId = string;
export type SaleId = string;

/* ------------------------------------------------------------------- people */

export interface User {
  id: UserId;
  name: string;
  email: string;
  role: StaffRole;
  phone: string;
  licenseNumber?: string;
  /** Managers approve pricing; assistants can only request it. */
  canApprovePricing: boolean;
}

export interface PharmacyBranch {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  openingHours: string;
  isOpenNow: boolean;
  rating: number;
  reviewsCount: number;
  isMainHub?: boolean;
}

/* ---------------------------------------------------------------- medicines */

/**
 * One tradeable packaging unit.
 *
 * `multiplier` is **flat**: how many base units a single one of this contains.
 * So `Card (10)` is 10 and `Box (100)` is 100 — not "10 cards". The hierarchy
 * is reconstructible from these factors by `convertFromBaseUnits`, which is
 * what renders "4 × Box (100) · 9 × Card (10)" from a canonical 498.
 *
 * Exactly one unit per medicine has `multiplier === 1`, and it must be first.
 * That is the base unit, and it is enforced in the database by
 * `pf_check_base_unit` as well as by `validateUnitHierarchy` here.
 *
 * All arithmetic around these lives in `src/domain/units.ts`. Do not multiply
 * a `multiplier` by hand in a component.
 *
 * @see src/domain/units.ts for the full model and conversion rules.
 */
export interface TradeUnit {
  key: string;
  name: string;
  /** Base units in one of these. A positive integer; 1 marks the base unit. */
  multiplier: number;
  /**
   * Price for one of these, in naira.
   *
   * Configured independently per unit and deliberately NOT derived as
   * `pricePerBaseUnit * multiplier`: a pharmacy is free to price a box at a
   * different margin from the same number of loose tablets.
   */
  sellingPrice: number;
}

export type StockStatus =
  | 'in_stock'
  | 'low_stock'
  | 'out_of_stock'
  | 'expiring_soon'
  | 'expired';

/**
 * How a product may be sold.
 *
 * Display casing only. The database enum is lowercase (`otc`, `prescription`,
 * `controlled`); the mapping in `src/hooks/medicine-mapping.ts` translates between
 * the two, so no screen has to know which one it is holding. Exported as a named
 * type because the mapping needs to name the target.
 */
export type PrescriptionStatus = 'OTC' | 'Prescription' | 'Controlled';

/** Days from today at which stock is flagged as expiring soon. */
export const EXPIRY_WARNING_DAYS = 90;

export interface MedicineBatch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  /** In base units. */
  quantity: number;
  costPerBaseUnit?: number;
  supplier: string;
  receivedDate: string;
  isRecalled: boolean;
  recallReason?: string;
}

export interface Medicine {
  id: MedicineId;
  barcode?: string;
  name: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  category: string;

  units: TradeUnit[];
  /** In base units. Mirrors the sum of live batches. */
  totalQuantity: number;
  lowStockThreshold: number;

  expiryDate: string;
  supplier: string;
  purchaseDate: string;

  /**
   * Cost per base unit. **ABSENT** when the session cannot read cost.
   *
   * Owner-only in the database: the column is withheld by column grants and
   * published through the owner-gated `pf_medicine_costs` view. An assistant's
   * response genuinely carries no value here — not zero, not a hidden one.
   *
   * Optional rather than defaulting to 0 on purpose. A 0 would flow silently into
   * `stockValue`, `unitMargin` and every margin report, producing confident
   * numbers built on nothing. `hasCost()` is the guard — use it before any
   * cost-derived calculation.
   */
  costPerBaseUnit?: number;
  /** Selling price per base unit. */
  pricePerBaseUnit: number;

  batches: MedicineBatch[];

  commonUse: string;
  storage: string;
  prescriptionStatus: PrescriptionStatus;
  warnings: string[];

  isBrand: boolean;
  genericEquivalentId?: MedicineId;

  /** Safety lock. A locked medicine cannot be sold, at any price. */
  doNotSell: { active: boolean; reason?: string; lockedBy?: string; lockedAt?: string };

  nafdacRegNumber?: string;
  manufacturer?: string;
  /** Average base units sold per day. Drives reorder maths. */
  averageDailySales: number;
}

/* ------------------------------------------------------------------- stock */

export type StockMovementType =
  | 'receipt'
  | 'sale'
  | 'adjustment'
  | 'return'
  | 'void'
  | 'disposal';

export interface StockMovement {
  id: string;
  timestamp: string;
  medicineId: MedicineId;
  medicineName: string;
  type: StockMovementType;
  /** Base units, signed. Negative for outflow. */
  quantityChanged: number;
  resultingQuantity: number;
  performedBy: string;
  performedByRole: Role;
  notes: string;
  referenceId?: string;
}

export type ReceiptStatus = 'pending_pricing' | 'confirmed';

export interface StockReceipt {
  id: string;
  receiptNumber: string;
  medicineId: MedicineId;
  medicineName: string;
  batchNumber: string;
  /** In base units, so the unit the attendant picked does not matter later. */
  baseUnitsReceived: number;
  supplier: string;
  expiryDate: string;
  dateReceived: string;
  receivedBy: string;
  receivedByRole: Role;
  status: ReceiptStatus;
  costPerBaseUnit?: number;
  pricePerBaseUnit?: number;
  pricedBy?: string;
  pricedAt?: string;

  /**
   * What was actually typed on the delivery note, kept as a snapshot.
   *
   * A supplier's paperwork says "5 boxes". `baseUnitsReceived` says 500. Both
   * are recorded, because the day the pharmacy repackages a "box" as 120
   * pieces the historical receipt must still read "5 boxes" rather than
   * silently reinterpreting itself as 600.
   *
   * Absent on receipts recorded before this existed, and on receipts entered
   * directly in base units. Absent means "not recorded", never zero.
   */
  receivedQuantity?: number;
  receivedUnitKey?: string;
  receivedUnitName?: string;
  receivedUnitMultiplier?: number;
}

/* -------------------------------------------------------------------- sales */

export type PaymentMethod = 'cash' | 'transfer' | 'pos_card' | 'wallet' | 'split';

/**
 * One row of a sale's payment history — a part of a split payment recorded at
 * checkout, or a repayment recorded later. `recordedBy`/`recordedAt` are set
 * only on repayments: the money collected at the till is the sale itself.
 */
export interface SalePayment {
  method: PaymentMethod;
  amount: number;
  recordedBy?: string;
  recordedAt?: string;
}
/** How the sale settled. `credit` means nothing was collected in full. */
export type SaleStatus = 'paid' | 'part_paid' | 'credit' | 'refunded' | 'voided';

export interface CartLine {
  medicineId: MedicineId;
  unitKey: string;
  unitName: string;
  unitMultiplier: number;
  unitPrice: number;
  quantity: number;
  baseUnitsTotal: number;
  lineTotal: number;
}

export interface SaleItem extends CartLine {
  /** Database line id. Present on mapped live sales; absent on demo seeds. */
  id?: string;
  medicineName: string;
  genericName: string;
  /**
   * What the line was dispensed at. Optional because it is owner-only and an
   * assistant's medicine carries no cost to snapshot. Null means unknown, not zero.
   */
  costPerBaseUnitSnapshot?: number;
  batchId?: string;
}

/* ------------------------------------------------------------------ returns */

export type SaleReturnStatus = 'pending_review' | 'completed' | 'rejected';

export type SaleReturnReason =
  | 'wrong_medicine'
  | 'damaged'
  | 'customer_changed_mind'
  | 'expired'
  | 'recalled'
  | 'other';

export type SaleReturnMethod =
  | 'cash'
  | 'transfer'
  | 'pos_card'
  | 'wallet'
  | 'store_credit'
  | 'not_refunded';

export interface SaleReturnItem {
  saleItemId: string;
  medicineId: MedicineId;
  medicineName: string;
  /** Whole units of the packaging the customer returned. */
  quantity: number;
  /** Base units, so quarantine/restock can be summed across packaging. */
  baseUnitsTotal: number;
  /** Value of this line at the original sale's proportional price. */
  returnValue: number;
  /** Units put back on the original lot. */
  restockedUnits: number;
  /** Units held out of sellable stock. */
  quarantinedUnits: number;
}

/**
 * A customer return, linked to the completed sale it reverses in part or whole.
 *
 * This is deliberately not a `Sale` with a different status. The original sale,
 * its lines, receipt and payments are immutable; the return is its own
 * transaction with its own number and review trail. `Sale.outstandingBalance`
 * is already net of `creditApplied`; `Sale.total` remains the historical sale.
 */
export interface SaleReturn {
  id: string;
  returnNumber: string;
  status: SaleReturnStatus;
  reason: SaleReturnReason;
  note: string;
  createdAt: string;
  reviewedAt?: string;
  completedAt?: string;
  reviewNote?: string;
  refundValue: number;
  creditApplied: number;
  refundAmount: number;
  refundMethod?: SaleReturnMethod;
  items: SaleReturnItem[];
}

export interface Sale {
  id: SaleId;
  receiptNumber: string;
  date: string;
  attendantId: UserId;
  attendantName: string;
  items: SaleItem[];
  subtotal: number;
  discount: number;
  discountReason?: string;
  total: number;
  paymentMethod: PaymentMethod;
  status: SaleStatus;
  /** Collected at the counter. Less than `total` for part_paid and credit. */
  amountPaid: number;
  outstandingBalance: number;
  /**
   * The split-method parts of the collected money, plus (later) each repayment.
   * Supporting detail for reporting and reconciliation: `amountPaid` remains
   * the money of record.
   */
  paymentBreakdown?: SalePayment[];
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  creditAccountId?: string;
  /**
   * The portion of accepted returns applied against this sale's outstanding
   * balance. Historic sale totals and `amountPaid` are not rewritten.
   */
  returnedCredit?: number;
  /** Linked returns, newest first. Absent/empty means none recorded. */
  returns?: SaleReturn[];
  /** True when an Rx was dispensed under prescription, not OTC. */
  dispensedAgainstPrescription?: boolean;
  statusReason?: string;
  statusChangedBy?: string;
  statusChangedAt?: string;
}

/* ------------------------------------------------------------------ people */

export interface CreditLedgerEntry {
  id: string;
  date: string;
  type: 'charge' | 'payment';
  amount: number;
  balanceAfter: number;
  note: string;
  referenceId?: string;
}

export type CreditAccountType = 'school' | 'company' | 'family' | 'clinic' | 'business';

export interface CreditAccount {
  id: string;
  name: string;
  type: CreditAccountType;
  contactPerson: string;
  phone: string;
  email?: string;
  creditLimit: number;
  outstandingBalance: number;
  status: 'active' | 'suspended';
  createdAt: string;
  ledger: CreditLedgerEntry[];
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string;
  email?: string;
  walletBalance: number;
  outstandingDebt: number;
  totalSpent: number;
  purchaseCount: number;
  registeredDate: string;
  lastPurchaseDate?: string;
  consentForReminders: boolean;
  chronicMedications: string[];
  notes?: string;
}

export interface Supplier {
  id: string;
  name: string;
  contactPerson: string;
  phone: string;
  address: string;
  leadTimeDays: number;
  rating: number;
}

/* ------------------------------------------------------- orders and signals */

export type OrderStatus =
  | 'pending_review'
  | 'confirmed'
  | 'ready_for_pickup'
  | 'out_for_delivery'
  | 'completed'
  | 'cancelled';

export interface CustomerOrderItem {
  medicineId: MedicineId;
  medicineName: string;
  unitName: string;
  quantity: number;
  lineTotal: number;
}

export interface CustomerOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  deliveryType: 'pickup' | 'delivery';
  deliveryAddress?: string;
  branchName: string;
  items: CustomerOrderItem[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMethod: 'pay_on_delivery' | 'bank_transfer' | 'card';
  paymentStatus: 'pending' | 'paid';
  orderStatus: OrderStatus;
  prescriptionUploaded: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A customer asked for something the shelf was empty of. */
export interface MedicineRequest {
  id: string;
  medicineName: string;
  genericName?: string;
  customerName?: string;
  customerPhone?: string;
  quantityRequested: number;
  urgency: 'routine' | 'urgent' | 'emergency';
  status: 'pending_restock' | 'restocked' | 'notified';
  recordedAt: string;
}

/* ------------------------------------------------------- audit and alerts */

/**
 * Badge tone for an audit action. The four tones `ACTION_TONE` uses, matching
 * the `Badge` variants that carry them. Kept beside the action itself so the
 * label map and the mapper share one definition.
 */
export type ActionTone = 'success' | 'warning' | 'destructive' | 'secondary';

export type AuditAction =
  | 'sale'
  | 'refund'
  | 'void'
  | 'discount'
  | 'stock_receipt'
  | 'product_created'
  | 'pricing_approval'
  | 'price_change'
  | 'unit_change'
  | 'recall_lock'
  | 'stock_adjustment'
  | 'login'
  | 'logout';

export interface AuditEvent {
  id: string;
  timestamp: string;
  actorName: string;
  actorRole: Role;
  action: AuditAction;
  /**
   * Display label for `action`. `audit_events.action` is unconstrained text, so
   * a live row may carry a value outside `AuditAction`; the mapper sets this for
   * every row it maps. The seeded log omits it and the screens fall back to
   * `ACTION_LABEL` through `audit-mapping`'s `actionLabelOf`.
   */
  actionLabel?: string;
  /** Display tone for `action`; an unknown action is neutral. See `actionLabel`. */
  actionTone?: ActionTone;
  description: string;
  metadata?: Record<string, unknown>;
}

export type NotificationType =
  | 'pending_pricing'
  | 'low_stock'
  | 'expiry_risk'
  | 'cost_increase'
  | 'recall'
  | 'medicine_request';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  date: string;
  read: boolean;
  severity: 'info' | 'warning' | 'urgent';
  to?: string;
}

/* -------------------------------------------------------- derived, not stored */

export type ReorderPriority = 'urgent' | 'soon' | 'watch' | 'overstock';

export interface ReorderSuggestion {
  medicine: Medicine;
  priority: ReorderPriority;
  daysUntilStockout: number;
  recommendedQuantity: number;
  /** What it costs to restock this line. Null when this session cannot read cost. */
  estimatedCost: number | null;
  reason: string;
}

export interface ExpiryBucket {
  medicine: Medicine;
  daysRemaining: number;
  quantity: number;
  /** Value of this batch at cost. Null when this session cannot read cost. */
  valueAtCost: number | null;
}

export interface SaleSummary {
  count: number;
  gross: number;
  discount: number;
  /** Gross sale value, before accepted returns. */
  net: number;
  /** Value of completed returns in the counted sales. */
  returned: number;
  /** `net - returned`, floored at zero. */
  netAfterReturns: number;
  /**
   * Cost of goods, or null when any sale line lacks a cost snapshot.
   *
   * `gross`, `discount`, `net` and `outstanding` are always real — money taken in
   * is not a secret. Only the three cost-derived figures can be null, because
   * cost is owner-only in the database and an attendant's sale records no cost.
   */
  cost: number | null;
  margin: number | null;
  marginPercent: number | null;
  outstanding: number;
}
