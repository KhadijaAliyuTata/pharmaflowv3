/**
 * Offline test of the dry-run gate in `apply-staging-migrations.ps1`.
 *
 * That gate is the last thing standing between "the wrong set of migrations" and
 * a written database, and it cannot be reached without a real credential. So its
 * three decisions - "is the named set exactly what is expected?", "is it in
 * order?" and "contains a stop-phrase?" - are reproduced here against
 * representative `supabase db push --dry-run` outputs.
 *
 * No network, no database, no credential.
 *
 * ## The list is not duplicated here on purpose
 *
 * The expected filenames are READ from the .ps1 and from `supabase/migrations/`,
 * then compared to each other. Duplicating them in a third place is how the
 * safeguard and the repository drift apart in the first place: the gate was left
 * checking "exactly 17" while the folder grew to 20, and nothing failed because
 * the test carried its own copy of the same 17. Here, adding a migration to the
 * folder turns this test red until the .ps1's list is updated deliberately.
 */

import { readFileSync, readdirSync } from 'node:fs';

const SOURCE = readFileSync('scripts/apply-staging-migrations.ps1', 'utf8');

// The exact order the .ps1 declares.
const block = /ExpectedMigrations\s*=\s*@\(([\s\S]*?)\)/.exec(SOURCE)?.[1] ?? '';
const NAMES = [...block.matchAll(/'(\d{14}_\w+\.sql)'/g)].map((m) => m[1]);

// What is actually on disk.
const DISK = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort();

const STOP_PHRASES = [
  'Remote migration versions not found',
  'not found in local migrations directory',
  'has been applied but',
  'Already up to date',
  'already up to date',
  'must be run',
];

/**
 * The pre-apply decision, exactly as the .ps1 states it.
 *
 * Names are collected in the ORDER they appear, first occurrence kept - the .ps1
 * no longer sorts, because a sorted comparison cannot see a chain whose members
 * are right but whose order is wrong. A stop-phrase aborts before the set is even
 * inspected, mirroring the script's order of checks.
 */
function gate(dryOut, expected = NAMES) {
  const found = [];
  for (const m of dryOut.matchAll(/\b(\d{14}_\w+\.sql)\b/g)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  const phrase = STOP_PHRASES.find((p) => dryOut.includes(p)) ?? null;
  if (phrase) return { count: found.length, names: found, stopPhrase: phrase, proceed: false };

  if (found.length !== expected.length) {
    return { count: found.length, names: found, stopPhrase: null, proceed: false };
  }
  for (let i = 0; i < expected.length; i++) {
    if (found[i] !== expected[i]) {
      return { count: found.length, names: found, stopPhrase: null, proceed: false, firstDiff: i };
    }
  }
  return { count: found.length, names: found, stopPhrase: null, proceed: true };
}

let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};

console.log('');
console.log('  Dry-run gate logic (offline)');
console.log('  ' + '='.repeat(58));

// --- the safeguard and the repository must agree --------------------------
console.log('\n  The declared set vs supabase/migrations/');
check(
  NAMES.length > 0,
  'the .ps1 declares an explicit $ExpectedMigrations list',
  `parsed ${NAMES.length} name(s)`,
);
check(
  NAMES.length === DISK.length,
  'the .ps1 expects as many migrations as are on disk',
  `declared ${NAMES.length}, on disk ${DISK.length}`,
);
check(
  NAMES.length === DISK.length && NAMES.every((n, i) => n === DISK[i]),
  'the .ps1 list equals supabase/migrations/, in order',
  NAMES.length === DISK.length && DISK.some((n, i) => n !== NAMES[i])
    ? `first difference at index ${DISK.findIndex((n, i) => n !== NAMES[i])}`
    : '',
);
check(new Set(NAMES).size === NAMES.length, 'the .ps1 list has no duplicate names');

// The regression that prompted this: the gate asked for a count and lost the
// order, so "right number, wrong chain" passed.
check(!/ExpectedMigs/.test(SOURCE), 'the old count-only $ExpectedMigs is gone');
check(
  /New-Object System\.Collections\.Generic\.List\[string\]/.test(SOURCE) &&
    /\$found\.Contains\(\$name\)/.test(SOURCE),
  'the pre-apply extraction preserves order (no Sort-Object)',
);

