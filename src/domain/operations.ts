import type { AppState } from './state';
import type {
  AuditAction,
  CartLine,
  CreditAccount,
  Medicine,
  PaymentMethod,
  Role,
  Sale,
  SaleItem,
  StockMovement,
  StockReceipt,
  User,
} from './types';
import { add, createId, isoTimestamp, money, multiply, subtract, sum } from './money';
import { canApprovePricing, can } from './state';
import { liveBatches, saleBlock, stockStatus } from './selectors';

/**
 * Every mutation in the app.
 *
 * These are pure: they take state and return new state, never touching
 * storage or React. The store owns persistence and notifying subscribers. That
 * split is what makes the rules testable and the undo path trivial.
 *
 * Each operation returns a `Result` rather than throwing, so a UI can render
 * the reason inline. v2 threw from deep inside a context method and surfaced
 * a generic "something went wrong" at the top level.
 */

export type Result<T> = { ok: true; state: AppState; value: T } | { ok: false; error: string };

function ok<T>(state: AppState, value: T): Result<T> {
  return { ok: true, state, value };
}

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function now(): string {
  return isoTimestamp();
}

/* ------------------------------------------------------------------- audit */

function withAudit(
  state: AppState,
  user: User,
  action: AuditAction,
  description: string,
  metadata?: Record<string, unknown>,
): AppState {
  return {
    ...state,
    auditEvents: [
      {
        id: createId('aud'),
        timestamp: now(),
        actorName: user.name,
        actorRole: user.role,
        action,
        description,
        ...(metadata ? { metadata } : {}),
      },
      ...state.auditEvents,
    ],
  };
}

function withNotification(
  state: AppState,
  notification: Omit<AppState['notifications'][number], 'id' | 'date' | 'read'>,
): AppState {
  return {
    ...state,
    notifications: [
      { id: createId('ntf'), date: now(), read: false, ...notification },
      ...state.notifications,
    ],
  };
}

/* -------------------------------------------------------------- stock moves */

function movement(
  medicine: Medicine,
  type: StockMovement['type'],
  quantityChanged: number,
  resultingQuantity: number,
  user: User,
  notes: string,
  referenceId?: string,
): StockMovement {
  return {
    id: createId('mov'),
    timestamp: now(),
    medicineId: medicine.id,
    medicineName: medicine.name,
    type,
    quantityChanged,
    resultingQuantity,
    performedBy: user.name,
    performedByRole: user.role,
    notes,
    ...(referenceId ? { referenceId } : {}),
  };
}

/** Adds or removes base units, keeping the batch ledger and total in step. */
function applyStockDelta(
  state: AppState,
  medicineId: string,
  delta: number,
  type: StockMovement['type'],
  user: User,
  notes: string,
  referenceId?: string,
  newBatch?: Medicine['batches'][number],
): AppState {
  const index = state.medicines.findIndex((m) => m.id === medicineId);
  if (index === -1) return state;

  const medicine = state.medicines[index]!;
  const resulting = Math.max(0, medicine.totalQuantity + delta);

  const nextMedicine: Medicine = {
    ...medicine,
    totalQuantity: resulting,
    batches: newBatch ? [...medicine.batches, newBatch] : medicine.batches,
  };

  const medicines = [...state.medicines];
  medicines[index] = nextMedicine;

  return {
    ...state,
    medicines,
    stockMovements: [
      movement(medicine, type, delta, resulting, user, notes, referenceId),
      ...state.stockMovements,
    ],
  };
}

/* --------------------------------------------------------------- selling */

export interface CheckoutInput {
  lines: CartLine[];
  paymentMethod: PaymentMethod;
  amountPaid: number;
  discount?: number;
  discountReason?: string;
  customerId?: string;
  creditAccountId?: string;
  dispensedAgainstPrescription?: boolean;
}

export type CheckoutResult = {
  sale: Sale;
  state: AppState;
};

