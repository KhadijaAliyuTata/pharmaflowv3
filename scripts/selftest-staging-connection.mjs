/**
 * Safety test for `verify-staging-connection.mjs`.
 *
 * Feeds it deliberately WRONG URIs and asserts it refuses before it ever tries to
 * connect. Uses fabricated credentials - there is no real password in this file,
 * and the tests never reach the network: every case must be rejected during
 * offline parsing.
 *
 *   bun scripts/_selftest-connection-verify.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  assessFreshness,
  classifyError,
  EXIT_FRESH,
  EXIT_POPULATED,
  EXIT_UNDETERMINED,
  EXIT_REFUSED,
  EXIT_UNVERIFIED,
} from './verify-staging-connection.mjs';

const STAGING = 'xnhsuifcbplnwtxnpedw';
const FAKE_PASSWORD = 'not-a-real-password-000';
const SESSION_HOST = 'aws-0-eu-west-1.pooler.supabase.com';

const run = (uri) => {
  const r = spawnSync(process.execPath, ['scripts/verify-staging-connection.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, PGURI: uri },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

let failed = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};

// ==========================================================================
// 1. assessFreshness - the decision table, exercised without a database
// ==========================================================================
console.log('');
console.log('  assessFreshness: fresh-project states (offline)');
console.log('  ' + '='.repeat(58));

// THE CASE THAT BROKE THE SCRIPT: a genuinely fresh Supabase project has no
// supabase_migrations schema at all, because the first `db push` creates it.
// Querying it unconditionally raised 42P01 and the catch reported the whole
// successful connection as a failure.
const freshNoSchema = assessFreshness({
  publicTables: 0,
  publicViews: 0,
  migrationSchema: false,
  migrationTable: false,
  migrationCount: 0,
  pfFunctions: 0,
});
report(freshNoSchema.fresh, 'no supabase_migrations schema at all -> FRESH', `notes: ${JSON.stringify(freshNoSchema.notes)}`);
report(
  freshNoSchema.notes.some((n) => /not initialized/.test(n)),
  '  ...and it is reported as "history not initialized", not an error',
);

// Schema present, table not yet created.
const freshSchemaNoTable = assessFreshness({
  publicTables: 0,
  publicViews: 0,
  migrationSchema: true,
  migrationTable: false,
  migrationCount: 0,
  pfFunctions: 0,
});
report(freshSchemaNoTable.fresh, 'schema present, table absent -> FRESH', `notes: ${JSON.stringify(freshSchemaNoTable.notes)}`);

// Schema and table both present, zero records - the state right after a project
// is initialised but before any migration lands.
const emptyHistory = assessFreshness({
  publicTables: 0,
  publicViews: 0,
  migrationSchema: true,
  migrationTable: true,
  migrationCount: 0,
  pfFunctions: 0,
});
report(emptyHistory.fresh, 'schema_migrations present and empty -> FRESH', `notes: ${JSON.stringify(emptyHistory.notes)}`);

// Views reported but never a failure: the chain creates ~30 tables, so
// publicTables > 0 already proves it ran. Failing on views too would risk a
// false positive from a default view nobody has observed.
const viewsOnly = assessFreshness({
  publicTables: 0,
  publicViews: 3,
  migrationSchema: false,
  migrationTable: false,
  migrationCount: 0,
  pfFunctions: 0,
});
report(
  viewsOnly.fresh && viewsOnly.notes.some((n) => /3 view/.test(n)),
  'views alone -> still FRESH, but reported',
  `notes: ${JSON.stringify(viewsOnly.notes)}`,
);

console.log('');
console.log('  assessFreshness: states that must FAIL');
console.log('  ' + '-'.repeat(58));

const alreadyMigrated = assessFreshness({
  publicTables: 30,
  publicViews: 8,
  migrationSchema: true,
  migrationTable: true,
  migrationCount: 17,
  pfFunctions: 40,
});
report(!alreadyMigrated.fresh, '17 migrations recorded -> NOT FRESH');
report(alreadyMigrated.problems.length >= 3, '  ...naming every reason', JSON.stringify(alreadyMigrated.problems));

// Migration history present with records, but no public tables - an odd but
// possible half-state. The history alone must be enough to stop it.
const historyOnly = assessFreshness({
  publicTables: 0,
  publicViews: 0,
  migrationSchema: true,
  migrationTable: true,
  migrationCount: 3,
  pfFunctions: 0,
});
report(!historyOnly.fresh, 'migration records but no tables -> NOT FRESH', JSON.stringify(historyOnly.problems));

// pf_* functions without a migration-history table. Possible if someone applied
// SQL by hand. The functions are unambiguous evidence.
const strayFunctions = assessFreshness({
  publicTables: 0,
  publicViews: 0,
  migrationSchema: false,
  migrationTable: false,
  migrationCount: 0,
  pfFunctions: 2,
});
report(!strayFunctions.fresh, 'pf_* functions present -> NOT FRESH', JSON.stringify(strayFunctions.problems));

// Tables with no history at all.
const strayTables = assessFreshness({
  publicTables: 5,
  publicViews: 0,
  migrationSchema: false,
  migrationTable: false,
  migrationCount: 0,
  pfFunctions: 0,
});
report(!strayTables.fresh, 'tables but no history -> NOT FRESH', JSON.stringify(strayTables.problems));

// ==========================================================================
// 2. classifyError - a good connection must never read as a connection failure
// ==========================================================================
console.log('');
console.log('  classifyError: error kinds are distinguished');
console.log('  ' + '='.repeat(58));

report(classifyError({ code: '42P01' }).kind === 'catalog', '42P01 undefined_table -> catalog', 'attributed to the script, not your URI');
report(classifyError({ code: '28P01' }).kind === 'auth', '28P01 bad password -> auth');
report(classifyError({ code: '42501' }).kind === 'auth', '42501 insufficient_privilege -> auth');
report(classifyError({ code: 'ECONNREFUSED' }).kind === 'network', 'ECONNREFUSED -> network');
report(classifyError({ code: 'ENOTFOUND' }).kind === 'network', 'ENOTFOUND -> network');
report(classifyError({}).kind === 'unknown', 'no code -> unknown');
report(
  classifyError({ code: '42P01' }).kind !== 'network' && classifyError({ code: '42P01' }).kind !== 'auth',
  'a missing object is NOT reported as a connection or credential failure',
);

// ==========================================================================
// 3. Wrong-target refusal, end to end, offline
// ==========================================================================
console.log('');
console.log('  Wrong-target refusal (offline, fabricated URIs)');
console.log('  ' + '='.repeat(58));

// Exit-code taxonomy under test:
//   0 identity verified + fresh      1 identity verified + populated
//   2 unable to determine target     3 target refused
//   4 connection / verification failure
//
// The property that matters and that the previous version got wrong: only ONE
// condition may produce 1. If a wrong target or an auth failure could ever exit
// 1, the post-apply gate would report it as a successful migration.
const cases = [
  // --- exit 3: refused, before any connection ---
  { name: 'production ref in a session-pooler username', code: 3, uri: `postgresql://postgres.lhsjtjsxmuspbqoaxvcm:${FAKE_PASSWORD}@${SESSION_HOST}:5432/postgres`, text: 'THIS IS PRODUCTION' },
  { name: 'production ref in a direct host', code: 3, uri: `postgresql://postgres:${FAKE_PASSWORD}@db.lhsjtjsxmuspbqoaxvcm.supabase.co:5432/postgres`, text: 'THIS IS PRODUCTION' },
  { name: 'a ref that is neither staging nor production', code: 3, uri: `postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:${FAKE_PASSWORD}@${SESSION_HOST}:5432/postgres`, text: 'PROJECT MISMATCH' },
  { name: 'staging ref but TRANSACTION pooler port', code: 3, uri: `postgresql://postgres.${STAGING}:${FAKE_PASSWORD}@${SESSION_HOST}:6543/postgres`, text: 'TRANSACTION pooler' },

  // --- exit 2: cannot determine the target ---
  { name: 'pooler host with no ref in the username', code: 2, uri: `postgresql://postgres:${FAKE_PASSWORD}@${SESSION_HOST}:5432/postgres`, text: 'Could not extract a project reference' },
  { name: 'unrecognised host entirely', code: 2, uri: `postgresql://postgres:${FAKE_PASSWORD}@db.example.internal:5432/postgres`, text: 'Could not extract a project reference' },
  { name: 'no password at all', code: 2, uri: `postgresql://postgres.${STAGING}@${SESSION_HOST}:5432/postgres`, text: 'No password' },
  { name: 'PGURI unset', code: 2, uri: '', text: '$env:PGURI is not set' },
  { name: 'PGURI is not a URL at all', code: 2, uri: 'not-a-uri', text: 'does not parse as a URL' },
];

for (const c of cases) {
  const { code, out } = c.uri ? run(c.uri) : run(undefined);
  const ok = code === c.code && out.includes(c.text);
  report(ok, c.name, `exit ${code} (want ${c.code}), message "${c.text}" ${out.includes(c.text) ? 'found' : 'MISSING'}`);
}

// Every refusal must SAY that no connection was attempted, so a reader who only
// sees the exit code never has to guess whether a socket was opened.
//
// The match is POSITIVE. An earlier version of this line negated it, so it
// asserted the phrase was absent - and passed only because the early exits did
// omit it, which is the opposite of the intent.
const refusalTexts = cases.map((c) => run(c.uri || undefined));
report(
  refusalTexts.every((r) => /No connection was attempted|not verified/i.test(r.out)),
  'every refusal states that no connection was attempted',
  `${refusalTexts.filter((r) => !/No connection was attempted|not verified/i.test(r.out)).length} of ${refusalTexts.length} lacked it`,
);
report(
  refusalTexts.every((r) => r.code !== 1),
  'no refusal can produce exit 1 (which would read as a successful migration)',
);

// ==========================================================================
// 5. Exit-code constants match the documented taxonomy
// ==========================================================================
console.log('');
console.log('  Exit-code constants');
console.log('  ' + '='.repeat(58));
report(EXIT_FRESH === 0, 'EXIT_FRESH === 0');
report(EXIT_POPULATED === 1, 'EXIT_POPULATED === 1');
report(EXIT_UNDETERMINED === 2, 'EXIT_UNDETERMINED === 2');
report(EXIT_REFUSED === 3, 'EXIT_REFUSED === 3');
report(EXIT_UNVERIFIED === 4, 'EXIT_UNVERIFIED === 4');
report(
  new Set([EXIT_FRESH, EXIT_POPULATED, EXIT_UNDETERMINED, EXIT_REFUSED, EXIT_UNVERIFIED]).size === 5,
  'all five codes are distinct',
);

// ==========================================================================
// 6. The read-only guard is present in the source
// ==========================================================================
console.log('');
console.log('  Read-only session guard');
console.log('  ' + '='.repeat(58));
const src = readFileSync('scripts/verify-staging-connection.mjs', 'utf8');
report(
  /set\s+default_transaction_read_only\s*=\s*on/i.test(src),
  'the guard is issued, not merely intended',
);
report(
  /show\s+default_transaction_read_only/i.test(src),
  'the guard is READ BACK and checked, so it fails closed',
);
report(
  /statement_timeout/i.test(src),
  'the statement timeout is retained',
);
report(
  /superuser can still set/i.test(src),
  'the override limitation is documented rather than glossed',
);
// The guard must be established BEFORE the first catalog read.
const guardAt = src.search(/set\s+default_transaction_read_only/i);
const firstCatalogAt = src.search(/information_schema/i);
report(
  guardAt !== -1 && firstCatalogAt !== -1 && guardAt < firstCatalogAt,
  'the guard is established BEFORE any catalog query',
  `guard at offset ${guardAt}, first catalog query at ${firstCatalogAt}`,
);

// ==========================================================================
// 7. The password never appears in output
// ==========================================================================
console.log('');
const leak = cases.map((c) => run(c.uri ?? undefined)).some((r) => r.out.includes(FAKE_PASSWORD));
report(!leak, 'the password never appears in any output');

console.log('');
console.log(failed === 0 ? '  RESULT: all checks passed.' : `  RESULT: ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);