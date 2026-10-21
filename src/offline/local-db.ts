/**
 * The local (IndexedDB) repository — Phase 1 foundation.
 *
 * This is the offline data layer every later phase mounts on. It owns four
 * guarantees, and each one has a verify suite behind it:
 *
 *   1. **No financial leak.** Every write calls a guard (`financial-guard.ts`)
 *      that strips owner-only cost/COGS/margin fields unless the caller's role
 *      is `owner`. Attendant caches provably cannot hold cost data.
 *
 *   2. **Tenant isolation.** One database per `(pharmacy, user)` pair
 *      (`databaseName`), and additionally every row stamps its `pharmacyId`,
 *      which every read filters on. A namespacing defect would have to defeat
 *      both layers to return another pharmacy's rows.
 *
 *   3. **Honestness of cached data.** Cached catalogue rows are persisted with
 *      `serverConfirmed: false` and reads carry freshness buckets
 *      (`staleInfo`, with thresholds the policy document cites). Cached stock
 *      is never presented as server-confirmed stock — see
 *      `docs/OFFLINE-DATA-POLICY.md`.
 *
 *   4. **Recoverable writes.** Storage failures are classified
 *      (`classifyStorageError`) and surfaced, never swallowed; outbox writes
 *      with a duplicate operation id are idempotent when the payload matches
 *      and written to `conflicts` when it does not.
 *
 * ## What is wired
 *
 * The POS screen is the only caller. It writes a read-only catalogue/customer
 * snapshot, records sale intents in the outbox, and drains them through the sync
 * engine. The cache is branch/user scoped and never substitutes for a live read
 * on an online branch.
 */

import { openDB, type IDBPDatabase } from 'idb';
import {
  SCHEMA_VERSION,
  applyOfflineSchemaV1,
  databaseName,
  type CatalogueRecord,
  type ConflictRecord,
  type CustomerRecord,
  type LocalRole,
  type OfflineDBV1,
  type OfflineIdentity,
  type OfflineStoreName,
  type OutboxRecord,
} from './db-schema';
import { findFinancialKeys, stripFinancialFields } from './financial-guard';
import {
  UNRESOLVED_ATTEMPT_META_KEY,
  parseUnresolvedAttempt,
} from './settlement-reconciliation';

/* ------------------------------------------------------------------- policy */

/**
 * Freshness thresholds, in milliseconds since the row was received.
 *
 * The **policy** that turns these into user-facing behaviour lives in
 * `docs/OFFLINE-DATA-POLICY.md`; this constant is the single numeric source the
 * policy cites, so a threshold change is one line, here.
 */
export const FRESH_MS = 120_000; // 2 minutes
export const VERY_STALE_MS = 24 * 60 * 60_000; // 24 hours

export type FreshnessBucket = 'fresh' | 'stale' | 'very-stale';

export interface StaleInfo {
  ageMs: number;
  bucket: FreshnessBucket;
  /** Cached stock must never be presented as confirmed; a fresh bucket is a *hint*. */
  stockIsHintOnly: boolean;
  /**
   * Prices older than `very-stale` must not be shown as the price to charge
   * without saying so; `stale` is advisory, with a visible age.
   */
  priceRequiresLabelling: boolean;
  /**
   * Recall state: sticky-safe. `is_recalled` stays true however stale the row;
   * *clearing* a recall requires only the server, never the cache.
   */
  recallStateRequiresRevalidation: boolean;
}

export function staleInfo(record: { cachedAt: number }, now = Date.now()): StaleInfo {
  const ageMs = Math.max(0, now - record.cachedAt);
  const bucket: FreshnessBucket =
    ageMs <= FRESH_MS ? 'fresh' : ageMs < VERY_STALE_MS ? 'stale' : 'very-stale';

  return {
    ageMs,
    bucket,
    stockIsHintOnly: true,
    priceRequiresLabelling: bucket === 'very-stale',
    // Cleared recalls always need the server; a stale row can only ever keep
    // blocking, never unblock.
    recallStateRequiresRevalidation: bucket !== 'fresh',
  };
}

/* ------------------------------------------------------------- storage errors */

export type StorageFailureKind =
  | 'quota' /** DB or cache full — must be surfaced, retried later, never silent. */
  | 'clone' /** Value cannot be structured-cloned (cyclic, non-serialisable). */
  | 'constraint' /** Key/index constraint (a duplicate key we did not guard). */
  | 'version' /** A concurrent downgrade — must be fatal, never retried. */
  | 'blocked' /** Upgrade blocked by another open connection. */
  | 'abort' /** Transaction aborted — a normal retriable failure. */
  | 'unknown';

