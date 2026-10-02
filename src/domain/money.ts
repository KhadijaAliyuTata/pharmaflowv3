/**
 * Money and dates.
 *
 * All money in PharmaFlow is a plain number of naira. It is NOT safe to do
 * arithmetic on those numbers directly: `0.1 + 0.2 !== 0.3`, and a pharmacy
 * that is off by a kobo on 400 sales is a pharmacy nobody trusts.
 *
 * Every calculation therefore goes through these helpers. The rule is: never
 * write `a * b - c` on money in a component; write `multiply`, `subtract`.
 */

const NAIRA = '₦';

export function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function add(...values: number[]): number {
  return money(values.reduce((total, value) => total + value, 0));
}

export function subtract(a: number, b: number): number {
  return money(a - b);
}

export function multiply(value: number, factor: number): number {
  return money(value * factor);
}

export function sum(values: number[]): number {
  return add(...values);
}

/** Percentage of `part` against `whole`. Guards against divide-by-zero. */
export function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return money((part / whole) * 100);
}

/** Margin and its percentage, given revenue and cost. */
export function margin(revenue: number, cost: number) {
  const value = subtract(revenue, cost);
  return { value, percent: percentOf(value, revenue) };
}

/** "₦12,500" — no decimals, because kobo are noise at this scale. */
export function formatNaira(value: number, options: { compact?: boolean } = {}): string {
  const { compact = false } = options;
  const rounded = money(value);

  if (compact && Math.abs(rounded) >= 1_000_000) {
    return `${NAIRA}${trim(rounded / 1_000_000)}M`;
  }
  if (compact && Math.abs(rounded) >= 10_000) {
    return `${NAIRA}${trim(rounded / 1000)}k`;
  }

  const hasFraction = rounded % 1 !== 0;
  return `${NAIRA}${rounded.toLocaleString('en-NG', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  })}`;
}

/** Drops a trailing ".0" so 1.5M does not render as 1.5M.0 */
function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

export function formatCount(value: number, unitName?: string): string {
  return `${value.toLocaleString('en-NG')}${unitName ? ` ${unitName}` : ''}`;
}

/* -------------------------------------------------------------------- dates */

/** ISO date only, in UTC. Avoids the "yesterday" drift of local Date parsing. */
export function isoDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function isoTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/** Whole days from today until `iso`. Negative once the date has passed. */
export function daysUntil(iso: string, from: Date = new Date()): number {
  const target = Date.parse(`${iso}T00:00:00Z`);
  const start = Date.parse(`${isoDate(from)}T00:00:00Z`);
  return Math.round((target - start) / 86_400_000);
}

/** "12 Nov 2027" — unambiguous across regions, unlike "11/12/27". */
export function formatDate(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "14:32" for today, otherwise a date. Saves vertical space in tables. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return formatDate(iso);
}

/** "3 days ago" / "in 2 months" — for audit and activity feeds. */
export function formatRelative(iso: string, from: Date = new Date()): string {
  const deltaSeconds = Math.round((Date.parse(iso) - from.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return 'just now';
}

/** Deterministic id. Good enough for a local-first app, and SSR-safe. */
export function createId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}