/**
 * Rings up a sale.
 *
 * The checks, in the order an attendant would meet them:
 *   1. the cart is not empty
 *   2. nothing in it is locked, expired or out of stock
 *   3. the cash received covers the total (or it becomes credit, explicitly)
 *   4. stock is decremented and an audit entry written
 *
 * Validation happens before any state changes, so a rejected sale leaves the
 * state untouched.
 */
export function checkout(state: AppState, input: CheckoutInput): Result<CheckoutResult> {
  const user = state.currentUser;

  if (!can(user.role, 'sell')) return fail<CheckoutResult>('Your role cannot ring up sales');
  if (input.lines.length === 0) return fail<CheckoutResult>('Cart is empty');

  // 2. Re-validate every line against live state. The cart may have been open
  //    while someone else sold the last box.
  for (const line of input.lines) {
    const medicine = state.medicines.find((m) => m.id === line.medicineId);
    if (!medicine) return fail<CheckoutResult>(`Unknown product: ${line.medicineId}`);

    const block = saleBlock(medicine);
    if (block) return fail<CheckoutResult>(`${medicine.name}: ${block}`);

    if (medicine.totalQuantity < line.baseUnitsTotal) {
      return fail<CheckoutResult>(
        `Only ${medicine.totalQuantity} ${medicine.units[0]?.name ?? 'units'} of ${medicine.name} left`,
      );
    }
  }

  const subtotal = sum(input.lines.map((line) => line.lineTotal));
  const discount = money(input.discount ?? 0);
  if (discount < 0) return fail<CheckoutResult>('Discount cannot be negative');
  if (discount > subtotal) {
    return fail<CheckoutResult>('Discount cannot exceed the subtotal');
  }

  const total = subtract(subtotal, discount);
  const paid = money(input.amountPaid);

  if (paid < 0) return fail<CheckoutResult>('Amount received cannot be negative');
  if (paid > total) {
    return fail<CheckoutResult>('Amount received is more than the total');
  }

  // 3. Unpaid balances are only allowed when someone is on the sale.
  const outstanding = subtract(total, paid);
  if (outstanding > 0 && !input.customerId && !input.creditAccountId) {
    return fail<CheckoutResult>('Record a customer before leaving a balance');
  }

  let status: Sale['status'] = 'paid';
  if (outstanding > 0) {
    status = paid > 0 ? 'part_paid' : 'credit';
  }

  const customer = input.customerId
    ? state.customers.find((c) => c.id === input.customerId)
    : undefined;
  const account = input.creditAccountId
    ? state.creditAccounts.find((a) => a.id === input.creditAccountId)
    : undefined;

  if (input.creditAccountId && !account) {
    return fail<CheckoutResult>('Credit account not found');
  }
  if (account && account.status === 'suspended') {
    return fail<CheckoutResult>(`${account.name} is suspended`);
  }
  if (account && add(account.outstandingBalance, outstanding) > account.creditLimit) {
    return fail<CheckoutResult>(
      `Credit limit exceeded — ${account.name} is at ₦${account.outstandingBalance.toLocaleString('en-NG')} of ₦${account.creditLimit.toLocaleString('en-NG')}`,
    );
  }

  const receiptNumber = nextReceiptNumber(state);
  const saleId = createId('sale');
  const discountReason = input.discountReason?.trim() || undefined;

  const items: SaleItem[] = input.lines.map((line) => {
    const medicine = state.medicines.find((m) => m.id === line.medicineId)!;
    return {
      ...line,
      medicineName: medicine.name,
      genericName: medicine.genericName,
      // Snapshot the cost at sale time. Reordering later must not rewrite
      // last month's margin.
      costPerBaseUnitSnapshot: medicine.costPerBaseUnit,
    };
  });

  const sale: Sale = {
    id: saleId,
    receiptNumber,
    date: now(),
    attendantId: user.id,
    attendantName: user.name,
    items,
    subtotal,
    discount,
    ...(discountReason ? { discountReason } : {}),    total,
    paymentMethod: input.paymentMethod,
    status,
    amountPaid: paid,
    outstandingBalance: outstanding,
    ...(customer
      ? {
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
        }
      : {}),
    ...(account ? { creditAccountId: account.id } : {}),
    ...(input.dispensedAgainstPrescription ? { dispensedAgainstPrescription: true } : {}),
  };

  // 4. Commit: stock down, sale recorded, customer and account updated.
  let next: AppState = { ...state, sales: [sale, ...state.sales] };

  for (const line of input.lines) {
    next = applyStockDelta(
      next,
      line.medicineId,
      -line.baseUnitsTotal,
      'sale',
      user,
      `Sold on ${receiptNumber}`,
      saleId,
    );
  }

  if (customer) {
    next = {
      ...next,
      customers: next.customers.map((c) =>
        c.id === customer.id
          ? {
              ...c,
              totalSpent: add(c.totalSpent, total),
              purchaseCount: c.purchaseCount + 1,
              lastPurchaseDate: now(),
              outstandingDebt: add(c.outstandingDebt, outstanding),
            }
          : c,
      ),
    };
  }

  if (account && outstanding > 0) {
    next = {
      ...next,
      creditAccounts: next.creditAccounts.map((a) =>
        a.id === account.id
          ? {
              ...a,
              outstandingBalance: add(a.outstandingBalance, outstanding),
              ledger: [
                {
                  id: createId('led'),
                  date: now(),
                  type: 'charge' as const,
                  amount: outstanding,
                  balanceAfter: add(a.outstandingBalance, outstanding),
                  note: `Sale ${receiptNumber}`,
                  referenceId: saleId,
                },
                ...a.ledger,
              ],
            }
          : a,
      ),
    };
  }

  next = withAudit(
    next,
    user,
    discount > 0 ? 'discount' : 'sale',
    `Completed ${receiptNumber} for ₦${total.toLocaleString('en-NG')}`,
    { receiptNumber, total },
  );

  return ok(next, { sale, state: next });
}

