/**
 * Parsing the quantity typed on Stock Receiving.
 *
 * ## Why the field is not `<input type="number">`
 *
 * A native number input is not a reliable way to type a count:
 *
 *   * Browsers disagree about which keystrokes are accepted, and a rejected
 *     keystroke can leave `event.target.value` as `''`. A controlled input then
 *     renders that empty string back, so the character the attendant typed
 *     disappears and the field looks like it cannot be typed into.
 *   * `min` and `step` are enforced as *form validation*, not as input rules, so
 *     a miss-typed value blocks the submit with a browser tooltip instead of an
 *     inline message the screen can explain.
 *   * The old code fed the raw string through `Number(raw) || 0` and `money()`,
 *     which rounds. `1.999` became `2` — a silently different delivery from the
 *     one on the delivery note.
 *
 * A text field with `inputMode="numeric"` plus the rules below is deterministic
 * in every browser: nothing is rewritten behind the attendant's back, clearing
 * and replacing work like any other text field, and every rejected value has a
 * sentence attached to it.
 *
 * These functions are the *early* guard for the screen. They do not replace the
 * authoritative check in `convertToBaseUnits` (whole base units, safe integers),
 * which still runs inside `receiveStock` for both the demo and live paths.
 */

/** Why a typed quantity cannot be received. */
export type QuantityProblem = 'empty' | 'not-whole' | 'zero' | 'too-large';

export type QuantityParse =
  | { ok: true; value: number }
  | { ok: false; reason: QuantityProblem };

/** The sentence shown under the field. One message per problem, no codes. */
export const QUANTITY_PROBLEM: Record<QuantityProblem, string> = {
  empty: 'Enter the quantity received.',
  'not-whole': 'Quantity must be a whole number of units — no decimals, signs or letters.',
  zero: 'Quantity must be greater than zero.',
  'too-large': 'That quantity is too large to record. Check the delivery note.',
};

/**
 * Grouping separators people paste from a delivery note or a spreadsheet.
 *
 * A thin/narrow no-break space is common in exported numbers, so it is stripped
 * with the ordinary space and comma rather than treated as an invalid character.
 */
function stripGrouping(raw: string): string {
  return raw.replace(/[\s,_\u00a0\u202f]/g, '');
}

/**
 * Turn one `onChange` value into the string the field should display.
 *
 * Returns `null` when the edit must be refused: the caller keeps the previous
 * value so that typing `.`, `-`, `e` or a letter can never be silently turned
 * into a different number. (Removing the character instead would make `1.5`
 * read as `15`, which is exactly the kind of quiet corruption this screen must
 * not do.)
 *
 * Leading zeros are dropped as they are typed (`05` → `5`) so a value left by
 * the decrement button does not turn the next digit into `05`. A lone `0` is
 * kept, because the attendant pressed it.
 */
export function normaliseQuantityTyping(raw: string): string | null {
  const grouped = stripGrouping(raw);
  if (!/^\d*$/.test(grouped)) return null;
  return grouped.replace(/^0+(?=\d)/, '');
}

/**
 * Read the field for submission or for the live conversion preview.
 *
 * `'007'` is 7; `''` is not a number the pharmacy can receive; `'0'` is a count
 * the screen refuses out loud rather than passing on as "zero units received".
 * Negative and fractional values can only arrive by paste or programmatic set,
 * and are refused for the same reason.
 */
export function parseQuantityText(raw: string): QuantityParse {
  const grouped = stripGrouping(raw);

  if (grouped === '') return { ok: false, reason: 'empty' };
  if (!/^\d+$/.test(grouped)) return { ok: false, reason: 'not-whole' };

  const value = Number(grouped);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'too-large' };
  if (value <= 0) return { ok: false, reason: 'zero' };

  return { ok: true, value };
}

/**
 * Counts offered by the dropdown beside the quantity field.
 *
 * These are *counted* units, not base units: the menu shows what each preset
 * means for the selected packaging (five boxes of 100 is 500 tablets). They are
 * shortcuts for common delivery sizes, not a closed list — the field stays a
 * normal editable input and any whole count can still be typed.
 */
export const QUANTITY_PRESETS = [1, 2, 5, 10, 20, 50, 100] as const;

/**
 * The `+` / `−` buttons, in the unit the delivery was **counted in**.
 *
 * One press is one counted unit — one box on a note that says "5 boxes", not
 * one base unit and not the packaging multiplier. Stepping by
 * `receiveUnit.multiplier` made the buttons jump by 100 on a Box(100) product,
 * so the number in the field was never the number being keyed.
 *
 * `−` on one (or on empty) clears the field instead of showing `0`: the next
 * digit is then a fresh count rather than an append to a zero.
 */
export function nextQuantity(current: string, delta: 1 | -1): string {
  const parsed = parseQuantityText(current);
  const base = parsed.ok ? parsed.value : 0;
  const next = base + delta;
  return next > 0 ? String(next) : '';
}
