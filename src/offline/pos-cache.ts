/**
 * The POS-only offline read cache.
 *
 * This is deliberately narrower than a general offline catalogue:
 *
 *   - it stores only what the POS needs to compose a sale (product identity,
 *     packaging, retail price, batches and customer id/name/phone);
 *   - it never stores cost, margin, wallet, debt or lifetime-spend fields;
 *   - it replaces the whole snapshot at once, so a reload can never combine
 *     yesterday's products with today's customers;
 *   - cached stock is a hint only. The server remains the authority when the
 *     queued sale syncs.
 *
 * The live hooks remain the source on an online branch. This module is read only
 * when the branch itself came from the saved-branch snapshot.
 */

import type { Customer, Medicine } from '~/domain/types';
import type { CatalogueRecord, CustomerRecord } from './db-schema';
import { stripFinancialFields } from './financial-guard';
import {
  VERY_STALE_MS,
  staleInfo,
  type FreshnessBucket,
  type OfflineRepo,
} from './local-db';

export type PosCustomer = Pick<Customer, 'id' | 'name' | 'phone'> & {
  /**
   * Present only on a live row. The cached projection deliberately omits it,
   * because an old balance must not be shown as the current amount owed.
   */
  outstandingDebt?: number;
};

export interface CachedSlice<T> {
  records: T[];
  /** False when this device has never saved a snapshot for this store. */
  present: boolean;
  cachedAt: number | null;
  bucket: FreshnessBucket | null;
  ageMs: number | null;
}

export interface PosCacheSnapshot {
  catalogue: CachedSlice<Medicine>;
  customers: CachedSlice<PosCustomer>;
}

export class PosCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PosCacheError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTradeUnit(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.name === 'string' &&
    isFiniteNumber(value.multiplier) &&
    value.multiplier > 0 &&
    isFiniteNumber(value.sellingPrice) &&
    value.sellingPrice >= 0
  );
}

function isBatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.batchNumber === 'string' &&
    typeof value.expiryDate === 'string' &&
    isFiniteNumber(value.quantity) &&
    value.quantity >= 0 &&
    typeof value.supplier === 'string' &&
    typeof value.receivedDate === 'string' &&
    typeof value.isRecalled === 'boolean'
  );
}

/**
 * A deliberately strict shape check for the cached medicine. A damaged or
 * older-shape row is refused rather than cast, because the POS reads many
 * fields while composing a sale and a partial row would fail later, mid-sale.
 */
function isCachedMedicine(value: unknown): value is Medicine {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.barcode === undefined || typeof value.barcode === 'string') &&
    typeof value.name === 'string' &&
    typeof value.genericName === 'string' &&
    typeof value.strength === 'string' &&
    typeof value.dosageForm === 'string' &&
    typeof value.category === 'string' &&
    Array.isArray(value.units) &&
    value.units.every(isTradeUnit) &&
    isFiniteNumber(value.totalQuantity) &&
    isFiniteNumber(value.lowStockThreshold) &&
    typeof value.expiryDate === 'string' &&
    typeof value.supplier === 'string' &&
    typeof value.purchaseDate === 'string' &&
    isFiniteNumber(value.pricePerBaseUnit) &&
    Array.isArray(value.batches) &&
    value.batches.every(isBatch) &&
    typeof value.commonUse === 'string' &&
    typeof value.storage === 'string' &&
    typeof value.prescriptionStatus === 'string' &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string') &&
    typeof value.isBrand === 'boolean' &&
    isRecord(value.doNotSell) &&
    typeof value.doNotSell.active === 'boolean' &&
    (value.doNotSell.reason === undefined || typeof value.doNotSell.reason === 'string') &&
    isFiniteNumber(value.averageDailySales)
  );
}

function isCachedCustomer(value: unknown): value is PosCustomer {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.phone === 'string'
  );
}

