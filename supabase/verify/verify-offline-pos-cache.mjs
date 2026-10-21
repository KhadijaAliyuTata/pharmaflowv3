/**
 * Stage 1 — the POS-only offline read cache and sign-out policy.
 *
 * These checks cover the P0/P1 gaps the audit found:
 *
 *   - a cached catalogue and customer list can be written and read back;
 *   - the catalogue is replaced as a snapshot, never merged with older rows;
 *   - an empty snapshot is distinguishable from "never cached";
 *   - a snapshot older than 24 hours is not usable for a sale;
 *   - the cache writer strips cost/COGS/margin even for an owner;
 *   - the customer cache holds only id/name/phone, never debt or spend;
 *   - a device-sales read failure is reported, never presented as an empty
 *     queue;
 *   - sign-out retains pending/conflict/stray work and only purges a clean
 *     identity;
 *   - a cached branch role is always assistant;
 *   - an offline sale is cash-only: full cash is allowed, while debt, part
 *     payment, wallet, transfer, card and split are refused.
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

import {
  OfflineRepo,
  inspectIdentityWork,
  purgeIdentity,
} from '../../src/offline/local-db.ts';
import { effectiveRole } from '../../src/offline/effective-role.ts';
import { offlineSettlementError } from '../../src/offline/payment-policy.ts';
import {
  UNRESOLVED_ATTEMPT_META_KEY,
  attemptSettlementLabel,
  clearUnresolvedAttempt,
  isUnverifiedCompletedReplay,
  parseUnresolvedAttempt,
  persistUnresolvedAttempt,
  reconciliationRepoMatches,
  retainUnresolvedAttempt,
  shouldClearUnresolvedNote,
  unresolvedAttemptBlock,
  unresolvedNonCashAttempt,
} from '../../src/offline/settlement-reconciliation.ts';
import {
  cachePosCatalogue,
  cachePosCustomers,
  formatCacheAge,
  isCachedSliceUsable,
  readPosCache,
} from '../../src/offline/pos-cache.ts';
import { loadDeviceSales } from '../../src/offline/device-sales.ts';
import { decideOfflineSignOut } from '../../src/offline/signout-policy.ts';
import { recordSaleIntent } from '../../src/offline/pos-offline.ts';
import { findFinancialKeys } from '../../src/offline/financial-guard.ts';
import { createReporter } from './harness.mjs';
import { SCHEMA_VERSION, databaseName } from '../../src/offline/db-schema.ts';
import { openDB } from 'idb';

const { check, section, finish } = createReporter('verify-offline-pos-cache');

const PH = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-0000-0000-0000-000000000002';
const OTHER_USER = 'aaaaaaaa-0000-0000-0000-000000000003';
const TAMPER_USER = 'aaaaaaaa-0000-0000-0000-000000000004';
const RECON_USER = 'aaaaaaaa-0000-0000-0000-000000000005';
const NOTE_USER = 'aaaaaaaa-0000-0000-0000-000000000006';
const RACE_USER = 'aaaaaaaa-0000-0000-0000-000000000007';
const NOW = 1_800_000_000_000;

function medicine(id, extra = {}) {
  return {
    id,
    barcode: `barcode-${id}`,
    name: `Medicine ${id}`,
    genericName: 'Paracetamol',
    strength: '500 mg',
    dosageForm: 'tablet',
    category: 'Analgesic',
    units: [{ key: 'box', name: 'Box', multiplier: 10, sellingPrice: 100 }],
    totalQuantity: 40,
    lowStockThreshold: 5,
    expiryDate: '2027-01-01',
    supplier: 'Acme',
    purchaseDate: '2026-01-01',
    pricePerBaseUnit: 10,
    batches: [
      {
        id: `${id}-batch`,
        batchNumber: 'B-1',
        expiryDate: '2027-01-01',
        quantity: 40,
        supplier: 'Acme',
        receivedDate: '2026-01-01',
        isRecalled: false,
        costPerBaseUnit: 4,
      },
    ],
    commonUse: 'Pain',
    storage: 'Dry place',
    prescriptionStatus: 'otc',
    warnings: [],
    isBrand: true,
    doNotSell: { active: false },
    averageDailySales: 2,
    // Deliberately present so the cache writer has something to remove.
    costPerBaseUnit: 4,
    ...extra,
  };
}

const customer = {
  id: 'cust-1',
  code: 'C-1',
  name: 'Ada Obi',
  phone: '08030000000',
  outstandingDebt: 500,
  totalSpent: 9000,
  walletBalance: 1200,
  notes: 'owner-only note',
};

section('hook failure semantics');

{
  const customerHook = await Bun.file(
    new URL('../../src/hooks/use-customers.ts', import.meta.url),
  ).text();
  check(
    'a failed customer read settles as loading:false with the error',
    /loading: false,\s*error,/.test(customerHook),
  );
  check(
    'a cached-branch to server-branch transition refreshes customers',
    /\[useRemote, currentBranchId, reloadToken, branchSource\]/.test(customerHook),
  );
}

section('effective role');

check('a server-confirmed branch keeps its branch role', effectiveRole('server', 'owner', 'assistant') === 'owner');
check(
  'a cached branch is assistant even when the session says owner',
  effectiveRole('cache', 'owner', 'owner') === 'assistant',
);
check(
  'the caller fallback is used when no role is known',
  effectiveRole('server', null, null, 'owner') === 'owner',
);

section('offline settlement is cash only');

{
  check('full cash is allowed offline', offlineSettlementError('full', 'cash') === null);
  check('debt settlement is refused offline', offlineSettlementError('debt', 'cash') !== null);
  check('part payment is refused offline', offlineSettlementError('part', 'cash') !== null);
  check('wallet is refused offline', offlineSettlementError('full', 'wallet') !== null);
  check('transfer is refused offline', offlineSettlementError('full', 'transfer') !== null);
  check('pos card is refused offline', offlineSettlementError('full', 'pos_card') !== null);
  check('split is refused offline', offlineSettlementError('split', 'split') !== null);

  const refusal = offlineSettlementError('debt', 'cash');
  check(
    'the refusal explains the full-cash rule',
    typeof refusal === 'string' &&
      /cash/i.test(refusal) &&
      /full/i.test(refusal),
  );

  const posSource = await Bun.file(
    new URL('../../src/routes/_app/pos.tsx', import.meta.url),
  ).text();
  check(
    'the POS disables the blocked payment modes while offline',
    /disabled=\{offlineCashOnly && mode\.value !== 'full'\}/.test(posSource),
  );
  check(
    'the POS disables the wallet/method selector while offline',
    /disabled=\{offlineCashOnly\}/.test(posSource),
  );
  check(
    'the POS enforces the rule before the probe and again on the offline path',
    (posSource.match(/offlineSettlementError\(/g) ?? []).length >= 3,
  );
  check(
    'the POS refuses a blocked settlement when the online attempt loses its connection',
    /failure\.kind === 'network'[\s\S]{0,800}offlineSettlementError\(/.test(posSource),
  );
}

section('ambiguous non-cash settlement reconciliation');

{
  const attempt = unresolvedNonCashAttempt({
    failureKind: 'network',
    payMode: 'debt',
    paymentMethod: 'cash',
    idempotencyKey: 'pos-ambiguous-1',
    amountPaid: 0,
    total: 750,
    at: '2026-10-21T10:00:00.000Z',
  });

  check(
    'a non-cash attempt that loses its answer is preserved as unresolved evidence',
    attempt !== null &&
      attempt.idempotencyKey === 'pos-ambiguous-1' &&
      attempt.payMode === 'debt' &&
      attempt.paymentMethod === 'cash' &&
      attempt.amountPaid === 0 &&
      attempt.total === 750 &&
      attempt.attemptedAt === '2026-10-21T10:00:00.000Z',
  );
  check(
    'a debt attempt is labelled Debt, not the cash method behind it',
    attempt !== null && attemptSettlementLabel(attempt) === 'debt',
  );
  {
    const walletAttempt = unresolvedNonCashAttempt({
      failureKind: 'network',
      payMode: 'full',
      paymentMethod: 'wallet',
      idempotencyKey: 'pos-wallet-1',
      amountPaid: 750,
      total: 750,
      at: '2026-10-21T10:00:00.000Z',
    });
    check(
      'a full wallet attempt is labelled Wallet',
      walletAttempt !== null && attemptSettlementLabel(walletAttempt) === 'wallet',
    );
  }

  const partAttempt = unresolvedNonCashAttempt({
    failureKind: 'network',
    payMode: 'part',
    paymentMethod: 'cash',
    idempotencyKey: 'pos-ambiguous-part',
    amountPaid: 200,
    total: 750,
    at: '2026-10-21T10:00:00.000Z',
  });
  check(
    'a part payment with a lost answer is unresolved too',
    partAttempt !== null && partAttempt.amountPaid === 200,
  );

  check(
    'a full cash attempt with a lost answer is not ambiguous and may be queued',
    unresolvedNonCashAttempt({
      failureKind: 'network',
      payMode: 'full',
      paymentMethod: 'cash',
      idempotencyKey: 'pos-cash-1',
      amountPaid: 750,
      total: 750,
    }) === null,
  );

  check(
    'a server refusal is a known outcome, not an unresolved attempt',
    unresolvedNonCashAttempt({
      failureKind: 'validation',
      payMode: 'debt',
      paymentMethod: 'cash',
      idempotencyKey: 'pos-refused-1',
      amountPaid: 0,
      total: 750,
    }) === null,
  );

  const block = unresolvedAttemptBlock(attempt);
  check(
    'every retry is blocked while the attempt is unresolved, including a same-key cash retry',
    block !== null &&
      block.includes('pos-ambiguous-1') &&
      /will not send another sale/i.test(block),
  );
  check('no unresolved attempt means no reconciliation block', unresolvedAttemptBlock(null) === null);

  check(
    'an already-completed replay of the unresolved non-cash key cannot become a cash receipt',
    isUnverifiedCompletedReplay({
      alreadyCompleted: true,
      attempt,
      idempotencyKey: 'pos-ambiguous-1',
    }) === true,
  );
  check(
    'an already-completed response for a different key is not this attempt',
    isUnverifiedCompletedReplay({
      alreadyCompleted: true,
      attempt,
      idempotencyKey: 'pos-other',
    }) === false,
  );
  check(
    'a normal first-time cash sale is a clean success',
    isUnverifiedCompletedReplay({
      alreadyCompleted: false,
      attempt: null,
      idempotencyKey: 'pos-cash-ok',
    }) === false,
  );
  check(
    'an ordinary cash replay (same known intent, no unresolved attempt) still completes',
    isUnverifiedCompletedReplay({
      alreadyCompleted: true,
      attempt: null,
      idempotencyKey: 'pos-cash-replay',
    }) === false,
  );

  {
    // Simulates the identity effect re-reading a different (or empty) note.
    // The cart and key are unchanged, so the original attempt must survive.
    const identityA = 'pharmacy-a:user-a';
    const identityB = 'pharmacy-b:user-b';
    const preserved = retainUnresolvedAttempt(attempt, null);
    check(
      'an identity-key change cannot clear or replace the unresolved attempt',
      preserved === attempt &&
        retainUnresolvedAttempt(attempt, partAttempt) === attempt &&
        retainUnresolvedAttempt(null, attempt) === attempt,
    );
    check(
      'the same cart and key cannot be retried as cash after an identity change',
      preserved !== null &&
        unresolvedAttemptBlock(preserved) !== null &&
        isUnverifiedCompletedReplay({
          alreadyCompleted: true,
          attempt: preserved,
          idempotencyKey: 'pos-ambiguous-1',
        }) === true,
    );
    check(
      'explicit resolution clears a durable note only in its own identity database',
      shouldClearUnresolvedNote(identityA, identityA) === true &&
        shouldClearUnresolvedNote(identityA, identityB) === false &&
        shouldClearUnresolvedNote(null, identityB) === false,
    );
  }

  const posSource = await Bun.file(
    new URL('../../src/routes/_app/pos.tsx', import.meta.url),
  ).text();
  check(
    'the POS blocks submission while an attempt is unresolved',
    /const unresolvedError = unresolvedAttemptBlock\(unresolvedAttempt\)/.test(posSource),
  );
  check(
    'the POS preserves the attempt when a non-cash online send loses its answer',
    /unresolvedNonCashAttempt\(\{[\s\S]{0,300}failureKind: failure\.kind/.test(posSource),
  );
  check(
    'the POS refuses a completed replay of the unresolved key',
    /isUnverifiedCompletedReplay\(\{/.test(posSource),
  );
  check(
    'the POS disables Complete sale until the attempt is resolved',
    /unresolvedAttempt !== null/.test(posSource),
  );
  check(
    'the POS saves the reconciliation note on the device',
    /evidenceSaved = await persistUnresolvedAttempt\(/.test(posSource),
  );
  check(
    'the POS restores the block from the saved note after a reload',
    /parseUnresolvedAttempt\(value\)/.test(posSource),
  );
  check(
    'the POS pins the repository and storage identity before the checkout awaits',
    /const submissionRepo = repoRef\.current;[\s\S]{0,160}const submissionStorageIdentity = offlineStorageIdentityKey;/.test(
      posSource,
    ),
  );
  check(
    'the POS saves reconciliation evidence only through the pinned repository',
    /persistUnresolvedAttempt\(\s*submissionRepo,/.test(posSource),
  );
  check(
    'the POS clears evidence only through the captured owning repository',
    /clearUnresolvedAttempt\(\s*unresolvedAttemptRepoRef\.current,/.test(posSource),
  );

  check(
    'a malformed saved note is ignored, not trusted as reconciliation state',
    parseUnresolvedAttempt({ idempotencyKey: 'x', paymentMethod: 'cash' }) === null &&
      parseUnresolvedAttempt({ ...attempt, amountPaid: -1 }) === null &&
      parseUnresolvedAttempt({ ...attempt, payMode: 'gift' }) === null &&
      parseUnresolvedAttempt('not-an-object') === null,
  );

  {
    const identity = { pharmacyId: PH, userId: RECON_USER };
    const repo = await OfflineRepo.open(identity, 'assistant');
    await repo.metaSet(UNRESOLVED_ATTEMPT_META_KEY, attempt);
    repo.close();

    const reopened = await OfflineRepo.open(identity, 'assistant');
    const restored = parseUnresolvedAttempt(
      await reopened.metaGet(UNRESOLVED_ATTEMPT_META_KEY),
    );
    check(
      'the unresolved attempt and its evidence survive a reload',
      restored !== null &&
        restored.idempotencyKey === 'pos-ambiguous-1' &&
        restored.amountPaid === 0 &&
        restored.total === 750,
    );

    await reopened.metaSet(UNRESOLVED_ATTEMPT_META_KEY, null);
    check(
      'resolving the attempt clears the durable note',
      parseUnresolvedAttempt(await reopened.metaGet(UNRESOLVED_ATTEMPT_META_KEY)) === null,
    );
    reopened.close();
  }
}

section('cross-identity reconciliation evidence');

{
  const identityA = { pharmacyId: PH, userId: NOTE_USER };
  const identityB = { pharmacyId: PH, userId: RACE_USER };
  const keyA = `${PH}:${NOTE_USER}`;
  const keyB = `${PH}:${RACE_USER}`;
  const attemptA = unresolvedNonCashAttempt({
    failureKind: 'network',
    payMode: 'full',
    paymentMethod: 'transfer',
    idempotencyKey: 'pos-race-a',
    amountPaid: 500,
    total: 500,
    at: '2026-10-21T12:00:00.000Z',
  });
  const attemptB = unresolvedNonCashAttempt({
    failureKind: 'network',
    payMode: 'debt',
    paymentMethod: 'cash',
    idempotencyKey: 'pos-race-b',
    amountPaid: 0,
    total: 500,
    at: '2026-10-21T12:01:00.000Z',
  });

  const repoA = await OfflineRepo.open(identityA, 'assistant');
  const repoB = await OfflineRepo.open(identityB, 'assistant');

  check(
    'repository identity, not the requested key, gates reconciliation access',
    attemptA !== null &&
      reconciliationRepoMatches(repoA, keyA) === true &&
      reconciliationRepoMatches(repoB, keyA) === false &&
      reconciliationRepoMatches(null, keyA) === false,
  );

  check(
    'a normal same-identity save writes the note',
    attemptB !== null &&
      (await persistUnresolvedAttempt(repoB, keyB, attemptB)) === true &&
      parseUnresolvedAttempt(await repoB.metaGet(UNRESOLVED_ATTEMPT_META_KEY))
        ?.idempotencyKey === 'pos-race-b',
  );

  check(
    'a submission started under A cannot write its note into B',
    attemptA !== null &&
      (await persistUnresolvedAttempt(repoB, keyA, attemptA)) === false &&
      parseUnresolvedAttempt(await repoB.metaGet(UNRESOLVED_ATTEMPT_META_KEY))
        ?.idempotencyKey === 'pos-race-b',
  );

  check(
    'resolution for A cannot clear B’s note',
    attemptA !== null &&
      (await clearUnresolvedAttempt(repoB, keyA, attemptA.idempotencyKey)) === false &&
      parseUnresolvedAttempt(await repoB.metaGet(UNRESOLVED_ATTEMPT_META_KEY))
        ?.idempotencyKey === 'pos-race-b',
  );

  check(
    'a missing repository fails closed for save and clear',
    attemptA !== null &&
      (await persistUnresolvedAttempt(null, keyA, attemptA)) === false &&
      (await clearUnresolvedAttempt(null, keyA, attemptA.idempotencyKey)) === false,
  );

  check(
    'normal same-identity explicit resolution clears only its own note',
    attemptA !== null &&
      (await persistUnresolvedAttempt(repoA, keyA, attemptA)) === true &&
      (await clearUnresolvedAttempt(repoA, keyA, 'pos-different-key')) === false &&
      parseUnresolvedAttempt(await repoA.metaGet(UNRESOLVED_ATTEMPT_META_KEY))
        ?.idempotencyKey === 'pos-race-a' &&
      (await clearUnresolvedAttempt(repoA, keyA, attemptA.idempotencyKey)) === true &&
      parseUnresolvedAttempt(await repoA.metaGet(UNRESOLVED_ATTEMPT_META_KEY)) === null,
  );

  const posSource = await Bun.file(
    new URL('../../src/routes/_app/pos.tsx', import.meta.url),
  ).text();
  check(
    'the POS leaves the in-memory block in place when a clear fails closed',
    /if \(!cleared\) \{[\s\S]{0,250}return;/.test(posSource),
  );

  repoA.close();
  repoB.close();
  await purgeIdentity(identityA);
  await purgeIdentity(identityB);
}

section('sign-out unresolved settlement evidence');

{
  const identity = { pharmacyId: PH, userId: NOTE_USER };
  const note = unresolvedNonCashAttempt({
    failureKind: 'network',
    payMode: 'full',
    paymentMethod: 'transfer',
    idempotencyKey: 'pos-note-1',
    amountPaid: 500,
    total: 500,
    at: '2026-10-21T11:00:00.000Z',
  });

  const repo = await OfflineRepo.open(identity, 'assistant');
  await repo.metaSet(UNRESOLVED_ATTEMPT_META_KEY, note);
  repo.close();

  const validWork = await inspectIdentityWork(identity);
  check(
    'a valid unresolved note is counted as sign-out evidence',
    note !== null &&
      validWork.outbox === 0 &&
      validWork.conflicts === 0 &&
      validWork.strays === 0 &&
      validWork.unresolved === 1,
  );

  const validDecision = decideOfflineSignOut(validWork);
  check(
    'a valid unresolved note prevents purge with its own warning',
    validDecision.action === 'retain' &&
      validDecision.pending === 1 &&
      /unresolved settlement evidence/i.test(validDecision.warning ?? '') &&
      !/unsynchronised sale/i.test(validDecision.warning ?? ''),
  );

  const tampered = await OfflineRepo.open(identity, 'assistant');
  await tampered.metaSet(UNRESOLVED_ATTEMPT_META_KEY, {
    idempotencyKey: 'x',
    paymentMethod: 'cash',
  });
  tampered.close();

  const malformedWork = await inspectIdentityWork(identity);
  check(
    'a malformed note does not count and does not block a clean purge',
    malformedWork.unresolved === 0 &&
      decideOfflineSignOut(malformedWork).action === 'purge',
  );

  await purgeIdentity(identity);
}

section('POS cache reads, replacement and freshness');

{
  const identity = { pharmacyId: PH, userId: USER };
  const repo = await OfflineRepo.open(identity, 'owner');

  const empty = await readPosCache(repo, NOW);
  check(
    'a never-written cache is explicitly absent, not an empty current snapshot',
    empty.catalogue.present === false &&
      empty.customers.present === false &&
      isCachedSliceUsable(empty.catalogue, NOW) === false,
  );

  await cachePosCatalogue(repo, [medicine('med-1')], NOW);
  await cachePosCustomers(repo, [customer], NOW);
  const snapshot = await readPosCache(repo, NOW + 1_000);

  check(
    'the cached catalogue is readable with a snapshot timestamp',
    snapshot.catalogue.present === true &&
      snapshot.catalogue.records.length === 1 &&
      snapshot.catalogue.records[0].id === 'med-1' &&
      snapshot.catalogue.cachedAt === NOW,
  );
  check(
    'a fresh cache is usable for offline composition',
    snapshot.catalogue.bucket === 'fresh' &&
      isCachedSliceUsable(snapshot.catalogue, NOW + 1_000),
  );
  check(
    'usability is re-evaluated at the current time, not frozen at read time',
    isCachedSliceUsable(snapshot.catalogue, NOW + 1_000) === true &&
      isCachedSliceUsable(snapshot.catalogue, NOW + 25 * 60 * 60 * 1000) === false,
  );
  check(
    'the cache writer strips cost and margin even for an owner repo',
    findFinancialKeys(snapshot.catalogue.records[0]).length === 0 &&
      snapshot.catalogue.records[0].batches[0].costPerBaseUnit === undefined,
  );
  check(
    'the customer cache contains only id, name and phone',
    JSON.stringify(Object.keys(snapshot.customers.records[0]).sort()) ===
      JSON.stringify(['id', 'name', 'phone']),
    JSON.stringify(snapshot.customers.records[0]),
  );

  // Replacement, not merge: the old product must be gone.
  await cachePosCatalogue(repo, [medicine('med-2')], NOW + 2_000);
  const replaced = await readPosCache(repo, NOW + 2_000);
  check(
    'a new server snapshot replaces the old catalogue rather than merging it',
    replaced.catalogue.records.length === 1 && replaced.catalogue.records[0].id === 'med-2',
  );

  // An empty server answer is a real snapshot.
  await repo.replaceCatalogue([], NOW + 3_000);
  const emptySnapshot = await readPosCache(repo, NOW + 3_000);
  check(
    'an empty server answer still records a present snapshot',
    emptySnapshot.catalogue.present === true && emptySnapshot.catalogue.records.length === 0,
  );

  // Older than the 24-hour rule.
  const old = NOW - 25 * 60 * 60 * 1000;
  await cachePosCatalogue(repo, [medicine('med-old')], old);
  const stale = await readPosCache(repo, NOW);
  check(
    'a catalogue older than 24 hours is very stale and not usable',
    stale.catalogue.bucket === 'very-stale' && isCachedSliceUsable(stale.catalogue, NOW) === false,
  );

  check(
    'cache age is described in operator language',
    formatCacheAge(30_000) === 'just now' &&
      formatCacheAge(90 * 60 * 1000) === '1 h ago' &&
      formatCacheAge(25 * 60 * 60 * 1000) === '1 d ago',
  );

  repo.close();
}

section('the read boundary strips tampered cache rows');

{
  const identity = { pharmacyId: PH, userId: TAMPER_USER };
  const repo = await OfflineRepo.open(identity, 'owner');
  await cachePosCatalogue(repo, [medicine('clean')], NOW);
  await cachePosCustomers(repo, [customer], NOW);

  const raw = await openDB(databaseName(identity), SCHEMA_VERSION);
  await raw.put('catalogue', {
    id: 'tamper',
    pharmacyId: PH,
    data: {
      ...medicine('tamper'),
      costPerBaseUnit: 999,
      batches: [{ ...medicine('tamper').batches[0], costPerBaseUnit: 999 }],
    },
    cachedAt: NOW,
    serverConfirmed: false,
  });
  await raw.put('customers', {
    id: 'tamper-c',
    pharmacyId: PH,
    data: {
      id: 'tamper-c',
      name: 'Tampered Customer',
      phone: '08039999999',
      outstandingDebt: 999,
      walletBalance: 999,
    },
    cachedAt: NOW,
    serverConfirmed: false,
  });
  raw.close();

  const snapshot = await readPosCache(repo, NOW);
  const tamperedMedicine = snapshot.catalogue.records.find((row) => row.id === 'tamper');
  const tamperedCustomer = snapshot.customers.records.find((row) => row.id === 'tamper-c');
  check(
    'a tampered cached medicine is re-stripped on read, even for an owner repo',
    tamperedMedicine !== undefined &&
      findFinancialKeys(tamperedMedicine).length === 0 &&
      tamperedMedicine.batches[0].costPerBaseUnit === undefined,
  );
  check(
    'a tampered cached customer is re-projected on read',
    tamperedCustomer !== undefined &&
      JSON.stringify(Object.keys(tamperedCustomer).sort()) ===
        JSON.stringify(['id', 'name', 'phone']),
    JSON.stringify(tamperedCustomer),
  );
  repo.close();
}

section('device sales read failures are not empty queues');

{
  const identity = { pharmacyId: PH, userId: OTHER_USER };
  const repo = await OfflineRepo.open(identity, 'assistant');
  const key = 'pos-cache-device-sale';

  const recorded = await recordSaleIntent(
    repo,
    {
      lines: [{ medicineId: 'med-1', unitKey: 'box', quantity: 1 }],
      paymentMethod: 'cash',
      amountPaid: 100,
      expected: {
        subtotal: 100,
        discount: 0,
        total: 100,
        amountPaid: 100,
        lines: [
          {
            medicineId: 'med-1',
            unitKey: 'box',
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
          },
        ],
      },
    },
    key,
  );
  check('a pending sale can be recorded for the device panel', recorded.ok === true);

  await repo.recordConflict({
    opId: 'conflict-1',
    type: 'pf_complete_sale',
    payload: {},
    reason: 'test conflict',
  });

  const loaded = await loadDeviceSales(repo);
  check(
    'the device panel reads pending and conflict rows separately',
    loaded.ok === true &&
      loaded.data.pending.length === 1 &&
      loaded.data.conflicts.length === 1,
  );

  const work = await inspectIdentityWork(identity);
  check(
    'sign-out inspection counts outbox and conflicts',
    work.outbox === 1 && work.conflicts === 1 && work.strays === 0,
  );

  repo.close();
  const failed = await loadDeviceSales(repo);
  check(
    'a closed/unreadable device store reports failure instead of an empty queue',
    failed.ok === false && failed.error.length > 0,
  );

  // Direct purge closes the open handle first. The sign-out policy is what
  // prevents this path from running with unsynchronised work.
  const lingering = await OfflineRepo.open(identity, 'assistant');
  await cachePosCatalogue(lingering, [medicine('med-purge')], NOW);
  await purgeIdentity(identity);
  const reopened = await OfflineRepo.open(identity, 'assistant');
  const afterPurge = await readPosCache(reopened, NOW);
  check(
    'purging an identity closes matching handles and removes its cache',
    afterPurge.catalogue.present === false,
  );
  reopened.close();
}

section('sign-out policy');

{
  const clean = { outbox: 0, conflicts: 0, strays: 0, unresolved: 0 };
  const pending = { outbox: 1, conflicts: 0, strays: 0, unresolved: 0 };
  const conflict = { outbox: 0, conflicts: 2, strays: 0, unresolved: 0 };
  const stray = { outbox: 0, conflicts: 0, strays: 1, unresolved: 0 };
  const unresolved = { outbox: 0, conflicts: 0, strays: 0, unresolved: 1 };

  check('a clean identity may be purged', decideOfflineSignOut(clean).action === 'purge');
  check(
    'a pending sale is retained with a warning',
    decideOfflineSignOut(pending).action === 'retain' &&
      decideOfflineSignOut(pending).pending === 1 &&
      /kept, not deleted/.test(decideOfflineSignOut(pending).warning),
  );
  check(
    'conflicts are retained too',
    decideOfflineSignOut(conflict).action === 'retain' &&
      decideOfflineSignOut(conflict).pending === 2,
  );
  check(
    'foreign-stamped strays count as unsynchronised evidence',
    decideOfflineSignOut(stray).action === 'retain' &&
      decideOfflineSignOut(stray).pending === 1,
  );
  check(
    'unresolved settlement evidence is retained with distinct wording',
    decideOfflineSignOut(unresolved).action === 'retain' &&
      decideOfflineSignOut(unresolved).pending === 1 &&
      /unresolved settlement evidence/i.test(decideOfflineSignOut(unresolved).warning ?? '') &&
      !/unsynchronised sale/i.test(decideOfflineSignOut(unresolved).warning ?? ''),
  );
  check(
    'an uninspectable identity is retained, never purged',
    decideOfflineSignOut(null).action === 'retain-unidentified',
  );
}

section('sign-out re-inspection guard');

{
  const identity = { pharmacyId: PH, userId: RACE_USER };
  const repo = await OfflineRepo.open(identity, 'assistant');
  await purgeIdentity(identity);
  repo.close();

  const freshRepo = await OfflineRepo.open(identity, 'assistant');

  // Initial inspection should be clean
  const initialWork = await inspectIdentityWork(identity);
  check(
    'fresh identity is initially clean',
    initialWork.outbox === 0 &&
      initialWork.conflicts === 0 &&
      initialWork.strays === 0 &&
      initialWork.unresolved === 0,
  );
  const initialDecision = decideOfflineSignOut(initialWork);
  check('initial decision is purge', initialDecision.action === 'purge');

  // Simulate evidence appearing between inspections (another tab / in-flight)
  await recordSaleIntent(
    freshRepo,
    {
      lines: [{ medicineId: 'med-1', unitKey: 'box', quantity: 1 }],
      paymentMethod: 'cash',
      amountPaid: 100,
      expected: {
        subtotal: 100,
        discount: 0,
        total: 100,
        amountPaid: 100,
        lines: [
          { medicineId: 'med-1', unitKey: 'box', quantity: 1, unitPrice: 100, lineTotal: 100 },
        ],
      },
    },
    'pos-recheck-1',
  );

  // Re-inspection should catch the new evidence
  const recheckWork = await inspectIdentityWork(identity);
  check(
    're-inspection detects outbox row added between inspections',
    recheckWork.outbox === 1 &&
      recheckWork.conflicts === 0 &&
      recheckWork.strays === 0 &&
      recheckWork.unresolved === 0,
  );
  const recheckDecision = decideOfflineSignOut(recheckWork);
  check(
    'recheck decision is retain with pending count',
    recheckDecision.action === 'retain' && recheckDecision.pending === 1,
  );

  // Also test unresolved note appearing between inspections
  const note = unresolvedNonCashAttempt({
    failureKind: 'network',
    payMode: 'full',
    paymentMethod: 'transfer',
    idempotencyKey: 'pos-recheck-note',
    amountPaid: 500,
    total: 500,
    at: '2026-10-21T13:00:00.000Z',
  });
  await freshRepo.metaSet(UNRESOLVED_ATTEMPT_META_KEY, note);

  const recheckWork2 = await inspectIdentityWork(identity);
  check(
    're-inspection detects unresolved note added between inspections',
    recheckWork2.unresolved === 1,
  );
  const recheckDecision2 = decideOfflineSignOut(recheckWork2);
  check(
    'recheck decision for unresolved note is retain',
    recheckDecision2.action === 'retain' && recheckDecision2.pending >= 1,
  );

  freshRepo.close();
  await purgeIdentity(identity);
}

await finish();

await finish();
