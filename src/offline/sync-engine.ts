/**
 * The outbox sync engine — a durable flusher over the Phase 1 IndexedDB
 * outbox. It owns five guarantees, each pinned by `verify-offline-sync.mjs`:
 *
 *   1. **Ordered, explicit dependency handling.** Operations declare `deps[]`
 *      (operation ids). The engine runs satisfied operations first, and never
 *      leaves anything pending forever: a dep that completed unblocks the
 *      dependent; a rejected or missing dep, a cycle, or a dep that hit its
 *      attempt cap cascades an explicit `needs-attention` state onto anything
 *      that waits on it. Unrelated operations are never dragged down (§5).
 *
 *   2. **Bounded, persisted retry.** Every attempt — including `nextAttemptAt`
 *      and the last failure — is written to the outbox row itself, so reload,
 *      tab crash or browser restart does not reset retry history. Attempts are
 *      capped; an exhausted operation becomes `needs-attention`, not an
 *      infinite loop, and it does not stop other eligible operations.
 *
 *   3. **Single-flight across tabs.** Web Locks (`navigator.locks`) are the
 *      coordination primitive; a tab that cannot acquire the lock skips the
 *      run (`busy`) instead of double-processing. The documented fallback
 *      (localStorage lease with expiry) is strictly weaker and exists only
 *      because two engines concurrently draining the same outbox is worse than
 *      a crashed lease holder — the lease heals by expiry after ~30s.
 *
 *   4. **Honest confirmations.** An operation is removed and its outcome
 *      recorded in ONE transaction only when its handler reports the SERVER
 *      durably accepted it. Sent/queued/retrying is never "confirmed".
 *      `inFlightSince` is stamped before dispatch; a crash mid-send leaves the
 *      row self-describing and the engine re-sends under the idempotency
 *      contract (`docs/OFFLINE-SYNC.md`).
 *
 *   5. **Non-sensitive observability.** Events and persisted errors carry op
 *      id, type, attempt counts and failure kinds — never payloads, session
 *      material or access tokens. Handler-provided messages are sanitized of
 *      forbidden financial tokens and truncated before persistence.
 *
 * ## Scope of this phase
 *
 * The engine is generic infra, not app wiring: no screen declares operations
 * yet, and POS/receiving/credit handlers arrive in their own phases (where the
 * server RPC idempotency is verified per operation). An op type without a
 * registered handler is refused to `needs-attention` WITHOUT being sent —
 * see "Supported operation types" in `docs/OFFLINE-SYNC.md`.
 */

import type { OutboxRecord } from './db-schema';
import { OfflineStorageError, classifyStorageError, type OfflineRepo } from './local-db';
import { FORBIDDEN_FINANCIAL_KEYS } from './financial-guard';

/* ---------------------------------------------------------------- policy */

export interface SyncPolicy {
  /** Automatic attempts allowed before an op becomes needs-attention. */
  maxAttempts: number;
  /** First retry delay; then doubled per attempt, capped at `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for sweeps in a single `runOnce` (bounded batch work). */
  maxSweeps: number;
}

export const DEFAULT_POLICY: SyncPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 10 * 60_000,
  maxSweeps: 10,
};

function backoffDelay(policy: SyncPolicy, attempt: number): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

/* -------------------------------------------------------------- handlers */

export type HandlerFailureKind =
  /** Transport/5xx — retryable, with backoff. */
  | 'network'
  | 'server'
  /** Caller must act: re-authenticate; resolve a conflict; fix the payload. */
  | 'auth'
  | 'permission'
  | 'conflict'
  /** Terminal: the server looked at it and refused. Never retried. */
  | 'validation';

export interface OpResultOk {
  ok: true;
  /**
   * Small success data the engine persists into the durable outcome record
   * (ids and labels only — never payloads, never credentials). Absent for
   * handlers whose success needs no local record.
   */
  result?: Record<string, unknown>;
  /**
   * Present when the server accepted the operation but its financial result
   * differs from the locally quoted one. The engine records success AND a
   * durable conflict in one transaction, so the sale remains visible for
   * reconciliation without being retried or silently treated as clean.
   */
  reconciliation?: {
    reason: string;
    details?: Record<string, unknown> | null;
    serverRejection?: string | null;
  };
}

