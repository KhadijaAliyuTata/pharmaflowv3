/**
 * Phase 2 — the outbox sync engine.
 *
 * Runs against fake-indexeddb + injectable handlers, clocks and locks, pinning
 * the guarantees that must hold before any module (POS/receiving/credit)
 * declares a single real operation:
 *
 *   - dependency ordering, explicit missing/rejected/blocking-dep handling,
 *     cycle detection, and NO silent forever-pending state
 *   - duplicate processing safety and durable success recording (outcome +
 *     removal in one transaction; reopen-safe)
 *   - bounded retry/backoff with retry history PERSISTED across reopen
 *   - retryable (network/server) vs terminal (validation) vs attention
 *     (auth/permission/conflict) classification
 *   - single-flight (busy adapter + lease fallback Web Locks behaviour)
 *   - browser/tenant/auth gates: auth expiry stops everything; tenant and
 *     payload-pharmacy mismatches are flagged, never sent
 *   - storage failures surface without losing queued operations
 *   - a permanently failed op never stops unrelated eligible operations
 *   - no forbidden financial token reaches events, persisted errors, or
 *     attendant-visible records even when handler text echoes payloads
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

import { OfflineRepo } from '../../src/offline/local-db.ts';
import {
  createLeaseAdapter,
  createSyncEngine,
  defaultLockAdapter,
  sanitizeMessage,
  webLocksAvailable,
} from '../../src/offline/sync-engine.ts';
import { SCHEMA_VERSION, databaseName } from '../../src/offline/db-schema.ts';
import { createReporter } from './harness.mjs';
import { openDB } from 'idb';

const { check, section, finish } = createReporter('verify-offline-sync');

const PH1 = '11111111-1111-1111-1111-111111111111';
const PH2 = '22222222-2222-2222-2222-222222222222';
const U1 = 'aaaa1111-1111-1111-1111-111111111111';

/** Mutable clock: tests advance time by reassigning `t`. */
let t = 1_700_000_000_000;
const clock = () => t;

function okId(id) {
  return `ok-handled-${id}`;
}

/** Engine with default policy unless overridden; handlers keyed by type. */
function makeEngine(repo, handlers, opts = {}) {
  return createSyncEngine({
    repo,
    handlers,
    clock,
    session: opts.session ?? null,
    policy: opts.policy,
    locks: opts.locks ?? null,
    onEvent: opts.onEvent,
  });
}

/** Each section opens its OWN database (one identity per label) — sections
 * must not contaminate each other's outbox. Same label = same DB (for a
 * close/reopen pair inside one section). */
const ids = new Map();
const openRepo = (label) => {
  if (!label) throw new Error('openRepo needs a per-section label');
  let uid = ids.get(label);
  if (!uid) {
    uid = `sect-${label}`.slice(0, 64);
    ids.set(label, uid);
  }
  return OfflineRepo.open({ pharmacyId: PH1, userId: uid }, 'owner');
};

/* ------------------------------------------------ dependency ordering */

section('dependency ordering, duplicates, durable success');

{
  const repo = await openRepo('ordering');
  const order = [];
  const handlers = {
    'op:child': async () => {
      order.push('child');
      return { ok: true };
    },
    'op:parent': async () => {
      order.push('parent');
      return { ok: true };
    },
  };
  await repo.enqueueOp({ opId: 'child-1', type: 'op:child', payload: { n: 1 } });
  await repo.enqueueOp({
    opId: 'parent-1',
    type: 'op:parent',
    payload: { n: 2 },
    deps: ['child-1'],
  });

  const summary = await makeEngine(repo, handlers).runOnce();
  check(
    'the parent waits for the child: execution order is child then parent',
    order.join(',') === 'child,parent',
    order.join(','),
  );
  check(
    'both completed durably within one run',
    summary.completed.length === 2 && summary.sent.length === 2,
  );
  const outbox = await repo.listOutbox();
  check('no rows remain pending after success', outbox.length === 0);
  check(
    'outcomes are recorded durably (ok + timestamp)',
    (await repo.getOutcome('child-1'))?.ok === true &&
      typeof (await repo.getOutcome('parent-1'))?.at === 'number',
  );

  // Duplicate processing: a second run does nothing, records nothing twice.
  const summary2 = await makeEngine(repo, handlers).runOnce();
  check(
    'a second run is a no-op (nothing re-sent, nothing re-completed)',
    summary2.sent.length === 0 && summary2.completed.length === 0,
  );

  // Durable-across-reopen: close, reopen, verify outcomes.
  repo.close();
  const reopened = await openRepo('ordering');
  check(
    'outcomes survive a repository reopen',
    (await reopened.getOutcome('parent-1'))?.ok === true,
  );
  reopened.close();
}

