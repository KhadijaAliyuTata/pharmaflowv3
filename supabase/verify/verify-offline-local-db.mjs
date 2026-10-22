/**
 * Phase 1 — the local (IndexedDB) data foundation.
 *
 * Runs against `fake-indexeddb` (an in-memory IndexedDB implementation whose
 * upgrade/transaction semantics match the spec closely enough to pin these
 * properties). Five kinds of claim are pinned here:
 *
 *   1. **Financial leak-proofing** — an attendant repo cannot persist cost,
 *      COGS or margin data *anywhere* in its cache tree, even when the caller
 *      hands it data that contains those fields; an owner repo can. A tampered
 *      store (cost written by some other process) is re-cut on read.
 *
 *   2. **Tenant and identity isolation** — per-(pharmacy, user) databases; one
 *      identity's rows are invisible to another's; rows are stamped with the
 *      pharmacy id and reads filter on it.
 *
 *   3. **Durability** — data survives a close/reopen; the upgrade path keeps
 *      data while adding stores; duplicate outbox operation ids are idempotent
 *      on identical payloads and refused (as a recorded conflict) on divergent
 *      ones.
 *
 *   4. **Failure semantics** — un-serialisable values fail *classified*, and
 *      the database stays usable afterwards; classification is unit pinned for
 *      quota/version/abort families.
 *
 *   5. **Truthful freshness** — cached reads are labelled `fromCache` with a
 *      snapshot timestamp; buckets follow the policy but stock is *always* a
 *      hint, and recalls fail closed.
 *
 *   Plus purge: identity purge and browse-wide purge that never touches a
 *   database outside the `pf-offline:` namespace.
 */

import 'fake-indexeddb/auto';

// A minimal localStorage shim: fake-indexeddb runs in Node where localStorage
// may not exist, and the purge registry reads/writes it best-effort.
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

import {
  FRESH_MS,
  OfflineRepo,
  OfflineStorageError,
  VERY_STALE_MS,
  classifyStorageError,
  purgeAllOffline,
  purgeIdentity,
  staleInfo,
} from '../../src/offline/local-db.ts';
import {
  SCHEMA_VERSION,
  applyOfflineSchemaV1,
  databaseName,
} from '../../src/offline/db-schema.ts';
import {
  FORBIDDEN_FINANCIAL_KEYS,
  findFinancialKeys,
  stripFinancialFields,
} from '../../src/offline/financial-guard.ts';
import { createReporter } from './harness.mjs';
import { openDB } from 'idb';

const { check, note, section, finish } = createReporter('verify-offline-local-db');

const PH1 = '11111111-1111-1111-1111-111111111111';
const PH2 = '22222222-2222-2222-2222-222222222222';
const PH3 = '33333333-3333-3333-3333-333333333333';
const U1 = 'aaaa1111-1111-1111-1111-111111111111';
const U2 = 'bbbb2222-2222-2222-2222-222222222222';
const U3 = 'cccc3333-3333-3333-3333-333333333333';

/**
 * A medicine row shaped like the owner view delivers it: cost figures present,
 * plus a non-owner's copy where every financial field has been duplicated in
 * *nested* positions (variants, batch lists) to prove deep stripping.
 */
function ownerShapedMedicine(id, withCost = true) {
  const med = {
    id,
    name: `Medicine ${id}`,
    measure: 'strip',
    base_units_per_measure: 10,
    sale_prices: [{ currency: 'USD', per_measure: '2.50', per_base_unit: '0.25' }],
    stock: [{ branch_id: PH1, quantity: 42, low_stock_threshold: 5 }],
  };
  if (withCost) {
    med.cost_per_base_unit = '0.10';
    med.unitCost = 1.0;
    med.purchase_price = '1.00';
    med.batches = [
      {
        id: `${id}-batch-1`,
        batch_number: 'B-1',
        expiry_date: '2027-01-01',
        quantity: 30,
        cost: '0.10',
        is_recalled: false,
        profitability: { margin: 0.6, cogs: '0.10', profit: '0.15' },
      },
    ];
  }
  return med;
}

/* --------------------------------------------------------------- identity */

section('identity validation');