export interface OpResultFailed {
  ok: false;
  kind: HandlerFailureKind;
  /** HTTP-ish status code, if the failure came from a transport. */
  status?: number;
  /**
   * Short, human-safe text. MUST NOT contain payloads or credentials — the
   * engine additionally sanitizes forbidden financial tokens and truncates.
   */
  message?: string;
}

export type OpResult = OpResultOk | OpResultFailed;

export interface SyncHandlerContext {
  opId: string;
}

export type SyncHandler = (
  op: { opId: string; type: string; payload: unknown; pharmacyId: string },
  ctx: SyncHandlerContext,
) => Promise<OpResult>;

export type OpHandlers = Record<string, SyncHandler>;

/** Answers "is the session currently usable?" freshly, every sweep. */
export interface SessionProbe {
  isValid(): Promise<boolean>;
}

/* ------------------------------------------------------------- failures */

export type AttentionAction =
  | 'retry' /** scheduled with backoff */
  | 'needs-attention' /** preserved, surfaced, not auto-retried */
  | 'reject' /** terminal: moved durably to `conflicts` */;

export interface ClassifiedFailure {
  kind: HandlerFailureKind;
  action: AttentionAction;
  reason: string;
}

const FAILURE_TREATMENT: Record<HandlerFailureKind, AttentionAction> = {
  network: 'retry',
  server: 'retry',
  auth: 'needs-attention',
  permission: 'needs-attention',
  conflict: 'needs-attention',
  validation: 'reject',
};

export function classifyHandlerFailure(kind: HandlerFailureKind): ClassifiedFailure {
  return {
    kind,
    action: FAILURE_TREATMENT[kind],
    reason: `${kind}-failure`,
  };
}

/* --------------------------------------------------------- message guard */

/** Error.name-based help for thrown handler errors (never trusted verbatim). */
function kindFromThrown(error: unknown): HandlerFailureKind {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : '';
  if (name === 'AbortError' || name === 'TypeError') return 'network';
  return 'server';
}

/**
 * The ONLY path a handler/transport message can take into storage or events.
 * Forbidden financial tokens are redacted from any position/case, then the
 * text is capped — an attendant-visible error must not leak owner costs even
 * when the failure description echoes a serialized payload.
 *
 * Longer keys are replaced FIRST: replacing `cost` before `cost_per_base_unit`
 * would leave a residue (`[redacted]_per_base_unit`) that partially reveals the
 * leaked field name.
 */
export function sanitizeMessage(message: string, limit = 200): string {
  let out = String(message ?? '');
  const keys = [...FORBIDDEN_FINANCIAL_KEYS].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    out = out.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[redacted]');
  }
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

/* --------------------------------------------------------------- locking */

export interface SyncLockAdapter {
  /** `false` when another tab currently holds the lock. */
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

const SYNC_LOCK_NAME = 'pf-offline:sync-leader';

/** True when Web Locks API is usable in this context. */
export function webLocksAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { locks?: { request?: unknown } }).locks?.request === 'function'
  );
}

/**
 * Web Locks-backed exclusive adapter, for browsers that expose the API.
 * The lock is held from `tryAcquire` until `release` (the callback resolves a
 * promise we keep until release).
 */
export function createWebLocksAdapter(): SyncLockAdapter {
  let releaseLock: (() => void) | null = null;
  return {
    tryAcquire() {
      return (navigator as unknown as {
        locks: {
          request(
            name: string,
            opts: { ifAvailable: boolean },
            cb: (lock: unknown) => Promise<void>,
          ): Promise<unknown>;
        };
      }).locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (lock) {
          return new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
        }
        return Promise.resolve();
      }).then((maybeHeld) => {
        // The callback ran and returned an unresolved promise → we hold the
        // lock (`releaseLock` set). An immediate return means another tab
        // holds it. Detect which by whether a resolver was installed.
        return releaseLock !== null;
      });
    },
    async release() {
      const resolve = releaseLock;
      releaseLock = null;
      resolve?.();
    },
  };
}

/**
 * localStorage lease fallback (`docs/OFFLINE-SYNC.md` §Locking): strictly
 * weaker — a crashed holder stalls others until the lease expires (~30s),
 * which is the documented healing window. Without any storage at all this
 * degrades to "no cross-tab protection", which the docs call out.
 */
