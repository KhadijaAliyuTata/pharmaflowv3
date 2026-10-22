/**
 * Phase 3 — offline POS sales (client side).
 *
 * Runs against fake-indexeddb with the real outbox + sync engine and a STUB
 * transport standing in for `completeSale` (the only server call the real
 * handler makes). Pins the properties the till depends on:
 *
 *   - the sale intent and its idempotency key are durable BEFORE "saved" is
 *     reported, and survive a repo close/reopen (reload/crash)
 *   - repeated clicks are ONE operation — same key, same payload, duplicate
 *     no-op; a divergent payload with the same key is refused, never merged
 *   - a lost/ambiguous response retries with the SAME key, so the server's
 *     replay short-circuit — not a guess — settles the outcome
 *   - stock conflicts, permission failures and validation rejections are
 *     distinguished, and a rejected sale is preserved with its details and a
 *     next action — never silently discarded
 *   - restricted financial data never reaches the outbox, outcomes, or
 *     attendant-visible views
 *   - a persistence throw rejects as a classified error — callers can never
 *     report "saved" on storage loss, and raw read failures reject too
 *   - the truthful states: saved / pending / needs-attention / confirmed
 *
 * Real-browser checks (Web Locks contention, quota, actual outage) stay manual
 * and are listed in the phase report — same split as Phase 2.
 */

import 'fake-indexeddb/auto';

