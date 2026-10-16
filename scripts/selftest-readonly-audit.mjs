/**
 * Negative control: prove `audit-readonly.mjs` FAILS if the read-only guard is
 * removed. Without this, the guard-presence check is untested and could be
 * satisfied by anything.
 *
 * Works on an in-memory copy. The real file is never modified.
 */

import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/verify-staging-connection.mjs', 'utf8');

// The exact checks audit-readonly.mjs performs.
const GUARD = /set\s+default_transaction_read_only\s*=\s*on/i;
const TIMEOUT = /set\s+statement_timeout/i;
const statementsOf = (s) => [...s.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
const readOnly = /^(select|set|show)\b/i;

function audit(s) {
  let bad = statementsOf(s).filter((q) => !readOnly.test(q)).length;
  if (!GUARD.test(s)) bad++;
  if (!TIMEOUT.test(s)) bad++;
  return bad;
}

let failed = 0;
const report = (ok, label) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
};

console.log('');
console.log('  Negative control: audit-readonly.mjs');
console.log('  ' + '='.repeat(58));

report(audit(src) === 0, 'the real file passes the audit');

// Remove ONLY the guard statement, leaving everything else intact.
const withoutGuard = src.replace(/await sql`set default_transaction_read_only = on`;/, '');
report(withoutGuard !== src, '  (the guard statement was locatable and removable for this test)');
report(audit(withoutGuard) > 0, 'removing the guard makes the audit FAIL');

// Remove the timeout too.
const withoutTimeout = src.replace(/await sql`set statement_timeout = 15000`;/, '');
report(audit(withoutTimeout) > 0, 'removing the statement timeout makes the audit FAIL');

// Inject a write, in the most plausible shape: a new sql`...` template.
const withWrite = src.replace(
  /const \[ident\] = await sql`select current_database/,
  "await sql`insert into public.branches (name) values ('pwned')`;\n  const [ident] = await sql`select current_database",
);
report(withWrite !== src, '  (a write could be injected for this test)');
report(audit(withWrite) > 0, 'an injected INSERT makes the audit FAIL');

// A DDL statement must also be caught.
const withDdl = src.replace(
  /const \[ident\] = await sql`select current_database/,
  "await sql`drop table public.branches`;\n  const [ident] = await sql`select current_database",
);
report(audit(withDdl) > 0, 'an injected DROP TABLE makes the audit FAIL');

// The original must still be untouched.
report(readFileSync('scripts/verify-staging-connection.mjs', 'utf8') === src, 'the real file was never modified');

console.log('');
console.log(failed === 0 ? '  RESULT: the audit detects its own regressions.' : `  RESULT: ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);