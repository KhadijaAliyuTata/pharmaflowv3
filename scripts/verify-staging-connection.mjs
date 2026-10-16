/**
 * Verify that $env:PGURI points at STAGING, and that staging is untouched.
 *
 *   bun scripts/verify-staging-connection.mjs
 *
 * ## The credential never enters this repository
 *
 * `PGURI` is read from the environment of whatever shell runs this script. The
 * script does not read `.env`, does not read a file, and does not accept the URI
 * as an argument - an argument would land in shell history and in the process
 * command line, both of which are readable by other processes on the machine.
 *
 * It is designed to be run by you, in your own shell, after setting $env:PGURI
 * there. It is deliberately NOT run by an automated agent process, which does not
 * have the variable set.
 *
 * ## What it will never do
 *
 * - Print the password, or any substring of the URI that contains it.
 * - Execute anything other than SELECT.
 * - Change data. Every statement is a SELECT and the session is set read-only.
 *
 * ## Why the project ref is read from the USERNAME for a pooler URI
 *
 * A Supabase SESSION pooler URI does not contain the project ref in the host:
 *
 *   postgresql://postgres.<PROJECT_REF>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
 *                       ^^^^^^^^^^^^^^^^ here, not in the host
 *
 * A naive check that greps the whole URI for the expected ref would pass on a
 * production URI too if the names were ever similar, and would fail confusingly
 * on a correctly formed staging one. So the ref is extracted from the place the
 * provider actually puts it, per connection style:
 *
 *   direct   host = db.<PROJECT_REF>.supabase.co          -> ref from the host
 *   session  user = postgres.<PROJECT_REF>                -> ref from the user
 *   session  host = aws-0-<region>.pooler.supabase.com     -> ref from the user
 *
 * Exit codes: 0 verified, 1 WRONG TARGET (do not continue), 2 could not determine.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// `import.meta.dirname` is the supported form, but resolve it explicitly so the
// production-ref read cannot silently fail. A hand-rolled `new URL(...).pathname`
// is wrong on Windows: the repo path contains a space, which the URL percent-
// encodes as %20, so `readFileSync` would miss the file and the production check
// would degrade to "could not read" instead of actually running.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const EXPECTED_STAGING_REF = 'xnhsuifcbplnwtxnpedw';

/**
 * Exit codes. The distinction that matters is IDENTITY versus EVERYTHING ELSE.
 *
 * Previously every non-success collapsed onto exit 1, which meant a post-apply
 * check could not tell "the database is now populated, as expected" from "the
 * URI drifted to production" or "the password is wrong". All three exited 1, and
 * the apply script treated all three as success.
 *
 *   0  identity verified, database fresh/empty      - correct BEFORE a migration
 *   1  identity verified, database populated         - correct AFTER a migration
 *   2  unable to determine the target
 *   3  target refused: production, mismatch, or a prohibited pooler
 *   4  connection or verification failure
 *
 * Codes 3 and 4 are failures that must never be mistaken for 1.
 */
export const EXIT_FRESH = 0;
export const EXIT_POPULATED = 1;
export const EXIT_UNDETERMINED = 2;
export const EXIT_REFUSED = 3;
export const EXIT_UNVERIFIED = 4;

/**
 * Decide from catalog counts alone whether this is a genuinely fresh project.
 *
 * Pure and exported, with no database access, so the decision table can be
 * tested offline. The connection path cannot be: exercising it needs a real
 * server, which means the states below would otherwise only ever be seen once,
 * in production, at the worst possible moment.
 *
 * `supabase_migrations.schema_migrations` is NOT guaranteed to exist. It is
 * created by the first `supabase db push`, so on a project that has never been
 * migrated the schema is simply absent - and querying it unconditionally raises
 * `42P01 undefined_table`. That is the normal state of a fresh project, not a
 * fault, and it must never be reported as one.
 *
 * On `publicViews`: reported, but never a failure. The migration chain creates
 * ~30 tables, so `publicTables > 0` already proves it ran; failing on views too
 * would add a false-positive risk for a default view whose existence has not
 * been observed on a real fresh project.
 */
export function assessFreshness(c) {
  const problems = [];
  const notes = [];

  if (c.migrationSchema && c.migrationTable) {
    if (c.migrationCount > 0) {
      problems.push(`migration history already contains ${c.migrationCount} record(s)`);
    } else {
      notes.push('schema_migrations exists and is empty');
    }
  } else if (c.migrationSchema && !c.migrationTable) {
    notes.push('supabase_migrations schema exists but has no schema_migrations table - history not initialized');
  } else {
    notes.push('no supabase_migrations schema - migration history not initialized');
  }

  if (c.publicTables > 0) {
    problems.push(`public contains ${c.publicTables} table(s)`);
  }
  if (c.pfFunctions > 0) {
    problems.push(`${c.pfFunctions} pf_* function(s) exist, so the migration chain has already run`);
  }
  if (c.publicViews > 0) {
    notes.push(`public contains ${c.publicViews} view(s) - reported, not treated as a failure`);
  }

  return { fresh: problems.length === 0, problems, notes };
}