function nextReceiptNumber(state: AppState): string {
  const year = new Date().getFullYear();
  const highest = state.sales
    .map((sale) => Number(sale.receiptNumber.split('-').pop()))
    .filter((n) => Number.isFinite(n))
    .reduce((max, n) => Math.max(max, n), 0);
  return `PF-${year}-${String(highest + 1).padStart(4, '0')}`;
}

/* ---------------------------------------------------- refunds and voids */

/**
 * Voids a sale: stock goes back, the record stays for audit, and the status
 * carries the reason. Sales are never deleted — a pharmacy cannot un-ring a
 * sale without leaving a hole in the day's numbers.
 */
export function voidSale(state: AppState, saleId: string, reason: string): Result<boolean> {
  const user = state.currentUser;
  const sale = state.sales.find((s) => s.id === saleId);
  if (!sale) return fail('Sale not found');
  if (sale.status === 'voided') return fail('Sale is already voided');
  if (sale.status === 'refunded') return fail('Refunded sales cannot be voided');
  if (!reason.trim()) return fail('Give a reason for the void');

  let next: AppState = {
    ...state,
    sales: state.sales.map((s) =>
      s.id === saleId
        ? {
            ...s,
            status: 'voided' as const,
            statusReason: reason.trim(),
            statusChangedBy: user.name,
            statusChangedAt: now(),
          }
        : s,
    ),
  };

  for (const item of sale.items) {
    next = applyStockDelta(
      next,
      item.medicineId,
      item.baseUnitsTotal,
      'void',
      user,
      `Voided ${sale.receiptNumber}`,
      sale.id,
    );
  }

  // Unwind the customer and credit-account side effects too.
  if (sale.customerId) {
    next = {
      ...next,
      customers: next.customers.map((c) =>
        c.id === sale.customerId
          ? {
              ...c,
              totalSpent: subtract(c.totalSpent, sale.total),
              purchaseCount: Math.max(0, c.purchaseCount - 1),
              outstandingDebt: Math.max(0, subtract(c.outstandingDebt, sale.outstandingBalance)),
            }
          : c,
      ),
    };
  }

  if (sale.creditAccountId && sale.outstandingBalance > 0) {
    next = {
      ...next,
      creditAccounts: next.creditAccounts.map((a) =>
        a.id === sale.creditAccountId
          ? {
              ...a,
              outstandingBalance: Math.max(0, subtract(a.outstandingBalance, sale.outstandingBalance)),
              ledger: [
                {
                  id: createId('led'),
                  date: now(),
                  type: 'payment' as const,
                  amount: sale.outstandingBalance,
                  balanceAfter: 0,
                  note: `Voided ${sale.receiptNumber}`,
                  referenceId: sale.id,
                },
                ...a.ledger,
              ],
            }
          : a,
      ),
    };
  }

  next = withAudit(next, user, 'void', `Voided ${sale.receiptNumber} — ${reason.trim()}`, {
    saleId,
  });

  return ok(next, true);
}