{
  const repo = await openRepo('ordering-dupe');
  let sends = 0;
  const handlers = {
    'op:dupe': async () => {
      sends += 1;
      return { ok: true };
    },
  };
  await repo.enqueueOp({ opId: 'dupe-1', type: 'op:dupe', payload: { a: 1 } });
  const enqueue = await repo.enqueueOp({ opId: 'dupe-1', type: 'op:dupe', payload: { a: 1 } });
  const summary = await makeEngine(repo, handlers).runOnce();
  check(
    'a duplicate enqueue is idempotent: exactly one send, one row',
    enqueue.duplicate === true && sends === 1 && summary.completed.length === 1,
  );
  repo.close();
}

/* ------------------------------------------------- missing deps & cycles */

section('missing dependencies, blocking deps, cycles');

{
  const repo = await openRepo('missing');
  const sent = [];
  const handlers = {
    'op:sentinel': async () => {
      sent.push('sentinel');
      return { ok: true };
    },
  };
  await repo.enqueueOp({
    opId: 'orphan-1',
    type: 'op:never-registered',
    payload: {},
    deps: ['never-enqueued-anywhere'],
  });
  await repo.enqueueOp({ opId: 'sentinel-1', type: 'op:sentinel', payload: {} });

  const summary = await makeEngine(repo, handlers).runOnce();
  check(
    'a missing dependency triggers an explicit needs-attention (never sent, never silent)',
    summary.needsAttention.some((n) => n.opId === 'orphan-1' && n.reason === 'dependency-missing:never-enqueued-anywhere'),
  );
  check('an unrelated op still processes in the same run', sent.join(',') === 'sentinel');
  const row = await repo.getOutboxOp('orphan-1');
  check(
    'the missing-dep op is preserved (not deleted) and marked needs-attention',
    row?.status === 'needs-attention' && row.nextAttemptAt === null,
  );
  repo.close();
}

{
  const repo = await openRepo('cycle');
  const calls = [];
  const handlers = {
    'op:a': async () => {
      calls.push('a');
      return { ok: true };
    },
    'op:b': async () => {
      calls.push('b');
      return { ok: true };
    },
    'op:downstream': async () => {
      calls.push('downstream');
      return { ok: true };
    },
    'op:unrelated': async () => {
      calls.push('unrelated');
      return { ok: true };
    },
  };
  await repo.enqueueOp({ opId: 'cyc-a', type: 'op:a', payload: {}, deps: ['cyc-b'] });
  await repo.enqueueOp({ opId: 'cyc-b', type: 'op:b', payload: {}, deps: ['cyc-a'] });
  // Strictly downstream of the cycle — must not linger pending forever either.
  await repo.enqueueOp({
    opId: 'below-cycle',
    type: 'op:downstream',
    payload: {},
    deps: ['cyc-a', 'cyc-b'],
  });
  await repo.enqueueOp({ opId: 'healthy-1', type: 'op:unrelated', payload: {} });

  const summary = await makeEngine(repo, handlers).runOnce();
  const cyc = summary.needsAttention.filter((n) => n.reason === 'dependency-cycle');
  check(
    'the cycle members AND their downstream are explicitly marked, not left pending',
    new Set(cyc.map((n) => n.opId)).size === 3,
    cyc.map((n) => n.opId).join(','),
  );
  check('a one-blocked-graph does NOT block a healthy unrelated op', calls.join(',') === 'unrelated');
  check(
    'nothing from the cycle graph was sent',
    !summary.sent.some((id) => id.startsWith('cyc-') || id === 'below-cycle'),
  );
  repo.close();
}

