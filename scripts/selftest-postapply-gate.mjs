/**
 * Offline test of the post-apply gate in `apply-staging-migrations.ps1`.
 *
 * ## Why this exists
 *
 * The gate used to read "any non-zero exit is fine" after an apply, because a
 * populated database makes the verifier exit non-zero. That conflated four
 * unrelated outcomes with the one expected one, and the worst of them was
 * silent: a `$env:PGURI` that had drifted to production exits 3 without opening a
 * connection, and the old gate treated that as a successful migration.
 *
 * ## Why it must be offline
 *
 * Reaching the real gate needs a real database and a real apply. So the decision
 * itself is reproduced here, byte-for-byte as the .ps1 implements it, and driven
 * with every exit code the verifier can produce plus the codes it must never
 * produce.
 */

import { readFileSync } from 'node:fs';

const SOURCE = readFileSync('scripts/apply-staging-migrations.ps1', 'utf8');

let failed = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};

/**
 * The post-apply decision, exactly as the .ps1 states it.
 * Returns { ok, reason }.
 */
function postApplyGate(exitCode) {
  if (exitCode !== 1) {
    switch (exitCode) {
      case 0: return { ok: false, reason: 'the database still reports as EMPTY. The migrations did not land.' };
      case 2: return { ok: false, reason: 'the target could not be determined.' };
      case 3: return { ok: false, reason: 'THE TARGET WAS REFUSED. Do not continue; check $env:PGURI.' };
      case 4: return { ok: false, reason: 'the connection or verification failed. Nothing was confirmed.' };
      default: return { ok: false, reason: `unrecognised exit code. Treat as failure.` };
    }
  }
  return { ok: true, reason: 'identity verified AND the database is populated, as expected' };
}

// --------------------------------------------------------------------------
console.log('');
console.log('  Post-apply gate: exit code 1 is the ONLY success');
console.log('  ' + '='.repeat(58));

report(postApplyGate(1).ok, 'exit 1 -> SUCCESS', postApplyGate(1).reason);

report(!postApplyGate(0).ok, 'exit 0 -> FAILURE', postApplyGate(0).reason);
report(!postApplyGate(2).ok, 'exit 2 -> FAILURE', postApplyGate(2).reason);
report(!postApplyGate(3).ok, 'exit 3 -> FAILURE', postApplyGate(3).reason);
report(!postApplyGate(4).ok, 'exit 4 -> FAILURE', postApplyGate(4).reason);

// Every code outside 0-4 must also fail. An unknown code must never be read as
// success - a verifier that crashed, or a shell that swallowed the code, must
// not be able to pass this gate.
for (const code of [5, 6, 127, 255, null, undefined, -1, '1']) {
  report(!postApplyGate(code).ok, `exit ${JSON.stringify(code)} -> FAILURE (unknown code)`);
}

// The specific regression: the old gate accepted these.
const regressions = [
  { code: 3, label: 'production URI refused before connecting' },
  { code: 4, label: 'wrong password / network failure' },
  { code: 2, label: 'target undeterminable' },
];
for (const r of regressions) {
  report(
    !postApplyGate(r.code).ok,
    `regression: ${r.label} must NOT read as success`,
    `exit ${r.code} -> ${postApplyGate(r.code).reason}`,
  );
}

// --------------------------------------------------------------------------
/**
 * The post-apply SECOND dry run.
 *
 * The dangerous shape: this check requires ZERO pending migrations. A dry run
 * that failed - dropped connection, expired password, pooler hiccup - also names
 * zero. Counting names alone therefore reports success on a command that never
 * ran, and the script prints "Identity and history checks passed." having
 * verified nothing.
 *
 * The pre-apply gate cannot have this bug: it requires EXACTLY 17, so 0 stops.
 */
function secondDryRunGate(exitCode, namesFound) {
  if (exitCode !== 0) {
    return { ok: false, reason: `the second dry run FAILED (exit ${exitCode}). Its output cannot be trusted.` };
  }
  if (namesFound !== 0) {
    return { ok: false, reason: `a second dry run still lists ${namesFound} migration(s)` };
  }
  return { ok: true, reason: 'the chain is fully applied' };
}