/* -------------------------------------------------------- stock receiving */

export interface ReceiveInput {
  medicineId: string;
  batchNumber: string;
  baseUnitsReceived: number;
  supplierId: string;
  expiryDate: string;
  costPerBaseUnit?: number;
  pricePerBaseUnit?: number;
  notes?: string;
}

/**
 * Receives stock.
 *
 * Assistants can receive but not price. An assistant's receipt lands in
 * `pending_pricing` and raises a notification for the owner, which is the
 * whole reason v2 had that queue.
 */
export function receiveStock(state: AppState, input: ReceiveInput): Result<StockReceipt> {
  const user = state.currentUser;

  if (!can(user.role, 'receive_stock')) {
    return fail('Your role cannot receive stock');
  }

  const medicine = state.medicines.find((m) => m.id === input.medicineId);
  if (!medicine) return fail('Product not found');
  if (!input.batchNumber.trim()) return fail('Batch number is required');
  if (input.baseUnitsReceived <= 0) return fail('Quantity must be greater than zero');
  if (!input.expiryDate) return fail('Expiry date is required');
  if (input.expiryDate <= new Date().toISOString().slice(0, 10)) {
    return fail('Expiry date must be in the future');
  }

  const supplier = state.suppliers.find((s) => s.id === input.supplierId);
  if (!supplier) return fail('Supplier not found');

  const priced = canApprovePricing(user.role) && input.costPerBaseUnit !== undefined;

  if (priced && input.costPerBaseUnit! <= 0) {
    return fail('Cost must be greater than zero');
  }
  if (priced && input.pricePerBaseUnit !== undefined) {
    if (input.pricePerBaseUnit <= 0) return fail('Selling price must be greater than zero');
    if (input.pricePerBaseUnit <= input.costPerBaseUnit!) {
      return fail('Selling price must be above cost');
    }
  }

  const status: StockReceipt['status'] = priced ? 'confirmed' : 'pending_pricing';
  const year = new Date().getFullYear();
  const sequence = state.stockReceipts.length + 1;

  const receipt: StockReceipt = {
    id: createId('rcp'),
    receiptNumber: `GRN-${year}-${String(sequence).padStart(4, '0')}`,
    medicineId: medicine.id,
    medicineName: medicine.name,
    batchNumber: input.batchNumber.trim(),
    baseUnitsReceived: input.baseUnitsReceived,
    supplier: supplier.id,
    expiryDate: input.expiryDate,
    dateReceived: now(),
    receivedBy: user.name,
    receivedByRole: user.role,
    status,
    ...(priced ? { costPerBaseUnit: input.costPerBaseUnit! } : {}),
    ...(priced && input.pricePerBaseUnit !== undefined
      ? { pricePerBaseUnit: input.pricePerBaseUnit }
      : {}),
    ...(priced ? { pricedBy: user.name, pricedAt: now() } : {}),
  };

  const batch: Medicine['batches'][number] = {
    id: createId('bat'),
    batchNumber: receipt.batchNumber,
    expiryDate: input.expiryDate,
    quantity: input.baseUnitsReceived,
    costPerBaseUnit: input.costPerBaseUnit ?? medicine.costPerBaseUnit,
    supplier: supplier.id,
    receivedDate: now(),
    isRecalled: false,
  };

  let next: AppState = {
    ...state,
    stockReceipts: [receipt, ...state.stockReceipts],
  };

  // Stock is counted on the shelf the moment it arrives, whether or not it has
  // been priced. Price is a paperwork step; the goods are already there.
  next = applyStockDelta(
    next,
    medicine.id,
    input.baseUnitsReceived,
    'receipt',
    user,
    `Received on ${receipt.receiptNumber}`,
    receipt.id,
    batch,
  );

  if (priced && input.pricePerBaseUnit !== undefined) {
    next = {
      ...next,
      medicines: next.medicines.map((m) =>
        m.id === medicine.id
          ? {
              ...m,
              costPerBaseUnit: input.costPerBaseUnit!,
              pricePerBaseUnit: input.pricePerBaseUnit!,
              supplier: supplier.id,
              purchaseDate: now().slice(0, 10),
            }
          : m,
      ),
    };
  }

  next = withAudit(
    next,
    user,
    'stock_receipt',
    `Received ${input.baseUnitsReceived} × ${medicine.name} on ${receipt.receiptNumber}`,
    { receiptId: receipt.id },
  );

  if (!priced) {
    next = withNotification(next, {
      type: 'pending_pricing',
      title: 'Receipt awaiting pricing',
      message: `${receipt.receiptNumber} · ${medicine.name} · ${input.baseUnitsReceived} units`,
      severity: 'warning',
      to: '/pricing',
    });
  }

  return ok(next, receipt);
}