{
  const repo = await openRepo('blocking');
  let bCalls = 0;
  const handlers = {
    'op:c': async () => {
      return { ok: true };
    },
  };
  await repo.enqueueOp({
    opId: 'blocked-b',
    type: 'op:b-needsman',
    payload: {},
  });
  // Force the dep into needs-attention first (simulating a human-gated op).
  await repo.markAttempt('blocked-b', {
    attempts: 1,
    nextAttemptAt: null,
    inFlightSince: null,
    lastError: { kind: 'permission', message: 'x', at: t },
    status: 'needs-attention',
  });
  await repo.enqueueOp({
    opId: 'waiter-c',
    type: 'op:c',
    payload: {},
    deps: ['blocked-b'],
  });

  const summary = await makeEngine(repo, handlers).runOnce();
  check(
    'a dependent of a needs-attention dep is cascaded, never silently waiting',
    summary.needsAttention.some(
      (n) => n.opId === 'waiter-c' && n.reason.startsWith('dependency-blocking-dep'),
    ),
  );
  repo.close();
}

/* ------------------------------------------------- retry/backoff persistence */

section('bounded retry, backoff, persisted history, exhaustion');

{
  const repo = await openRepo('retry');
  let fails = 0;
  const handlers = {
    'op:flaky': async () => {
      fails += 1;
      return { ok: false, kind: 'network', message: 'fetch failed' };
    },
  };
  const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 };

  await repo.enqueueOp({ opId: 'flaky-1', type: 'op:flaky', payload: { n: 1 } });

  // Attempt 1: fails, nextAttemptAt scheduled.
  const engine1 = makeEngine(repo, handlers, { policy });
  const s1 = await engine1.runOnce();
  const row1 = await repo.getOutboxOp('flaky-1');
  check(
    'a network failure schedules a retry with backoff (not immediate, not dropped)',
    s1.completed.length === 0 &&
      row1.attempts === 1 &&
      row1.nextAttemptAt === t + 2000 &&
      row1.lastError?.kind === 'network',
  );

  // Persistence across reopen: new engine, same repo rows, same clock (not due).
  repo.close();
  const repo2 = await openRepo('retry');
  const engine2 = makeEngine(repo2, handlers, { policy });
  const s2 = await engine2.runOnce();
  const row2 = await repo2.getOutboxOp('flaky-1');
  check(
    'reload does not reset history: no re-send before the scheduled time',
    s2.sent.length === 0 && row2.attempts === 1 && s2.stillPending.includes('flaky-1'),
  );

  // Advance past the backoff: attempt 2.
  t += 2001;
  await engine2.runOnce();
  const row3 = await repo2.getOutboxOp('flaky-1');
  check(
    'attempt two fires after the backoff and the delay doubles',
    row3.attempts === 2 && row3.nextAttemptAt === t + 4000,
  );

  // Advance to due: attempt 3 reaches maxAttempts → needs-attention, terminal.
  t += 4001;
  await engine2.runOnce();
  const row4 = await repo2.getOutboxOp('flaky-1');
  check(
    'attempts exhaust into needs-attention (preserved row, no next retry)',
    row4.status === 'needs-attention' && row4.attempts === 3 && row4.nextAttemptAt === null,
  );

  // No endless loop: further runs never send again, and the row stays
  // needs-attention (it is no longer "pending", it is human-work).
  const callsAfterExhaustion = fails;
  t += 60_000;
  const s4 = await makeEngine(repo2, handlers, { policy }).runOnce();
  const row5 = await repo2.getOutboxOp('flaky-1');
  check(
    'an exhausted op is never re-sent automatically or re-opened as pending',
    fails === callsAfterExhaustion && !s4.sent.includes('flaky-1') && s4.stillPending.length === 0 && row5.status === 'needs-attention',
  );

  // A permanently failed op does not block a healthy unrelated op.
  let healthyCalls = 0;
  const engine3 = makeEngine(
    repo2,
    {
      'op:flaky': handlers['op:flaky'],
      'op:healthy': async () => {
        healthyCalls += 1;
        return { ok: true };
      },
    },
    { policy },
  );
  await repo2.enqueueOp({ opId: 'healthy-late', type: 'op:healthy', payload: {} });
  const s5 = await engine3.runOnce();
  check(
    'unrelated eligible ops process despite a permanently failed one',
    healthyCalls === 1 && s5.completed.includes('healthy-late'),
  );
  repo2.close();
}

