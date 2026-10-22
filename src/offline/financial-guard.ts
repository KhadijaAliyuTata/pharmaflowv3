/**
 * The financial-field redaction that every local cache write passes through.
 *
 * ## Why this module exists
 *
 * The database withholds cost from `authenticated` by grant, and the owner reads
 * it only through the `pf_*_costs` views. That boundary holds while the bytes are
 * in transit from Postgres — but an offline cache persists rows into IndexedDB,
 * and IndexedDB is readable by anything running in the page: another tab, an
 * extension, a bug that dumps state to the console. If an attendant's cache ever
 * held a cost figure, the grant would have been undone after the fact.
 *
 * Removing cost at the **client reader** (`useMedicines`) is not protection: it is
 * a display rule. The only reliable cut is at the **cache writer** — a single
 * function every local cache write calls, which removes owner-only financial
 * fields wherever they appear in the value tree before anything is persisted.
 *
 * This is defence in depth, not the primary control. The primary control is that
 * the catalogue read never delivers cost to an assistant at all (the bytes are
 * absent from the response). This guard covers the writer so that a future read
 * path that *does* hand the owner's catalogue to a shared writer cannot persist
 * it for the owner's attendant.
 *
 * ## What is forbidden
 *
 * Exact key names, never substring matches — `margin` must not swallow a
 * hypothetical `marginNote`, and `cost` must not swallow `costume`. Keys are
 * matched on the exact lower-cased name at any depth. Legitimate non-financial
 * fields never collide with this set.
 */

/**
 * Owner-only financial field names, lower-cased. Any one of these is a leak when
 * persisted for a role that is not the owner.
 */
export const FORBIDDEN_FINANCIAL_KEYS: ReadonlySet<string> = new Set([
  // Purchase cost — the grant-hidden column and every spelling it can arrive as.
  'cost',
  'costprice',
  'costperbaseunit',
  'cost_per_base_unit',
  'costperunit',
  'costperstrip',
  'costpercarton',
  'unitcost',
  'purchasecost',
  'purchasecostperbaseunit',
  'purchaseprice',
  'suppliercost',
  'wholesalerate',
  'wholesaleprice',
  'basecost',

  // Derived financials, never part of an attendant's data.
  'cogs',
  'costofgoodssold',
  'cost_of_goods_sold',
  'margin',
  'grossmargin',
  'marginperunit',
  'marginpercent',
  'profit',
  'profitamount',
  'profitperunit',
  'profitmargin',

  // Owner-only aggregates (stock value is a Pf costs-view figure).
  'stockvalue',
  'stockvalueatcost',
  'stockvaluex',
]);

/** Owner-only key allowance, exported for tests. */
export const OWNER_ONLY = true;

function isStrippable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a FINANCIAL-FREE copy of `value` for a role other than the owner.
 *
 * Recurses through plain objects and arrays. Primitives, `Date`s and `null`s
 * pass through untouched. Non-plain objects pass through — the cache only ever
 * stores JSON-shaped domain rows. Copying (rather than mutating) is deliberate:
 * a caller holding the live domain object must not have it silently rewritten.
 */
export function stripFinancialFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripFinancialFields(entry));
  }
  if (!isStrippable(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FINANCIAL_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripFinancialFields(child);
  }
  return out;
}

function deepWalk(value: unknown, keys: string[], seen: Set<object>): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const entry of value) deepWalk(entry, keys, seen);
    return;
  }
  if (!isStrippable(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FINANCIAL_KEYS.has(key.toLowerCase())) keys.push(key);
    deepWalk(child, keys, seen);
  }
}

/**
 * Names every forbidden financial key present anywhere in `value`.
 *
 * The cache writer asserts this returns `[]` after stripping for a non-owner
 * role; if it ever returns anything, the role calculation that produced the
 * writer's perception of the caller is wrong — that is a security defect to
 * find here, not quietly downstream in a screen.
 */
export function findFinancialKeys(value: unknown): string[] {
  const keys: string[] = [];
  deepWalk(value, keys, new Set());
  return keys;
}
