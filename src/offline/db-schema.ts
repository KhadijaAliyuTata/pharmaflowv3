/**
 * Local-database identity, naming and versioned schema.
 *
 * ## One database per (pharmacy, user) pair
 *
 * Local data is namespaced at the *database* level, not by a row key. A database
 * name is `pf-offline:<pharmacyId>:<userId>`, so opening a repo for a different
 * account or branch cannot reach another account's rows — there is simply no
 * path from one database's connection to another's stores. Record-level stamping
 * (`pharmacyId` on every row, checked on every read) is kept as a second layer
 * for defence in depth: if a namespacing defect ever returned foreign rows, the
 * read filter would still exclude them.
 *
 * Names only ever contain branch/user ids and are constructed from validated
 * components — an identity component that is not `[A-Za-z0-9_-]` refuses to
 * open rather than degrading to a shared fallback name.
 *
 * ## Versioned schema (v2)
 *
 * `applyOfflineSchemaV1` is called by `idb`'s `upgrade` callback with an
 * `oldVersion` of `0` for a fresh database and the previous version for an
 * upgrade. v1 created six stores; v2 adds one:
 *
 *   `meta`      — key/value housekeeping (schema version, snapshot timestamps).
 *   `catalogue` — cached medicines, one keyed row per product.
 *   `customers` — cached customer identity rows (id, name, phone only).
 *   `outbox`    — pending operations waiting for the sync engine.
 *   `conflicts` — rejected or needs-attention operations awaiting a decision.
 *   `sales`     — server-confirmed sale mirrors.
 *   `audit`     — server-confirmed audit-event mirrors.
 *
 * Every store listed here exists now so later phases add *fields in records*,
 * not new stores, and a fresh install and a three-phase-old install that both
 * run today's code end with the same shape. Adding a store is a new version plus
 * an additive branch here — never an in-place rewrite of a shipped store.
 */

import type { DBSchema } from 'idb';
import type { StaffRole } from '~/domain/types';

/** The branch id and user id that name this browser's local database. */
export interface OfflineIdentity {
  pharmacyId: string;
  userId: string;
  role?: StaffRole;
}

/** Which role a cache is allowed to persist for. `owner` is the only privileged one. */
export type LocalRole = 'owner' | 'assistant' | 'platform_admin' | 'unknown';

const DB_PREFIX = 'pf-offline';

/**
 * Databases created today. Every offline handle to these tables below starts at
 * v1/v2 and moves forward, so the array is read for housekeeping purposes only.
 */
export const SCHEMA_VERSION = 2;

/**
 * Database name for a `(branch, user)` pair.
 *
 * Identity components are validated, not sanitised: a component that is not a
 * plain id token fails the open instead of quietly aliasing two accounts into a
 * shared name.
 */
export function databaseName(identity: OfflineIdentity): string {
  const branch = identity.pharmacyId?.trim() ?? '';
  const user = identity.userId?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(branch)) {
    throw new Error('offline: invalid pharmacy id in local identity');
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(user)) {
    throw new Error('offline: invalid user id in local identity');
  }
  return `${DB_PREFIX}:${branch}:${user}`;
}

export type OfflineStoreName =
  | 'meta'
  | 'catalogue'
  | 'customers'
  | 'outbox'
  | 'conflicts'
  | 'sales'
  | 'audit';

export interface CatalogueRecord {
  id: string;
  pharmacyId: string;
  /** The domain row as the reader delivered it, financial fields already cut for non-owners. */
  data: unknown;
  /** When the row was received from the server. Freshness policy reads this. */
  cachedAt: number;
  /** False here means one thing: the server has not vouched for this copy. */
  serverConfirmed: false;
}

/**
 * A cached customer row. The `data` is deliberately minimal: id, name and phone
 * only. Wallet, debt, lifetime spend and every other owner-visible financial
 * field stay out of IndexedDB; the live customer hook remains the only source
 * for those figures.
 */
export interface CustomerRecord {
  id: string;
  pharmacyId: string;
  data: unknown;
  cachedAt: number;
  serverConfirmed: false;
}

/**
 * One pending server operation.
 *
 * ## Retry bookkeeping (persisted, never in-memory)
 *
 * `attempts`, `nextAttemptAt`, `inFlightSince` and `lastError` survive reload
 * and restart, so a tab crash does not reset retry history
 * (`verify-offline-sync.mjs` pins this). `inFlightSince` is stamped before a
 * send and cleared once the outcome is durable — a row found still in flight
 * means the outcome was never recorded, which the engine treats as a possibly-
 * executed operation for the next run (therefore every op id doubles as the
 * server-side idempotency key; see `docs/OFFLINE-SYNC.md`).
 *
 * Record-field evolution is deliberately done *without* a database version
 * bump: the keyPath and index set are unchanged, so v1 rows missing these
 * fields simply default to "never attempted" on read. A version bump happens
 * only when a keyPath or index changes.
 */