/** A classified storage failure. `kind` decides retry/alert policy upstream. */
export class OfflineStorageError extends Error {
  readonly kind: StorageFailureKind;

  constructor(kind: StorageFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OfflineStorageError';
    this.kind = kind;
  }
}

/**
 * Classifies an IndexedDB-era failure once, from its `name`, so callers translate
 * kinds rather than sniffing vendor-specific messages.
 */
export function classifyStorageError(error: unknown): StorageFailureKind {
  if (error instanceof OfflineStorageError) return error.kind;
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : '';
  switch (name) {
    case 'QuotaExceededError':
      return 'quota';
    case 'DataCloneError':
      return 'clone';
    case 'ConstraintError':
      return 'constraint';
    case 'VersionError':
      return 'version';
    case 'BlockedError':
      return 'blocked';
    case 'AbortError':
      return 'abort';
    default:
      return 'unknown';
  }
}

/* ---------------------------------------------------------- identity registry */

const DB_PREFIX = 'pf-offline';
const REGISTRY_KEY = `${DB_PREFIX}:databases`;

interface RegistryFormat {
  version: 1;
  names: string[];
}

function localStorage(): Storage | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readRegistry(): string[] {
  const store = localStorage();
  if (store) {
    try {
      const raw = store.getItem(REGISTRY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<RegistryFormat> | null;
        if (Array.isArray(parsed?.names)) return parsed.names.filter((n) => typeof n === 'string');
      }
    } catch {
      /* registry is best-effort; fall through to enumeration */
    }
  }
  return [];
}

function writeRegistry(names: string[]): void {
  const store = localStorage();
  if (!store) return; // Purge falls back to enumeration when unavailable.
  try {
    const value: RegistryFormat = { version: 1, names };
    store.setItem(REGISTRY_KEY, JSON.stringify(value));
  } catch {
    /* best-effort only */
  }
}

/**
 * Adds a database name to the (id-only) purge registry. Contains no user data —
 * only derived database names, so losing it cannot leak anything.
 */
function enroll(name: string): void {
  const names = readRegistry();
  if (!names.includes(name)) writeRegistry([...names, name]);
}

function dropFromRegistry(name: string): void {
  writeRegistry(readRegistry().filter((n) => n !== name));
}

/* --------------------------------------------------------------- the database */

export type OfflineHandle = IDBPDatabase<OfflineDBV1>;

export interface OpenOptions {
  /** Test hook only: a lower version to exercise the upgrade path from. */
  version?: number;
}

/** Opens (or upgrades) the local database for one `(pharmacy, user)` identity. */
export async function openOfflineDatabase(
  identity: OfflineIdentity,
  options: OpenOptions = {},
): Promise<OfflineHandle> {
  const name = databaseName(identity);
  // Enrollment is done by the repo (which knows the role context) too, but the
  // database must be listed even when the caller never builds a repo around it.
  enroll(name);
  return openDB<OfflineDBV1>(name, options.version ?? SCHEMA_VERSION, {
    upgrade(db, oldVersion) {
      applyOfflineSchemaV1(db, oldVersion);
    },
  });
}

/* -------------------------------------------------------------- the repository */

/** A catalogue row exactly as the caller delivered it, before guards run. */
export interface CatalogueWrite {
  id: string;
  data: unknown;
  cachedAt: number;
}

/** A customer identity row before guards run. Only id/name/phone are cached. */
export interface CustomerWrite {
  id: string;
  data: unknown;
  cachedAt: number;
}

export interface OutboxOp {
  opId: string;
  type: string;
  payload: unknown;
  /** Operation ids that must be durably completed before this one may run. */
  deps?: string[];
}

export interface OutboxEnqueueResult {
  ok: boolean;
  duplicate?: boolean;
  error?: string;
}

export interface CatalogueRead {
  records: CatalogueRecord[];
  /** Present in every read so no caller can forget to label cached data. */
  fromCache: true;
  snapshotAt: number | null;
}

export interface CustomerRead {
  records: CustomerRecord[];
  fromCache: true;
  snapshotAt: number | null;
}

/** The stored shapes for the mirror stores. */
export interface MirrorWrite {
  id: string;
  data: unknown;
  cachedAt: number;
  soldAt?: string | null;
  occurredAt?: string | null;
}