/** Owner approves a pending receipt's pricing. This is the pending-pricing queue. */
export function approvePricing(
  state: AppState,
  receiptId: string,
  costPerBaseUnit: number,
  pricePerBaseUnit: number,
): Result<boolean> {
  const user = state.currentUser;

  if (!canApprovePricing(user.role)) {
    return fail('Only an owner can approve pricing');
  }

  const receipt = state.stockReceipts.find((r) => r.id === receiptId);
  if (!receipt) return fail('Receipt not found');
  if (receipt.status === 'confirmed') return fail('This receipt is already priced');
  if (costPerBaseUnit <= 0) return fail('Cost must be greater than zero');
  if (pricePerBaseUnit <= 0) return fail('Selling price must be greater than zero');
  if (pricePerBaseUnit <= costPerBaseUnit) {
    return fail('Selling price must be above cost');
  }

  let next: AppState = {
    ...state,
    stockReceipts: state.stockReceipts.map((r) =>
      r.id === receiptId
        ? {
            ...r,
            status: 'confirmed' as const,
            costPerBaseUnit,
            pricePerBaseUnit,
            pricedBy: user.name,
            pricedAt: now(),
          }
        : r,
    ),
  };

  next = {
    ...next,
    medicines: next.medicines.map((m) =>
      m.id === receipt.medicineId
        ? {
            ...m,
            costPerBaseUnit,
            pricePerBaseUnit,
            purchaseDate: now().slice(0, 10),
            batches: m.batches.map((batch) =>
              batch.batchNumber === receipt.batchNumber
                ? { ...batch, costPerBaseUnit }
                : batch,
            ),
          }
        : m,
    ),
  };

  next = withAudit(
    next,
    user,
    'pricing_approval',
    `Priced ${receipt.receiptNumber} · ${receipt.medicineName}`,
    { receiptId, costPerBaseUnit, pricePerBaseUnit },
  );

  // Drop the notification this receipt raised.
  next = {
    ...next,
    notifications: next.notifications.filter(
      (n) => !(n.type === 'pending_pricing' && n.to === '/pricing' && n.message.includes(receipt.receiptNumber)),
    ),
  };

  return ok(next, true);
}

