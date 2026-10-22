/**
 * Offline sale recording for the POS screen — Phase 3.
 *
 * One screen, one server path. The sale intent is recorded locally through the
 * Phase 1 outbox (`OfflineRepo`, store `pf_complete_sale`), and the Phase 2
 * sync engine drains it through a handler whose ONLY server call is the
 * existing authoritative `completeSale` (`src/lib/supabase/sales.ts`) — the
 * same `pf_complete_sale` RPC the online till already uses. There is no second
 * sales-write path here: no direct table inserts, no client-computed money
 * beyond what the server re-derives anyway, and no service role.
 *
 * ## The idempotency key is the operation id
 *
 * `opId === idempotency_key`. The server's replay short-circuit
 * (`pf_complete_sale` step 2) keys on `(branch_id, idempotency_key)`, so reusing
 * the op id across retries, reloads and lost responses is exactly right: the
 * rerun either is genuinely new work or returns the original sale with
 * `already_completed: true`. The key is generated ONCE per intended sale, and
 * its durability is the outbox row itself — it survives a tab crash, a reload
 * and a browser restart.
 *
 * ## What is validated locally, and what is not trusted
 *
 * The structure of the intent (lines, units, whole-number quantities, payment
 * shape) is checked here so obviously-broken data never enters the outbox — but
 * NO cached figure is treated as authority: stock, prices, permissions and any
 * cost data stay server-owned. `pf_complete_sale` re-derives them.
 *
 * ## Occurrence time (M1)
 *
 * The intent stamps `sold_at` the moment the sale happened on the device. When
 * it syncs, the handler sends it through and the migration (see
 * `supabase/migrations/20261017120000_offline_sale_sold_at.sql`) validates the
 * edges server-side. Sync time never overwrites sale time.
 */

import {
  OfflineStorageError,
  classifyStorageError,
  stableStringify,
  type OfflineRepo,
} from './local-db';
import type { OpResult, SyncHandler, HandlerFailureKind } from './sync-engine';
import { sanitizeMessage } from './sync-engine';

/** The only operation type this module can record or drive. */
export const POS_SALE_OP_TYPE = 'pf_complete_sale';

/* ------------------------------------------------------------------ intent */

export interface OfflineSaleLine {
  medicineId: string;
  unitKey: string;
  quantity: number;
}

/**
 * The prices the attendant actually saw when the sale was committed.
 *
 * This is an immutable *quote*, not an instruction to the server. The server
 * still derives every price and total. Keeping the quote lets the client detect
 * a server total that differs and escalate it instead of presenting a clean
 * receipt.
 */
export interface OfflineSaleExpectedLine {
  medicineId: string;
  unitKey: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OfflineSaleExpected {
  subtotal: number;
  discount: number;
  total: number;
  amountPaid: number;
  lines: OfflineSaleExpectedLine[];
}

export interface OfflineSaleIntent {
  lines: OfflineSaleLine[];
  paymentMethod: string;
  amountPaid: number;
  discount?: number;
  discountReason?: string;
  customerId?: string;
  creditAccountId?: string;
  dispensedAgainstPrescription?: boolean;
  /** The per-method parts of a split payment. `undefined` for every other kind. */
  paymentBreakdown?: { method: string; amount: number }[];
  /**
   * Required for an offline sale. Recorded once, with the intent, and compared
   * with the server's confirmed total when it syncs.
   */
  expected?: OfflineSaleExpected;
}

export interface RecordedSaleIntent {
  /** The outbox operation id — the same string the server sees as its key. */
  idempotencyKey: string;
  /** ISO timestamp of the ACTUAL sale time, not of any later sync. */
  soldAt: string;
  /** True when this exact intent was already recorded (repeated click). */
  duplicate: boolean;
}

/** A key the server can recognise a repeated submission by (`pos.tsx` twin). */
export function newIdempotencyKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `pos-${uuid}`;
}

/** A helper for the truthful per-record occurrence-time stamp. */
function occurrenceTime(): string {
  return new Date().toISOString();
}

/** Every kind an intent may name, including the split composite. */
const PAYMENT_METHODS = new Set(['cash', 'transfer', 'pos_card', 'wallet', 'split']);

