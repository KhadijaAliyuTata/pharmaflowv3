/**
 * Offline checks for the Stock Receiving product picker and quantity control.
 *
 * These cover the things the screen got wrong, and nothing that needs a browser
 * or a database:
 *
 *   * what the product search matches, and that the picker is a searchable
 *     combobox rather than a dropdown-only select;
 *   * what the quantity field accepts and rejects as it is typed, including
 *     clearing it, replacing it, grouping separators and non-numeric edits;
 *   * what a confirmed receipt does to stock — the quantity increases by the
 *     counted amount, existing units and batches are preserved, the receipt,
 *     movement, notification and audit row are written, and an invalid count
 *     changes nothing at all.
 *
 * It imports the same modules the screen and the store import. `bun` strips the
 * type-only imports, so no build step, network or Supabase project is involved.
 */

import { readFileSync } from 'node:fs';
import { matchesMedicineQuery, medicineLabel } from '../src/domain/medicine-search.ts';
import {
  QUANTITY_PRESETS,
  QUANTITY_PROBLEM,
  nextQuantity,
  normaliseQuantityTyping,
  parseQuantityText,
} from '../src/domain/quantity-input.ts';
import { receiveStock } from '../src/domain/operations.ts';
import { createSeedState } from '../src/domain/seed.ts';

// The field's state logic can be perfect and still look broken if its flex row
// squeezes the input to a text-less sliver on a wide screen. Keep a guard for
// the layout fix here too, because the domain checks below cannot see CSS.
const routeSource = readFileSync(
  new URL('../src/routes/_app/stock-receiving.tsx', import.meta.url),
  'utf8'
);
const productControlSource = routeSource.slice(
  routeSource.indexOf('htmlFor="recv-medicine"'),
  routeSource.indexOf('htmlFor="recv-batch"')
);

let failed = 0;
let passed = 0;

function check(ok, label, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
}

console.log('');
console.log('  Stock Receiving product picker and quantity field (offline)');
console.log('  ' + '='.repeat(58));

/* ------------------------------------------------------- product search */

const catalog = createSeedState().medicines;
const paracetamol = catalog.find((medicine) => medicine.id === 'med-paracetamol');
const amoxicillin = catalog.find((medicine) => medicine.id === 'med-amoxicillin');

check(paracetamol != null && amoxicillin != null, 'the seeded catalogue has both test products');
check(
  paracetamol != null && matchesMedicineQuery(paracetamol, 'Paracetamol'),
  'typing the product name matches its catalogue entry',
);
check(
  paracetamol != null && matchesMedicineQuery(paracetamol, '  paracetamol  '),
  'the search ignores case and surrounding space',
);
check(
  paracetamol != null && matchesMedicineQuery(paracetamol, '500mg'),
  'typing the strength narrows the product list',
);
check(
  paracetamol != null && matchesMedicineQuery(paracetamol, '8901030365012'),
  'typing the barcode matches the product',
);
check(
  paracetamol != null && !matchesMedicineQuery(paracetamol, 'Amoxicillin'),
  'a different product name does not match',
);
check(
  paracetamol != null && matchesMedicineQuery(paracetamol, ''),
  'an empty query keeps the catalogue available to browse',
);
check(
  paracetamol != null && medicineLabel(paracetamol) === 'Paracetamol Tablets · 500mg',
  'the selected label keeps the name and strength together',
);

/* ------------------------------------------------------ product control */