export interface SaleRead {
  records: {
    id: string;
    data: unknown;
    soldAt: string | null;
    cachedAt: number;
    serverConfirmed: boolean;
  }[];
  fromCache: true;
  snapshotAt: number | null;
}

function nowIsoOrNull(value?: string | null): string | null {
  return value ?? null;
}

/** Canonical JSON with sorted keys, so payload comparison is order-insensitive. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  const body = keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(',');
  return `{${body}}`;
}

/**
 * Every repo with an open IndexedDB handle in this tab. `purgeIdentity` closes
 * the matching handles before deleting, so a sign-out purge is not defeated by
 * the POS's own connection.
 */
const openRepos = new Set<OfflineRepo>();

export class OfflineRepo {
  readonly identity: OfflineIdentity;
  readonly role: LocalRole;
  private constructor(
    private readonly db: OfflineHandle,
    identity: OfflineIdentity,
    role: LocalRole,
  ) {
    this.identity = identity;
    this.role = role;
  }

  static async open(
    identity: OfflineIdentity,
    role: LocalRole,
    options: OpenOptions = {},
  ): Promise<OfflineRepo> {
    const db = await openOfflineDatabase(identity, options);
    const repo = new OfflineRepo(db, identity, role);
    openRepos.add(repo);
    return repo;
  }

  /** Non-privileged writers cannot persist financial fields at all. */
  private guarded(data: unknown): unknown {
    if (this.role === 'owner') return data;
    const clean = stripFinancialFields(data);
    const residual = findFinancialKeys(clean);
    if (residual.length > 0) {
      // Cannot happen if the guard and the forbidden-key oracle agree; if it
      // ever does, the oracle or the guard has a defect and the write is refused
      // rather than persisting a leaking shape.
      throw new OfflineStorageError(
        'unknown',
        `offline: financial keys survived the guard: ${residual.join(', ')}`,
      );
    }
    return clean;
  }

  /** Refuses rows that do not stamp this pharmacy — the read-side twin filter. */
  private strayEncoded(pharmacyId: string): boolean {
    return pharmacyId !== this.identity.pharmacyId;
  }

  /* ------------------------------------------------------------- catalogue */

  async saveCatalogue(writes: CatalogueWrite[]): Promise<void> {
    const tx = this.db.transaction('catalogue', 'readwrite');
    try {
      let newest = 0;
      for (const write of writes) {
        newest = Math.max(newest, write.cachedAt);
        const record: CatalogueRecord = {
          id: write.id,
          pharmacyId: this.identity.pharmacyId,
          data: this.guarded(write.data) as CatalogueRecord['data'],
          cachedAt: write.cachedAt,
          serverConfirmed: false,
        };
        await tx.store.put(record);
      }
      await tx.done;
      // Maintain the snapshot timestamp honestly: it is the newest delivery
      // this writer has observed, never back-dated forward by old writes.
      if (writes.length > 0) {
        const current = await this.metaGet<number>('catalogue:snapshotAt');
        if (current === undefined || current < newest) {
          await this.metaSet('catalogue:snapshotAt', newest);
        }
      }
    } catch (error) {
      throw new OfflineStorageError(
        classifyStorageError(error),
        `offline: catalogue write failed`,
        { cause: error },
      );
    }
  }

  /**
   * Replaces the whole cached catalogue with one server read. The clear, the
   * row writes and the snapshot timestamp commit in one transaction, so a
   * reload never sees a half-updated snapshot.
   *
   * An empty `writes` array is still a real snapshot: `catalogue:snapshotAt`
   * is advanced to `snapshotAt`, which is how the POS distinguishes "the server
   * said this branch has no products" from "this device has never cached a
   * catalogue".
   */
  async replaceCatalogue(writes: CatalogueWrite[], snapshotAt = Date.now()): Promise<void> {
    const tx = this.db.transaction(['catalogue', 'meta'], 'readwrite');
    try {
      await tx.objectStore('catalogue').clear();
      for (const write of writes) {
        const record: CatalogueRecord = {
          id: write.id,
          pharmacyId: this.identity.pharmacyId,
          data: this.guarded(write.data) as CatalogueRecord['data'],
          cachedAt: write.cachedAt,
          serverConfirmed: false,
        };
        await tx.objectStore('catalogue').put(record);
      }
      await tx.objectStore('meta').put({
        key: 'catalogue:snapshotAt',
        value: snapshotAt,
      });
      await tx.done;
    } catch (error) {
      throw new OfflineStorageError(
        classifyStorageError(error),
        'offline: catalogue snapshot replacement failed',
        { cause: error },
      );
    }
  }