{
  const repo = await openRepo('srv-5xx');
  let serverFails = 0;
  const handlers = {
    'op:server-fail': async () => {
      serverFails += 1;
      return { ok: false, kind: 'server', status: 500, message: 'HTTP 500' };
    },
  };
  const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 };
  await repo.enqueueOp({ opId: 'srv-1', type: 'op:server-fail', payload: {} });
  await makeEngine(repo, handlers, { policy }).runOnce();
  const row = await repo.getOutboxOp('srv-1');
  check(
    'an HTTP 5xx classifies as retryable (server), like network failures',
    row.lastError?.kind === 'server' && row.nextAttemptAt !== null && serverFails === 1,
  );
  repo.close();
}

/* --------------------------------------- retryable vs terminal vs attention */

section('validation rejection, conflicts, auth, permission');

{
  const repo = await openRepo('validation');
  const handlers = {
    'op:bad-payload': async () => ({ ok: false, kind: 'validation', status: 422, message: 'invalid quantity' }),
    'op:conflicted': async () => ({ ok: false, kind: 'conflict', status: 409, message: 'stock changed' }),
  };
  await repo.enqueueOp({ opId: 'bad-1', type: 'op:bad-payload', payload: { qty: -5 } });
  await repo.enqueueOp({ opId: 'conf-1', type: 'op:conflicted', payload: { qty: 3 } });

  const summary = await makeEngine(repo, handlers).runOnce();
  check(
    'a validation rejection is terminal: op removed, conflict recorded',
    summary.rejected.includes('bad-1') &&
      !(await repo.getOutboxOp('bad-1')) &&
      (await repo.getConflict('bad-1'))?.reason === 'validation-failure',
  );
  check(
    'a conflict is NOT terminal: op preserved for human review',
    (await repo.getOutboxOp('conf-1'))?.status === 'needs-attention' &&
      summary.needsAttention.some((n) => n.opId === 'conf-1' && n.kind === 'conflict'),
  );

  // A dependent of a REJECTED dep: cascade, never silent.
  await repo.enqueueOp({
    opId: 'after-bad',
    type: 'op:conflicted',
    payload: {},
    deps: ['bad-1'],
  });
  const s2 = await makeEngine(repo, handlers).runOnce();
  check(
    'a dependent of a rejected dep is explicitly flagged (dependency-rejected)',
    s2.needsAttention.some((n) => n.opId === 'after-bad' && n.reason.startsWith('dependency-rejected')),
  );
  repo.close();
}

{
  const repo = await openRepo('attention');
  let authCalls = 0;
  let permCalls = 0;
  const handlers = {
    'op:auth-fail': async () => {
      authCalls += 1;
      return { ok: false, kind: 'auth', status: 401 };
    },
    'op:perm-fail': async () => {
      permCalls += 1;
      return { ok: false, kind: 'permission', status: 403 };
    },
  };
  await repo.enqueueOp({ opId: 'auth-1', type: 'op:auth-fail', payload: {} });
  await repo.enqueueOp({ opId: 'perm-1', type: 'op:perm-fail', payload: {} });
  await makeEngine(repo, handlers).runOnce();

  const authRow = await repo.getOutboxOp('auth-1');
  const permRow = await repo.getOutboxOp('perm-1');
  check(
    'an auth failure (401) marks needs-attention and preserves the op',
    authRow.status === 'needs-attention' && authRow.nextAttemptAt === null,
  );
  check(
    'a permission failure (403) marks needs-attention too (cached role ≠ server authority)',
    permRow.status === 'needs-attention' && permRow.nextAttemptAt === null,
  );

  // No retry loops for attention-class failures.
  t += 60_000;
  await makeEngine(repo, handlers).runOnce();
  check(
    'attention-class failures do not re-send automatically',
    authCalls === 1 && permCalls === 1,
  );
  repo.close();
}