/** The real kinds a split breakdown part may name — never 'split' itself. */
const SINGLE_PAYMENT_METHODS = new Set(['cash', 'transfer', 'pos_card', 'wallet']);

/** A tolerance in naira; both sides round to the kobo so this never binds. */
const MONEY_EPSILON = 0.01;

/**
 * The split-payment shape, checked the same way the server checks it
 * (`pf_complete_sale`, payment-breakdown step): real methods, positive parts,
 * and the parts adding up to exactly the amount received.
 */
function validateBreakdown(
  breakdown: { method: string; amount: number }[],
  amountPaid: number,
): string | null {
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    return 'The payment breakdown is empty';
  }
  let sum = 0;
  for (const part of breakdown) {
    if (!part || typeof part.method !== 'string' || !SINGLE_PAYMENT_METHODS.has(part.method)) {
      return 'A payment part names an unknown method';
    }
    if (typeof part.amount !== 'number' || !Number.isFinite(part.amount) || part.amount <= 0) {
      return 'Every payment part must be a positive amount';
    }
    sum += part.amount;
  }
  if (Math.abs(sum - amountPaid) > MONEY_EPSILON) {
    return 'The payment parts do not add up to the amount received';
  }
  return null;
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= MONEY_EPSILON;
}

/**
 * Checks that the quote is internally consistent and describes the same cart
 * and payment that will be sent. A quote that disagrees with the intent is not a
 * useful safety net; it is a second, contradictory source of truth.
 */
function validateExpected(
  expected: OfflineSaleExpected | undefined,
  lines: OfflineSaleLine[],
  amountPaid: number,
  discount: number,
): string | null {
  if (!expected || typeof expected !== 'object') {
    return 'The sale has no saved price check — it was not recorded';
  }
  if (
    !isMoney(expected.subtotal) ||
    !isMoney(expected.discount) ||
    !isMoney(expected.total) ||
    !isMoney(expected.amountPaid)
  ) {
    return 'The saved price check is not valid';
  }
  if (!approximatelyEqual(expected.amountPaid, amountPaid)) {
    return 'The saved amount received does not match this sale';
  }
  if (!approximatelyEqual(expected.discount, discount)) {
    return 'The saved discount does not match this sale';
  }
  if (!approximatelyEqual(expected.total, expected.subtotal - expected.discount)) {
    return 'The saved total does not match its subtotal and discount';
  }
  if (!Array.isArray(expected.lines) || expected.lines.length !== lines.length) {
    return 'The saved price check does not cover this cart';
  }

  let quotedSubtotal = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const quote = expected.lines[index];
    if (!quote || quote.medicineId !== line.medicineId || quote.unitKey !== line.unitKey) {
      return 'The saved price check does not match this cart';
    }
    if (quote.quantity !== line.quantity) {
      return 'The saved quantity does not match this cart';
    }
    if (!isMoney(quote.unitPrice) || !isMoney(quote.lineTotal)) {
      return 'A saved line price is not valid';
    }
    if (!approximatelyEqual(quote.lineTotal, quote.unitPrice * quote.quantity)) {
      return 'A saved line total does not match its unit price and quantity';
    }
    quotedSubtotal += quote.lineTotal;
  }
  if (!approximatelyEqual(quotedSubtotal, expected.subtotal)) {
    return 'The saved subtotal does not match its lines';
  }
  return null;
}

type ValidatedIntent =
  | { ok: true; lines: OfflineSaleLine[] }
  | { ok: false; error: string };

/**
 * Structural validation only. Nothing here reads or trusts a cached quantity,
 * price or permission — those are the server's to decide; this gate exists so
 * malformed data cannot squat in the outbox.
 *
 * The payload is deliberately minimal and BUILT, not spread: cart lines,
 * payment shape and customer references, in the snake_case keys the sync
 * handler reads. Nothing else the caller supplied rides along — no cost, no
 * COGS, no margin; those are owner-gated and must never reach the outbox
 * (Phase 1's guard strips them anyway).
 */
