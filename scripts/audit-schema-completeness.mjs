/**
 * Completeness audit: does the migration chain actually produce the schema that
 * `src/lib/db.types.ts` declares?
 *
 * `db.types.ts` is hand-maintained and describes the application. The migrations
 * are what will actually be built. If those two disagree, staging will fail in a
 * way no local test can catch, because every suite runs against the migrations
 * and not against the type file.
 *
 * Read-only. Reads two files, prints a table. Exits non-zero on any gap.
 */

import { readFileSync, readdirSync } from 'node:fs';

const MIG_DIR = 'supabase/migrations';
const types = readFileSync('src/lib/db.types.ts', 'utf8');

const migs = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const sql = migs.map((f) => readFileSync(`${MIG_DIR}/${f}`, 'utf8')).join('\n');

/** Names inside a `section: { name: ... }` block of the Database type. */
function namesInSection(section) {
  const start = types.indexOf(`    ${section}: {`);
  if (start === -1) return { names: [], found: false };
  // Walk braces to the matching close.
  let depth = 0;
  let i = types.indexOf('{', start);
  for (; i < types.length; i++) {
    if (types[i] === '{') depth++;
    else if (types[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = types.slice(start, i);
  const names = [];
  for (const line of body.split('\n')) {
    const m = /^\s{6}([a-z_][a-z0-9_]*)\s*:/.exec(line);
    if (m) names.push(m[1]);
  }
  return { names, found: true };
}

const tables = namesInSection('Tables');
const views = namesInSection('Views');
const fns = namesInSection('Functions');
const enums = namesInSection('Enums');

/**
 * `pattern` is applied case-insensitively via the RegExp flags.
 *
 * JavaScript has no inline `(?i)` flag - that is a PCRE/PostgreSQL thing - so
 * passing `(?i)` to `new RegExp` throws "unrecognized character after (?"
 * rather than matching. The flag belongs in the constructor.
 */
function check(label, list, pattern) {
  console.log('');
  console.log(`  ${label} (${list.names.length} declared in db.types.ts)`);
  if (!list.found) {
    console.log('    !! section not found in db.types.ts');
    return 1;
  }
  let missing = 0;
  for (const n of list.names) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pattern.replace('%s', escaped), 'i');
    if (!re.test(sql)) {
      console.log(`    MISSING  ${n}  - not produced by any migration`);
      missing++;
    }
  }
  console.log(`    ${missing === 0 ? 'all present in the migration chain' : `${missing} MISSING`}`);
  return missing;
}

console.log('');
console.log('  Schema completeness: db.types.ts vs the migration chain');
console.log('  ' + '='.repeat(64));

let gaps = 0;
gaps += check('TABLES', tables, 'create table (if not exists )?(public\\.)?%s\\b');
gaps += check('VIEWS', views, 'create (or replace )?view (public\\.)?%s\\b');
gaps += check('ENUMS', enums, 'create type (public\\.)?%s\\b');
gaps += check('FUNCTIONS', fns, 'create (or replace )?function (public\\.)?%s\\s*\\(');

console.log('');
console.log('  ' + '='.repeat(64));
console.log(gaps === 0
  ? '  RESULT: the migration chain produces everything db.types.ts declares.'
  : `  RESULT: ${gaps} declared object(s) have no migration. Staging would fail.`);

process.exit(gaps === 0 ? 0 : 1);