check(/<Combobox\b/.test(productControlSource), 'the product field is a combobox');
check(
  !/<Select\b/.test(productControlSource),
  'the product field is not the old dropdown-only select',
);
check(
  /<ComboboxInput\b[\s\S]*?showClear/.test(productControlSource),
  'the product search can be cleared',
);
check(
  /filter=\{matchesMedicineQuery\}/.test(productControlSource),
  'the combobox filters with the shared name/generic/barcode matcher',
);
check(
  /onValueChange=\{\(option\) => \{[\s\S]*?setMedicineId\(option\?\.id \?\? ''\)/.test(
    productControlSource,
  ),
  'selecting a match records the product ID used by the receipt',
);
check(
  /No product matches/.test(productControlSource) &&
    /does not create a duplicate/.test(productControlSource),
  'no match says to add the product instead of silently creating one',
);

/* ------------------------------------------------------------ layout guards */

check(
  /<Field className="sm:col-span-2">\s*<FieldLabel htmlFor="recv-qty">/.test(routeSource),
  'the quantity field spans the full form width instead of a half-column'
);
check(
  /id="recv-qty"[\s\S]{0,500}?className="[^"]*\bmin-w-24\b[^"]*"/.test(routeSource),
  'the quantity input cannot collapse below a usable width'
);

/* ------------------------------------------------------------ what is typed */

check(normaliseQuantityTyping('') === '', 'an empty field stays empty (clearing works)');
check(normaliseQuantityTyping('1') === '1', 'one digit is kept');
check(normaliseQuantityTyping('12') === '12', 'several digits are kept');
check(normaliseQuantityTyping('05') === '5', 'a leading zero from the − button is dropped');
check(normaliseQuantityTyping('000') === '0', 'all zeros collapse to a single 0, which is refused on submit');
check(normaliseQuantityTyping('1,000') === '1000', 'a grouped delivery-note number is accepted');
check(normaliseQuantityTyping('1 000') === '1000', 'a space-grouped number is accepted');
check(normaliseQuantityTyping(' 12 ') === '12', 'surrounding space is ignored');
check(normaliseQuantityTyping('1.5') === null, 'a decimal edit is refused, not turned into 15');
check(normaliseQuantityTyping('-5') === null, 'a sign is refused, not turned into 5');
check(normaliseQuantityTyping('+5') === null, 'a plus sign is refused');
check(normaliseQuantityTyping('1e3') === null, 'scientific notation is refused, not turned into 13');
check(normaliseQuantityTyping('abc') === null, 'letters are refused');
check(normaliseQuantityTyping('500 tablets') === null, 'a pasted sentence is refused');

/* --------------------------------------------------------------- stepper */

check(nextQuantity('', 1) === '1', '+ on an empty field starts at one counted unit');
check(nextQuantity('', -1) === '', '− on an empty field cannot produce a negative count');
check(nextQuantity('0', -1) === '', '− at zero clears the field instead of showing 0');
check(nextQuantity('1', -1) === '', '− at one clears the field');
check(nextQuantity('7', 1) === '8', '+ adds exactly one counted unit');
check(nextQuantity('7', -1) === '6', '− removes exactly one counted unit');
check(nextQuantity('84', 1) === '85', '+ on a real total steps by one');
check(
  nextQuantity('2', 1) === '3',
  'a Box (100) delivery steps 2 boxes to 3 boxes, not to 102',
);
check(nextQuantity('not-a-number', 1) === '1', 'an invalid field recovers to 1, not NaN');

/* -------------------------------------------------------- what is submitted */

check(
  parseQuantityText('').ok === false && parseQuantityText('').reason === 'empty',
  'empty is refused, never read as 0',
);
check(
  parseQuantityText('   ').ok === false && parseQuantityText('   ').reason === 'empty',
  'whitespace is refused as empty',
);
check(
  parseQuantityText('0').ok === false && parseQuantityText('0').reason === 'zero',
  'zero is refused with a specific reason',
);
check(
  parseQuantityText('000').ok === false && parseQuantityText('000').reason === 'zero',
  'a padded zero is still zero',
);
check(
  parseQuantityText('1.5').ok === false && parseQuantityText('1.5').reason === 'not-whole',
  'a fractional count is refused',
);
check(
  parseQuantityText('-5').ok === false && parseQuantityText('-5').reason === 'not-whole',
  'a negative count is refused',
);
check(
  parseQuantityText('1e3').ok === false && parseQuantityText('1e3').reason === 'not-whole',
  'scientific notation is refused',
);
check(
  parseQuantityText('9007199254740993').ok === false &&
    parseQuantityText('9007199254740993').reason === 'too-large',
  'an unsafe integer is refused instead of losing precision',
);

const seven = parseQuantityText('7');
check(seven.ok && seven.value === 7, 'seven reads as seven');
const padded = parseQuantityText('007');
check(padded.ok && padded.value === 7, 'padded digits read as their value');
const grouped = parseQuantityText('1,000');
check(grouped.ok && grouped.value === 1000, 'a grouped number reads as 1000');

for (const reason of ['empty', 'not-whole', 'zero', 'too-large']) {
  check(
    typeof QUANTITY_PROBLEM[reason] === 'string' && QUANTITY_PROBLEM[reason].length > 10,
    `the ${reason} problem has a sentence for the attendant`,
  );
}

/* ---------------------------------------------------------- dropdown presets */

check(QUANTITY_PRESETS.length >= 5, 'the dropdown offers several common quantities');
check(
  QUANTITY_PRESETS.every((preset) => Number.isSafeInteger(preset) && preset > 0),
  'every preset is a positive whole count',
);
check(
  QUANTITY_PRESETS.every((preset, index) => index === 0 || preset > QUANTITY_PRESETS[index - 1]),
  'the presets are unique and ascending',
);
check(
  QUANTITY_PRESETS.every((preset) => parseQuantityText(String(preset)).ok),
  'every preset passes the same parser the typed field uses',
);
check(
  QUANTITY_PRESETS.includes(1) && QUANTITY_PRESETS.includes(10),
  'the presets cover a single unit and a typical delivery',
);
check(
  QUANTITY_PRESETS.every((preset) => normaliseQuantityTyping(String(preset)) === String(preset)),
  'selecting a preset writes a display value the field accepts unchanged',
);

/* -------------------------------------------------------- the write itself */

const seed = createSeedState();
const baseline = seed.medicines.find((m) => m.id === 'med-paracetamol');
const baselineReceipts = seed.stockReceipts.length;
const baselineBatches = baseline.batches.length;
const baselineMovements = seed.stockMovements.length;
const baselineAudit = seed.auditEvents.length;
const future = new Date();
future.setDate(future.getDate() + 30);
const expiryDate = future.toISOString().slice(0, 10);

const received = receiveStock(seed, {
  medicineId: 'med-paracetamol',
  batchNumber: ' BN-TEST-001 ',
  quantity: 7,
  unitKey: 'tablet',
  supplierId: 'sup-abc',
  expiryDate,
  costPerBaseUnit: 100,
  pricePerBaseUnit: 200,
});

check(received.ok, 'a valid receipt is booked in', received.ok ? '' : received.error);

if (received.ok) {
  const after = received.state;
  const medicine = after.medicines.find((m) => m.id === 'med-paracetamol');
  const receipt = received.value;

  check(
    medicine.totalQuantity === baseline.totalQuantity + 7,
    `stock rises by the received 7 (${baseline.totalQuantity} → ${medicine.totalQuantity})`,
  );
  check(
    medicine.batches.length === baselineBatches + 1,
    'the delivery adds one batch and leaves the existing batches in place',
  );
  check(
    medicine.batches.some((b) => b.id === 'bat-para-1' || b.batchNumber === 'BN-EMZ-2604A'),
    'the pre-existing batch is preserved',
  );
  check(after.stockReceipts.length === baselineReceipts + 1, 'one receipt is appended');
  check(after.stockMovements.length === baselineMovements + 1, 'one stock movement is appended');
  check(after.auditEvents.length === baselineAudit + 1, 'one audit event is appended');
  check(
    receipt.receivedQuantity === 7 &&
      receipt.receivedUnitKey === 'tablet' &&
      receipt.baseUnitsReceived === 7,
    'the receipt records the counted quantity and its unit',
  );
  check(receipt.batchNumber === 'BN-TEST-001', 'the batch number is stored trimmed');
  check(receipt.status === 'confirmed', 'an owner receipt with cost and price is confirmed');
  check(
    after.stockMovements[0].quantityChanged === 7 &&
      after.stockMovements[0].medicineId === 'med-paracetamol',
    'the movement carries the base units and the product',
  );
  check(
    after.auditEvents[0].action === 'stock_receipt' &&
      after.auditEvents[0].metadata.baseUnitsReceived === 7,
    'the audit row states what was received in base units',
  );
}

// Immutability: the call must not mutate the state it was handed.
check(
  seed.medicines.find((m) => m.id === 'med-paracetamol').totalQuantity === baseline.totalQuantity &&
    seed.stockReceipts.length === baselineReceipts,
  'receiving leaves the previous state untouched (pure operation)',
);

/* ------------------------------------------------- counted in a packaging unit */

const byBox = receiveStock(seed, {
  medicineId: 'med-paracetamol',
  batchNumber: 'BN-TEST-BOX',
  quantity: 2,
  unitKey: 'box',
  supplierId: 'sup-abc',
  expiryDate,
});

check(byBox.ok, 'two boxes are booked in', byBox.ok ? '' : byBox.error);
if (byBox.ok) {
  const medicine = byBox.state.medicines.find((m) => m.id === 'med-paracetamol');
  check(
    medicine.totalQuantity === baseline.totalQuantity + 200,
    'two Box (100) deliveries add 200 base units',
  );
  check(
    byBox.value.receivedQuantity === 2 &&
      byBox.value.receivedUnitName === 'Box (100)' &&
      byBox.value.receivedUnitMultiplier === 100 &&
      byBox.value.baseUnitsReceived === 200,
    'the receipt snapshots the counted unit and its multiplier',
  );
}

/* ------------------------------------------- the chosen product is the one moved */

const amoxBaseline = seed.medicines.find((m) => m.id === 'med-amoxicillin');
const paraBaseline = seed.medicines.find((m) => m.id === 'med-paracetamol');
const byAmoxicillin = receiveStock(seed, {
  medicineId: 'med-amoxicillin',
  batchNumber: 'BN-TEST-AMOX',
  quantity: 2,
  unitKey: 'pack',
  supplierId: 'sup-medplus',
  expiryDate,
});

check(
  byAmoxicillin.ok,
  'a receipt for the selected product is booked in',
  byAmoxicillin.ok ? '' : byAmoxicillin.error,
);
if (byAmoxicillin.ok) {
  const amox = byAmoxicillin.state.medicines.find((m) => m.id === 'med-amoxicillin');
  const para = byAmoxicillin.state.medicines.find((m) => m.id === 'med-paracetamol');
  check(
    amox.totalQuantity === amoxBaseline.totalQuantity + 42,
    'the selected Amoxicillin product gains its 2 Pack (21) delivery',
  );
  check(
    para.totalQuantity === paraBaseline.totalQuantity,
    'the previously viewed Paracetamol product is untouched',
  );
  check(
    byAmoxicillin.value.medicineId === 'med-amoxicillin' &&
      byAmoxicillin.value.medicineName === 'Amoxicillin Capsules',
    'the receipt keeps the selected product ID and name',
  );
}

/* ------------------------------------------------------------- an attendant */

const attendantState = { ...seed, currentUser: seed.users.find((u) => u.id === 'usr-assistant') };
const byAssistant = receiveStock(attendantState, {
  medicineId: 'med-paracetamol',
  batchNumber: 'BN-TEST-ASSIST',
  quantity: 3,
  unitKey: 'tablet',
  supplierId: 'sup-abc',
  expiryDate,
  costPerBaseUnit: 100,
  pricePerBaseUnit: 200,
});

check(byAssistant.ok, 'an attendant can receive stock', byAssistant.ok ? '' : byAssistant.error);
if (byAssistant.ok) {
  const medicine = byAssistant.state.medicines.find((m) => m.id === 'med-paracetamol');
  check(
    byAssistant.value.status === 'pending_pricing',
    'an attendant receipt goes to the pricing queue',
  );
  check(
    medicine.totalQuantity === baseline.totalQuantity + 3,
    'the stock still arrives before pricing, as before',
  );
  check(
    byAssistant.value.costPerBaseUnit === undefined,
    'an attendant cannot set the cost',
  );
}

/* -------------------------------------------- invalid counts change nothing */

const invalidCounts = [
  ['zero', 0],
  ['negative', -5],
  ['fractional', 1.5],
  ['not a number', Number.NaN],
  ['infinite', Number.POSITIVE_INFINITY],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
];

for (const [label, quantity] of invalidCounts) {
  const result = receiveStock(seed, {
    medicineId: 'med-paracetamol',
    batchNumber: 'BN-BAD',
    quantity,
    unitKey: 'tablet',
    supplierId: 'sup-abc',
    expiryDate,
  });
  check(!result.ok, `a ${label} quantity is refused`);
}

/* ------------------------------------------------------------------- report */

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');
if (failed > 0) process.exitCode = 1;
