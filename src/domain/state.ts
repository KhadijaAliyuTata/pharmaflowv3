import type {
  AppNotification,
  AuditEvent,
  CreditAccount,
  Customer,
  CustomerOrder,
  Medicine,
  MedicineRequest,
  ReceiptStatus,
  Role,
  Sale,
  StockMovement,
  StockReceipt,
  Supplier,
  User,
} from './types';

/**
 * The whole of PharmaFlow's state in one object.
 *
 * v2 kept this as a single `localStorage` blob and exposed it through a
 * 2,711-line context, so every mutation re-rendered every consumer. The shape
 * is the same here, but it lives behind a store with selectors, and
 * `auditLogs` is gone — v2 stored the audit array twice under two names.
 */
export interface AppState {
  currentUser: User;
  users: User[];
  branch: Branch;
  medicines: Medicine[];
  suppliers: Supplier[];
  creditAccounts: CreditAccount[];
  customers: Customer[];
  sales: Sale[];
  stockMovements: StockMovement[];
  stockReceipts: StockReceipt[];
  auditEvents: AuditEvent[];
  notifications: AppNotification[];
  customerOrders: CustomerOrder[];
  medicineRequests: MedicineRequest[];
}

export interface Branch {
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

/** Everything a user can do, gathered for the role switcher and audit log. */
export type Action =
  | 'view_dashboard'
  | 'sell'
  | 'receive_stock'
  | 'edit_inventory'
  | 'view_reports'
  | 'approve_pricing'
  | 'manage_staff';

const ROLE_ACTIONS: Record<Role, Action[]> = {
  owner: [
    'view_dashboard',
    'sell',
    'receive_stock',
    'edit_inventory',
    'view_reports',
    'approve_pricing',
    'manage_staff',
  ],
  assistant: ['view_dashboard', 'sell', 'receive_stock', 'view_reports'],
};

export function can(role: Role, action: Action): boolean {
  return ROLE_ACTIONS[role].includes(action);
}

export function canApprovePricing(role: Role): boolean {
  return can(role, 'approve_pricing');
}

/**
 * v2's `AppState` also had `auditLogs` as an alias of `auditEvents`, and
 * `stockReceipts` mixing pending with confirmed. Kept as a named filter here
 * so the distinction is explicit at the call site instead of implied.
 */
export function receiptsByStatus(
  receipts: StockReceipt[],
  status: ReceiptStatus,
): StockReceipt[] {
  return receipts.filter((receipt) => receipt.status === status);
}