export function createLeaseAdapter(
  clock: () => number = Date.now,
  leaseMs = 30_000,
): SyncLockAdapter {
  const key = 'pf-offline:sync-lease';
  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  let holder: string | null = null;
  return {
    tryAcquire() {
      const store = storage();
      const now = clock();
      if (store) {
        try {
          const raw = store.getItem(key);
          if (raw) {
            const lease = JSON.parse(raw) as { holder: string; expiresAt: number };
            if (lease.expiresAt > now && lease.holder !== holder) return Promise.resolve(false);
          }
          holder = `lease-${now}-${Math.random().toString(36).slice(2, 8)}`;
          store.setItem(key, JSON.stringify({ holder, expiresAt: now + leaseMs }));
          return Promise.resolve(true);
        } catch {
          /* fall through to no-storage behaviour */
        }
      }
      holder = holder ?? `lease-${now}`;
      return Promise.resolve(true);
    },
    async release() {
      const store = storage();
      if (!store || !holder) return;
      try {
        const raw = store.getItem(key);
        if (raw) {
          const lease = JSON.parse(raw) as { holder: string };
          if (lease.holder === holder) store.removeItem(key);
        }
      } catch {
        /* best-effort */
      }
      holder = null;
    },
  };
}

/**
 * Default adapter selection: Web Locks where available, lease otherwise.
 * Both are injectable via options for tests and embedders.
 */
export function defaultLockAdapter(): SyncLockAdapter {
  return webLocksAvailable() ? createWebLocksAdapter() : createLeaseAdapter();
}

/* -------------------------------------------------------------- the engine */

export interface SyncEngineOptions {
  repo: OfflineRepo;
  handlers: OpHandlers;
  session?: SessionProbe;
  clock?: () => number;
  policy?: Partial<SyncPolicy>;
  locks?: SyncLockAdapter;
  onEvent?: (event: SyncEvent) => void;
}

export type SyncEvent =
  | { type: 'sweep'; at: number; eligible: number }
  | { type: 'sent'; opId: string; opType: string; attempt: number; at: number }
  | { type: 'completed'; opId: string; opType: string; at: number }
  | { type: 'reject'; opId: string; opType: string; kind: HandlerFailureKind; at: number }
  | { type: 'retry'; opId: string; opType: string; attempt: number; nextAttemptAt: number; kind: HandlerFailureKind; at: number }
  | { type: 'needs-attention'; opId: string; opType: string; reason: string; kind: string; at: number };

export interface AttentionEntry {
  opId: string;
  opType: string;
  reason: string;
  kind: string;
}

export interface SyncRunSummary {
  startedAt: number;
  finishedAt: number;
  sweeps: number;
  sent: string[];
  completed: string[];
  rejected: string[];
  /** Still pending for a future run (backoff/waiting on a failed dep). */
  stillPending: string[];
  needsAttention: AttentionEntry[];
  stopped: 'auth-expired' | 'busy' | null;
  /** Non-sensitive storage-failure notes (never payloads). */
  errors: string[];
}

/** Defaults for v1 rows written before retry bookkeeping existed. */
function normalizeOp(row: OutboxRecord): OutboxRecord {
  return {
    ...row,
    deps: row.deps ?? [],
    attempts: row.attempts ?? 0,
    nextAttemptAt: row.nextAttemptAt ?? null,
    inFlightSince: row.inFlightSince ?? null,
    lastError: row.lastError ?? null,
  };
}

type DepResolution =
  | { state: 'satisfied' }
  | { state: 'wait-other-pending' } // dep op is pending (topological wait)
  | { state: 'cascade'; reason: 'dependency-blocking-dep'; depId: string }
  | { state: 'cascade'; reason: 'dependency-rejected'; depId: string }
  | { state: 'cascade'; reason: 'dependency-missing'; depId: string }
  | { state: 'cycle' };

export interface SyncEngine {
  runOnce(): Promise<SyncRunSummary>;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const repo = options.repo;
  const now = options.clock ?? Date.now;
  const policy: SyncPolicy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  const locks = options.locks ?? defaultLockAdapter();
  const emit = (e: SyncEvent) => options.onEvent?.(e);

  const attention = (op: OutboxRecord, reason: string, kind: string): AttentionEntry => ({
    opId: op.opId,
    opType: op.type,
    reason,
    kind,
  });