/**
 * Classify a server or driver error.
 *
 * The original version reported every failure as "Connection failed", which is
 * how a *successful* connection that tripped over an absent table came to be
 * reported as a connection failure. A wrong password and an undefined table need
 * different sentences, because one is your mistake and the other is the script's.
 */
export function classifyError(e) {
  const code = e?.code;
  if (code === '28P01' || code === '28000' || code === '42501') {
    return { kind: 'auth', message: 'the server refused these credentials' };
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET', 'EPROTO'].includes(code)) {
    return { kind: 'network', message: 'could not reach the server' };
  }
  if (code === '42P01') {
    return { kind: 'catalog', message: 'the server reported a missing object - see the script, not your URI' };
  }
  return { kind: 'unknown', message: 'unexpected error' };
}

/** Redacts the password and any full URI out of anything about to be printed. */
function makeRedactor(uri) {
  const secrets = new Set();
  if (uri) {
    secrets.add(uri);
    try {
      const u = new URL(uri);
      if (u.password) {
        secrets.add(u.password);
        secrets.add(decodeURIComponent(u.password));
      }
    } catch {
      /* unparseable - handled below */
    }
  }
  return (text) => {
    let out = String(text);
    for (const s of secrets) {
      if (s && s.length > 3) out = out.split(s).join('***REDACTED***');
    }
    // Belt and braces: scrub anything that still looks like inline credentials.
    return out.replace(/:\/\/[^:@/\s]+:[^@/\s]+@/g, '://***:***@');
  };
}

// --------------------------------------------------------------------------
// Everything below runs only when this file is the entrypoint.
//
// The module is importable so the offline self-test can exercise
// assessFreshness() and classifyError() against synthetic states. None of the
// executable half may sit at top level: importing the file to reach a pure
// function must not connect anywhere, or print, or exit.
// --------------------------------------------------------------------------
let redact = makeRedactor(null);
let lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(redact(s));
};
const fail = (s) => say(`  FAIL  ${s}`);

