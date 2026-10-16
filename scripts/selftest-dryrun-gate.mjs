/**
 * Offline test of the dry-run gate in `apply-staging-migrations.ps1`.
 *
 * That gate is the last thing standing between "the wrong set of migrations" and
 * a written database, and it cannot be reached without a real credential. So its
 * two decisions - "exactly 17?" and "contains a stop-phrase?" - are reproduced
 * here against representative `supabase db push --dry-run` outputs.
 *
 * The names below are the real filenames from this repository, in order. No
 * network, no database, no credential.
 */

const NAMES = [
  '20261002160000_initial_schema.sql',
  '20261004090000_stock_ledger_and_fefo_foundation.sql',
  '20261005120000_unit_hierarchy.sql',
  '20261005160000_branch_registration.sql',
  '20261005190000_function_execute_hardening.sql',
  '20261005210000_role_and_destructive_authorization.sql',
  '20261005230000_receipt_pricing_authority.sql',
  '20261005250000_branch_membership_role_authority.sql',
  '20261005260000_role_change_auditability.sql',
  '20261006090000_staff_invitations.sql',
  '20261006150000_staff_invitation_expiry.sql',
  '20261007120000_staff_invitation_claim.sql',
  '20261007130000_revoke_invitation_clears_claim.sql',
  '20261007140000_revoke_invitation_active_claim_only.sql',
  '20261012120000_authoritative_checkout.sql',
  '20261012130000_void_sale_restores_stock.sql',
  '20261012140000_platform_admin.sql',
];

const EXPECTED = 17;
const STOP_PHRASES = [
  'Remote migration versions not found',
  'not found in local migrations directory',
  'has been applied but',
  'Already up to date',
  'already up to date',
  'must be run',
];

// The exact logic used by the .ps1.
function gate(dryOut) {
  const found = [...new Set([...dryOut.matchAll(/\b(2026\d{10}_\w+\.sql)\b/g)].map((m) => m[1]))];
  const phrase = STOP_PHRASES.find((p) => dryOut.includes(p));
  return { count: found.length, names: found, stopPhrase: phrase ?? null, proceed: found.length === EXPECTED && !phrase };
}

let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
};

console.log('');
console.log('  Dry-run gate logic (offline)');
console.log('  ' + '='.repeat(58));

// The happy path, in the shape the CLI prints.
const good = [
  'Applying migration 20261002160000_initial_schema.sql',
  ...NAMES.slice(1).map((n) => `Applying migration ${n}`),
].join('\n');
const g1 = gate(good);
check(g1.proceed && g1.count === 17, 'all 17 pending -> PROCEED', `count=${g1.count}`);
check(g1.names[0] === NAMES[0] && g1.names[16] === NAMES[16], '  ...and they are the right 17, in order');

// A short list must never proceed.
const g2 = gate(NAMES.slice(0, 16).map((n) => `Applying migration ${n}`).join('\n'));
check(!g2.proceed, `only 16 pending -> STOP`, `count=${g2.count}`);

// A duplicated mention must not inflate the count.
const g3 = gate([...NAMES, ...NAMES].map((n) => `Applying migration ${n}`).join('\n'));
check(g3.count === 17 && g3.proceed, 'the same 17 listed twice -> still 17 (deduped)', `count=${g3.count}`);

// Each stop-phrase must abort.
for (const p of STOP_PHRASES) {
  const g = gate(`Remote: something\nApplying migration x\n${p}`);
  check(!g.proceed && g.stopPhrase === p, `stop-phrase "${p}" -> STOP`);
}

// The classic "target already has history this chain does not know" case.
const g4 = gate(
  'Remote migration versions not found in local migrations directory:\n  20260101000000_something_new.sql',
);
check(!g4.proceed, 'unknown remote history -> STOP', `stopPhrase=${g4.stopPhrase}`);

// Already-migrated target.
const g5 = gate('Database is already up to date.');
check(!g5.proceed, 'already up to date -> STOP', `stopPhrase=${g5.stopPhrase}`);

// A non-empty project with 17 known migrations.
const g6 = gate(NAMES.map((n) => `Applying migration ${n}`).join('\n'));
check(g6.proceed, 'exactly 17 regardless of surrounding text -> PROCEED', `count=${g6.count}`);

// Empty output must not silently proceed.
const g7 = gate('');
check(!g7.proceed, 'empty dry-run output -> STOP', `count=${g7.count}`);

console.log('');
console.log(failed === 0 ? '  RESULT: the dry-run gate behaves correctly.' : `  RESULT: ${failed} case(s) failed.`);
process.exit(failed === 0 ? 0 : 1);