if (typeof globalThis.localStorage === 'undefined') {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

import { OfflineRepo, OfflineStorageError } from '../../src/offline/local-db.ts';
import { createSyncEngine } from '../../src/offline/sync-engine.ts';
import {
  POS_SALE_OP_TYPE,
  classifySaleFailure,
  confirmedSales,
  createPosSaleHandler,
  newIdempotencyKey,
  pendingSalesView,
  recordSaleIntent,
} from '../../src/offline/pos-offline.ts';
import { findFinancialKeys } from '../../src/offline/financial-guard.ts';
import { createReporter } from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-offline-pos');

const PH1 = '11111111-1111-1111-1111-111111111111';

/** Mutable clock: tests advance time by reassigning `t`. */
let t = 1_800_000_000_000;
const clock = () => t;

const ids = new Map();
const openRepo = (label) => {
  let uid = ids.get(label);
  if (!uid) {
    uid = `pos-${label}`.slice(0, 64);
    ids.set(label, uid);
  }
  return OfflineRepo.open({ pharmacyId: PH1, userId: uid }, 'assistant');
};

const INTENT = {
  lines: [{ medicineId: 'med-1', unitKey: 'box', quantity: 2 }],
  paymentMethod: 'cash',
  amountPaid: 400,
  expected: {
    subtotal: 400,
    discount: 0,
    total: 400,
    amountPaid: 400,
    lines: [
      { medicineId: 'med-1', unitKey: 'box', quantity: 2, unitPrice: 200, lineTotal: 400 },
    ],
  },
};

/* ---------------------------------------------------- 1. durable key + clicks */

section('the sale key is durable, and repeated clicks are one operation');

{
  const repo = await openRepo('durable');
  const key = newIdempotencyKey();

  const first = await recordSaleIntent(repo, INTENT, key);
  check(
    'first click reports saved with the exact key supplied',
    first.ok === true && first.data?.idempotencyKey === key && first.data?.duplicate === false,
    first.ok ? '' : first.error,
  );
  const soldAt = first.data?.soldAt;
  check('the occurrence time was stamped at record time', typeof soldAt === 'string' && !Number.isNaN(Date.parse(soldAt)));

  // Simulate an app reload: close, drop the handle, open again.
  await repo.close?.();
  const reopened = await openRepo('durable');
  const rows = (await reopened.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
  check(
    'the intent survives a close/reopen with the SAME key and payload',
    rows.length === 1 && rows[0].opId === key && rows[0].payload.sold_at === soldAt,
    `rows=${rows.length}, key=${rows[0]?.opId}`,
  );

  const second = await recordSaleIntent(reopened, INTENT, key);
  const afterClick = (await reopened.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
  check(
    'a repeated click is a duplicate no-op — one outbox row, never a second sale',
    second.ok === true && second.data?.duplicate === true && afterClick.length === 1,
    `ok=${second.ok}, rows=${afterClick.length}`,
  );

  const divergent = await recordSaleIntent(
    reopened,
    { ...INTENT, paymentMethod: 'transfer' },
    key,
  );
  check(
    'same key with a diverging payload is refused, not overwritten',
    divergent.ok === false,
    divergent.ok ? 'accepted (should be refused)' : divergent.error,
  );
  const [row] = (await reopened.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
  check(
    'the original intent payload is intact after the refusal',
    row.payload.amount_paid === 400,
    `amount_paid=${row?.payload?.amount_paid}`,
  );
  const localConflict = (await reopened.listConflicts()).find(
    (conflict) => conflict.type === POS_SALE_OP_TYPE,
  );
  const localView = await pendingSalesView(reopened);
  const localConflictView = localView.conflicts.find(
    (conflict) => conflict.idempotencyKey === key,
  );
  check(
    'a different cart reusing the key is classified as a local duplicate, never a server refusal',
    localConflict?.kind === 'local-duplicate' &&
      localConflictView?.serverRefused === false &&
      localConflictView?.serverConfirmed === false &&
      localConflictView?.reason?.includes('not sent anywhere') &&
      localConflictView?.nextAction.includes('Do not ring another sale for the same basket'),
    JSON.stringify({ kind: localConflict?.kind ?? null, view: localConflictView ?? null }),
  );

  // ------------------------------------------------------------ concurrency
  // REGRESSION (Phase 3 review): two clicks inside one tick can both pass the
  // `submitting` guard before it is set, so BOTH may call recordSaleIntent
  // with the same key concurrently. Their occurrence stamps inevitably differ
  // by milliseconds — that must make them ONE operation (a duplicate), never
  // a "duplicate-id-payload-mismatch" conflict.
  {
    const raceRepo = await openRepo('concurrent');
    const raceKey = newIdempotencyKey();
    const [a, b] = await Promise.all([
      recordSaleIntent(raceRepo, INTENT, raceKey),
      recordSaleIntent(raceRepo, INTENT, raceKey),
    ]);
    const raceRows = (await raceRepo.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
    check(
      'concurrent recording of the same sale yields ONE outbox operation',
      a.ok && b.ok && raceRows.length === 1,
      `ok a=${a.ok}, b=${b.ok}; rows=${raceRows.length}`,
    );
    check(
      'both concurrent callers agree on the retained occurrence stamp',
      a.ok && b.ok && a.data.soldAt === b.data.soldAt,
      `a=${a.data?.soldAt} b=${b.data?.soldAt}`,
    );
    const raceConflicts = (await raceRepo.listConflicts()).filter((c) => c.type === POS_SALE_OP_TYPE);
    check(
      'no conflict record is produced for the same intended sale',
      raceConflicts.length === 0,
      `conflicts=${raceConflicts.length}`,
    );
  }
}

/* --------------------------------------------------- 2. ambiguous + retry key */

section('a lost response retries with the SAME key; the replay settles it');

{
  const repo = await openRepo('retry');
  const key = newIdempotencyKey();
  await recordSaleIntent(repo, INTENT, key);

  const calls = [];
  let failWith = { error: 'The network dropped', code: null };
  const handler = createPosSaleHandler({
    completeSale: async (input) => {
      calls.push(input);
      if (failWith) return { ok: false, error: failWith.error, code: failWith.code };
      return {
        ok: true,
        saleId: 'sale-1',
        receiptNumber: 'PF-2026-1',
        total: 400,
        lineCount: 1,
        alreadyCompleted: calls.length > 1,
      };
    },
  });

  const s1 = await createSyncEngine({ repo, handlers: { [POS_SALE_OP_TYPE]: handler }, clock }).runOnce();
  check(
    'an ambiguous (no-code, transport-looking) failure is classified retryable',
    s1.stillPending.includes(key),
    JSON.stringify({ sent: s1.sent, completed: s1.completed, needsAttention: s1.needsAttention, stillPending: s1.stillPending }),
  );
  check(
    'the first call carried the durable key as the server idempotency key',
    calls[0]?.idempotencyKey === key,
    `key=${calls[0]?.idempotencyKey}`,
  );
  check(
    'the occurrence time travelled to the server untouched',
    typeof calls[0]?.soldAt === 'string',
    `soldAt=${calls[0]?.soldAt}`,
  );

  // Connectivity returns; the retry reuses the SAME key (nothing regenerated).
  failWith = null;
  t += 10 * 60_000;
  const s2 = await createSyncEngine({ repo, handlers: { [POS_SALE_OP_TYPE]: handler }, clock }).runOnce();
  check(
    'the retry completes the sale through the replay short-circuit',
    s2.completed.includes(key),
    JSON.stringify(s2),
  );
  check(
    'both attempts used the SAME idempotency key',
    calls.length === 2 && calls[1]?.idempotencyKey === key,
    `calls=${calls.length}, keys=${calls.map((c) => c.idempotencyKey).join(',')}`,
  );
  const confirmed = await confirmedSales(repo);
  check(
    'the confirmed state is durable (survives the op row removal)',
    confirmed.length === 1 && confirmed[0].idempotencyKey === key && confirmed[0].saleId === 'sale-1' &&
      confirmed[0].soldAt === (calls[0]?.soldAt ?? null),
    JSON.stringify(confirmed),
  );

  // ---------------------------------------------------------------- onConfirmed
  // REGRESSION (Phase 3 review): a UI refresh / notification callback that
  // throws AFTER the server has committed must not turn an already-confirmed
  // server transaction into a sync failure. Before the fix the engine caught
  // the throw and re-sent the op (the server replays it, so no duplicate sale
  // ever rang up — but the durable outcome was lost for the attempt, attempts
  // burned, and the till was told the sale failed when it had succeeded).
  const repo2 = await openRepo('confirm-throw');
  const key2 = newIdempotencyKey();
  await recordSaleIntent(repo2, INTENT, key2);
  let threwOnce = false;
  const throwingHandler = createPosSaleHandler({
    completeSale: async () => ({
      ok: true,
      saleId: 'sale-2',
      receiptNumber: 'PF-2026-2',
      total: 400,
      lineCount: 1,
      alreadyCompleted: false,
    }),
    onConfirmed: async () => {
      threwOnce = true;
      throw new Error('UI refresh exploded after the server committed');
    },
  });
  const threwSummary = await createSyncEngine({
    repo: repo2,
    handlers: { [POS_SALE_OP_TYPE]: throwingHandler },
    clock,
  }).runOnce();
  check(
    'a throwing onConfirmed does not surface as a failed sync',
    threwSummary.completed.includes(key2) && !threwSummary.needsAttention.some((e) => e.opId === key2),
    JSON.stringify({ completed: threwSummary.completed, sent: threwSummary.sent, needsAttention: threwSummary.needsAttention }),
  );
  const confirmed2 = await confirmedSales(repo2);
  check(
    'the sale remains durably confirmed despite the UI failure',
    confirmed2.length === 1 && confirmed2[0].idempotencyKey === key2 && confirmed2[0].saleId === 'sale-2',
    JSON.stringify(confirmed2),
  );
  const outboxAfterThrow = (await repo2.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
  check(
    'the confirmed sale is NOT re-queued or retried after the UI failure',
    outboxAfterThrow.length === 0 && threwOnce === true,
    `outbox=${outboxAfterThrow.length}, called=${threwOnce}`,
  );
}

/* --------------------------------------------- 2b. price/payment reconciliation */

section('a server total that differs from the quote is visible, never a clean success');

{
  const repo = await openRepo('price-up');
  const key = newIdempotencyKey();
  await recordSaleIntent(repo, INTENT, key);

  const handler = createPosSaleHandler({
    completeSale: async () => ({
      ok: true,
      saleId: 'sale-price-up',
      receiptNumber: 'PF-2026-UP',
      total: 450,
      lineCount: 1,
      alreadyCompleted: false,
    }),
  });
  const summary = await createSyncEngine({
    repo,
    handlers: { [POS_SALE_OP_TYPE]: handler },
    clock,
  }).runOnce();

  const conflicts = await repo.listConflicts();
  check(
    'the server-completed sale is recorded, not retried or rejected',
    summary.completed.includes(key) && summary.rejected.length === 0,
    JSON.stringify(summary),
  );
  check(
    'the original payload and idempotency key are preserved for reconciliation',
    conflicts.length === 1 &&
      conflicts[0].opId === key &&
      conflicts[0].payload.amount_paid === 400 &&
      conflicts[0].kind === 'server-mismatch' &&
      conflicts[0].serverConfirmed === true,
    JSON.stringify(conflicts[0] ?? null),
  );
  check(
    'the quoted and server totals are both stored for the operator',
    conflicts[0]?.details?.expectedTotal === 400 &&
      conflicts[0]?.details?.serverTotal === 450 &&
      conflicts[0]?.details?.paymentDifference === 50,
    JSON.stringify(conflicts[0]?.details ?? null),
  );

  const view = await pendingSalesView(repo);
  check(
    'an empty pending queue does not hide the price mismatch',
    view.pending.length === 0 &&
      view.conflicts.length === 1 &&
      view.conflicts[0].receiptNumber === 'PF-2026-UP' &&
      /450/.test(view.conflicts[0].reason ?? '') &&
      /owner/i.test(view.conflicts[0].nextAction),
    JSON.stringify(view),
  );

  const confirmed = await confirmedSales(repo);
  check(
    'the confirmed view carries the reconciliation instead of pretending the receipt was clean',
    confirmed.length === 1 &&
      confirmed[0].expectedTotal === 400 &&
      confirmed[0].serverTotal === 450 &&
      confirmed[0].reconciliation?.reason === 'server-total-mismatch',
    JSON.stringify(confirmed),
  );
}

{
  // An online sale has no outbox row, but its price mismatch still needs a
  // durable review record. The POS writes this through repo.recordConflict with
  // an explicit server-mismatch classification.
  const repo = await openRepo('online-mismatch');
  const key = newIdempotencyKey();
  await repo.recordConflict({
    opId: key,
    type: POS_SALE_OP_TYPE,
    payload: { expected: INTENT.expected, sold_at: '2026-10-20T12:00:00.000Z' },
    reason: 'server-total-mismatch',
    kind: 'server-mismatch',
    serverConfirmed: true,
    details: {
      expectedTotal: 400,
      serverTotal: 450,
      amountPaid: 400,
      paymentDifference: 50,
      receiptNumber: 'PF-2026-ONLINE',
    },
  });
  const view = await pendingSalesView(repo);
  check(
    'an online total mismatch is storable and visible as server-confirmed, not a refusal',
    view.conflicts.length === 1 &&
      view.conflicts[0].serverConfirmed === true &&
      view.conflicts[0].serverRefused === false &&
      view.conflicts[0].receiptNumber === 'PF-2026-ONLINE' &&
      view.conflicts[0].expectedTotal === 400 &&
      view.conflicts[0].serverTotal === 450 &&
      /450/.test(view.conflicts[0].reason ?? ''),
    JSON.stringify(view),
  );
}

{
  const repo = await openRepo('price-down');
  const key = newIdempotencyKey();
  await recordSaleIntent(repo, INTENT, key);
  const handler = createPosSaleHandler({
    // The real server refuses an overpayment before writing: a lower server
    // total with ₦400 collected is a terminal validation refusal, not a sale.
    completeSale: async () => ({
      ok: false,
      error: 'Amount received is more than the total',
      code: '23514',
    }),
  });
  const summary = await createSyncEngine({
    repo,
    handlers: { [POS_SALE_OP_TYPE]: handler },
    clock,
  }).runOnce();
  const view = await pendingSalesView(repo);
  check(
    'a price decrease that makes the collected cash excessive is preserved as a refusal',
    summary.rejected.includes(key) &&
      view.conflicts.length === 1 &&
      view.conflicts[0].serverConfirmed === false &&
      view.conflicts[0].nextAction.includes('not in the server ledger'),
    JSON.stringify({ summary, view }),
  );
}

{
  const repo = await openRepo('split-mismatch');
  const key = newIdempotencyKey();
  await recordSaleIntent(
    repo,
    {
      ...INTENT,
      paymentMethod: 'split',
      paymentBreakdown: [
        { method: 'cash', amount: 200 },
        { method: 'transfer', amount: 200 },
      ],
    },
    key,
  );
  const handler = createPosSaleHandler({
    completeSale: async () => ({
      ok: true,
      saleId: 'sale-split-up',
      receiptNumber: 'PF-2026-SPLIT',
      total: 425,
      lineCount: 1,
      alreadyCompleted: false,
    }),
  });
  await createSyncEngine({ repo, handlers: { [POS_SALE_OP_TYPE]: handler }, clock }).runOnce();
  const view = await pendingSalesView(repo);
  const conflicts = await repo.listConflicts();
  check(
    'a split-payment sale with a changed server total is escalated with the amount paid retained',
    view.conflicts.length === 1 &&
      view.conflicts[0].expectedTotal === 400 &&
      view.conflicts[0].serverTotal === 425 &&
      view.conflicts[0].reason?.includes('425') &&
      conflicts[0]?.payload.payment_breakdown?.length === 2,
    JSON.stringify({ view, payload: conflicts[0]?.payload ?? null }),
  );
}

/* ------------------------------------------------- 3. stock conflict handling */

section('a stock conflict is preserved with its reason, never retried nor discarded');

{
  const repo = await openRepo('conflict');
  const key = newIdempotencyKey();
  await recordSaleIntent(
    repo,
    {
      ...INTENT,
      lines: [{ medicineId: 'med-1', unitKey: 'box', quantity: 50 }],
      expected: {
        subtotal: 400,
        discount: 0,
        total: 400,
        amountPaid: 400,
        lines: [
          { medicineId: 'med-1', unitKey: 'box', quantity: 50, unitPrice: 8, lineTotal: 400 },
        ],
      },
    },
    key,
  );

  const handler = createPosSaleHandler({
    completeSale: async () => ({
      ok: false,
      error: 'Only 30 of Paracetamol left in sellable stock',
      code: '23514',
    }),
  });
  const summary = await createSyncEngine({ repo, handlers: { [POS_SALE_OP_TYPE]: handler }, clock }).runOnce();
  check(
    'stock shortage lands in needs-attention, out of the retry rotation',
    summary.needsAttention.some((entry) => entry.opId === key),
    JSON.stringify(summary.needsAttention),
  );
  const view = await pendingSalesView(repo);
  check(
    'the operator sees the sale as needs-attention with the server reason',
    view.needsAttention.length === 1 &&
      /insufficient stock/i.test(view.needsAttention[0].reason ?? '') &&
      /shelf/i.test(view.needsAttention[0].nextAction ?? ''),
    JSON.stringify(view),
  );
  const still = (await repo.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
  check(
    'the sale intent itself is still on the device (not deleted, not sent again)',
    still.length === 1 && still[0].status === 'needs-attention' && still[0].inFlightSince === null,
    JSON.stringify(still[0] ?? null),
  );
}

/* ----------------------------------------------- 4. validation rejection path */

section('a validation rejection is preserved in conflicts with a next action');

{
  const repo = await openRepo('validation');
  const key = newIdempotencyKey();
  await recordSaleIntent(repo, INTENT, key);

  const handler = createPosSaleHandler({
    completeSale: async () => ({ ok: false, error: 'Product med-1 does not exist', code: 'P0002' }),
  });
  const summary = await createSyncEngine({ repo, handlers: { [POS_SALE_OP_TYPE]: handler }, clock }).runOnce();
  check('a server-validated rejection is terminal (moved to conflicts)', summary.rejected.includes(key), JSON.stringify(summary));

  const outboxLeft = (await repo.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
  const conflicts = await repo.listConflicts();
  check(
    'the rejected sale keeps its details in the conflicts store',
    outboxLeft.length === 0 && conflicts.length === 1 && conflicts[0].opId === key,
    `outbox=${outboxLeft.length}, conflicts=${JSON.stringify(conflicts)}`,
  );
  const rejectView = await pendingSalesView(repo);
  check(
    'a terminal validation failure is visible in the recovery view, not hidden by an empty pending queue',
    rejectView.pending.length === 0 &&
      rejectView.needsAttention.length === 0 &&
      rejectView.conflicts.length === 1 &&
      rejectView.conflicts[0].idempotencyKey === key &&
      rejectView.conflicts[0].serverConfirmed === false,
    JSON.stringify(rejectView),
  );
  check(
    'the recovery view says the refused sale is not in the ledger and preserves its idempotency key',
    rejectView.conflicts[0]?.nextAction.includes('not in the server ledger') &&
      rejectView.conflicts[0]?.idempotencyKey === key,
    JSON.stringify(rejectView.conflicts[0] ?? null),
  );
  check(
    'the server explanation and classification are preserved with the refused sale',
    conflicts[0]?.reason === 'validation-failure' &&
      /Product med-1 does not exist/.test(conflicts[0]?.serverRejection ?? ''),
    JSON.stringify(conflicts[0] ?? null),
  );
}

/* ------------------------------------------------- 5. permission failures */

section('permission failures are attention-worthy, not retried blindly');

{
  const repo = await openRepo('permission');
  const key = newIdempotencyKey();
  await recordSaleIntent(repo, INTENT, key);
  const handler = createPosSaleHandler({
    completeSale: async () => ({ ok: false, error: 'permission denied for table sales', code: '42501' }),
  });
  const summary = await createSyncEngine({ repo, handlers: { [POS_SALE_OP_TYPE]: handler }, clock }).runOnce();
  const view = await pendingSalesView(repo);
  check(
    'a role/permission refusal needs a person, and says what that person does',
    view.needsAttention.length === 1 && /owner/i.test(view.needsAttention[0].nextAction ?? ''),
    JSON.stringify({ summary, view }),
  );
}

/* ------------------------------------------------ 5b. quote safety boundaries */

section('a sale without a truthful quote is refused before it enters the outbox');

{
  const repo = await openRepo('no-quote');
  const noQuote = { ...INTENT, expected: undefined };
  const refused = await recordSaleIntent(repo, noQuote, newIdempotencyKey());
  check(
    'a missing price snapshot is refused with a specific reason',
    refused.ok === false && /price check/i.test(refused.error),
    refused.ok ? 'accepted' : refused.error,
  );
  check(
    'nothing was queued when the quote was missing',
    (await repo.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE).length === 0,
  );

  const lyingQuote = {
    ...INTENT,
    expected: { ...INTENT.expected, total: 399 },
  };
  const inconsistent = await recordSaleIntent(repo, lyingQuote, newIdempotencyKey());
  check(
    'an internally inconsistent quote is refused rather than stored',
    inconsistent.ok === false && /subtotal/i.test(inconsistent.error),
    inconsistent.ok ? 'accepted' : inconsistent.error,
  );
}

/* ------------------------------------------------- 6. financial data hygiene */

section('restricted financial data never reaches the outbox or outcomes');

{
  const repo = await openRepo('financial');
  const key = newIdempotencyKey();
  // A caller that hands the recorder a cart line polluted with owner-only
  // financial fields: the payload must be built so nothing rides along.
  const polluted = {
    ...INTENT,
    lines: [
      {
        medicineId: 'med-1',
        unitKey: 'box',
        quantity: 2,
        cost_per_base_unit: 20,
        costTotal: 99999,
        margin: 40,
        supplier_price: 15.5,
      },
    ],
    discountReason: 'Owner cost override margin 40%',
  };
  await recordSaleIntent(repo, polluted, key);
  const [row] = (await repo.listOutbox()).filter((r) => r.type === POS_SALE_OP_TYPE);
  const leaks = findFinancialKeys(row.payload);
  check(
    'the stored payload carries no forbidden financial keys',
    leaks.length === 0,
    leaks.length > 0 ? leaks.join(', ') : '',
  );
  const serialized = JSON.stringify(row.payload);
  check(
    'no cost or margin figures are serialized into the outbox',
    !/99999|supplier_price|"margin"/.test(serialized),
    serialized,
  );

  // And a validation rejection must not leak through the conflicts store.
  const rejectHandler = createPosSaleHandler({
    completeSale: async () => ({ ok: false, error: 'Product does not exist', code: 'P0002' }),
  });
  await createSyncEngine({ repo, handlers: { [POS_SALE_OP_TYPE]: rejectHandler }, clock }).runOnce();
  const conflicts = await repo.listConflicts();
  check(
    'the conflicts copy is financially clean too',
    conflicts.length === 1 && findFinancialKeys(conflicts[0].payload).length === 0,
    JSON.stringify(conflicts[0]?.payload ?? null),
  );
}

/* ------------------------------------------------------ 7. failure mapping */

section('classification distinguishes the operators that matter');

check(
  'stock exhaustion (23514, "Only N ...") → conflict, retriable by a person after restock',
  classifySaleFailure({ error: 'Only 30 of X left in sellable stock', code: '23514' }).kind === 'conflict',
);
check(
  'other money-shape rejections (23514) → validation, terminal',
  classifySaleFailure({ error: 'Amount received is more than the total', code: '23514' }).kind === 'validation',
);
check('unknown product (P0002) → validation', classifySaleFailure({ error: 'Product does not exist', code: 'P0002' }).kind === 'validation');
check('permission denied (42501) → permission', classifySaleFailure({ error: 'permission denied', code: '42501' }).kind === 'permission');
check(
  'a failed fetch (transport, no code) → network, auto-retried',
  classifySaleFailure({ error: 'TypeError: Failed to fetch', code: null }).kind === 'network',
);

/* --------------------------------------------- 8. persistence throw contract */

section('a persistence failure REJECTS loudly — callers can never mistake it for "saved"');

{
  // REGRESSION (Phase 3 review): recordSaleIntent must throw on a storage
  // failure, and the throw must arrive as a classified OfflineStorageError.
  // The screen's catch shows "the sale was NOT recorded" — a lie if this
  // ever resolved ok, invisible if it swallowed the rejection.
  const fullDisk = {
    getOutboxOp: async () => undefined,
    enqueueOp: async () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    },
  };
  let rejection = null;
  await recordSaleIntent(fullDisk, INTENT, newIdempotencyKey()).then(
    (r) => {
      rejection = `RESOLVED ok=${r.ok}`;
    },
    (e) => {
      rejection = e;
    },
  );
  check(
    'a full disk rejects with a classified OfflineStorageError (kind quota) — never a silent loss',
    rejection instanceof OfflineStorageError && rejection.kind === 'quota',
    String(rejection),
  );
  check(
    'the rejection MESSAGE says persistence failed, not just a vendor code',
    rejection instanceof OfflineStorageError && rejection.message.includes('persistence'),
    String(rejection),
  );

  // A raw read failure before the guarded write path must ALSO reject —
  // callers catch ANY rejection, not only OfflineStorageError.
  const brokenRead = {
    getOutboxOp: async () => {
      throw new TypeError('db connection lost');
    },
    enqueueOp: async () => undefined,
  };
  let readFailure = null;
  await recordSaleIntent(brokenRead, INTENT, newIdempotencyKey()).then(
    (r) => {
      readFailure = `RESOLVED ok=${r.ok}`;
    },
    (e) => {
      readFailure = e;
    },
  );
  check(
    'a raw storage read failure rejects too (any rejection is caught, nothing resolves ok)',
    readFailure instanceof Error && readFailure.name === 'TypeError',
    String(readFailure),
  );
}

note(
  'real-browser checks remain manual',
  'Web Locks two-tab contention, real QuotaExceededError, the lease adapter against real localStorage, and a genuine outage must be checked in a browser — same list as Phase 2, plus the POS screen walk-through',
);

process.exit(await finish());
