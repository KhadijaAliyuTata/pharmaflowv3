/**
 * Audit event presentation.
 *
 * ## Why this lives here
 *
 * v2 shipped no labels for `AuditAction`, so each screen that showed the audit
 * log invented its own. That is how "Recall / lock" ends up spelled three
 * different ways across three screens, and how an action gets a different colour
 * depending on where you read it. Both maps now live here, in the domain beside
 * the `AuditAction` type they describe, and every screen reads them.
 */

import type { AuditAction } from './types';

export const ACTION_LABEL: Record<AuditAction, string> = {
  sale: 'Sale',
  refund: 'Refund',
  void: 'Void',
  discount: 'Discount',
  stock_receipt: 'Stock receipt',
  pricing_approval: 'Pricing approval',
  price_change: 'Price change',
  unit_change: 'Packaging change',
  recall_lock: 'Recall / lock',
  stock_adjustment: 'Stock adjustment',
  login: 'Sign in',
  logout: 'Sign out',
};

/**
 * Badge tone per action.
 *
 * `void` and `recall_lock` are destructive because they remove goods or money
 * from the shelf; `discount` and `refund` are warnings because they gave value
 * away. Colour is never the only signal — the label text always accompanies it.
 */
export const ACTION_TONE: Record<
  AuditAction,
  'success' | 'warning' | 'destructive' | 'secondary'
> = {
  sale: 'success',
  refund: 'warning',
  void: 'destructive',
  discount: 'warning',
  stock_receipt: 'secondary',
  pricing_approval: 'secondary',
  price_change: 'secondary',
  unit_change: 'warning',
  recall_lock: 'destructive',
  stock_adjustment: 'secondary',
  login: 'secondary',
  logout: 'secondary',
};

/**
 * Actions an owner most often needs to investigate, in the order they are
 * offered in the ledger's filter. Derived from `ACTION_LABEL` rather than
 * hand-listed, so a new action cannot be added to the enum and then be missing
 * from the filter.
 */
export const LEDGER_ACTION_ORDER: AuditAction[] = [
  'sale',
  'discount',
  'void',
  'refund',
  'stock_receipt',
  'stock_adjustment',
  'recall_lock',
  'pricing_approval',
  'price_change',
  'unit_change',
  'login',
  'logout',
];
