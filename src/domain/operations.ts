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
import {
  hasCost,
  liveBatches,
  saleBlock,
  stockStatus,
  unitsUsedInHistory,
} from './selectors';
import {
  calculateUnitCost,
  convertToBaseUnits,
  findBaseUnit,
  findUnit,
  validateUnitHierarchy,
} from './units';

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

    // The cart's base-unit total is re-derived from the unit hierarchy rather
    // than trusted. It is the number stock is deducted by, so a tampered or
    // stale cart must not be able to decide how much leaves the shelf. If the
    // pharmacy repackaged while the cart was open, the mismatch is caught here
    // instead of quietly deducting the wrong amount.
    const hierarchy = validateUnitHierarchy(medicine.units);
    if (!hierarchy.ok) {
      const detail = hierarchy.issues.map((issue) => issue.problem).join('; ');
      return fail<CheckoutResult>(`${medicine.name} has an invalid unit setup: ${detail}`);
    }

    const conversion = convertToBaseUnits(medicine.units, line.unitKey, line.quantity);
    if (!conversion.ok) {
      return fail<CheckoutResult>(`${medicine.name}: ${conversion.error}`);
    }
    if (conversion.amount.baseUnits !== line.baseUnitsTotal) {
      return fail<CheckoutResult>(
        `${medicine.name}: the cart is out of date — ${line.quantity} × ${conversion.amount.unitName} is now ${conversion.amount.baseUnits} base units, not ${line.baseUnitsTotal}. Re-add the item.`,
      );
    }

    if (medicine.totalQuantity < line.baseUnitsTotal) {
      const baseUnit = findBaseUnit(medicine.units);
      return fail<CheckoutResult>(
        `Only ${medicine.totalQuantity} ${baseUnit?.name ?? 'base units'} of ${medicine.name} left`,
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
      //
      // `undefined` when the attendant cannot read cost — the normal case, since
      // cost is owner-only. Recorded as unknown rather than 0: a zero snapshot
      // would resurface later as a 100% margin on that line, which is worse than
      // admitting the cost was never captured.
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
  supplierId: string;
  expiryDate: string;
  /**
   * How many were counted, in `unitKey`.
   *
   * A delivery note says "5 boxes"; the attendant enters 5 and picks Box. The
   * canonical quantity is derived here and nowhere else, so an owner
   * repackaging later cannot change what this receipt means.
   */
  quantity: number;
  /** Key of the unit `quantity` was counted in. Must exist on the medicine. */
  unitKey: string;
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
  if (!input.expiryDate) return fail('Expiry date is required');
  if (input.expiryDate <= new Date().toISOString().slice(0, 10)) {
    return fail('Expiry date must be in the future');
  }

  // The entered unit is converted once, here, and the result is what every
  // downstream calculation uses. The hierarchy is validated first so a broken
  // packaging definition cannot produce a plausible-looking number.
  const hierarchy = validateUnitHierarchy(medicine.units);
  if (!hierarchy.ok) {
    const detail = hierarchy.issues.map((issue) => issue.problem).join('; ');
    return fail(`This product's unit setup is invalid: ${detail}`);
  }

  const conversion = convertToBaseUnits(medicine.units, input.unitKey, input.quantity);
  if (!conversion.ok) return fail(conversion.error);
  const baseUnitsReceived = conversion.amount.baseUnits;

  const supplier = state.suppliers.find((s) => s.id === input.supplierId);
  if (!supplier) return fail('Supplier not found');

  // Cost is only taken from the receipt when an owner supplied it. An attendant
  // can record what arrived but not what it cost, so the receipt goes to the
  // pricing queue instead of being confirmed.
  const cost = canApprovePricing(user.role) ? input.costPerBaseUnit : undefined;
  const priced = cost !== undefined;

  if (cost !== undefined && cost <= 0) {
    return fail('Cost must be greater than zero');
  }
  if (priced && input.pricePerBaseUnit !== undefined) {
    if (input.pricePerBaseUnit <= 0) return fail('Selling price must be greater than zero');
    if (cost !== undefined && input.pricePerBaseUnit <= cost) {
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
    baseUnitsReceived,
    supplier: supplier.id,
    expiryDate: input.expiryDate,
    dateReceived: now(),
    receivedBy: user.name,
    receivedByRole: user.role,
    status,
    // Snapshot of the delivery note, not a live read of today's packaging.
    receivedQuantity: conversion.amount.quantity,
    receivedUnitKey: conversion.amount.unitKey,
    receivedUnitName: conversion.amount.unitName,
    receivedUnitMultiplier: conversion.amount.baseUnitsPerUnit,
    ...(priced ? { costPerBaseUnit: cost } : {}),
    ...(priced && input.pricePerBaseUnit !== undefined
      ? { pricePerBaseUnit: input.pricePerBaseUnit }
      : {}),
    ...(priced ? { pricedBy: user.name, pricedAt: now() } : {}),
  };

  const batch: Medicine['batches'][number] = {
    id: createId('bat'),
    batchNumber: receipt.batchNumber,
    expiryDate: input.expiryDate,
    quantity: baseUnitsReceived,
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
    baseUnitsReceived,
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
    // In the unit that was actually counted, with the base total alongside.
    // "Received 5 × Box (100) (500 base units)" is what an auditor needs; a
    // bare 500 does not say whether the supplier sent five boxes or 500 tablets.
    `Received ${conversion.amount.quantity} × ${conversion.amount.unitName} of ${medicine.name} on ${receipt.receiptNumber} (${baseUnitsReceived} base units)`,
    {
      receiptId: receipt.id,
      quantity: conversion.amount.quantity,
      unitKey: conversion.amount.unitKey,
      unitMultiplier: conversion.amount.baseUnitsPerUnit,
      baseUnitsReceived,
    },
  );

  if (!priced) {
    next = withNotification(next, {
      type: 'pending_pricing',
      title: 'Receipt awaiting pricing',
      message: `${receipt.receiptNumber} · ${medicine.name} · ${conversion.amount.quantity} × ${conversion.amount.unitName}`,
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

  // The "price must be above cost" rule needs cost. If this session has none, the
  // rule cannot be checked — and skipping the check would quietly let an owner
  // sell below cost with no warning. Fail closed instead: the pricing screen
  // surfaces this rather than guessing.
  if (!hasCost(medicine)) {
    return fail(
      'Purchase cost is unavailable for this product, so the price cannot be checked against it. Reload with cost access or ask an owner to set cost first.',
    );
  }

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

/**
 * Sets the selling price of one packaging unit.
 *
 * Separate from `updatePrice` because the two are genuinely different decisions.
 * The base-unit price and a box's price are configured independently: a
 * pharmacy may sell loose paracetamol at ₦60 and the box at ₦5,000, which is not
 * 100 × ₦60, and nothing here will "correct" it to be.
 *
 * The unit's price is checked against the cost of *that unit*
 * (`costPerBaseUnit × multiplier`), not the base cost — comparing a box's price
 * to the price of one tablet would reject every correctly-priced box.
 *
 * Owner-only, and it fails closed without cost for the same reason
 * `updatePrice` does.
 */
export function updateUnitPrice(
  state: AppState,
  medicineId: string,
  unitKey: string,
  sellingPrice: number,
): Result<boolean> {
  const user = state.currentUser;
  if (!canApprovePricing(user.role)) return fail('Only an owner can change prices');

  const medicine = state.medicines.find((m) => m.id === medicineId);
  if (!medicine) return fail('Product not found');

  const unit = findUnit(medicine.units, unitKey);
  if (!unit) return fail(`"${unitKey}" is not a unit of this medicine`);

  if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
    return fail('Selling price must be zero or more');
  }
  if (sellingPrice === 0) return fail('Selling price must be greater than zero');
  if (sellingPrice === unit.sellingPrice) return fail('Price is unchanged');

  // Cost is owner-only in the database, so without it the "above cost" rule
  // cannot be checked and must not be silently skipped.
  const unitCost = calculateUnitCost(medicine, unitKey);
  if (unitCost === null) {
    return fail(
      'Purchase cost is unavailable for this product, so the price cannot be checked against it. Reload with cost access or ask an owner to set cost first.',
    );
  }
  if (sellingPrice <= unitCost) {
    return fail(
      `Price must be above the cost of one ${unit.name} (₦${unitCost.toLocaleString('en-NG')})`,
    );
  }

  const next: AppState = {
    ...state,
    medicines: state.medicines.map((m) =>
      m.id === medicineId
        ? {
            ...m,
            units: m.units.map((u) =>
              u.key === unitKey ? { ...u, sellingPrice } : u,
            ),
            // The base unit's price and the medicine's base price are the same
            // number, so they must not be allowed to drift apart.
            ...(unit.multiplier === 1 ? { pricePerBaseUnit: sellingPrice } : {}),
          }
        : m,
    ),
  };

  return ok(
    withAudit(
      next,
      user,
      'price_change',
      `${medicine.name} · ${unit.name}: ₦${unit.sellingPrice.toLocaleString('en-NG')} → ₦${sellingPrice.toLocaleString('en-NG')}`,
      { medicineId, unitKey, old: unit.sellingPrice, next: sellingPrice },
    ),
    true,
  );
}

/* ---------------------------------------------------------- unit hierarchy */

/**
 * Replaces a medicine's packaging configuration.
 *
 * Owner-only, matching `pf_guard_unit_write` on the database. The UI hides the
 * controls for anyone else, but this is the check that actually matters: the
 * database is the security boundary and this mirrors it so the local store does
 * not accept a write the server would refuse.
 *
 * Two classes of change are treated very differently:
 *
 * **Safe** — adding a unit, renaming one, or repricing one. Sales and receipts
 * snapshot `unit_key`, `unit_name`, `unit_multiplier` and `base_units_total`, so
 * the past keeps its own copy of what it meant and is unaffected.
 *
 * **Refused** — removing a unit that has been transacted in, or changing the
 * multiplier of one that has. Both would make an existing document silently
 * describe something it never was. A box recorded as "5 boxes = 500" must keep
 * meaning 500 even after the pharmacy starts selling 120-piece boxes.
 *
 * Only `units` is touched. Every other field on the medicine is left alone.
 */
export function updateUnits(
  state: AppState,
  medicineId: string,
  units: Medicine['units'],
): Result<Medicine['units']> {
  const user = state.currentUser;
  if (!canApprovePricing(user.role)) {
    return fail('Only an owner can change a product\'s packaging units');
  }

  const medicine = state.medicines.find((m) => m.id === medicineId);
  if (!medicine) return fail('Product not found');

  // The one validator. The UI previews with the same function so what the owner
  // is warned about and what blocks the save can never disagree.
  const validation = validateUnitHierarchy(units);
  if (!validation.ok) {
    return fail(validation.issues.map((issue) => issue.problem).join('; '));
  }

  const incoming = validation.units;
  const existingByKey = new Map(medicine.units.map((unit) => [unit.key, unit]));
  const incomingByKey = new Map(incoming.map((unit) => [unit.key, unit]));

  // --- historical guard -----------------------------------------------------
  for (const key of unitsUsedInHistory(state, medicineId)) {
    const before = existingByKey.get(key);
    if (!before) continue;

    if (!incomingByKey.has(key)) {
      return fail(
        `${before.name} has been used in sales or receipts, so it cannot be removed. Its name and price can still be edited.`,
      );
    }

    const after = incomingByKey.get(key);
    if (after && after.multiplier !== before.multiplier) {
      return fail(
        `${before.name} has historical transactions, so its conversion cannot change from ${before.multiplier} to ${after.multiplier}. Create a new unit instead.`,
      );
    }
  }

  // The base unit is not removable, and its multiplier is not negotiable. The
  // validator already requires exactly one multiplier-1 unit; this states the
  // reason so an owner who hits it learns why rather than guessing.
  const baseBefore = findBaseUnit(medicine.units);
  if (baseBefore) {
    const baseAfter = findBaseUnit(incoming);
    if (!baseAfter || baseAfter.key !== baseBefore.key) {
      return fail(
        `The base unit (${baseBefore.name}) cannot be removed or replaced — it is what all stock is counted in.`,
      );
    }
  }

  // --- price safety ---------------------------------------------------------
  // Same rule as `updateUnitPrice`: a price is checked against the cost of *that
  // unit*, and only when it actually changed, so a harmless rename is not blocked
  // by a cost rule that has nothing to do with it.
  const costKnown = hasCost(medicine);
  if (!costKnown) {
    const priceChanged = incoming.some((unit) => {
      const before = existingByKey.get(unit.key);
      return !before || before.sellingPrice !== unit.sellingPrice;
    });
    if (priceChanged) {
      return fail(
        'Purchase cost is unavailable for this product, so a new or changed selling price cannot be checked against it. Reload with cost access, or ask an owner to set the cost first.',
      );
    }
  } else {
    for (const unit of incoming) {
      const unitCost = calculateUnitCost(medicine, unit.key);
      // `medicine` here is the *current* record; a newly added key has no entry,
      // so its cost is derived from the base cost directly.
      const cost = unitCost ?? multiply(medicine.costPerBaseUnit ?? 0, unit.multiplier);
      if (unit.sellingPrice <= cost) {
        return fail(
          `${unit.name} must sell for more than it costs (₦${cost.toLocaleString('en-NG')}).`,
        );
      }
    }
  }

  // --- persist --------------------------------------------------------------
  const next: AppState = {
    ...state,
    medicines: state.medicines.map((m) => (m.id === medicineId ? { ...m, units: incoming } : m)),
  };

  const summary = incoming
    .map((unit) => `${unit.name} ×${unit.multiplier}`)
    .join(', ');

  return ok(
    withAudit(
      next,
      user,
      'unit_change',
      `${medicine.name} packaging: ${summary}`,
      { medicineId, units: incoming },
    ),
    incoming,
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