  /**
   * Reads the cached catalogue for this pharmacy.
   *
   * Every record keeps `serverConfirmed: false` from the write path; a caller
   * that wants current data must have its own refresh path. Financial keys in
   * the STORE cannot be trusted to be absent if a different process wrote them
   * (an owned database opened by a non-owner repo) — the read re-strips for
   * non-owners and asserts emptiness, the same invariant the write had.
   */
  async readCatalogue(): Promise<CatalogueRead> {
    const rows = await this.db.getAll('catalogue');
    const records = rows
      .filter((r) => !this.strayEncoded(r.pharmacyId))
      .map((r) =>
        this.role === 'owner'
          ? r
          : // Read-side re-cut: the persisted shape may have been written by an
            // owner repo in a dev shell; the attendant's read must never hand it on.
            { ...r, data: this.guarded(r.data) as CatalogueRecord['data'] },
      );
    const snapshotAt = await this.metaGet<number>('catalogue:snapshotAt');
    return { records, fromCache: true, snapshotAt: snapshotAt ?? null };
  }

  /* --------------------------------------------------------------- customers */

  /**
   * Replaces the whole cached customer identity list. Callers must pass the
   * minimal projection (id, name, phone); wallet, debt and lifetime spend are
   * never written here.
   */
  async replaceCustomers(writes: CustomerWrite[], snapshotAt = Date.now()): Promise<void> {
    const tx = this.db.transaction(['customers', 'meta'], 'readwrite');
    try {
      await tx.objectStore('customers').clear();
      for (const write of writes) {
        const record: CustomerRecord = {
          id: write.id,
          pharmacyId: this.identity.pharmacyId,
          data: this.guarded(write.data) as CustomerRecord['data'],
          cachedAt: write.cachedAt,
          serverConfirmed: false,
        };
        await tx.objectStore('customers').put(record);
      }
      await tx.objectStore('meta').put({
        key: 'customers:snapshotAt',
        value: snapshotAt,
      });
      await tx.done;
    } catch (error) {
      throw new OfflineStorageError(
        classifyStorageError(error),
        'offline: customer snapshot replacement failed',
        { cause: error },
      );
    }
  }

  async readCustomers(): Promise<CustomerRead> {
    const rows = await this.db.getAll('customers');
    const records = rows
      .filter((r) => !this.strayEncoded(r.pharmacyId))
      .map((r) =>
        this.role === 'owner'
          ? r
          : { ...r, data: this.guarded(r.data) as CustomerRecord['data'] },
      );
    const snapshotAt = await this.metaGet<number>('customers:snapshotAt');
    return { records, fromCache: true, snapshotAt: snapshotAt ?? null };
  }

  /* ------------------------------------------------------- housekeeping/meta */

  async metaGet<T>(key: string): Promise<T | undefined> {
    const row = await this.db.get('meta', key);
    return row?.value as T | undefined;
  }

  async metaSet(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction('meta', 'readwrite');
    await tx.store.put({ key, value });
    await tx.done;
  }

  /* ------------------------------------------------------------------- outbox */

