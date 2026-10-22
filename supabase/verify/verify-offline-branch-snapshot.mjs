/**
 * Offline branch recovery — the saved server-confirmed branch.
 *
 * These checks are deliberately about the FAIL-CLOSED boundary, not just the
 * happy path: a saved branch may only be re-used by the same authenticated user,
 * only while fresh, and only when the stored shape is coherent. A storage fault
 * must be reported, never treated as "no branch" or as a valid one.
 */

import {
  BRANCH_SNAPSHOT_KEY,
  clearBranchSnapshot,
  isOfflineBranchFailure,
  readBranchSnapshot,
  savedBranchForOffline,
  validateBranchSnapshot,
  writeBranchSnapshot,
} from '../../src/offline/branch-snapshot.ts';
import { createReporter } from './harness.mjs';

const { check, section, finish } = createReporter('verify-offline-branch-snapshot');

const USER = 'aaaaaaaa-0000-0000-0000-000000000002';
const OTHER_USER = 'aaaaaaaa-0000-0000-0000-000000000003';
const BRANCH = '11111111-1111-1111-1111-111111111111';
const NOW = 1_800_000_000_000;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    dump: () => Object.fromEntries(map),
  };
}

const branch = {
  id: BRANCH,
  name: 'Main Counter',
  address: '1 Test Road',
  city: 'Lagos',
  state: 'Lagos',
  phone: '08000000000',
  opening_hours: '08:00-20:00',
  is_open_now: true,
  is_main_hub: true,
  rating: 4.5,
  reviews_count: 12,
  pcn_number: null,
  premises_number: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  isDefault: true,
};

const snapshot = (overrides = {}) => ({
  version: 1,
  userId: USER,
  branchId: BRANCH,
  branch,
  role: 'owner',
  confirmedAt: NOW,
  ...overrides,
});

/* --------------------------------------------------------- happy path */

section('a server-confirmed branch is readable for the same user');

{
  const store = memoryStorage();
  const written = writeBranchSnapshot(
    { userId: USER, branch, role: 'owner', confirmedAt: NOW },
    store,
  );
  check('writing the snapshot succeeds', written.ok === true, written.error ?? '');

  const read = readBranchSnapshot({ storage: store, userId: USER, now: NOW });
  check(
    'the same user reads the exact branch and role',
    read.ok === true &&
      read.snapshot.branchId === BRANCH &&
      read.snapshot.userId === USER &&
      read.snapshot.role === 'owner' &&
      read.snapshot.branch.name === 'Main Counter',
    JSON.stringify(read),
  );
  check(
    'the snapshot is keyed under a single namespaced key',
    Object.keys(store.dump()).join(',') === BRANCH_SNAPSHOT_KEY,
    Object.keys(store.dump()).join(','),
  );

  const offline = read.ok ? savedBranchForOffline(read.snapshot) : { role: null, id: null };
  check(
    'an owner snapshot is downgraded to assistant for offline use',
    offline.role === 'assistant' && offline.id === BRANCH,
    JSON.stringify({ role: offline.role, branch: offline.id }),
  );
}

/* --------------------------------------------------------- identity / tenant */

section('a saved branch cannot cross accounts or tenants');

{
  const store = memoryStorage({ [BRANCH_SNAPSHOT_KEY]: JSON.stringify(snapshot()) });
  const otherUser = readBranchSnapshot({ storage: store, userId: OTHER_USER, now: NOW });
  check(
    'a different authenticated user cannot reuse the snapshot',
    otherUser.ok === false && /different account/i.test(otherUser.error),
    JSON.stringify(otherUser),
  );

  const wrongBranch = validateBranchSnapshot(
    snapshot({ branch: { ...branch, id: '22222222-2222-2222-2222-222222222222' } }),
    { userId: USER, now: NOW },
  );
  check(
    'a branch object that disagrees with its branchId is rejected',
    wrongBranch.ok === false && /incomplete/i.test(wrongBranch.error),
    JSON.stringify(wrongBranch),
  );

  const malformedId = validateBranchSnapshot(snapshot({ branchId: '' }), {
    userId: USER,
    now: NOW,
  });
  check(
    'an empty branch id is malformed, never widened to a shared key',
    malformedId.ok === false && /branch identity/i.test(malformedId.error),
    JSON.stringify(malformedId),
  );
}