export function validateSaleIntent(intent: OfflineSaleIntent): ValidatedIntent {
  if (!Array.isArray(intent.lines) || intent.lines.length === 0) {
    return { ok: false, error: 'The cart is empty' };
  }
  for (const line of intent.lines) {
    if (!line || typeof line.medicineId !== 'string' || !line.medicineId.trim()) {
      return { ok: false, error: 'A cart line is missing its product' };
    }
    if (typeof line.unitKey !== 'string' || !line.unitKey.trim()) {
      return { ok: false, error: 'A cart line is missing its unit' };
    }
    if (
      typeof line.quantity !== 'number' ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0
    ) {
      return { ok: false, error: 'Quantities must be whole numbers of at least one' };
    }
  }
  if (!PAYMENT_METHODS.has(intent.paymentMethod)) {
    return { ok: false, error: 'The payment method is not recognised' };
  }
  if (typeof intent.amountPaid !== 'number' || !Number.isFinite(intent.amountPaid) || intent.amountPaid < 0) {
    return { ok: false, error: 'The amount received is not valid' };
  }
  if (intent.paymentMethod === 'split') {
    if (!intent.paymentBreakdown) {
      return { ok: false, error: 'A split payment must carry its breakdown of methods' };
    }
    if (intent.paymentBreakdown.filter((part) => part.amount > 0).length < 2) {
      return { ok: false, error: 'A split payment needs at least two payment methods' };
    }
    const breakdownProblem = validateBreakdown(intent.paymentBreakdown, intent.amountPaid);
    if (breakdownProblem) return { ok: false, error: breakdownProblem };
  } else if (intent.paymentBreakdown !== undefined) {
    return { ok: false, error: 'A payment breakdown only belongs to a split payment' };
  }
  if (
    intent.discount !== undefined &&
    (typeof intent.discount !== 'number' || !Number.isFinite(intent.discount) || intent.discount < 0)
  ) {
    return { ok: false, error: 'The discount is not valid' };
  }

  const lines = intent.lines.map((line) => ({
    medicineId: line.medicineId.trim(),
    unitKey: line.unitKey.trim(),
    quantity: line.quantity,
  }));
  const expectedProblem = validateExpected(
    intent.expected,
    lines,
    intent.amountPaid,
    intent.discount ?? 0,
  );
  if (expectedProblem) return { ok: false, error: expectedProblem };

  return { ok: true, lines };
}

/**
 * Persists the sale intent DURABLY and only then reports it saved.
 *
 * Repeated clicks keep their per-cart idempotency key, so a second click of the
 * same sale is a duplicate no-op — one outbox row, one eventual server call —
 * never a second sale. A same key with a diverging payload is refused by the
 * outbox conflict guard (Phase 1), never overwritten.
 *
 * The intent is persisted BEFORE the caller learns it saved; a caller that
 * crashes between persist and return leaves exactly one queued row, which the
 * engine later sends idempotently.
 */