check(
  'a well-formed pharmacy+user id maps to a stable database name',
  databaseName({ pharmacyId: PH1, userId: U1 }) === `pf-offline:${PH1}:${U1}`,
);

check(
  'a malformed identity component refuses to open (no silent fallback alias)',
  (() => {
    try {
      databaseName({ pharmacyId: 'short', userId: U1 });
      return false;
    } catch (error) {
      return /invalid pharmacy id/.test(String(error?.message));
    }
  })(),
);

/* ---------------------------------------------------- financial leak tests */

section('attendant caches cannot hold financial fields');

{
  const repo = await OfflineRepo.open({ pharmacyId: PH1, userId: U2 }, 'assistant');
  const med = ownerShapedMedicine('med-1');
  // Hand the writer the OWNER-shaped row: cost, nested profitability with COGS
  // and margin, batch cost. The writer's job is to strip all of it.
  await repo.saveCatalogue([{ id: med.id, data: med, cachedAt: Date.now() }]);

  const read = await repo.readCatalogue();
  check(
    'attendant read reports fromCache with a snapshot timestamp',
    read.fromCache === true && typeof read.snapshotAt === 'number',
  );

  const persisted = read.records.find((r) => r.id === 'med-1');
  const leakKeys = persisted ? findFinancialKeys(persisted) : ['<missing>'];
  check(
    'no forbidden financial key survives anywhere in the persisted tree',
    persisted !== undefined && leakKeys.length === 0,
    leakKeys.length ? `leaked: ${leakKeys.join(', ')}` : '',
  );

  // The precision of the claim: every nested field was actually cut.
  check(
    'nested batch cost and derived profitability were cut too',
    (() => {
      const batches = persisted?.data?.batches;
      if (!Array.isArray(batches) || batches.length === 0) return false;
      const b = batches[0];
      return (
        persisted?.data?.cost_per_base_unit === undefined &&
        persisted?.data?.unitCost === undefined &&
        b.cost === undefined &&
        b.profitability?.margin === undefined &&
        b.profitability?.cogs === undefined
      );
    })(),
  );

  check(
    'non-financial fields survived stripping (quantity, prices, expiry)',
    (() => {
      const d = persisted?.data ?? {};
      return d.sale_prices?.[0]?.per_measure === '2.50' && d.batches?.[0]?.quantity === 30;
    })(),
  );

  check(
    'the attendant row is not flagged server-confirmed',
    persisted?.serverConfirmed === false,
  );

  // Read-side re-cut: simulate a foreign writer putting cost into the
  // attendant's own store (a tamper or a past defect). The read must strip.
  const rawName = databaseName({ pharmacyId: PH1, userId: U2 });
  const raw = await openDB(rawName, SCHEMA_VERSION);
  await raw.put('catalogue', {
    id: 'med-2',
    pharmacyId: PH1,
    data: ownerShapedMedicine('med-2'),
    cachedAt: Date.now(),
    serverConfirmed: false,
  });
  raw.close();

  const tampered = await repo.readCatalogue();
  const med2 = tampered.records.find((r) => r.id === 'med-2');
  check(
    'a tampered store is re-cut on read (cost never crosses to the UI)',
    med2 !== undefined && findFinancialKeys(med2).length === 0,
  );
  repo.close();
}

{
  const repo = await OfflineRepo.open({ pharmacyId: PH1, userId: U1 }, 'owner');
  const med = ownerShapedMedicine('med-owner');
  await repo.saveCatalogue([{ id: med.id, data: med, cachedAt: Date.now() }]);
  const read = await repo.readCatalogue();
  const persisted = read.records.find((r) => r.id === 'med-owner');
  check(
    'the owner cache DOES keep cost figures (stripping must not over-cut)',
    persisted?.data?.cost_per_base_unit === '0.10' &&
      persisted?.data?.batches?.[0]?.profitability?.cogs === '0.10',
  );
  repo.close();
}

