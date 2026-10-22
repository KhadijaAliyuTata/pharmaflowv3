/**
 * Runs every suite in this directory and reports one combined result.
 *
 * Each suite is a separate process so a crash or a hang in one cannot mask the
 * others, and so the exit code reflects "everything passed" rather than "the last
 * thing I ran passed".
 *
 * A suite's own summary is also read, so a suite that reports failed assertions
 * but still exits zero cannot produce a false green.
 *
 *   bun run verify:db
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = readdirSync(HERE)
  .filter((f) => f.startsWith('verify-') && (f.endsWith('.mjs') || f.endsWith('.ts')))
  .sort();

const bun = process.execPath;

/** Read the last "N passed, M failed" summary the suite printed. */
function parseCounts(output) {
  const matches = [...output.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)];
  const last = matches.at(-1);
  return last ? { passed: Number(last[1]), failed: Number(last[2]) } : null;
}

/** Run one suite, streaming its output while keeping its tail for classification. */
function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(bun, [join(HERE, suite)], { stdio: ['inherit', 'pipe', 'pipe'] });
    let tail = '';
    let settled = false;

    const capture = (chunk, stream) => {
      stream.write(chunk);
      tail = (tail + chunk.toString('utf8')).slice(-8192);
    };

    child.stdout.on('data', (chunk) => capture(chunk, process.stdout));
    child.stderr.on('data', (chunk) => capture(chunk, process.stderr));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ status: null, signal: null, error, tail });
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      resolve({ status, signal, error: null, tail });
    });
  });
}

const results = [];

for (const suite of SUITES) {
  console.log(`\n${'='.repeat(70)}\n${suite}\n${'='.repeat(70)}`);
  const run = await runSuite(suite);
  const counts = parseCounts(run.tail);
  const assertionFailure = counts !== null && counts.failed > 0;
  const executionError =
    !assertionFailure && (run.error !== null || run.signal !== null || run.status !== 0);
  const ok = !assertionFailure && !executionError;
  const kind = ok ? 'pass' : assertionFailure ? 'assertion' : 'execution';

  results.push({
    suite,
    ok,
    kind,
    counts,
    status: run.status,
    signal: run.signal,
    error: run.error,
  });
}

const failed = results.filter((r) => !r.ok);
const assertionFailures = failed.filter((r) => r.kind === 'assertion');
const executionFailures = failed.filter((r) => r.kind === 'execution');
const totals = results.reduce(
  (acc, r) => {
    if (r.counts) {
      acc.passed += r.counts.passed;
      acc.failed += r.counts.failed;
    }
    return acc;
  },
  { passed: 0, failed: 0 },
);

console.log(`\n${'='.repeat(70)}\nVERIFICATION SUMMARY\n${'='.repeat(70)}`);
for (const r of results) {
  const counts = r.counts ? ` (${r.counts.passed} passed, ${r.counts.failed} failed)` : '';
  let detail = '';
  if (!r.ok) {
    if (r.kind === 'assertion') {
      detail = ' [assertion failures]';
    } else {
      const reason = r.error
        ? `spawn error: ${r.error.message}`
        : r.signal
          ? `signal ${r.signal}`
          : `exit ${r.status ?? 'unknown'}`;
      detail = ` [execution error: ${reason}]`;
    }
  }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.suite}${counts}${detail}`);
}

console.log(
  `\nAssertions: ${totals.passed} passed, ${totals.failed} failed across ${results.length} suites`,
);
if (assertionFailures.length) {
  console.log(`Assertion-failing suites: ${assertionFailures.map((r) => r.suite).join(', ')}`);
}
if (executionFailures.length) {
  console.log(`Execution-error suites: ${executionFailures.map((r) => r.suite).join(', ')}`);
}
console.log(
  `\n${failed.length === 0 ? 'ALL SUITES PASSED' : `${failed.length} SUITE(S) FAILED`} — ${results.length} suites`,
);

process.exitCode = failed.length === 0 ? 0 : 1;
