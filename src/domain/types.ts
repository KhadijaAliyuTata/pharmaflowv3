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

export type Role = 'owner' | 'assistant';

export type UserId = string;
export type MedicineId = string;
export type SaleId = string;

/* ------------------------------------------------------------------- people */

export interface User {
  id: UserId;
  name: string;
  email: string;
  role: Role;
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

/** A unit the pharmacy can sell in. The first entry is the base unit. */
export interface TradeUnit {
  key: string;
  name: string;
  /** How many base units one of these contains. */
  multiplier: number;
  /** Price for one of these, in naira. */
  sellingPrice: number;
}

export type StockStatus =
  | 'in_stock'
  | 'low_stock'
  | 'out_of_stock'
  | 'expiring_soon'
  | 'expired';

/** Days from today at which stock is flagged as expiring soon. */
export const EXPIRY_WARNING_DAYS = 90;

export interface MedicineBatch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  /** In base units. */
  quantity: number;
  costPerBaseUnit: number;
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

  /** Cost per base unit. Owner-visible only — never rendered for assistants. */
  costPerBaseUnit: number;
  /** Selling price per base unit. */
  pricePerBaseUnit: number;

  batches: MedicineBatch[];

  commonUse: string;
  storage: string;
  prescriptionStatus: 'OTC' | 'Prescription' | 'Controlled';
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
}

/* -------------------------------------------------------------------- sales */

export type PaymentMethod = 'cash' | 'transfer' | 'pos_card' | 'wallet';
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
  medicineName: string;
  genericName: string;
  costPerBaseUnitSnapshot: number;
  batchId?: string;
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
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  creditAccountId?: string;
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

export type AuditAction =
  | 'sale'
  | 'refund'
  | 'void'
  | 'discount'
  | 'stock_receipt'
  | 'pricing_approval'
  | 'price_change'
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
  estimatedCost: number;
  reason: string;
}

export interface ExpiryBucket {
  medicine: Medicine;
  daysRemaining: number;
  quantity: number;
  valueAtCost: number;
}

export interface SaleSummary {
  count: number;
  gross: number;
  discount: number;
  net: number;
  cost: number;
  margin: number;
  marginPercent: number;
  outstanding: number;
}