{
  // Structural: the forbidden-key oracle and the stripper must agree exactly;
  // a key present in the oracle but missed by the stripper is a leak.
  check(
    'the forbidden-key set is non-trivial (guarding is real, not a stub)',
    FORBIDDEN_FINANCIAL_KEYS.size >= 20,
    `${FORBIDDEN_FINANCIAL_KEYS.size} keys`,
  );
  const tricky = { a: { b: [{ c: { COST: 1, Cost_of_Goods_Sold: 2, ProfitMargin: 3 } }] } };
  const found = findFinancialKeys(tricky);
  const stripped = findFinancialKeys(stripFinancialFields(tricky));
  check(
    'guard matching is case-insensitive and reaches every depth',
    found.length === 3 && stripped.length === 0,
    `found: ${found.join(', ')}`,
  );
}

/* --------------------------------------------------- tenant/user isolation */

section('tenant and account isolation');

{
  const p1u1 = await OfflineRepo.open({ pharmacyId: PH1, userId: U1 }, 'owner');
  await p1u1.saveCatalogue([{ id: 'med-x', data: { name: 'P1 med' }, cachedAt: Date.now() }]);
  p1u1.close();

  const p2sameUser = await OfflineRepo.open({ pharmacyId: PH2, userId: U1 }, 'owner');
  const p2Read = await p2sameUser.readCatalogue();
  check(
    'the same user under a different pharmacy sees none of the other pharmacy rows',
    p2Read.records.length === 0,
  );
  p2sameUser.close();

  const p1u3 = await OfflineRepo.open({ pharmacyId: PH1, userId: U3 }, 'assistant');
  const p1u3Read = await p1u3.readCatalogue();
  check(
    'a second account of the same pharmacy sees none of the first account rows',
    p1u3Read.records.length === 0,
  );
  p1u3.close();

  // Row-level stamps: reopening P1/U1's own database directly and putting a
  // FOREIGN-stamped row must not make it visible on read.
  const raw = await openDB(databaseName({ pharmacyId: PH1, userId: U1 }), SCHEMA_VERSION);
  await raw.put('catalogue', {
    id: 'foreign',
    pharmacyId: PH2,
    data: { name: 'foreign pharmacy row' },
    cachedAt: Date.now(),
    serverConfirmed: false,
  });
  raw.close();

  const p1u1again = await OfflineRepo.open({ pharmacyId: PH1, userId: U1 }, 'owner');
  const readAgain = await p1u1again.readCatalogue();
  check(
    'a foreign-stamped row inside the database is filtered out on read',
    readAgain.records.some((r) => r.id === 'med-x') &&
      readAgain.records.every((r) => r.id !== 'foreign'),
  );
  p1u1again.close();
}

/* --------------------------------------------------------------- durability */

section('persistence across reopen');

{
  const repo = await OfflineRepo.open({ pharmacyId: PH1, userId: U1 }, 'owner');
  const cachedAt = Date.now() - 5_000;
  await repo.saveCatalogue([{ id: 'med-keep', data: { name: 'durable' }, cachedAt }]);
  await repo.metaSet('catalogue:snapshotAt', cachedAt);
  await repo.enqueueOp({ opId: 'op-1', type: 'test-op', payload: { x: 1 } });
  repo.close();

  const reopened = await OfflineRepo.open({ pharmacyId: PH1, userId: U1 }, 'owner');
  const read = await reopened.readCatalogue();
  const rec = read.records.find((r) => r.id === 'med-keep');
  check(
    'catalogue rows survive a close/reopen with their cachedAt intact',
    rec !== undefined && rec.cachedAt === cachedAt,
  );
  check(
    'outbox rows survive a close/reopen',
    (await reopened.listOutbox()).some((o) => o.opId === 'op-1'),
  );
  check('meta survives a close/reopen', (await reopened.metaGet('catalogue:snapshotAt')) === cachedAt);
  reopened.close();
}

/* ------------------------------------------------------- upgrades */

section('schema upgrades');