async function main() {
// --------------------------------------------------------------------------
// 1. The variable must be present
// --------------------------------------------------------------------------
const uri = process.env.PGURI;
say('');
say('  Staging connection verification');
say('  ' + '='.repeat(50));

if (!uri) {
  fail('$env:PGURI is not set in this shell.');
  say('');
  say('  Set it in YOUR PowerShell window, so the credential never reaches chat:');
  say('');
  say('    $sec = Read-Host "Staging session pooler URI" -AsSecureString');
  say('    $env:PGURI = [System.Net.NetworkCredential]::new("", $sec).Password');
  say('');
  say('  -AsSecureString keeps it out of shell history and masks it on screen.');
  say('  It lives only in this shell session and dies with it.');
  say('  Never paste the URI into chat, and never write it into a file.');
  say('  No connection was attempted.');
  say('');
  process.exit(EXIT_UNDETERMINED);
}
redact = makeRedactor(uri);

// --------------------------------------------------------------------------
// 2. Parse, and pull the ref out of where the provider actually puts it
// --------------------------------------------------------------------------
let u;
try {
  u = new URL(uri);
} catch {
  fail('PGURI does not parse as a URL. Expected postgresql://user:pass@host:port/db');
  say('  No connection was attempted.');
  say('');
  process.exit(EXIT_UNDETERMINED);
}

const hasPassword = Boolean(u.password);
const host = u.hostname;
const port = u.port || '5432';
const user = decodeURIComponent(u.username);
const database = u.pathname.replace(/^\//, '');

// Which connection style is this?
const direct = /^db\.([a-z]{20})\.supabase\.(co|in)$/.exec(host);
const pooler = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
const userRef = /^postgres\.([a-z]{20})$/.exec(user);

let style;
let ref = null;
if (direct) {
  style = 'direct';
  ref = direct[1];
} else if (pooler) {
  style = 'pooler';
  ref = userRef ? userRef[1] : null;
} else {
  style = 'unrecognised host';
}

say(`  connection style     : ${style}`);
say(`  host                 : ${host}:${port}`);
say(`  user                 : ${user}`);
say(`  database             : ${database}`);
say(`  password present     : ${hasPassword ? 'yes' : 'NO - this cannot authenticate'}`);
if (ref) say(`  project ref (source) : ${ref} (${style === 'direct' ? 'from host' : 'from username'})`);

// `stopCode` rather than a boolean. The boolean could only say "stop", and every
// stop looked identical to the caller. Now each condition carries its own reason,
// and the first refusal found wins - the ordering below is the priority order.
let stopCode = null;
const refuse = (code) => {
  if (stopCode === null) stopCode = code;
};

// The password must exist, or every later step is noise.
if (!hasPassword) {
  fail('No password in PGURI. Re-copy the URI; it ends in :postgres');
  refuse(EXIT_UNDETERMINED);
}

// The ref must be recoverable. Refusing here is what stops an unrecognised host
// from being waved through as "probably fine".
if (!ref) {
  fail('Could not extract a project reference from this URI.');
  say('        For a session pooler the ref must be in the username as');
  say('        postgres.<20 lowercase letters>. For a direct connection the');
  say('        host must be db.<20 lowercase letters>.supabase.co');
  refuse(EXIT_UNDETERMINED);
}

// Production is checked BEFORE the staging match, deliberately.
//
// A production URI is also a "mismatch" - it is simply not the staging ref - so
// a generic check first would report the least useful thing and exit before the
// one sentence that matters most is ever printed. Production must always be
// named explicitly.
let productionRef = null;
try {
  const toml = readFileSync(resolve(REPO, 'supabase/config.toml'), 'utf8');
  productionRef = toml.split('\n').find((l) => /^project_id\s*=/.test(l.trim()))?.match(/"([^"]+)"/)?.[1] ?? null;
} catch {
  /* handled below */
}
if (!productionRef) {
  fail('Could not read the production project_id from supabase/config.toml');
  refuse(EXIT_UNDETERMINED);
} else if (ref && ref === productionRef) {
  say('');
  fail('#################### THIS IS PRODUCTION ####################');
  say('        Do not run any migration, deploy, or script against this URI.');
  say('        The connection string in $env:PGURI is the live database.');
  say('        Stop, and re-copy the STAGING session pooler URI.');
  say('  #############################################################');
  say('');
  refuse(EXIT_REFUSED);
} else if (ref) {
  say('  is not production    : confirmed (differs from supabase/config.toml)');
}

// Then the staging match.
if (ref && ref !== EXPECTED_STAGING_REF) {
  fail(`PROJECT MISMATCH: this URI points at ${ref}`);
  say(`        Expected staging: ${EXPECTED_STAGING_REF}`);
  say('        STOP. Do not run any migration against this.');
  refuse(EXIT_REFUSED);
} else if (ref) {
  say(`  project ref          : MATCHES staging (${EXPECTED_STAGING_REF})`);
}

// A transaction pooler cannot run DDL, which would fail confusingly later.
if (style === 'pooler') {
  if (port === '6543') {
    fail('Port 6543 is the TRANSACTION pooler. Use the session pooler (5432).');
    refuse(EXIT_REFUSED);
  } else if (port === '5432') {
    say('  pooler mode          : session (5432) - correct for DDL');
  } else {
    say(`  pooler mode          : port ${port} - unexpected, confirm you chose "Session pooler"`);
  }
}

if (stopCode !== null) {
  say('');
  say('  RESULT: target not verified. No connection was attempted.');
  say('');
  process.exit(stopCode);
}

// --------------------------------------------------------------------------
// 3. Connect, read-only, and look at the database
// --------------------------------------------------------------------------
say('');
say('  Connecting (read-only, SELECT only)...');
let sql;
try {
  sql = postgres(uri, {
    max: 1,
    ssl: 'require',
    connect_timeout: 15,
    idle_timeout: 2,
    onnotice: () => {},
  });
  // Session-level, so it applies outside any transaction. A hung query must not
  // leave the shell blocked.
  await sql`set statement_timeout = 15000`;

  // ---------------------------------------------------------------- guard
  //
  // Make "read-only" a DATABASE guarantee rather than an authoring convention.
  //
  // Why this is load-bearing rather than belt-and-braces: RLS is NOT a backstop
  // for this connection. No migration in this repository uses FORCE ROW LEVEL
  // SECURITY (0 occurrences; 19 enable RLS), and the session-pooler user
  // `postgres.<ref>` maps to the `postgres` role, which OWNS these tables and
  // therefore bypasses RLS outright. So the only thing standing between a
  // careless template literal and a write is what happens here.
  //
  // `default_transaction_read_only` makes every subsequent transaction
  // read-only. Under autocommit each of our statements is its own transaction,
  // so it covers all of them.
  //
  // LIMITATION, stated rather than glossed: this is a strong guard against
  // accident, not against an adversary. A superuser can still set
  // `transaction_read_only = off` per transaction. That is acceptable here
  // because the threat is a bug in this script, not a hostile connection - but
  // it should not be described as an absolute guarantee.
  await sql`set default_transaction_read_only = on`;

  // Confirm the guard took rather than assuming it. Fail closed: if the
  // database did not honour it, this script must not proceed to read anything,
  // let alone be trusted with the word "read-only".
  const [ro] = await sql`show default_transaction_read_only`;
  if (String(ro?.v ?? '').toLowerCase() !== 'on') {
    say('');
    fail('Could not establish a read-only session.');
    say(`  default_transaction_read_only = ${ro?.v ?? '<unset>'}`);
    say('  Refusing to continue: this script cannot honour its own guarantee.');
    await sql.end({ timeout: 1 });
    process.exit(EXIT_UNVERIFIED);
  }
  say('  read-only session    : on (default_transaction_read_only)');

  const [ident] = await sql`select current_database() as db, current_user as usr, current_setting('server_version') as ver`;
  say(`  connected to database : ${ident.db}`);
  say(`  connected as          : ${ident.usr}`);
  say(`  server version        : ${ident.ver}`);

  // Catalog FIRST. One round trip, and nothing here can fail for want of an
  // object that may legitimately not exist yet.
  const [cat] = await sql`
    select
      (select count(*)::int from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE')          as public_tables,
      (select count(*)::int from information_schema.views
        where table_schema = 'public')                                        as public_views,
      (select exists (select 1 from information_schema.schemata
        where schema_name = 'supabase_migrations'))                           as migration_schema,
      (select exists (select 1 from information_schema.tables
        where table_schema = 'supabase_migrations'
          and table_name   = 'schema_migrations'))                            as migration_table,
      (select count(*)::int from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'pf\_%')                as pf_functions`;

  say(`  tables in public      : ${cat.public_tables}`);
  say(`  views in public       : ${cat.public_views}`);
  say(`  pf_* functions        : ${cat.pf_functions}`);
  say(`  supabase_migrations   : ${cat.migration_schema ? 'schema present' : 'absent'}`);
  say(`  schema_migrations tbl : ${cat.migration_table ? 'present' : 'absent'}`);

  // Only touch the history table if the catalog says it is there. On a fresh
  // project it is not, and that is the expected result.
  let migrationCount = 0;
  if (cat.migration_schema && cat.migration_table) {
    const [m] = await sql`select count(*)::int as n from supabase_migrations.schema_migrations`;
    migrationCount = m.n;
    say(`  recorded migrations   : ${migrationCount}`);
  } else {
    say('  recorded migrations   : n/a - history not initialized, which is');
    say('                         correct for a project that has never been migrated');
  }

  const verdict = assessFreshness({
    publicTables: cat.public_tables,
    publicViews: cat.public_views,
    migrationSchema: cat.migration_schema,
    migrationTable: cat.migration_table,
    migrationCount,
    pfFunctions: cat.pf_functions,
  });

  for (const n of verdict.notes) say(`    - ${n}`);

  if (!verdict.fresh) {
    say('');
    fail('This database is NOT a fresh, unmigrated staging project:');
    for (const p of verdict.problems) say(`        * ${p}`);
    say('');
    say('        Either a migration has already been applied here, or you are');
    say('        pointed at the wrong database. STOP. Work out which project');
    say('        this is before running anything else.');
    await sql.end({ timeout: 1 });
    process.exit(EXIT_POPULATED);
  }

  await sql.end({ timeout: 1 });
  say('');
  say('  RESULT: verified. This is the staging project, it is not production,');
  say('          and it is empty and unmigrated. No data was changed.');
  say('');
  say('  Stop here and confirm before any migration is applied.');
  say('');
  process.exit(EXIT_FRESH);
} catch (e) {
  const { kind, message } = classifyError(e);
  say('');
  fail(`${kind === 'auth' ? 'Authentication failed' : kind === 'network' ? 'Connection failed' : 'Server error'}: ${message}`);
  say(`  ${redact(e?.message ?? e)}`);
  if (e?.code) say(`  SQLSTATE: ${e.code}`);
  say('');
  say('  Nothing was changed.');
  if (kind === 'catalog') {
    say('  This is a bug in this script, not a problem with your URI.');
  } else {
    say('  Common causes: wrong password, wrong port, or the project has no');
    say('  running database.');
  }
  say('');
  try {
    await sql?.end({ timeout: 1 });
  } catch {
    /* already failing */
  }
  // Never 1. A connection failure is not evidence that the database is
  // populated, and the apply script treats 1 as success. Conflating them is
  // exactly the bug this taxonomy exists to remove.
  process.exit(EXIT_UNVERIFIED);
}
}

// `import.meta.main` keeps the module importable so the offline self-test can
// exercise assessFreshness() and classifyError() without opening a connection.
if (import.meta.main) {
  await main();
}