  /**
   * Queues one pending operation.
   *
   * A repeat with the same operation id AND the same canonical payload is a
   * no-op (`duplicate: true`) — that is idempotent replay, and it is what makes
   * a caller safe to re-run. The same id with a *different* payload is not a
   * retry; it is either a bug or an attacker. It is refused and written to
   * `conflicts` for the operator to see, rather than overwriting the queued
   * operation (which would silently change what will be sent).
   */
  async enqueueOp(op: OutboxOp, options?: { ignoreKeys?: string[] }): Promise<OutboxEnqueueResult> {
    if (!op.opId || typeof op.opId !== 'string') {
      return { ok: false, error: 'an operation id is required' };
    }
    if (!op.type || typeof op.type !== 'string') {
      return { ok: false, error: 'an operation type is required' };
    }
    const stamp = this.identity.pharmacyId;
    // `ignoreKeys` names payload keys that are NOT part of the operation's
    // identity ("same opId must mean the same intent"). A caller that stamps a
    // local-only time (the POS sale's `sold_at`) between its clicks would
    // otherwise read as a divergent payload and raise a false conflict. The
    // keys are dropped from BOTH sides of the comparison; they remain stored.
    const ignore = options?.ignoreKeys ?? [];
    const strip = (value: unknown): unknown => {
      const copy = { ...(value as Record<string, unknown>) };
      for (const key of ignore) delete copy[key];
      return copy;
    };
    const record: OutboxRecord = {
      opId: op.opId,
      pharmacyId: stamp,
      type: op.type,
      payload: this.guarded(op.payload),
      createdAt: Date.now(),
      status: 'pending',
      deps: op.deps ?? [],
      attempts: 0,
      nextAttemptAt: null,
      inFlightSince: null,
      lastError: null,
    };
    // Check-and-put must be ONE transaction: two concurrent enqueues of the
    // same opId (two clicks of one sale in the same tick) can otherwise BOTH
    // miss the pre-check, and the second put silently OVERWRITES the first
    // row's bookkeeping. IndexedDB gives single-store readwrite transactions
    // serialised, all-or-nothing store access, so this is the fence that makes
    // "one intended sale" actually atomic on the device.
    const tx = this.db.transaction('outbox', 'readwrite');
    const existing = await tx.store.get(op.opId);
    if (existing) {
      const same =
        existing.type === record.type &&
        stableStringify(strip(existing.payload)) === stableStringify(strip(record.payload));
      await tx.done;
      if (same) return { ok: true, duplicate: true };
      await this.recordConflict({
        opId: op.opId,
        type: op.type,
        payload: op.payload,
        reason: 'duplicate-op-id-payload-mismatch',
      });
      return { ok: false, error: 'duplicate operation id with a different payload' };
    }
    await tx.store.put(record);
    await tx.done;
    return { ok: true };
  }

  /** Defaults for rows written before retry bookkeeping existed. */
  private normalizeOutboxRow(r: OutboxRecord): OutboxRecord {
    return {
      ...r,
      deps: r.deps ?? [],
      attempts: r.attempts ?? 0,
      nextAttemptAt: r.nextAttemptAt ?? null,
      inFlightSince: r.inFlightSince ?? null,
      lastError: r.lastError ?? null,
    };
  }

  async listOutbox(): Promise<OutboxRecord[]> {
    const rows = await this.db.getAll('outbox');
    return rows
      .filter((r) => !this.strayEncoded(r.pharmacyId))
      .map((r) => this.normalizeOutboxRow(r));
  }

  async getOutboxOp(opId: string): Promise<OutboxRecord | undefined> {
    const row = await this.db.get('outbox', opId);
    if (!row) return undefined;
    return this.strayEncoded(row.pharmacyId) ? undefined : this.normalizeOutboxRow(row);
  }

  /**
   * Rows stamped with a *foreign* pharmacy id inside this database. They are
   * invisible to every normal read; the sync engine asks for them explicitly so
   * they can be flagged for attention rather than left pending forever.
   */
  async listOutboxStrays(): Promise<OutboxRecord[]> {
    const rows = await this.db.getAll('outbox');
    return rows
      .filter((r) => this.strayEncoded(r.pharmacyId))
      .map((r) => this.normalizeOutboxRow(r));
  }