  // Terminal cascade marks are written once (idempotent by status). `detail`
  // lets a handler's already-sanitized server sentence survive into the row,
  // so the operator reads WHY (stock counts, product names) and not just a
  // kind label — reason codes stay in `lastError.kind` for programmatic views.
  const markNeedsAttention = async (
    op: OutboxRecord,
    reason: string,
    kind: string,
    attempts?: number,
    detail?: string,
  ): Promise<void> => {
    await repo.markAttempt(op.opId, {
      attempts: attempts ?? op.attempts,
      // Blocked from automatic retry until a user (later wiring) intervenes.
      nextAttemptAt: null,
      inFlightSince: null,
      lastError: { kind, message: sanitizeMessage(detail ?? reason), at: now() },
      status: 'needs-attention',
    });
    emit({
      type: 'needs-attention',
      opId: op.opId,
      opType: op.type,
      reason,
      kind,
      at: now(),
    });
  };

  /** Resolves one declared dep against the outbox, outcomes and conflicts. */
  const resolveDep = async (depId: string, pendingIds: Set<string>): Promise<DepResolution> => {
    const depRow = await repo.getOutboxOp(depId);
    if (depRow) {
      // A dep that hit needs-attention will not self-terminate: cascade NOW or
      // the dependent stays pending forever.
      return depRow.status === 'needs-attention'
        ? { state: 'cascade', reason: 'dependency-blocking-dep', depId }
        : { state: 'wait-other-pending' };
    }
    const outcome = await repo.getOutcome(depId);
    if (outcome?.ok) return { state: 'satisfied' };
    const conflict = await repo.getConflict(depId);
    if (conflict) return { state: 'cascade', reason: 'dependency-rejected', depId };
    return { state: 'cascade', reason: 'dependency-missing', depId };
  };