// --- the happy path -------------------------------------------------------
console.log('\n  A fresh database, the whole chain pending');
const good = NAMES.map((n) => `Applying migration ${n}`).join('\n');
const g1 = gate(good);
check(g1.proceed, `all ${NAMES.length} pending -> PROCEED`, `count=${g1.count}`);
check(
  g1.names[0] === NAMES[0] && g1.names[NAMES.length - 1] === NAMES[NAMES.length - 1],
  `  ...and they are the right ${NAMES.length}, in order`,
);
check(
  gate(NAMES.map((n) => `• ${n}`).join('\r\n')).proceed,
  '  ...and the shape of the CLI line does not matter (bullet, CRLF)',
);

// --- the wrong set must stop ---------------------------------------------
console.log('\n  A set that is not exactly the expected one');
check(
  !gate(NAMES.slice(0, NAMES.length - 1).map((n) => `Applying migration ${n}`).join('\n')).proceed,
  'one migration missing -> STOP',
);
check(
  !gate([...NAMES, '20270101000000_something_new.sql'].map((n) => `Applying migration ${n}`).join('\n'))
    .proceed,
  'an unexpected extra migration -> STOP',
);
{
  // Same count, different chain: drop one expected file, add one unknown. A count
  // check alone cannot see this; the ordered set can.
  const swapped = [...NAMES.slice(0, -1), '20270101000000_impostor.sql'];
  const g = gate(swapped.map((n) => `Applying migration ${n}`).join('\n'));
  check(!g.proceed, 'same count, one substituted for an unknown -> STOP', `count=${g.count}`);
  check(g.firstDiff === NAMES.length - 1, '  ...and it stops at the first differing position');
}
{
  const reordered = [...NAMES];
  [reordered[7], reordered[8]] = [reordered[8], reordered[7]];
  const g = gate(reordered.map((n) => `Applying migration ${n}`).join('\n'));
  check(!g.proceed, 'the right 20 in the wrong order -> STOP', `firstDiff=${g.firstDiff}`);
}
{
  const shuffled = [...NAMES].reverse();
  check(!gate(shuffled.map((n) => `Applying migration ${n}`).join('\n')).proceed, 'fully reversed -> STOP');
}

// A duplicated mention must not inflate the count, and must not reorder.
{
  const g = gate([...NAMES, ...NAMES].map((n) => `Applying migration ${n}`).join('\n'));
  check(g.count === NAMES.length && g.proceed, 'the same list printed twice -> still the expected set (deduped)');
}

// --- stop-phrases ---------------------------------------------------------
console.log('\n  Stop-phrases');
for (const p of STOP_PHRASES) {
  const g = gate(`Remote: something\nApplying migration x\n${p}`);
  check(!g.proceed && g.stopPhrase === p, `stop-phrase "${p}" -> STOP`);
}

// The classic "target already has history this chain does not know" case.
const g4 = gate(
  'Remote migration versions not found in local migrations directory:\n  20260101000000_something_new.sql',
);
check(!g4.proceed, 'unknown remote history -> STOP', `stopPhrase=${g4.stopPhrase}`);

// Already-migrated target. On the PRE-apply gate a fresh, empty database is
// required, so "up to date" means the target is wrong and must stop.
const g5 = gate('Database is already up to date.');
check(!g5.proceed, 'already up to date (pre-apply) -> STOP', `stopPhrase=${g5.stopPhrase}`);

// --- ambiguous / dangerous output ----------------------------------------
console.log('\n  Ambiguous or dangerous output');
check(!gate('').proceed, 'empty dry-run output -> STOP');
check(
  !gate('Connecting to remote database...\nDRY RUN complete.').proceed,
  'a run that named no migration at all -> STOP',
);
{
  // A stop-phrase wins even when the full set is also named: a mixed message is a
  // stop, never a proceed.
  const g = gate(good + '\nRemote migration versions not found in local migrations directory:');
  check(!g.proceed && g.stopPhrase !== null, 'the expected set AND a stop-phrase -> STOP');
}
check(
  gate(`Some header text\n${good}\nSome footer text`).proceed,
  'the exact set with surrounding text -> PROCEED',
);

// --- the post-apply second dry run must NOT use the phrase list ------------
// There, "up to date" is the EXPECTED result, so consulting STOP_PHRASES would
// turn every successful apply into a failure. It is judged on naming nothing and
// exiting 0 instead.
console.log('\n  The post-apply second dry run is judged differently');
const postApply = SOURCE.slice(SOURCE.indexOf('7. post-apply verification'));
check(!postApply.includes('$stopPhrases'), 'the second dry run does not consult the pre-apply stop-phrases');
check(/\$againCode -ne 0/.test(SOURCE), 'the second dry run checks its own exit code first');

console.log('');
console.log(failed === 0 ? '  RESULT: the dry-run gate behaves correctly.' : `  RESULT: ${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