/* --------------------------------------------------------- freshness / shape */

section('missing, expired, malformed, and storage failures are explicit');

{
  const empty = memoryStorage();
  const missing = readBranchSnapshot({ storage: empty, userId: USER, now: NOW });
  check(
    'a missing snapshot reports missing, not a fabricated branch',
    missing.ok === false && missing.reason === 'missing',
    JSON.stringify(missing),
  );

  const expiredStore = memoryStorage({
    [BRANCH_SNAPSHOT_KEY]: JSON.stringify(snapshot({ confirmedAt: NOW - 8 * 86_400_000 })),
  });
  const expired = readBranchSnapshot({ storage: expiredStore, userId: USER, now: NOW });
  check(
    'a snapshot older than the maximum age is refused',
    expired.ok === false && expired.reason === 'expired' && /too old/i.test(expired.error),
    JSON.stringify(expired),
  );

  const future = validateBranchSnapshot(snapshot({ confirmedAt: NOW + 10 * 60_000 }), {
    userId: USER,
    now: NOW,
  });
  check(
    'a confirmation time in the future is refused',
    future.ok === false && /invalid confirmation time/i.test(future.error),
    JSON.stringify(future),
  );

  const badJson = memoryStorage({ [BRANCH_SNAPSHOT_KEY]: '{not-json' });
  const malformed = readBranchSnapshot({ storage: badJson, userId: USER, now: NOW });
  check(
    'damaged JSON is reported as malformed',
    malformed.ok === false && malformed.reason === 'malformed',
    JSON.stringify(malformed),
  );

  const badVersion = validateBranchSnapshot(snapshot({ version: 2 }), { userId: USER, now: NOW });
  check(
    'an unsupported snapshot version is refused',
    badVersion.ok === false && /unsupported format/i.test(badVersion.error),
    JSON.stringify(badVersion),
  );

  const badRole = validateBranchSnapshot(snapshot({ role: 'platform_admin' }), {
    userId: USER,
    now: NOW,
  });
  check(
    'a role outside the staff enum is refused',
    badRole.ok === false && /valid role/i.test(badRole.error),
    JSON.stringify(badRole),
  );

  const throwing = {
    getItem() {
      throw new Error('storage denied');
    },
    setItem() {},
    removeItem() {},
  };
  const storageError = readBranchSnapshot({ storage: throwing, userId: USER, now: NOW });
  check(
    'a storage read failure is reported, not treated as missing',
    storageError.ok === false && storageError.reason === 'storage-error',
    JSON.stringify(storageError),
  );

  const writeFailure = writeBranchSnapshot(
    { userId: USER, branch, role: 'owner', confirmedAt: NOW },
    {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {},
    },
  );
  check(
    'a storage write failure is returned to the caller',
    writeFailure.ok === false && /could not save/i.test(writeFailure.error ?? ''),
    JSON.stringify(writeFailure),
  );
}

/* --------------------------------------------------------------- network shape */

section('only transport-shaped failures are eligible for cached recovery');

check(
  'failed fetch is a transport failure',
  isOfflineBranchFailure('TypeError: Failed to fetch') === true,
);
check(
  'a timeout is a transport failure',
  isOfflineBranchFailure('request timed out') === true,
);
check(
  'permission denied is NOT a transport failure',
  isOfflineBranchFailure('permission denied for table branches') === false,
);
check(
  'an expired JWT is NOT a transport failure',
  isOfflineBranchFailure('JWT expired') === false,
);

/* ----------------------------------------------------------------- clearing */

{
  const store = memoryStorage({ [BRANCH_SNAPSHOT_KEY]: JSON.stringify(snapshot()) });
  clearBranchSnapshot(store);
  check('sign-out can remove the saved branch', store.getItem(BRANCH_SNAPSHOT_KEY) === null);
}

process.exit(await finish());