function decodeCatalogue(records: CatalogueRecord[]): Medicine[] {
  const decoded: Medicine[] = [];
  for (const record of records) {
    if (!isCachedMedicine(record.data)) {
      throw new PosCacheError('The saved product catalogue is not readable.');
    }
    // Re-strip on read as well as write. The writer already removes cost, but a
    // tampered or older row must not cross the cache boundary with it.
    decoded.push(toCachedMedicine(record.data));
  }
  return decoded;
}

function decodeCustomers(records: CustomerRecord[]): PosCustomer[] {
  const decoded: PosCustomer[] = [];
  for (const record of records) {
    if (!isCachedCustomer(record.data)) {
      throw new PosCacheError('The saved customer list is not readable.');
    }
    // Project again on read: even a tampered row cannot leak debt or spend into
    // the POS customer picker.
    decoded.push(toCachedCustomer(record.data));
  }
  return decoded;
}

function slice<T>(
  records: T[],
  snapshotAt: number | null,
  now: number,
): CachedSlice<T> {
  if (snapshotAt === null || !Number.isFinite(snapshotAt) || snapshotAt <= 0) {
    return { records: [], present: false, cachedAt: null, bucket: null, ageMs: null };
  }
  const freshness = staleInfo({ cachedAt: snapshotAt }, now);
  return {
    records,
    present: true,
    cachedAt: snapshotAt,
    bucket: freshness.bucket,
    ageMs: freshness.ageMs,
  };
}

/** Reads both halves of the POS snapshot. Storage/shape failures throw. */
export async function readPosCache(
  repo: OfflineRepo,
  now = Date.now(),
): Promise<PosCacheSnapshot> {
  const [catalogue, customers] = await Promise.all([
    repo.readCatalogue(),
    repo.readCustomers(),
  ]);
  return {
    catalogue: slice(decodeCatalogue(catalogue.records), catalogue.snapshotAt, now),
    customers: slice(decodeCustomers(customers.records), customers.snapshotAt, now),
  };
}

/**
 * The catalogue written to the cache is always stripped, even for an owner:
 * the POS cache is a shared-till artifact, not an owner reporting cache.
 */
export function toCachedMedicine(medicine: Medicine): Medicine {
  return stripFinancialFields(medicine) as Medicine;
}

/** Minimal customer identity. No wallet, debt, spend, notes or reminders. */
export function toCachedCustomer(
  customer: Pick<Customer, 'id' | 'name' | 'phone'>,
): PosCustomer {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
  };
}

export async function cachePosCatalogue(
  repo: OfflineRepo,
  medicines: Medicine[],
  now = Date.now(),
): Promise<void> {
  await repo.replaceCatalogue(
    medicines.map((medicine) => ({
      id: medicine.id,
      data: toCachedMedicine(medicine),
      cachedAt: now,
    })),
    now,
  );
}

export async function cachePosCustomers(
  repo: OfflineRepo,
  customers: Customer[],
  now = Date.now(),
): Promise<void> {
  await repo.replaceCustomers(
    customers.map((customer) => ({
      id: customer.id,
      data: toCachedCustomer(customer),
      cachedAt: now,
    })),
    now,
  );
}

/**
 * A snapshot older than 24 hours is not allowed to compose a sale. `stale`
 * (2 minutes to 24 hours) is usable with a visible age label.
 *
 * Age is re-evaluated against `now` rather than trusted from the `bucket`
 * computed when the cache was read. A till left open offline can cross the
 * 24-hour line without another read; the bucket would still say "stale".
 */
export function isCachedSliceUsable<T>(
  sliceValue: CachedSlice<T> | null | undefined,
  now = Date.now(),
): boolean {
  if (
    sliceValue === null ||
    sliceValue === undefined ||
    !sliceValue.present ||
    sliceValue.cachedAt === null ||
    !Number.isFinite(sliceValue.cachedAt)
  ) {
    return false;
  }
  return Math.max(0, now - sliceValue.cachedAt) < VERY_STALE_MS;
}

export function formatCacheAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return 'unknown age';
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
