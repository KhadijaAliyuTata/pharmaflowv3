/**
 * Pre-flight: prove which Supabase project a migration command would hit.
 *
 *   bun scripts/verify-staging-target.mjs
 *
 * ## What this does NOT do
 *
 * It opens no network connection, contacts no Supabase API, and reads no
 * database. It only compares strings in four local files. That is deliberate:
 * this is meant to be safe to run at any time, including immediately before a
 * migration, without any risk of itself becoming the thing that changes data.
 *
 * It is therefore a check on the **configuration**, not a check on the server.
 * It cannot tell you that staging is empty, that staging is reachable, or that
 * the password is right. For that, `psql "select 1"` - a read-only connection -
 * is the next step, and it needs the staging database password.
 *
 * ## Why this exists at all
 *
 * `supabase/.temp/project-ref` points at PRODUCTION. Any bare
 * `supabase db push` in this repository therefore targets production. This
 * script exists so that fact is stated loudly and mechanically before anyone
 * gets near a migration command, rather than being rediscovered each time.
 *
 * Exit codes: 0 safe, 1 unsafe (do not migrate), 2 could not determine.
 *
 * Reads: `supabase/config.staging.toml`, `supabase/config.toml`,
 * `supabase/.temp/project-ref`, `.env`.
 * Writes: nothing. Creates nothing. Contacts nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

/**
 * The staging project this repository is being prepared for.
 *
 * Duplicated from `supabase/config.staging.toml` on purpose: the script must be
 * able to say "the config file and the expectation disagree", which it could not
 * if it simply read the value out of the file it is checking.
 */
const EXPECTED_STAGING_REF = 'xnhsuifcbplnwtxnpedw';

const REF_PATTERN = /^[a-z]{20}$/;

/** Reads a file, returning null rather than throwing when it is absent. */
function read(path) {
  try {
    return readFileSync(resolve(REPO, path), 'utf8');
  } catch {
    return null;
  }
}

/** The `project_id` value, or null. Comments are stripped first. */
function projectIdOf(toml) {
  if (toml === null) return null;
  const line = toml
    .split('\n')
    .find((l) => /^project_id\s*=/.test(l.trim()));
  return line ? (line.match(/"([^"]+)"/)?.[1] ?? null) : null;
}

/**
 * The Supabase project ref behind a `PUBLIC_SUPABASE_URL`.
 *
 * Only the hostname is read. The key on the next line is never touched.
 */
function refFromEnvUrl(env) {
  if (env === null) return null;
  const line = env.split('\n').find((l) => /^PUBLIC_SUPABASE_URL\s*=/.test(l));
  if (!line) return null;
  return line.match(/https:\/\/([a-z]{20})\.supabase\./)?.[1] ?? null;
}

const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label, detail });
}

const stagingToml = read('supabase/config.staging.toml');
const prodToml = read('supabase/config.toml');
const linkFile = read('supabase/.temp/project-ref');
const env = read('.env');

const stagingRef = projectIdOf(stagingToml);
const prodRef = projectIdOf(prodToml);
const linkedRef = linkFile ? linkFile.trim() : null;
const envRef = refFromEnvUrl(env);

// --- 1. the expectation, and the file, must agree --------------------------
check(
  stagingRef === EXPECTED_STAGING_REF,
  'config.staging.toml records the expected staging ref',
  stagingRef === null
    ? 'config.staging.toml missing or has no project_id'
    : `records ${stagingRef === EXPECTED_STAGING_REF ? 'the expected ref' : 'a DIFFERENT ref'}`,
);

check(
  stagingRef !== null && REF_PATTERN.test(stagingRef),
  'the staging ref is well formed',
  '20 lowercase alphanumeric characters',
);

// --- 2. staging must not be production --------------------------------------
// This is the check that matters most. If any of these is equal, a migration
// command aimed at "staging" is aimed at production.
check(
  prodRef !== null && stagingRef !== null && stagingRef !== prodRef,
  'the staging ref differs from config.toml (production)',
  prodRef === null ? 'could not read production project_id' : 'distinct',
);

check(
  envRef !== null && stagingRef !== null && stagingRef !== envRef,
  'the staging ref differs from the project in .env',
  envRef === null ? 'could not read a ref from PUBLIC_SUPABASE_URL' : 'distinct',
);

check(
  linkedRef !== null && stagingRef !== null && stagingRef !== linkedRef,
  'the staging ref differs from the current CLI link',
  linkedRef === null
    ? 'no CLI link recorded (supabase/.temp/project-ref absent)'
    : 'distinct - the link still points at production, as intended',
);

// --- 3. the bare-command hazard ---------------------------------------------
// Not a failure: production not being linked to staging is the desired state.
// But `supabase db push` with no flags WILL use the link, so the hazard has to
// be reported on every run rather than left for someone to rediscover.
const barePushTargetsProduction =
  linkedRef !== null && prodRef !== null && linkedRef === prodRef;

check(
  true,
  'Hazard: a bare `supabase db push` would use the recorded link',
  barePushTargetsProduction
    ? 'WHICH IS PRODUCTION. Always pass --db-url <staging uri> or --workdir.'
    : 'the link is not the production project',
);

// --- report -----------------------------------------------------------------
const width = Math.max(...checks.map((c) => c.label.length));
console.log('');
console.log('  Supabase target verification  (local files only - no network, no database)');
console.log('  ' + '='.repeat(width + 12));
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.label.padEnd(width)}  ${c.detail}`);
}
console.log('');

const failed = checks.filter((c) => !c.ok);
const undetermined = checks.some((c) => c.detail.startsWith('could not'));

if (failed.length > 0) {
  console.log(`  RESULT: ${failed.length} check(s) failed.`);
  console.log('  DO NOT run any migration command.');
  process.exit(undetermined ? 2 : 1);
}

console.log('  RESULT: the staging project is configured and distinct from production.');
console.log('');
console.log('  This proves CONFIGURATION only. It does not prove that:');
console.log('    - the staging database is reachable');
console.log('    - the staging database is empty');
console.log('    - your password is correct');
console.log('    - the CLI is logged in');
console.log('  Those need a read-only connection and are a separate, approved step.');
console.log('');
process.exit(0);