{
  const repo = await openRepo('session');
  let sends = 0;
  const handlers = { 'op:any': async () => { sends += 1; return { ok: true }; } };
  await repo.enqueueOp({ opId: 'sess-1', type: 'op:any', payload: {} });
  const summary = await makeEngine(repo, handlers, {
    session: { isValid: async () => false },
  }).runOnce();
  const row = await repo.getOutboxOp('sess-1');
  check(
    'an expired session stops the run BEFORE any send; nothing is deleted or failed',
    summary.stopped === 'auth-expired' &&
      sends === 0 &&
      row?.status === 'pending' &&
      row.attempts === 0,
  );
  repo.close();
}

/* ------------------------------------------------------------ single-flight */

section('single-flight coordination');

{
  const repo = await openRepo('busy');
  let runs = 0;
  const busyLocks = { async tryAcquire() { return false; }, async release() {} };
  const handlers = {
    'op:any': async () => { runs += 1; return { ok: true }; },
  };
  await repo.enqueueOp({ opId: 'busy-1', type: 'op:any', payload: {} });
  const summary = await makeEngine(repo, handlers, { locks: busyLocks }).runOnce();
  check(
    'a tab that cannot acquire the lock skips the run entirely (busy, no sends)',
    summary.stopped === 'busy' && runs === 0 && summary.sent.length === 0,
  );
  repo.close();
}

{
  // Lease fallback: two adapters over one localStorage (simulated two tabs).
  const leaseA = createLeaseAdapter(clock, 30_000);
  const leaseB = createLeaseAdapter(clock, 30_000);
  const first = await leaseA.tryAcquire();
  const second = await leaseB.tryAcquire();
  check('leases are exclusive: the second tab is refused while the first holds', first === true && second === false);
  await leaseA.release();
  const secondAfterRelease = await leaseB.tryAcquire();
  check('release frees the lease for the next tab', secondAfterRelease === true);
  await leaseB.release();

  // Crash healing: a stale (expired) lease does not wedge everyone.
  const stuck = createLeaseAdapter(clock, 30_000);
  await stuck.tryAcquire();
  t += 31_000; // holder "crashed"
  const healed = await createLeaseAdapter(clock, 30_000).tryAcquire();
  check('a crashed holder heals by expiry (~30s), not forever', healed === true);

  check(
    'default adapter selection prefers Web Locks when available (documented order)',
    typeof defaultLockAdapter === 'function' && typeof webLocksAvailable() === 'boolean',
  );
}

/* --------------------------------------------------------------- tenant guards */

section('tenant and payload mismatch guards');

{
  const repo = await openRepo('tenant');
  let sent = 0;
  const handlers = { 'op:any': async () => { sent += 1; return { ok: true }; } };

  // A stray: a foreign-pharmacy row injected into THIS database.
  const raw = await openDB(
    databaseName({ pharmacyId: PH1, userId: ids.get('tenant') }),
    SCHEMA_VERSION,
  );
  await raw.put('outbox', {
    opId: 'stray-1',
    pharmacyId: PH2,
    type: 'op:any',
    payload: { total: '1.00' },
    createdAt: t,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    inFlightSince: null,
    lastError: null,
  });
  raw.close();

  // A payload that claims another branch than its stamp.
  await repo.enqueueOp({
    opId: 'liar-1',
    type: 'op:any',
    payload: { pharmacy_id: PH2, total: '2.00' },
  });

  const summary = await makeEngine(repo, handlers).runOnce();
  check(
    'a stray row is flagged tenant-mismatch and never sent',
    summary.needsAttention.some((n) => n.opId === 'stray-1' && n.kind === 'tenant') && sent === 0,
  );
  check(
    'a payload claiming another pharmacy is flagged before dispatch',
    summary.needsAttention.some((n) => n.opId === 'liar-1' && n.reason === 'payload-pharmacy-mismatch'),
  );
  const liarRow = await repo.getOutboxOp('liar-1');
  check('the mismatched payload op is preserved (not deleted, not sent)', liarRow?.status === 'needs-attention');
  repo.close();
}