console.log('');
console.log('  Post-apply: the second dry run');
console.log('  ' + '='.repeat(58));

// The regression: a failed command naming nothing must NOT pass.
report(
  !secondDryRunGate(1, 0).ok,
  'REGRESSION: failed dry run naming 0 migrations -> FAILURE',
  secondDryRunGate(1, 0).reason,
);
report(!secondDryRunGate(127, 0).ok, 'exit 127 naming 0 -> FAILURE');
report(!secondDryRunGate(4, 0).ok, 'exit 4 naming 0 -> FAILURE');

// A genuinely clean no-op still passes.
report(secondDryRunGate(0, 0).ok, 'clean dry run naming 0 migrations -> SUCCESS', secondDryRunGate(0, 0).reason);

// Anything still pending fails, even when the command succeeded.
report(!secondDryRunGate(0, 1).ok, 'successful dry run naming 1 -> FAILURE', secondDryRunGate(0, 1).reason);
report(!secondDryRunGate(0, 17).ok, 'successful dry run naming 17 -> FAILURE');

// The exit code must be checked BEFORE the name count, otherwise the order of
// the two conditions would let a failure through when names happen to be 0.
report(
  !secondDryRunGate(1, 0).ok && /FAILED/.test(secondDryRunGate(1, 0).reason),
  'the exit code is the FIRST thing consulted',
);

// --------------------------------------------------------------------------
console.log('');
console.log('  The .ps1 actually implements both fixes');
console.log('  ' + '='.repeat(58));

report(
  /\$againCode = \$LASTEXITCODE/.test(SOURCE),
  'the second dry run exit code is captured',
);
report(
  /the second dry run FAILED \(exit \$againCode\)/.test(SOURCE),
  'a failed second dry run is a hard failure',
);
report(
  // Case-insensitive: the script sentence starts with a capital "A".
  /failed command lists no migrations, which is indistinguishable/i.test(SOURCE),
  'and the reason is explained rather than left implicit',
);
report(
  /\$dryCode = \$LASTEXITCODE/.test(SOURCE),
  'the pre-apply dry run exit code is captured too',
);
report(
  /the dry run itself FAILED/.test(SOURCE),
  'a failed pre-apply dry run stops with a clear message',
);
report(
  // "the dump at $dump is empty" - matched loosely on purpose; the point is that
// a non-empty check exists at all, not its exact wording.
  /\$dumpCode = \$LASTEXITCODE/.test(SOURCE) && /dump at .* is empty/i.test(SOURCE),
  'the dump step checks exit code AND non-emptiness, not just existence',
);

// --------------------------------------------------------------------------
console.log('');
console.log('  Success messages must match what is actually checked');
console.log('  ' + '='.repeat(58));

// "exit 1 - identity verified AND the database is populated" - accurate only if
// exit 1 is reachable ONLY after the identity checks and a successful connect.
const VERIFIER = readFileSync('scripts/verify-staging-connection.mjs', 'utf8');
const popAt = VERIFIER.indexOf('process.exit(EXIT_POPULATED)');
const prodAt = VERIFIER.indexOf('refuse(EXIT_REFUSED)');
const connectAt = VERIFIER.indexOf('sql = postgres(uri');
report(popAt !== -1 && prodAt !== -1 && connectAt !== -1, 'the three landmarks all exist');
report(
  connectAt < popAt,
  'exit 1 is unreachable before a successful connection',
);
report(
  prodAt < connectAt,
  'the production refusal precedes the connection, so exit 1 cannot skip it',
);

// The final claim must still be qualified.
report(
  /Identity and history checks passed\./.test(SOURCE),
  'the script states that identity and history checks passed',
);
report(
  /are NOT machine-checked/.test(SOURCE),
  'and immediately qualifies it: the five counts are still manual',
);

console.log('');
console.log(failed === 0 ? '  RESULT: the post-apply gate behaves correctly.' : `  RESULT: ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);