export interface OutboxRecord {
  opId: string;
  pharmacyId: string;
  type: string;
  payload: unknown;
  /** Created locally; the sync engine later attaches server outcomes. */
  createdAt: number;
  status: 'pending' | 'needs-attention';
  /** Operation ids that must be durably completed before this one runs. */
  deps?: string[];
  attempts: number;
  /** Earliest time the engine may send again; `null` = blocked from retrying. */
  nextAttemptAt: number | null;
  /** Set just before a send, cleared when the outcome is durably recorded. */
  inFlightSince: number | null;
  lastError: {
    kind: string;
    message: string;
    at: number;
  } | null;
}

export interface ConflictRecord {
  opId: string;
  pharmacyId: string;
  type: string;
  payload: unknown;
  reason: string;
  rejectedAt: number;
  /** Non-null means a server opinion was attached (sync phase). */
  serverRejection?: string | null;
  /**
   * `rejected` means the server refused the operation and nothing was written.
   * `server-mismatch` means the server completed it but the financial result
   * differs from the locally quoted sale, so it needs reconciliation.
   * `local-duplicate` means a second, different payload tried to reuse an
   * already-saved operation id. The original queued operation is untouched.
   */
  kind?: 'rejected' | 'server-mismatch' | 'local-duplicate';
  /** TRUE only for server-mismatch, where a sale id/receipt was returned. */
  serverConfirmed?: boolean;
  /** Small, non-sensitive comparison values for the recovery view. */
  details?: Record<string, unknown> | null;
}

export interface SaleRecord {
  id: string;
  pharmacyId: string;
  data: unknown;
  soldAt: string | null;
  cachedAt: number;
  serverConfirmed: boolean;
}

export interface AuditRecord {
  id: string;
  pharmacyId: string;
  data: unknown;
  occurredAt: string | null;
  cachedAt: number;
  serverConfirmed: boolean;
}

export interface OfflineDBV1 extends DBSchema {
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
  catalogue: {
    key: string;
    value: CatalogueRecord;
    indexes: { by_pharmacy: string };
  };
  customers: {
    key: string;
    value: CustomerRecord;
    indexes: { by_pharmacy: string };
  };
  outbox: {
    key: string;
    value: OutboxRecord;
    indexes: { by_pharmacy: string };
  };
  conflicts: {
    key: string;
    value: ConflictRecord;
    indexes: { by_pharmacy: string };
  };
  sales: {
    key: string;
    value: SaleRecord;
    indexes: { by_pharmacy: string };
  };
  audit: {
    key: string;
    value: AuditRecord;
    indexes: { by_pharmacy: string };
  };
}

export type OfflineTransaction<T extends OfflineStoreName | OfflineStoreName[]> = never;

/**
 * Applies every schema branch up to the current version. Called by the
 * `upgrade` hook when a database opens with `oldVersion` below this file's
 * version.
 *
 * The `objectStoreNames` guard makes the function safe for an incomplete
 * legacy database as well as the real shipped v1 shape: a store that already
 * exists is never recreated, and a missing v1 store is filled in before v2's
 * additive branch runs.
 */
export function applyOfflineSchemaV1(
  db: {
    objectStoreNames: { contains(name: string): boolean };
    createObjectStore(
      name: string,
      opts?: IDBObjectStoreParameters,
    ): { createIndex(name: string, keyPath: string | string[]): unknown };
  },
  oldVersion: number,
): void {
  if (oldVersion >= SCHEMA_VERSION) return;

  const ensureStore = (name: string, keyPath: string): void => {
    if (db.objectStoreNames.contains(name)) return;
    const store = db.createObjectStore(name, { keyPath });
    store.createIndex('by_pharmacy', 'pharmacyId');
  };

  // v1. Key/value housekeeping first.
  if (!db.objectStoreNames.contains('meta')) {
    db.createObjectStore('meta', { keyPath: 'key' });
  }

  // Pending operations and conflicts are keyed by their operation id; data
  // mirrors are keyed by row id.
  //
  // Every data store also carries a `pharmacyId` stamp and an index over it —
  // the record-level defence-in-depth behind database-level namespacing.
  ensureStore('catalogue', 'id');
  ensureStore('outbox', 'opId');
  ensureStore('conflicts', 'opId');
  ensureStore('sales', 'id');
  ensureStore('audit', 'id');

  // v2. Customer identity rows for the POS-only offline cache. This is an
  // additive store; no shipped store is rewritten.
  if (oldVersion < 2) ensureStore('customers', 'id');
}
