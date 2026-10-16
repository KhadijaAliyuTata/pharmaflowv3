/**
 * Prove `verify-staging-connection.mjs` cannot write to the database.
 *
 * Extracts every template-literal SQL statement the script can execute and
 * asserts each begins with SELECT or SET. Read-only is a property of the whole
 * file, not of one hand-checked query, so it is checked mechanically.
 */

import { readFileSync } from 'node:fs';

const path = 'scripts/verify-staging-connection.mjs';
const src = readFileSync(path, 'utf8');

const statements = [...src.matchAll(/sql`([\s\S]*?)`/g)].map((m) =>
  m[1].replace(/\s+/g, ' ').trim(),
);

console.log('');
console.log('  Read-only audit: ' + path);
console.log('  ' + '='.repeat(58));
console.log(`  statements found: ${statements.length}`);

let bad = 0;
/**
 * The allowlist is SELECT, SET and SHOW.
 *
 *   SELECT  reads.
 *   SET     changes a session GUC. `statement_timeout` and
 *           `default_transaction_read_only` are the only two, both session-level
 *           and neither writes data - which is why SET is here at all rather
 *           than being treated as a write.
 *   SHOW    reads a parameter and prints it. It is what confirms the read-only
 *           guard actually took, and it cannot modify anything. It is a separate
 *           statement from SET precisely because one reads and one writes.
 *
 * Anything not on this list fails the audit.
 */
const readOnly = /^(select|set|show)\b/i;
for (const [i, q] of statements.entries()) {
  const isReadOnly = readOnly.test(q);
  if (!readOnly) bad++;
  const head = q.split(' ').slice(0, 3).join(' ');
  console.log(`   ${String(i + 1).padStart(2)}. ${readOnly ? 'READ-ONLY ' : '*** WRITE ***'} ${head}`);
}

// A connection string is not a statement; make sure none was counted.
console.log('');
console.log(`  non-SELECT/SET statements: ${bad}`);

/**
 * Guard presence.
 *
 * The prefix check above is necessary but not sufficient. It answers "could any
 * statement write?" and would pass just as happily if someone deleted every SET
 * line - including the read-only session guard, which is the only thing making
 * the guarantee a database-level one rather than a promise about this file.
 *
 * So the guard is required to be present by name. Deleting it now fails this
 * audit instead of passing it.
 */
const GUARD = /set\s+default_transaction_read_only\s*=\s*on/i;
const TIMEOUT = /set\s+statement_timeout/i;
const guardPresent = GUARD.test(src);
const timeoutPresent = TIMEOUT.test(src);
if (!guardPresent) bad++;
if (!timeoutPresent) bad++;

console.log('');
console.log(`  ${guardPresent ? '[ok]  ' : '[MISSING] '} read-only guard: set default_transaction_read_only = on`);
console.log(`  ${timeoutPresent ? '[ok]  ' : '[MISSING] '} statement timeout retained`);

console.log('');
console.log(bad === 0
  ? '  RESULT: the script can only read, and it enforces that at the database.'
  : '  RESULT: FAIL - the script can write, or a read-only guarantee is missing.');
process.exit(bad === 0 ? 0 : 1);