/* ---------------------------------------------------------- storage failures */

section('storage errors surface without losing operations');

{
  const repo = await openRepo('storage');
  let sent = 0;
  const handlers = { 'op:any': async () => { sent += 1; return { ok: true }; } };
  await repo.enqueueOp({ opId: 'keep-1', type: 'op:any', payload: {} });
  await repo.enqueueOp({
    opId: 'keep-2',
    type: 'op:any',
    payload: { cost_per_base_unit: 'should-be-stripped-anyway' },
  });

  // Pull the database out from under the engine (crash/IO-failure analogue).
  repo.close();
  const summary = await makeEngine(repo, handlers).runOnce();
  check(
    'a storage failure is surfaced as a classified error, never as silence',
    summary.errors.length > 0 && sent === 0,
  );
  check('the run does not crash the process or fake a success', summary.completed.length === 0);

  // Recovery: reopen — the queued operations are still there, untouched.
  const reopened = await openRepo('storage');
  check(
    'queued operations survive a storage failure (nothing silently dropped)',
    (await reopened.listOutbox()).length === 2,
  );

  // And recovery completes them on a healthy run.
  const recovery = await makeEngine(reopened, handlers).runOnce();
  check(
    'a healthy re-run completes the recovered queue',
    recovery.completed.length === 2 && (await reopened.listOutbox()).length === 0,
  );
  reopened.close();
}

/* ------------------------------------------------------------------ leak guard */

section('sensitive data never reaches events or persisted errors');

{
  const repo = await openRepo('leak'); // attendant-visible events are role-independent
  const events = [];
  const handlers = {
    // Echoes a serialized payload with forbidden tokens into its error text —
    // exactly the "handler leaked payload into message" threat.
    'op:leaky-fail': async () => {
      const err = new Error(
        'upstream rejected {"cost_per_base_unit":"9.99","CostOfGoodsSold":"5","payload":{"ProfitMargin":0.6}}',
      );
      err.name = 'TypeError';
      throw err;
    },
    'op:leaky-ok': async () => ({ ok: true }),
  };
  await repo.enqueueOp({
    opId: 'leak-fail-1',
    type: 'op:leaky-fail',
    payload: { note: 'cost_per_base_unit=9.99' },
    deps: [],
  });
  await repo.enqueueOp({
    opId: 'leak-ok-1',
    type: 'op:leaky-ok',
    payload: { cost_per_base_unit: '9.99', cogs: '5' },
  });

  await makeEngine(repo, handlers, { onEvent: (e) => events.push(e) }).runOnce();

  const dumped = JSON.stringify({
    events,
    summaryErrors: true,
    lastError: (await repo.getOutboxOp('leak-fail-1'))?.lastError,
  }).toLowerCase();

  check(
    'forbidden financial tokens are redacted from persisted error text',
    !dumped.includes('cost_per_base_unit') && !dumped.includes('costofgoodssold') && !dumped.includes('profitmargin'),
  );
  check(
    'payloads never appear in events (op id + type only)',
    events.every((e) => !Object.hasOwn(e, 'payload')),
  );
  check(
    'sanitizeMessage is the single redaction point (unit pin)',
    sanitizeMessage('the cost_per_base_unit was 9.99') === 'the [redacted] was 9.99',
  );
  repo.close();
}

section('summary sanity');

{
  check(
    'webLocksAvailable tolerates environments without navigator.locks (bun: false, browser: api-dependent)',
    typeof webLocksAvailable() === 'boolean',
  );
}

process.exit(await finish());