/* ------------------------------------------------------------- price edits */

export function updatePrice(
  state: AppState,
  medicineId: string,
  pricePerBaseUnit: number,
): Result<boolean> {
  const user = state.currentUser;
  if (!canApprovePricing(user.role)) return fail('Only an owner can change prices');

  const medicine = state.medicines.find((m) => m.id === medicineId);
  if (!medicine) return fail('Product not found');
  if (pricePerBaseUnit <= 0) return fail('Selling price must be greater than zero');
  if (pricePerBaseUnit <= medicine.costPerBaseUnit) {
    return fail(
      `Selling price must be above cost (₦${medicine.costPerBaseUnit.toLocaleString('en-NG')})`,
    );
  }
  if (pricePerBaseUnit === medicine.pricePerBaseUnit) return fail('Price is unchanged');

  const next: AppState = {
    ...state,
    medicines: state.medicines.map((m) =>
      m.id === medicineId ? { ...m, pricePerBaseUnit } : m,
    ),
  };

  return ok(
    withAudit(
      next,
      user,
      'price_change',
      `${medicine.name}: ₦${medicine.pricePerBaseUnit.toLocaleString('en-NG')} → ₦${pricePerBaseUnit.toLocaleString('en-NG')}`,
      { medicineId, old: medicine.pricePerBaseUnit, next: pricePerBaseUnit },
    ),
    true,
  );
}

/* ------------------------------------------------------------ safety locks */

export function setSafetyLock(
  state: AppState,
  medicineId: string,
  locked: boolean,
  reason?: string,
): Result<boolean> {
  const user = state.currentUser;
  const medicine = state.medicines.find((m) => m.id === medicineId);
  if (!medicine) return fail('Product not found');

  // Lifting a safety lock is as consequential as applying one, and neither is an
  // attendant's decision. This check lives in the domain rather than the dialog
  // because the dialog can be bypassed; the database enforces it again via
  // `pf_guard_cost_write`'s sibling policies on `do_not_sell_locked_by`.
  if (!canApprovePricing(user.role)) return fail('Only an owner can change a safety lock');

  if (locked) {
    if (!reason?.trim()) return fail('Give a reason for the lock');
  } else if (!medicine.doNotSell.active) {
    return fail('This product is not locked');
  }

  const next: AppState = {
    ...state,
    medicines: state.medicines.map((m) =>
      m.id === medicineId
        ? {
            ...m,
            doNotSell: locked
              ? { active: true, reason: reason!.trim(), lockedBy: user.name, lockedAt: now() }
              : { active: false },
          }
        : m,
    ),
  };

  return ok(
    withAudit(
      next,
      user,
      'recall_lock',
      locked
        ? `Locked ${medicine.name} — ${reason!.trim()}`
        : `Unlocked ${medicine.name}`,
      { medicineId },
    ),
    true,
  );
}

export function setBatchRecall(
  state: AppState,
  batchId: string,
  recalled: boolean,
  reason?: string,
): Result<boolean> {
  const user = state.currentUser;

  // Releasing a manufacturer recall puts suspect stock back on the shelf, so it
  // is owner-only for the same reason as `setSafetyLock`.
  if (!canApprovePricing(user.role)) return fail('Only an owner can change a batch recall');

  if (recalled && !reason?.trim()) return fail('Give a reason for the recall');

  let found = false;
  const medicines = state.medicines.map((medicine) => ({
    ...medicine,
    batches: medicine.batches.map((batch) => {
      if (batch.id !== batchId) return batch;
      found = true;
      return recalled
        ? { ...batch, isRecalled: true, recallReason: reason!.trim() }
        : { ...batch, isRecalled: false, recallReason: undefined };
    }),
  }));

  if (!found) return fail('Batch not found');

  const next: AppState = { ...state, medicines };
  const batch = medicines.flatMap((m) => m.batches).find((b) => b.id === batchId)!;

  return ok(
    withAudit(
      next,
      user,
      'recall_lock',
      recalled
        ? `Recalled batch ${batch.batchNumber}${reason ? ` — ${reason.trim()}` : ''}`
        : `Released batch ${batch.batchNumber}`,
      { batchId },
    ),
    true,
  );
}