  /**
   * Persists an attempt's bookkeeping (and any status change) atomically.
   * The sync engine stamps `inFlightSince` BEFORE dispatching and clears it
   * (placing retry state) once the outcome is durable — a crash in between
   * leaves the row self-describing: send happened, outcome unknown.
   */
  async markAttempt(
    opId: string,
    update: {
      attempts: number;
      nextAttemptAt: number | null;
      inFlightSince: number | null;
      lastError: OutboxRecord['lastError'];
      status?: 'pending' | 'needs-attention';
    },
  ): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    const row = await tx.store.get(opId);
    if (!row) {
      await tx.done;
      return;
    }
    await tx.store.put({
      ...this.normalizeOutboxRow(row),
      attempts: update.attempts,
      nextAttemptAt: update.nextAttemptAt,
      inFlightSince: update.inFlightSince,
      lastError: update.lastError,
      ...(update.status ? { status: update.status } : {}),
    });
    await tx.done;
  }

  /**
   * Durably records a successful (or finally-rejected) outcome AND removes the
   * operation, in one transaction — the engine never deletes an op whose
   * outcome is not already committed. Callers re-run an op id found without an
   * outcome only under the idempotency contract (`docs/OFFLINE-SYNC.md`).
   */
  async completeOutboxOp(
    opId: string,
    outcome: {
      ok: boolean;
      reason?: string;
      at: number;
      /** Which operation type produced this outcome, so views can filter. */
      type?: string;
      /** Small success data (sale id, receipt) for confirmed-state views. */
      result?: Record<string, unknown>;
      /**
       * A server-confirmed operation whose financial result disagrees with the
       * locally quoted sale. The outcome remains durable and the original
       * payload is copied to `conflicts` in the SAME transaction, so the sale
       * cannot vanish merely because the sync engine completed it.
       */
      reconciliation?: {
        reason: string;
        details?: Record<string, unknown> | null;
        serverRejection?: string | null;
      };
    },
  ): Promise<boolean> {
    const tx = this.db.transaction(['outbox', 'meta', 'conflicts'], 'readwrite');
    const row = await tx.objectStore('outbox').get(opId);
    const existed = row !== undefined;
    if (row) {
      await tx.objectStore('meta').put({
        key: `outbox:outcome:${opId}`,
        value: {
          ok: outcome.ok,
          reason: outcome.reason ?? null,
          at: outcome.at,
          ...(outcome.type !== undefined ? { type: outcome.type } : {}),
          ...(outcome.result !== undefined ? { result: outcome.result } : {}),
          ...(outcome.reconciliation !== undefined ? { reconciliation: outcome.reconciliation } : {}),
        },
      });
      if (outcome.reconciliation) {
        await tx.objectStore('conflicts').put({
          opId,
          pharmacyId: row.pharmacyId,
          type: row.type,
          payload: row.payload,
          reason: outcome.reconciliation.reason,
          rejectedAt: outcome.at,
          serverRejection: outcome.reconciliation.serverRejection ?? null,
          kind: 'server-mismatch',
          serverConfirmed: true,
          details: outcome.reconciliation.details ?? null,
        });
      }
      await tx.objectStore('outbox').delete(opId);
    }
    await tx.done;
    return existed;
  }

  /**
   * Moves a rejected operation into `conflicts` and out of the outbox in ONE
   * transaction — "rejected" is a terminal, durable state, never a silent gap.
   */
  async rejectOutboxOp(
    opId: string,
    rejected: { type: string; reason: string; serverRejection?: string | null; rejectedAt: number },
  ): Promise<boolean> {
    const tx = this.db.transaction(['outbox', 'conflicts'], 'readwrite');
    const row = await tx.objectStore('outbox').get(opId);
    const existed = row !== undefined;
    if (row) {
      await tx.objectStore('conflicts').put({
        opId,
        pharmacyId: row.pharmacyId,
        type: rejected.type,
        payload: row.payload,
        reason: rejected.reason,
        rejectedAt: rejected.rejectedAt,
        serverRejection: rejected.serverRejection ?? null,
        kind: 'rejected',
        serverConfirmed: false,
        details: null,
      });
      await tx.objectStore('outbox').delete(opId);
    }
    await tx.done;
    return existed;
  }

  async getOutcome(opId: string): Promise<{ ok: boolean; reason: string | null; at: number } | undefined> {
    const row = await this.db.get('meta', `outbox:outcome:${opId}`);
    return row?.value as { ok: boolean; reason: string | null; at: number } | undefined;
  }

  /**
   * Every durably-recorded outbox outcome in this database, optionally filtered
   * by operation type. Outcomes outlive their outbox rows by design ("we sent
   * it" must survive the row's removal), so the confirmed-state view reads
   * here rather than having to remember which ops once existed.
   */
  async listOutboxOutcomes(filter?: { type?: string }): Promise<
    {
      opId: string;
      ok: boolean;
      reason: string | null;
      at: number;
      type: string | null;
      result: Record<string, unknown> | null;
      reconciliation: Record<string, unknown> | null;
    }[]
  > {
    const rows = await this.db.getAll('meta');
    const outcomes: {
      opId: string;
      ok: boolean;
      reason: string | null;
      at: number;
      type: string | null;
      result: Record<string, unknown> | null;
      reconciliation: Record<string, unknown> | null;
    }[] = [];
    const prefix = 'outbox:outcome:';
    for (const row of rows) {
      if (typeof row.key !== 'string' || !row.key.startsWith(prefix)) continue;
      const value = row.value as {
        ok: boolean;
        reason: string | null;
        at: number;
        type?: string;
        result?: Record<string, unknown>;
        reconciliation?: Record<string, unknown>;
      };
      if (filter?.type !== undefined && value.type !== filter.type) continue;
      outcomes.push({
        opId: row.key.slice(prefix.length),
        ok: value.ok,
        reason: value.reason,
        at: value.at,
        type: value.type ?? null,
        result: value.result ?? null,
        reconciliation: value.reconciliation ?? null,
      });
    }
    outcomes.sort((a, b) => b.at - a.at);
    return outcomes;
  }

  /* --------------------------------------------------------------- conflicts */

  async recordConflict(input: {
    opId: string;
    type: string;
    payload: unknown;
    reason: string;
    serverRejection?: string | null;
    /** Defaults to a device-only duplicate-key conflict. */
    kind?: ConflictRecord['kind'];
    serverConfirmed?: boolean;
    details?: Record<string, unknown> | null;
  }): Promise<void> {
    const record: ConflictRecord = {
      opId: input.opId,
      pharmacyId: this.identity.pharmacyId,
      type: input.type,
      payload: this.guarded(input.payload),
      reason: input.reason,
      rejectedAt: Date.now(),
      serverRejection: input.serverRejection ?? null,
      // Default: this conflict is raised entirely on the device. The original
      // queued operation is still intact and no server call was made for this
      // payload, so it must not be shown as a server refusal. The online POS
      // path overrides this for a server-confirmed price mismatch.
      kind: input.kind ?? 'local-duplicate',
      serverConfirmed: input.serverConfirmed ?? false,
      details: input.details ?? null,
    };
    const tx = this.db.transaction('conflicts', 'readwrite');
    await tx.store.put(record);
    await tx.done;
  }

  async listConflicts(): Promise<ConflictRecord[]> {
    const rows = await this.db.getAll('conflicts');
    return rows.filter((r) => !this.strayEncoded(r.pharmacyId));
  }

  /** One conflict record, if any. Dependency resolution reads this directly. */
  async getConflict(opId: string): Promise<ConflictRecord | undefined> {
    return this.db.get('conflicts', opId);
  }

  /* ------------------------------------------------------- sales/audit mirror */

  async saveSales(writes: MirrorWrite[], serverConfirmed: boolean): Promise<void> {
    const tx = this.db.transaction('sales', 'readwrite');
    try {
      for (const write of writes) {
        const record = {
          id: write.id,
          pharmacyId: this.identity.pharmacyId,
          data: this.guarded(write.data),
          soldAt: nowIsoOrNull(write.soldAt ?? null),
          cachedAt: write.cachedAt,
          serverConfirmed,
        };
        await tx.store.put(record);
      }
      await tx.done;
    } catch (error) {
      throw new OfflineStorageError(classifyStorageError(error), 'offline: sales write failed', {
        cause: error,
      });
    }
  }

  async listSales(): Promise<SaleRead> {
    const rows = await this.db.getAll('sales');
    const records = rows
      .filter((r) => !this.strayEncoded(r.pharmacyId))
      .map((r) => ({
        id: r.id,
        data: this.role === 'owner' ? r.data : this.guarded(r.data),
        soldAt: r.soldAt,
        cachedAt: r.cachedAt,
        serverConfirmed: r.serverConfirmed,
      }));
    const snapshotAt = await this.metaGet<number>('sales:snapshotAt');
    return { records, fromCache: true, snapshotAt: snapshotAt ?? null };
  }

  async saveAudit(writes: MirrorWrite[], serverConfirmed: boolean): Promise<void> {
    const tx = this.db.transaction('audit', 'readwrite');
    try {
      for (const write of writes) {
        const record = {
          id: write.id,
          pharmacyId: this.identity.pharmacyId,
          data: this.guarded(write.data),
          occurredAt: nowIsoOrNull(write.occurredAt ?? null),
          cachedAt: write.cachedAt,
          serverConfirmed,
        };
        await tx.store.put(record);
      }
      await tx.done;
    } catch (error) {
      throw new OfflineStorageError(classifyStorageError(error), 'offline: audit write failed', {
        cause: error,
      });
    }
  }

  async listAudit(): Promise<Record<string, unknown>[]> {
    const rows = await this.db.getAll('audit');
    return rows
      .filter((r) => !this.strayEncoded(r.pharmacyId))
      .map((r) => ({
        id: r.id,
        data: this.role === 'owner' ? r.data : this.guarded(r.data),
        occurredAt: r.occurredAt,
        cachedAt: r.cachedAt,
        serverConfirmed: r.serverConfirmed,
      }));
  }

  close(): void {
    openRepos.delete(this);
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------------ purge */

/**
 * Closes every open repo handle for one identity, or every repo when no
 * identity is supplied. Returns how many handles were closed.
 */
export function closeOpenOfflineRepos(identity?: OfflineIdentity): number {
  let closed = 0;
  for (const repo of [...openRepos]) {
    if (
      identity &&
      (repo.identity.pharmacyId !== identity.pharmacyId ||
        repo.identity.userId !== identity.userId)
    ) {
      continue;
    }
    repo.close();
    closed += 1;
  }
  return closed;
}

/** Deletes one identity's whole local database and drops it from the registry. */
export async function purgeIdentity({ pharmacyId, userId }: OfflineIdentity): Promise<void> {
  const name = databaseName({ pharmacyId, userId });
  // A purge is an explicit lifecycle action, not a concurrent read. Close this
  // tab's matching handles before deleting so the delete is not blocked by the
  // POS screen's own connection.
  closeOpenOfflineRepos({ pharmacyId, userId });
  await deleteDatabase(name);
  dropFromRegistry(name);
}

export interface OfflineIdentityWork {
  /** Rows still waiting to be sent, including needs-attention rows. */
  outbox: number;
  /** Terminal conflicts that still need a human decision. */
  conflicts: number;
  /** Outbox rows stamped with a foreign pharmacy id — still unsynced evidence. */
  strays: number;
  /**
   * A valid unresolved-settlement note: an attempt whose ledger outcome is not
   * known. It is not a queued sale, but losing it on sign-out would erase the
   * only device-side evidence that the server may already have recorded it.
   */
  unresolved: number;
}

/**
 * Reads the unsynchronised work for one identity without deleting anything.
 *
 * Sign-out uses this to decide whether a purge is safe. A read failure is
 * propagated: "could not tell" is never treated as "nothing pending".
 */
export async function inspectIdentityWork(identity: OfflineIdentity): Promise<OfflineIdentityWork> {
  const repo = await OfflineRepo.open(identity, 'unknown');
  try {
    const [outbox, conflicts, strays, note] = await Promise.all([
      repo.listOutbox(),
      repo.listConflicts(),
      repo.listOutboxStrays(),
      repo.metaGet<unknown>(UNRESOLVED_ATTEMPT_META_KEY),
    ]);
    return {
      outbox: outbox.length,
      conflicts: conflicts.length,
      strays: strays.length,
      // IndexedDB is untrusted bytes. A malformed note is ignored here too, so
      // corruption cannot keep an otherwise clean identity un-purgeable forever.
      unresolved: parseUnresolvedAttempt(note) ? 1 : 0,
    };
  } finally {
    repo.close();
  }
}

/**
 * Deletes every PharmaFlow offline database this browser holds, for example on
 * pharmacy suspension or a staff-removal directive.
 *
 * Enumeration is the primary source (`indexedDB.databases()`); the localStorage
 * registry (names only) is the fallback for engines without enumeration.
 * Both sources are filtered to `pf-offline:` names, so nothing outside this
 * application's namespace is ever deleted.
 */
export async function purgeAllOffline(): Promise<string[]> {
  closeOpenOfflineRepos();
  const names = await enumerateOfflineDatabases();
  const deleted: string[] = [];
  for (const name of names) {
    await deleteDatabase(name);
    deleted.push(name);
    dropFromRegistry(name);
  }
  // The registry itself is emptied too: names enumerated but missing locally
  // vanish here as well.
  if (names.length === 0) writeRegistry([]);
  return deleted;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new OfflineStorageError(classifyStorageError(request.error), `offline: purge failed for ${name}`));
    request.onblocked = () =>
      reject(new OfflineStorageError('blocked', `offline: purge blocked for ${name}`));
  });
}

async function enumerateOfflineDatabases(): Promise<string[]> {
  if (typeof globalThis.indexedDB.databases === 'function') {
    try {
      const dbs = await globalThis.indexedDB.databases();
      return (dbs ?? [])
        .filter((db) => typeof db.name === 'string' && db.name.startsWith('pf-offline:'))
        .map((db) => String(db.name));
    } catch {
      /* fall back to the registry */
    }
  }
  return readRegistry().filter((n) => n.startsWith('pf-offline:'));
}

/* ------------------------------------------------------------------- exports */

export type { OfflineIdentity, OfflineStoreName, LocalRole };