  /**
   * Kahn's pass over the PENDING subgraph: anything whose in-degree never
   * reaches zero is in a dependency cycle or strictly downstream of one. Both
   * states are explicit terminal `needs-attention` values ('dependency-cycle')
   * — never silent, never retried forever.
   */
  const findCycleOrDownstream = (ops: OutboxRecord[]): Set<string> => {
    const pendingIds = new Set(ops.map((o) => o.opId));
    const inDegree = new Map<string, number>(ops.map((o) => [o.opId, 0]));
    const dependents = new Map<string, string[]>();
    for (const op of ops) {
      const edges = new Set((op.deps ?? []).filter((d) => pendingIds.has(d) && d !== op.opId));
      inDegree.set(op.opId, edges.size);
      for (const dep of edges) {
        dependents.set(dep, [...(dependents.get(dep) ?? []), op.opId]);
      }
    }
    const queue = ops.filter((o) => (inDegree.get(o.opId) ?? 0) === 0).map((o) => o.opId);
    const processed = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      processed.add(id);
      for (const next of dependents.get(id) ?? []) {
        const left = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, left);
        if (left === 0) queue.push(next);
      }
    }
    return new Set([...inDegree.keys()].filter((id) => !processed.has(id)));
  };

  const runOnce = async (): Promise<SyncRunSummary> => {
    const startedAt = now();
    const summary: SyncRunSummary = {
      startedAt,
      finishedAt: startedAt,
      sweeps: 0,
      sent: [],
      completed: [],
      rejected: [],
      stillPending: [],
      needsAttention: [],
      stopped: null,
      errors: [],
    };

    const acquired = await locks.tryAcquire();
    if (!acquired) {
      summary.stopped = 'busy';
      summary.finishedAt = now();
      return summary;
    }

    try {
      /* ------------------------------------------------ strays (explicit) */
      // Rows stamped with a foreign pharmacy id are invisible to normal reads;
      // flag them for attention rather than leaving them pending forever.
      for (const stray of await repo.listOutboxStrays()) {
        await markNeedsAttention(stray, 'tenant-mismatch', 'tenant');
        summary.needsAttention.push(attention(stray, 'tenant-mismatch', 'tenant'));
      }

      /* --------------------------------------------------- session gate */
      if (options.session && !(await options.session.isValid())) {
        summary.stopped = 'auth-expired';
        summary.finishedAt = now();
        return summary;
      }

      let progress = true;
      while (progress && summary.sweeps < policy.maxSweeps) {
        summary.sweeps += 1;
        progress = false;

        const pendingIds = new Set<string>();
        const pending = (await repo.listOutbox()).map(normalizeOp);
        const active: OutboxRecord[] = [];
        for (const op of pending) {
          pendingIds.add(op.opId);
          if (op.status === 'pending') active.push(op);
        }

        /* -------------------------------------- dependency resolution */
        const eligible: OutboxRecord[] = [];
        const cascades: { op: OutboxRecord; resolution: DepResolution }[] = [];
        for (const op of active) {
          const resolutions: DepResolution[] = [];
          for (const depId of op.deps ?? []) {
            resolutions.push(
              (await resolveDep(depId, pendingIds)) as DepResolution,
            );
          }
          const cascading = resolutions.find((r) => r.state === 'cascade');
          if (cascading) {
            cascades.push({ op, resolution: cascading });
            continue;
          }
          const waiting = resolutions.some((r) => r.state === 'wait-other-pending');
          if (waiting) continue; // topological batch ordering
          const due = op.nextAttemptAt === null || op.nextAttemptAt <= now();
          if (due) eligible.push(op);
        }

        for (const { op, resolution } of cascades) {
          if (resolution.state !== 'cascade') continue;
          const reason = `${resolution.reason}:${resolution.depId}`;
          await markNeedsAttention(op, reason, 'dependency');
          summary.needsAttention.push(attention(op, reason, 'dependency'));
        }

        /* ------------------------------------------------- cycle detection */
        // Only when nothing is eligible wait-free; a plain backoff wait must
        // never be mistaken for a deadlocked graph.
        const noEligible = eligible.length === 0;
        const hasCascades = cascades.length > 0;
        if (noEligible && !hasCascades) {
          const stuck = findCycleOrDownstream(active.filter((o) => o.status === 'pending'));
          for (const op of active.filter((o) => stuck.has(o.opId))) {
            await markNeedsAttention(op, 'dependency-cycle', 'dependency');
            summary.needsAttention.push(attention(op, 'dependency-cycle', 'dependency'));
          }
          break;
        }

        if (eligible.length === 0) {
          // All remaining is backoff/attention-blocked: the bounded sweep work
          // for this run is done.
          break;
        }

        emit({ type: 'sweep', eligible: eligible.length, at: now() });

        /* ------------------------------------------------------ dispatch */
        const dispatchOne = async (
          op: OutboxRecord,
        ): Promise<{ opId: string; outcome: 'completed' | 'rejected' | 'needs-attention' | 'retrying' }> => {
          /* tenant check — belt on top of the store-level namespacing */
          const payloadPharmacy =
            op.payload && typeof op.payload === 'object'
              ? ((op.payload as Record<string, unknown>).pharmacy_id ??
                (op.payload as Record<string, unknown>).branch_id ??
                null)
              : null;
          if (typeof payloadPharmacy === 'string' && op.pharmacyId !== payloadPharmacy) {
            await markNeedsAttention(op, 'payload-pharmacy-mismatch', 'tenant');
            summary.needsAttention.push(attention(op, 'payload-pharmacy-mismatch', 'tenant'));
            return { opId: op.opId, outcome: 'needs-attention' };
          }

          /* handler existence — an unknown type is NEVER sent */
          const handler = options.handlers[op.type];
          if (!handler) {
            await markNeedsAttention(op, 'unsupported-operation-type', 'unsupported');
            summary.needsAttention.push(attention(op, 'unsupported-operation-type', 'unsupported'));
            return { opId: op.opId, outcome: 'needs-attention' };
          }

          /* stamp the attempt BEFORE dispatch: crash → "sent, unknown" */
          const attemptNumber = op.attempts + 1;
          if (attemptNumber > policy.maxAttempts) {
            await markNeedsAttention(op, 'attempts-exhausted', 'exhausted', attemptNumber - 1);
            summary.needsAttention.push(attention(op, 'attempts-exhausted', 'exhausted'));
            return { opId: op.opId, outcome: 'needs-attention' };
          }
          await repo.markAttempt(op.opId, {
            attempts: attemptNumber,
            nextAttemptAt: op.nextAttemptAt,
            inFlightSince: now(),
            lastError: op.lastError,
            status: 'pending',
          });
          emit({
            type: 'sent',
            opId: op.opId,
            opType: op.type,
            attempt: attemptNumber,
            at: now(),
          });
          summary.sent.push(op.opId);

          let result: OpResult;
          try {
            result = await handler(
              {
                opId: op.opId,
                type: op.type,
                payload: op.payload,
                pharmacyId: op.pharmacyId,
              },
              { opId: op.opId },
            );
          } catch (thrown) {
            result = {
              ok: false,
              kind: kindFromThrown(thrown),
              message:
                typeof thrown === 'object' && thrown !== null && 'message' in thrown
                  ? String((thrown as { message?: unknown }).message)
                  : String(thrown),
            };
          }

          if (result.ok) {
            // Durable success: outcome + removal in ONE transaction.
            await repo.completeOutboxOp(op.opId, {
              ok: true,
              at: now(),
              type: op.type,
              result: result.result,
              reconciliation: result.reconciliation,
            });
            emit({ type: 'completed', opId: op.opId, opType: op.type, at: now() });
            summary.completed.push(op.opId);
            return { opId: op.opId, outcome: 'completed' };
          }

          const message = sanitizeMessage(result.message ?? `${result.kind} failure`);
          const treatment = classifyHandlerFailure(result.kind);

          if (treatment.action === 'reject') {
            await repo.rejectOutboxOp(op.opId, {
              type: op.type,
              reason: treatment.reason,
              // Keep the server's sanitized explanation, not just a status code:
              // the recovery view must say WHAT was refused.
              serverRejection: result.status ? `HTTP ${result.status}: ${message}` : message,
              rejectedAt: now(),
            });
            emit({
              type: 'reject',
              opId: op.opId,
              opType: op.type,
              kind: result.kind,
              at: now(),
            });
            summary.rejected.push(op.opId);
            return { opId: op.opId, outcome: 'rejected' };
          }

          if (treatment.action === 'needs-attention') {
            await markNeedsAttention(op, treatment.reason, result.kind, undefined, message);
            summary.needsAttention.push(attention(op, treatment.reason, result.kind));
            return { opId: op.opId, outcome: 'needs-attention' };
          }

          /* retry (bounded) */
          if (attemptNumber >= policy.maxAttempts) {
            await markNeedsAttention(op, 'attempts-exhausted', result.kind, attemptNumber, message);
            summary.needsAttention.push(attention(op, 'attempts-exhausted', result.kind));
            return { opId: op.opId, outcome: 'needs-attention' };
          }
          const nextAttemptAt = now() + backoffDelay(policy, attemptNumber + 1);
          await repo.markAttempt(op.opId, {
            attempts: attemptNumber,
            nextAttemptAt,
            inFlightSince: null,
            lastError: { kind: result.kind, message, at: now() },
            status: 'pending',
          });
          emit({
            type: 'retry',
            opId: op.opId,
            opType: op.type,
            attempt: attemptNumber,
            nextAttemptAt,
            kind: result.kind,
            at: now(),
          });
          return { opId: op.opId, outcome: 'retrying' };
        };

        const dispatchResults = await Promise.allSettled(
          eligible.map(async (op) => {
            return dispatchOne(op);
          }),
        );
        for (const settled of dispatchResults) {
          if (settled.status === 'rejected') {
            // A dispatch itself threw outside handler scope (storage failure
            // etc.) — the op row may be untouched; note it and keep going.
            const cause = settled.reason;
            summary.errors.push(
              `dispatch-failure: ${sanitizeMessage(String(cause?.message ?? cause))}`,
            );
            progress = true;
            continue;
          }
          if (settled.value.outcome !== 'retrying') progress = true;
        }
      }

      summary.stillPending = (await repo.listOutbox())
        .filter((o) => o.status === 'pending')
        .map((o) => o.opId);
    } catch (error) {
      if (error instanceof OfflineStorageError || error instanceof Error) {
        const kind = error instanceof OfflineStorageError ? error.kind : classifyStorageError(error);
        summary.errors.push(`storage-error (${kind}): ${sanitizeMessage(String(error.message))}`);
      } else {
        summary.errors.push(`unknown-error: ${sanitizeMessage(String(error))}`);
      }
    } finally {
      try {
        await locks.release();
      } catch {
        /* release is best-effort; the adapter heals by expiry */
      }
    }

    summary.finishedAt = now();
    return summary;
  };

  return { runOnce };
}