/* ------------------------------------------------------------- stock adjust */

export function adjustStock(
  state: AppState,
  medicineId: string,
  newQuantity: number,
  reason: string,
): Result<boolean> {
  const user = state.currentUser;
  if (!can(user.role, 'edit_inventory')) {
    return fail('Your role cannot adjust stock');
  }

  const medicine = state.medicines.find((m) => m.id === medicineId);
  if (!medicine) return fail('Product not found');
  if (newQuantity < 0) return fail('Quantity cannot be negative');
  if (newQuantity === medicine.totalQuantity) return fail('Quantity is unchanged');
  if (!reason.trim()) return fail('Give a reason for the adjustment');

  const delta = newQuantity - medicine.totalQuantity;
  const next = applyStockDelta(
    state,
    medicineId,
    delta,
    'adjustment',
    user,
    reason.trim(),
  );

  return ok(withAudit(next, user, 'stock_adjustment', `${medicine.name} → ${newQuantity} — ${reason.trim()}`, { medicineId, newQuantity }), true);
}

/* ------------------------------------------------------------ credit & debt */

export function recordCreditPayment(
  state: AppState,
  accountId: string,
  amount: number,
  note: string,
): Result<boolean> {
  const user = state.currentUser;
  if (!canApprovePricing(user.role)) return fail('Only an owner can record a payment');

  const account = state.creditAccounts.find((a) => a.id === accountId);
  if (!account) return fail('Credit account not found');
  if (amount <= 0) return fail('Amount must be greater than zero');
  if (amount > account.outstandingBalance) {
    return fail(
      `Payment exceeds the balance of ₦${account.outstandingBalance.toLocaleString('en-NG')}`,
    );
  }

  const balanceAfter = subtract(account.outstandingBalance, amount);
  const next: AppState = {
    ...state,
    creditAccounts: state.creditAccounts.map((a) =>
      a.id === accountId
        ? {
            ...a,
            outstandingBalance: balanceAfter,
            status: balanceAfter === 0 ? 'active' : a.status,
            ledger: [
              {
                id: createId('led'),
                date: now(),
                type: 'payment' as const,
                amount,
                balanceAfter,
                note: note.trim() || 'Repayment',
              },
              ...a.ledger,
            ],
          }
        : a,
    ),
  };

  return ok(
    withAudit(
      next,
      user,
      'stock_adjustment',
      `${account.name} paid ₦${amount.toLocaleString('en-NG')} — balance ₦${balanceAfter.toLocaleString('en-NG')}`,
      { accountId, amount },
    ),
    true,
  );
}

export function creditAccountsOverLimit(accounts: CreditAccount[]): CreditAccount[] {
  return accounts.filter((account) => account.outstandingBalance > account.creditLimit);
}

/* ------------------------------------------------------------- notifications */

export function markNotificationRead(state: AppState, id: string): AppState {
  return {
    ...state,
    notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
  };
}

export function markAllNotificationsRead(state: AppState): AppState {
  return {
    ...state,
    notifications: state.notifications.map((n) => ({ ...n, read: true })),
  };
}

/* ------------------------------------------------------------------ exports */

export {
  can,
  canApprovePricing,
  liveBatches,
  multiply,
  money,
  saleBlock,
  stockStatus,
  sum,
  withAudit,
  withNotification,
  fail as failResult,
  ok as okResult,
  type Role,
};