{
  // Fresh install: the real schema function produces the full seven-store v2
  // shape, including the POS-only customer cache.
  const name = databaseName({ pharmacyId: PH3, userId: U3 });
  const fresh = await openDB(name, SCHEMA_VERSION, {
    upgrade(db, oldVersion) {
      applyOfflineSchemaV1(db, oldVersion);
    },
  });
  const stores = [...fresh.objectStoreNames].sort();
  fresh.close();
  check(
    'a fresh open creates all seven stores',
    JSON.stringify(stores) ===
      JSON.stringify([
        'audit',
        'catalogue',
        'conflicts',
        'customers',
        'meta',
        'outbox',
        'sales',
      ].sort()),
    stores.join(','),
  );

  // First, create a real "started below target version" scenario: an
  // incomplete v1 database that only has `catalogue` and `meta`.
  const legacy = 'pf-offline-test:legacy';
  const legacyV1 = await openDB(legacy, 1, {
    upgrade(db) {
      db.createObjectStore('catalogue', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
  await legacyV1.put('catalogue', { id: 'legacy-row', data: { name: 'from v1' } });
  legacyV1.close();

  const upgraded = await openDB(legacy, SCHEMA_VERSION, {
    upgrade(db, oldVersion) {
      // The module's own additive schema is what production uses; exercising
      // it here also covers a partial legacy shape with missing v1 stores.
      applyOfflineSchemaV1(db, oldVersion);
    },
  });
  const upgradedStores = [...upgraded.objectStoreNames].sort();
  check(
    'an upgrade from a lower version adds the missing stores and keeps the old one',
    JSON.stringify(upgradedStores) ===
      JSON.stringify([
        'audit',
        'catalogue',
        'conflicts',
        'customers',
        'meta',
        'outbox',
        'sales',
      ].sort()),
    upgradedStores.join(','),
  );
  check(
    'upgrade does not disturb pre-existing rows',
    (await upgraded.getKey('catalogue', 'legacy-row')) === 'legacy-row' &&
      (await upgraded.get('catalogue', 'legacy-row'))?.data?.name === 'from v1',
  );
  await upgraded.put('catalogue', { id: 'after-upgrade', data: { name: 'from v2' } });
  upgraded.close();

  // Reopen at the reached version: no re-upgrade, both rows intact.
  const again = await openDB(legacy, SCHEMA_VERSION);
  check(
    'reopening at the reached version is a no-op and keeps data',
    (await again.getKey('catalogue', 'legacy-row')) === 'legacy-row' &&
      (await again.getKey('catalogue', 'after-upgrade')) === 'after-upgrade',
  );
  again.close();

  // And the module-level reopen of a real repo database is likewise stable.
  const stable = await OfflineRepo.open({ pharmacyId: PH1, userId: U2 }, 'assistant');
  check(
    'module reopen with unchanged schema keeps earlier rows',
    (await stable.readCatalogue()).records.some((r) => r.id === 'med-1'),
  );
  stable.close();
}

/* --------------------------------------------------------- outbox discipline */

section('outbox duplicate-operation discipline');

{
  const repo = await OfflineRepo.open({ pharmacyId: PH1, userId: U2 }, 'assistant');
  const op = { opId: 'sale-42', type: 'pf_complete_sale', payload: { total: '12.00', lines: 2 } };

  const first = await repo.enqueueOp(op);
  check('a fresh operation id enqueues cleanly', first.ok === true);

  const copy = await repo.enqueueOp({ ...op, payload: { lines: 2, total: '12.00' } });
  check(
    're-enqueueing the same operation (order-insensitive payload) is an idempotent no-op',
    copy.ok === true && copy.duplicate === true,
  );

  const divergent = await repo.enqueueOp({ ...op, payload: { total: '12.00', lines: 3 } });
  check(
    'the same id with a different payload is refused, not overwritten',
    divergent.ok === false && /duplicate operation id/.test(divergent.error ?? ''),
  );

  const list = await repo.listOutbox();
  check('the outbox holds exactly one row for the id', list.filter((o) => o.opId === 'sale-42').length === 1);

  const conflicts = await repo.listConflicts();
  check(
    'the divergent attempt is recorded as a conflict with a reason',
    conflicts.length === 1 &&
      conflicts[0].reason === 'duplicate-op-id-payload-mismatch' &&
      conflicts[0].type === 'pf_complete_sale',
  );

  // Attendant payloads are stripped too — the outbox is a cache write.
  const guarded = await repo.enqueueOp({
    opId: 'op-cost',
    type: 'pf_test_cost',
    payload: { cost_per_base_unit: '9.99', total: '1.00' },
  });
  const opRow = (await repo.listOutbox()).find((o) => o.opId === 'op-cost');
  check(
    'outbox payloads pass through the financial guard for attendants',
    guarded.ok === true && opRow?.payload?.cost_per_base_unit === undefined,
  );

  const emptyId = await repo.enqueueOp({ opId: '', type: 'x', payload: {} });
  const emptyType = await repo.enqueueOp({ opId: 'y', type: '', payload: {} });
  check(
    'operations without an id or type are refused',
    emptyId.ok === false && emptyType.ok === false,
  );
  repo.close();
}

/* ------------------------------------------------------- failure semantics */

section('storage failure classification');

{
  const repo = await OfflineRepo.open({ pharmacyId: PH2, userId: U1 }, 'owner');
  // Functions cannot be structured-cloned (unlike cycles, which the algorithm
  // does support) — a genuine DataCloneError case.
  const uncloneable = { name: 'row', compute: () => 1 };
  let cloneFailure = null;
  try {
    await repo.saveCatalogue([{ id: 'uncloneable', data: uncloneable, cachedAt: Date.now() }]);
  } catch (error) {
    cloneFailure = error;
  }
  check(
    'an un-serialisable value fails as a structured-clone error, classified',
    cloneFailure instanceof OfflineStorageError && cloneFailure.kind === 'clone',
    String(cloneFailure?.kind ?? cloneFailure),
  );

  // The failed write must not have persisted a partial row, and the store stays
  // usable for the next write.
  const read = await repo.readCatalogue();
  check('a failed write left no partial row behind', read.records.length === 0);
  await repo.saveCatalogue([{ id: 'next-write', data: { ok: true }, cachedAt: Date.now() }]);
  check('the database is usable after a classified failure',
    (await repo.readCatalogue()).records.some((r) => r.id === 'next-write'));
  repo.close();

  class FakeIDBError extends Error {
    constructor(name) {
      super(name);
      this.name = name;
    }
  }
  check(
    'error classification: quota/version/abort/constraint/vendor names',
    classifyStorageError(new FakeIDBError('QuotaExceededError')) === 'quota' &&
      classifyStorageError(new FakeIDBError('VersionError')) === 'version' &&
      classifyStorageError(new FakeIDBError('AbortError')) === 'abort' &&
      classifyStorageError(new FakeIDBError('ConstraintError')) === 'constraint' &&
      classifyStorageError(new Error('something else')) === 'unknown',
  );
}

/* ---------------------------------------------------------------- freshness */

section('freshness buckets and truthful labelling');

{
  const now = Date.now();
  const fresh = staleInfo({ cachedAt: now - 1_000 }, now);
  const stale = staleInfo({ cachedAt: now - FRESH_MS - 1 }, now);
  const very = staleInfo({ cachedAt: now - VERY_STALE_MS - 1 }, now);

  check(
    'buckets follow the policy thresholds exactly',
    fresh.bucket === 'fresh' && stale.bucket === 'stale' && very.bucket === 'very-stale',
    `fresh=${fresh.bucket} (2min gap) stale=${stale.bucket} very=${very.bucket}`,
  );

  check(
    'stock is ALWAYS a hint, at any age (never server-confirmed)',
    fresh.stockIsHintOnly === true && very.stockIsHintOnly === true,
  );

  check(
    'very-stale prices demand labelling; fresh prices do not',
    fresh.priceRequiresLabelling === false && very.priceRequiresLabelling === true,
  );

  check(
    'recall clearance requires revalidation unless fresh (fail-closed)',
    fresh.recallStateRequiresRevalidation === false &&
      stale.recallStateRequiresRevalidation === true &&
      very.recallStateRequiresRevalidation === true,
  );

  check(
    'a future-dated cachedAt (clock skew) clamps to age 0 rather than going negative',
    staleInfo({ cachedAt: now + 60_000 }, now).ageMs === 0,
  );
}

/* ---------------------------------------------------------------- purge */

section('purge: identity and browse-wide');

{
  // Enrollment happens on open; make a registry-backed identity to lose.
  const repo = await OfflineRepo.open({ pharmacyId: PH2, userId: U2 }, 'assistant');
  await repo.saveCatalogue([{ id: 'p2u2-data', data: { name: 'gone soon' }, cachedAt: Date.now() }]);
  repo.close();

  // A foreign database that purge must NEVER touch.
  await openDB('unrelated-app-database', 1, {
    upgrade(db) { db.createObjectStore('kv', { keyPath: 'k' }); },
  }).then(async (foreign) => {
    await foreign.put('kv', { k: 'keep', v: 1 });
    foreign.close();
  });

  await purgeIdentity({ pharmacyId: PH2, userId: U2 });

  const afterPurge = await OfflineRepo.open({ pharmacyId: PH2, userId: U2 }, 'assistant');
  check(
    'identity purge removes the data: reopening yields an empty cache',
    (await afterPurge.readCatalogue()).records.length === 0,
  );
  afterPurge.close();

  const foreignAgain = await openDB('unrelated-app-database', 1);
  check(
    'browse-wide purge does not run yet: the foreign database is intact before it',
    (await foreignAgain.getKey('kv', 'keep')) === 'keep',
  );
  foreignAgain.close();

  const deleted = await purgeAllOffline();
  check(
    'purgeAllOffline deletes only pf-offline names and reports what it deleted',
    deleted.length > 0 &&
      deleted.every((n) => String(n).startsWith('pf-offline:')) &&
      deleted.includes(databaseName({ pharmacyId: PH2, userId: U2 })),
    deleted.join(','),
  );

  const foreignFinal = await openDB('unrelated-app-database', 1);
  check(
    'the foreign application database SURVIVED the purge',
    (await foreignFinal.getKey('kv', 'keep')) === 'keep',
  );
  foreignFinal.close();

  const empty = await OfflineRepo.open({ pharmacyId: PH1, userId: U2 }, 'assistant');
  check(
    'after browse-wide purge, opening an identity again yields a clean empty cache',
    (await empty.readCatalogue()).records.length === 0 &&
      (await empty.listOutbox()).length === 0 &&
      (await empty.listConflicts()).length === 0 &&
      (await empty.listSales()).records.length === 0 &&
      (await empty.listAudit()).length === 0,
  );
  empty.close();
}

/* ------------------------------------------------------------------ mirrors */

section('sales and audit mirrors');

{
  const repo = await OfflineRepo.open({ pharmacyId: PH1, userId: U1 }, 'owner');
  const soldAt = new Date(now_sec()).toISOString();
  await repo.saveSales(
    [{ id: 'sale-1', data: { total: '5.00', cost_per_base_unit: '0.50' }, cachedAt: Date.now(), soldAt }],
    true,
  );
  // Attendant write of the same sale id: cost fields must not survive.
  const repo2 = await OfflineRepo.open({ pharmacyId: PH1, userId: U2 }, 'assistant');
  await repo2.saveSales(
    [{ id: 'sale-att', data: { total: '5.00', cost_per_base_unit: '0.50' }, cachedAt: Date.now(), soldAt }],
    false,
  );

  const ownerSale = (await repo.listSales()).records.find((r) => r.id === 'sale-1');
  const attSale = (await repo2.listSales()).records.find((r) => r.id === 'sale-att');
  check(
    'owner mirror keeps cost; attendant mirror strips it',
    ownerSale?.data?.cost_per_base_unit === '0.50' && findFinancialKeys([attSale]).length === 0,
  );
  check(
    'the owner-written mirror is server-confirmed; the attendant write is not',
    ownerSale?.serverConfirmed === true && attSale?.serverConfirmed === false,
  );
  repo.close();
  repo2.close();

  // Audit events persist with occurredAt preserved.
  const repo3 = await OfflineRepo.open({ pharmacyId: PH1, userId: U2 }, 'assistant');
  const occurredAt = new Date(now_sec()).toISOString();
  await repo3.saveAudit(
    [{ id: 'audit-1', data: { action: 'login' }, cachedAt: Date.now(), occurredAt }],
    true,
  );
  const audit = await repo3.listAudit();
  check(
    'audit mirror preserves id, action and occurredAt',
    audit.some((a) => a.id === 'audit-1' && a.occurredAt === occurredAt && a.data.action === 'login'),
  );
  repo3.close();
}

function now_sec() {
  return Math.floor(Date.now() / 1000) * 1000;
}

process.exit(await finish());