export async function recordSaleIntent(
  repo: OfflineRepo,
  intent: OfflineSaleIntent,
  requestedKey?: string,
): Promise<Result<RecordedSaleIntent>> {
  if (!requestedKey || !requestedKey.trim()) {
    return { ok: false, error: 'An idempotency key is required for an offline sale' };
  }
  const validated = validateSaleIntent(intent);
  if (!validated.ok) return { ok: false, error: validated.error };

  // Built field-by-field on purpose: the handler reads exactly these keys, and
  // nothing the caller attached beyond them can leak into the outbox. Lines too
  // are rebuilt to the exact triple — a polluted cart object (cost, margin,
  // supplier fields accidentally included by a caller) must not ride along.
  const quote = intent.expected!;
  const bare = {
    lines: validated.lines,
    // Immutable snapshot of what the attendant saw. The server remains the only
    // authority; this exists solely to detect and expose a later disagreement.
    expected: {
      subtotal: quote.subtotal,
      discount: quote.discount,
      total: quote.total,
      amountPaid: quote.amountPaid,
      lines: quote.lines.map((line) => ({
        medicineId: line.medicineId,
        unitKey: line.unitKey,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
    },
    payment_method: intent.paymentMethod,
    amount_paid: intent.amountPaid,
    discount: intent.discount ?? 0,
    discount_reason: intent.discountReason ?? null,
    customer_id: intent.customerId ?? null,
    credit_account_id: intent.creditAccountId ?? null,
    dispensed_against_prescription: intent.dispensedAgainstPrescription === true,
    // Only present for a split sale, so an ordinary intent keeps the exact
    // shape it always had (and the duplicate-click comparison still matches
    // an outbox row recorded before this field existed).
    ...(intent.paymentBreakdown !== undefined
      ? {
          payment_breakdown: intent.paymentBreakdown.map((part) => ({
            method: part.method,
            amount: part.amount,
          })),
        }
      : {}),
  };

  // Repeated clicks of the same sale MUST be one operation. The occurrence
  // stamp is the only field that differs between two clicks, so the duplicate
  // check ignores it — and a duplicate RETAINS the FIRST stamp: the original
  // occurrence time, never a re-stamped one.
  const existing = await repo.getOutboxOp(requestedKey.trim());
  if (existing && existing.type === POS_SALE_OP_TYPE) {
    const previousPayload = (existing.payload ?? {}) as Record<string, unknown>;
    const existingCore = { ...previousPayload, sold_at: undefined };
    const thisCore = { ...bare, sold_at: undefined };
    if (stableStringify(existingCore) === stableStringify(thisCore)) {
      const payload = existing.payload as { sold_at?: string };
      return {
        ok: true,
        data: {
          idempotencyKey: requestedKey.trim(),
          soldAt: payload.sold_at ?? occurrenceTime(),
          duplicate: true,
        },
      };
    }
    // Same key, genuinely different sale: let the outbox guard record the
    // conflict durably (never overwrite, never silently merge).
    await repo.enqueueOp({ opId: requestedKey.trim(), type: POS_SALE_OP_TYPE, payload: { ...bare } });
    return {
      ok: false,
      error: 'This idempotency key already carries a different sale — it was kept and flagged',
    };
  }

  const soldAt = occurrenceTime();
  const payload = {
    ...bare,
    sold_at: soldAt, // occurrence time; the server validates and owns it
  };

  try {
    const enqueued = await repo.enqueueOp(
      { opId: requestedKey.trim(), type: POS_SALE_OP_TYPE, payload },
      // The occurrence stamp is location-local, not intent identity: two
      // concurrent clicks of one sale stamp it differently, and MUST still be
      // one operation (duplicate, one server call) — never a "conflict" row.
      { ignoreKeys: ['sold_at'] },
    );
    if (!enqueued.ok) {
      return { ok: false, error: enqueued.error ?? 'The sale could not be recorded on this device' };
    }
    if (enqueued.duplicate) {
      // A concurrent (or earlier) click won the write. Return its DURABLE row:
      // the retained first occurrence stamp and the same key, so both callers
      // agree on the sale that will sync.
      const durable = await repo.getOutboxOp(requestedKey.trim());
      const durableSoldAt =
        durable && durable.type === POS_SALE_OP_TYPE && durable.payload && typeof durable.payload === 'object'
          ? ((durable.payload as { sold_at?: string }).sold_at ?? soldAt)
          : soldAt;
      return {
        ok: true,
        data: { idempotencyKey: requestedKey.trim(), soldAt: durableSoldAt, duplicate: true },
      };
    }
    return { ok: true, data: { idempotencyKey: requestedKey.trim(), soldAt, duplicate: false } };
  } catch (error) {
    throw new OfflineStorageError(classifyStorageError(error), 'offline: sale intent persistence failed', {
      cause: error,
    });
  }
}

/* ------------------------------------------------------------- error mapping */

/**
 * PostgREST/Postgres → engine failure kind. The classifications below decide
 * what the operator sees and whether they must act; no juried message is ever
 * fabricated — server text (already written for an attendant, sanitized) is
 * surfaced as-is.
 */
export function classifySaleFailure(input: { error: string; code?: string | null }): {
  kind: HandlerFailureKind;
  message: string;
} {
  const message = input.error || 'The server refused the sale';
  const code = input.code ?? null;

  if (code === '42501' || /insufficient_privilege|permission denied/i.test(message)) {
    return { kind: 'permission', message };
  }
  // Stock exhaustion ("Only X of <name> left in sellable stock"), discount and
  // money shape are customer-visible conflicts on a live till, and are NOT
  // terminal deletes: the sale stays queued with its reasons listed so the
  // attendant can re-run it once they've fixed the cart.
  if (code === '23514' || code === '23503') {
    if (/^only \d/i.test(message)) {
      return { kind: 'conflict', message: `Insufficient stock — ${message}` };
    }
    return { kind: 'validation', message };
  }
  if (code === 'P0002' || code === '22P02') {
    return { kind: 'validation', message };
  }
  // Session/config gaps arrive with no Postgres code either, but they are NOT
  // transport trouble and must never loop as "network": they need the
  // operator's sign-in, not a better connection.
  if (/not signed in|supabase is not configured/i.test(message)) {
    return { kind: 'auth', message };
  }
  // No error code at all means the transport never got a PostgREST answer
  // (failed fetch, timeout, offline edge). Ambiguous outcome: the sale MIGHT
  // have gone through — the engine retries with the SAME key, and the server's
  // replay short-circuit resolves the question safely.
  if (!code || /fetch|network|timeout|failed to fetch/i.test(message)) {
    return { kind: 'network', message };
  }
  // Any other server-emitted ('4xx'/'P0001') rejection is a validation the
  // operator must fix — terminal, stored as a conflict with full detail.
  return { kind: 'validation', message };
}

/* ------------------------------------------------------------------- handler */

/**
 * The POS handler. Injected transport (`deps.completeSale`) — the ONLY server
 * call — is the existing `completeSale` from `src/lib/supabase/sales.ts`; tests
 * swap it for a stub, the POS passes the real one.
 */
export interface PosSaleHandlerDeps {
  completeSale(input: {
    lines: OfflineSaleLine[];
    paymentMethod: string;
    amountPaid: number;
    discount?: number;
    discountReason?: string;
    customerId?: string;
    creditAccountId?: string;
    dispensedAgainstPrescription?: boolean;
    paymentBreakdown?: { method: string; amount: number }[];
    idempotencyKey: string;
    soldAt?: string;
  }): Promise<
    | { ok: true; saleId: string; receiptNumber: string; total: number; lineCount: number; alreadyCompleted: boolean }
    | { ok: false; error: string; code?: string | null }
  >;
  /**
   * Called after a trustworthy server response confirms the sale. The UI layer
   * (pos.tsx) uses it to refresh shelf quantities and surface the truthful
   * "Confirmed by server" state; failures here must not undo the engine's
   * durable outcome.
   */
  onConfirmed?(info: {
    opId: string;
    saleId: string;
    receiptNumber: string;
    alreadyCompleted: boolean;
    soldAt: string | null;
    expectedTotal: number;
    serverTotal: number;
    reconciliation: { reason: string; details: Record<string, unknown> } | null;
  }): Promise<void> | void;
}

/** A bounded send window; an outcome that takes longer is treated as ambiguous. */
const SELL_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${tag} timed out after ${ms}ms`);
      err.name = 'AbortError';
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

export interface SaleReconciliation {
  reason: string;
  details: Record<string, unknown>;
}

/**
 * Compares the server's confirmed total and line count with the quote captured
 * when the sale was committed. It never changes either value and never retries
 * with a new key; a difference is a reconciliation case for a person.
 */
export function reconcileConfirmedSale(
  expected: OfflineSaleExpected,
  response: { total: number; lineCount: number },
): SaleReconciliation | null {
  const totalDiffers = !approximatelyEqual(expected.total, response.total);
  const lineCountDiffers = expected.lines.length !== response.lineCount;
  if (!totalDiffers && !lineCountDiffers) return null;

  const paymentDifference = response.total - expected.amountPaid;
  return {
    reason: totalDiffers ? 'server-total-mismatch' : 'server-line-count-mismatch',
    details: {
      expectedTotal: expected.total,
      serverTotal: response.total,
      expectedLineCount: expected.lines.length,
      serverLineCount: response.lineCount,
      amountPaid: expected.amountPaid,
      // Positive means the customer may owe more than the amount collected;
      // negative means the collected amount exceeds the server total.
      paymentDifference,
    },
  };
}

export function createPosSaleHandler(deps: PosSaleHandlerDeps): SyncHandler {
  return async (op) => {
    let payload: Record<string, unknown> & { sold_at?: string };
    try {
      payload = op.payload as Record<string, unknown> & { sold_at?: string };
    } catch {
      return { ok: false, kind: 'validation', message: 'A queued sale has an unreadable payload' };
    }
    const lines = payload.lines as OfflineSaleLine[] | undefined;
    if (!Array.isArray(lines) || lines.length === 0) {
      return { ok: false, kind: 'validation', message: 'A queued sale has no lines' };
    }

    const amountPaid = Number(payload.amount_paid ?? 0);
    const discount = payload.discount === undefined || payload.discount === null ? 0 : Number(payload.discount);
    const expected = payload.expected as OfflineSaleExpected | undefined;
    const quoteProblem = validateExpected(expected, lines, amountPaid, discount);
    if (quoteProblem) {
      // A sale queued before quotes existed cannot be checked safely. Keep it
      // for human review rather than sending it and hoping the total matches.
      return {
        ok: false,
        kind: 'conflict',
        message: `${quoteProblem}. This sale needs review before it can sync.`,
      };
    }

    let response;
    try {
      response = await withTimeout(
        deps.completeSale({
          lines,
          paymentMethod: String(payload.payment_method ?? 'cash'),
          amountPaid,
          discount,
          discountReason: payload.discount_reason ? String(payload.discount_reason) : undefined,
          customerId: payload.customer_id ? String(payload.customer_id) : undefined,
          creditAccountId: payload.credit_account_id ? String(payload.credit_account_id) : undefined,
          dispensedAgainstPrescription: payload.dispensed_against_prescription === true,
          paymentBreakdown: Array.isArray(payload.payment_breakdown)
            ? (payload.payment_breakdown as { method: string; amount: number }[]).map((part) => ({
                method: String(part.method),
                amount: Number(part.amount),
              }))
            : undefined,
          idempotencyKey: op.opId,
          soldAt: payload.sold_at ? String(payload.sold_at) : undefined,
        }),
        SELL_TIMEOUT_MS,
        'sale completion',
      );
    } catch (thrown) {
      const message =
        typeof thrown === 'object' && thrown !== null && 'message' in thrown
          ? String((thrown as { message?: unknown }).message)
          : String(thrown);
      return { ok: false, kind: 'network', message: sanitizeMessage(message) };
    }

    if (!response.ok) {
      const failure = classifySaleFailure({ error: response.error, code: response.code ?? null });
      return { ok: false, kind: failure.kind, message: failure.message };
    }

    // The server committed the sale. Compare its authoritative total with the
    // quote the attendant saw. A difference does NOT get retried, rewritten or
    // turned into a clean success: the engine records success and a durable
    // reconciliation conflict together.
    const quote = expected!;
    const baseReconciliation = reconcileConfirmedSale(quote, {
      total: response.total,
      lineCount: response.lineCount,
    });
    // Keep the server's identifying response with the comparison so the
    // operator can find the sale in the ledger, not just the two totals.
    const reconciliation: SaleReconciliation | null = baseReconciliation
      ? {
          ...baseReconciliation,
          details: {
            ...baseReconciliation.details,
            receiptNumber: response.receiptNumber,
            saleId: response.saleId,
            alreadyCompleted: response.alreadyCompleted,
            source: 'offline-queue',
          },
        }
      : null;

    // What is mirrored locally is only what the server returned (sale id,
    // receipt, total) — cost data is never returned through this RPC by design,
    // so there is nothing to leak. The `result` travels into the durable
    // outcome record (meta), which is what makes "Confirmed by server" survive a
    // reload.
    //
    // The post-confirmation callback is deliberately FAILURE-PROOF: the server
    // has already committed the sale, so a UI refresh or a toast that throws
    // must NOT turn a truthful, trustworthy outcome into a sync failure. If
    // this call were left unwrapped, the engine would catch the throw, classify
    // it (at best) as a server failure, and re-send an op the server has
    // already settled — burning attempts and reporting the sale as failed.
    try {
      await deps.onConfirmed?.({
        opId: op.opId,
        saleId: response.saleId,
        receiptNumber: response.receiptNumber,
        alreadyCompleted: response.alreadyCompleted,
        soldAt: payload.sold_at ?? null,
        expectedTotal: quote.total,
        serverTotal: response.total,
        reconciliation,
      });
    } catch {
      // Swallowed by design. Durable outcome recording below is the truth; idempotent
      // replay covers the wrap-around case where this whole handler is re-run.
    }
    return {
      ok: true,
      ...(reconciliation ? { reconciliation } : {}),
      result: {
        saleId: response.saleId,
        receiptNumber: response.receiptNumber,
        alreadyCompleted: response.alreadyCompleted,
        soldAt: payload.sold_at ?? null,
        expectedTotal: quote.total,
        serverTotal: response.total,
        ...(reconciliation ? { reconciliation } : {}),
      },
    };
  };
}

/* ---------------------------------------------------------------- view states */

export interface PendingSaleView {
  idempotencyKey: string;
  /** The sale's recorded occurrence time, unrelated to any sync time. */
  soldAt: string | null;
  state: 'pending' | 'needs-attention' | 'conflict';
  attempts: number;
  /** Sanitized, attendant-safe reason. */
  reason: string | null;
  /** The next action the operator can take for it, in their language. */
  nextAction: string;
  /** True only for a server-mismatch conflict: a sale id/receipt exists. */
  serverConfirmed: boolean;
  /** True only when the server explicitly refused the sale, so nothing was written. */
  serverRefused: boolean;
  /** The server receipt for a confirmed mismatch; null for refusals and pending sales. */
  receiptNumber: string | null;
  expectedTotal: number | null;
  serverTotal: number | null;
}

const ACTION_BY_KIND: Record<string, string | undefined> = {
  network: 'Will retry automatically when the pharmacy has a connection',
  server: 'Will retry automatically when the server answers',
  auth: 'Sign in again on this device, then ask a staff member to review this saved sale',
  permission: "Ask the owner to review this account's permissions before this sale is sent again",
  conflict: 'Check the shelf and stock with the owner. This sale stays saved; do not re-ring it until it is resolved',
  validation: 'This copy was refused by the server. Check the sales ledger before ringing the sale again',
  exhausted: 'This sale stopped retrying automatically. Ask an owner to review it before re-ringing it',
  dependency: 'An earlier sale in the queue must be resolved first',
  tenant: 'This sale belongs to another branch. Do not send it from this branch',
  unsupported: 'This sale type has no sync path on this build; ask an owner to review it',
  unknown: 'A staff member needs to look at this sale before it syncs',
};

export function describeAttention(kind: string, reason: string | null): string {
  const action = ACTION_BY_KIND[kind] ?? ACTION_BY_KIND.unknown ?? 'A staff member needs to look at this before it syncs';
  return reason ? `${action} — reason: ${reason}` : action;
}

/**
 * The four truthful states for the POS panel, straight from durable data:
 *
 *   - 'pending'           → Saved on this device, waiting for the engine.
 *   - 'needs-attention'   → The engine will not retry it on its own.
 *   - outcomes look up by opId where a completed row once existed.
 *
 * There is no "sent"/"confirmed" state until the engine completed the op —
 * the ledger (`useSales`) remains the durable confirmation record.
 */
export async function pendingSalesView(repo: OfflineRepo): Promise<{
  pending: PendingSaleView[];
  needsAttention: PendingSaleView[];
  conflicts: PendingSaleView[];
}> {
  const rows = await repo.listOutbox();
  const pending: PendingSaleView[] = [];
  const needsAttention: PendingSaleView[] = [];
  for (const row of rows) {
    if (row.type !== POS_SALE_OP_TYPE) continue;
    const payload = (row.payload ?? {}) as {
      sold_at?: string;
      expected?: { total?: number };
    };
    const state = row.status === 'needs-attention';
    const reason = row.lastError ? `${row.lastError.kind}: ${sanitizeMessage(row.lastError.message)}` : null;
    (state ? needsAttention : pending).push({
      idempotencyKey: row.opId,
      soldAt: payload.sold_at ?? null,
      state: state ? 'needs-attention' : 'pending',
      attempts: row.attempts,
      reason,
      nextAction: state
        ? describeAttention(row.lastError?.kind ?? 'unknown', sanitizeMessage(row.lastError?.message ?? ''))
        : row.nextAttemptAt !== null
          ? `Retry scheduled; ${row.attempts} attempt(s) so far`
          : 'Waiting to sync',
      serverConfirmed: false,
      serverRefused: false,
      receiptNumber: null,
      expectedTotal: typeof payload.expected?.total === 'number' ? payload.expected.total : null,
      serverTotal: null,
    });
  }

  // Conflicts are terminal local records: a server refusal, or a server-
  // confirmed sale whose total differs from the saved quote. Neither is in the
  // outbox, so a view that read only the outbox made them invisible.
  const conflicts: PendingSaleView[] = [];
  for (const conflict of await repo.listConflicts()) {
    if (conflict.type !== POS_SALE_OP_TYPE) continue;
    const payload = (conflict.payload ?? {}) as {
      sold_at?: string;
      expected?: { total?: number };
    };
    const details = conflict.details ?? {};
    const expectedTotal =
      typeof details.expectedTotal === 'number'
        ? details.expectedTotal
        : typeof payload.expected?.total === 'number'
          ? payload.expected.total
          : null;
    const serverTotal = typeof details.serverTotal === 'number' ? details.serverTotal : null;
    const mismatch = conflict.kind === 'server-mismatch' || conflict.serverConfirmed === true;
    const localDuplicate = conflict.kind === 'local-duplicate';
    const serverRefused = !mismatch && !localDuplicate;
    const reason = mismatch
      ? `The server recorded this sale at ${serverTotal ?? 'a different total'}, but this device quoted ${expectedTotal ?? 'a different total'}.`
      : localDuplicate
        ? 'A different cart tried to reuse the id of a sale that is already saved on this device. That second attempt was not sent anywhere.'
        : sanitizeMessage(conflict.serverRejection ?? conflict.reason);
    conflicts.push({
      idempotencyKey: conflict.opId,
      soldAt: payload.sold_at ?? null,
      state: 'conflict',
      attempts: 0,
      reason,
      nextAction: mismatch
        ? 'Do not collect or refund a difference until an owner reviews this sale.'
        : localDuplicate
          ? 'The original saved sale is still queued and will sync under this same ID. Do not ring another sale for the same basket.'
          : 'This sale was refused and is not in the server ledger. Do not assume it was recorded; check the ledger before re-ringing it.',
      serverConfirmed: mismatch,
      serverRefused,
      receiptNumber: typeof details.receiptNumber === 'string' ? details.receiptNumber : null,
      expectedTotal,
      serverTotal,
    });
  }
  conflicts.sort((a, b) => (b.soldAt ?? '').localeCompare(a.soldAt ?? ''));

  return { pending, needsAttention, conflicts };
}

/**
 * Confirmed sales this device has seen returned from the server, alongside
 * their occurrence times. Kept (outcomes live in `meta`) so the state
 * "Confirmed by server" survives a reload even before the ledger refreshes.
 */
export interface ConfirmedSaleView {
  idempotencyKey: string;
  saleId: string | null;
  receiptNumber: string | null;
  soldAt: string | null;
  at: number;
  serverTotal: number | null;
  expectedTotal: number | null;
  reconciliation: Record<string, unknown> | null;
}

export async function confirmedSales(repo: OfflineRepo): Promise<ConfirmedSaleView[]> {
  const outcomes = await repo.listOutboxOutcomes({ type: POS_SALE_OP_TYPE });
  return outcomes
    .filter((o) => o.ok)
    .map((o) => ({
      idempotencyKey: o.opId,
      saleId: (o.result?.saleId as string | null) ?? null,
      receiptNumber: (o.result?.receiptNumber as string | null) ?? null,
      soldAt: (o.result?.soldAt as string | null) ?? null,
      at: o.at,
      serverTotal: typeof o.result?.serverTotal === 'number' ? o.result.serverTotal : null,
      expectedTotal: typeof o.result?.expectedTotal === 'number' ? o.result.expectedTotal : null,
      reconciliation: o.reconciliation,
    }));
}

/* --------------------------------------------------------------- shared type */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
