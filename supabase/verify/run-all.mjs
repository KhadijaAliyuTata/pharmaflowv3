/**
 * Runs every suite in this directory and reports one combined result.
 *
 * Each suite is a separate process so a crash or a hang in one cannot mask the
 * others, and so the exit code reflects "everything passed" rather than "the last
 * thing I ran passed".
 *
 *   bun run verify:db
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = readdirSync(HERE)
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))
  .sort();

const bun = process.execPath;
const results = [];
let failed = 0;

for (const suite of SUITES) {
  console.log(`\n${'='.repeat(70)}\n${suite}\n${'='.repeat(70)}`);
  const run = spawnSync(bun, [join(HERE, suite)], { stdio: 'inherit' });
  const ok = run.status === 0;
  if (!ok) failed += 1;
  results.push({ suite, ok });
}

console.log(`\n${'='.repeat(70)}\nVERIFICATION SUMMARY\n${'='.repeat(70)}`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.suite}`);
console.log(
  `\n${failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`} — ${results.length} suites`,
);

process.exit(failed === 0 ? 0 : 1);
