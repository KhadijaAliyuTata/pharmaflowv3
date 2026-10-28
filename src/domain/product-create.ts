import type { PrescriptionClass } from '~/lib/db.types';
import { isoDate, money } from './money';
import type { Medicine, PrescriptionStatus } from './types';

/**
 * Creating a product from Stock Receiving.
 *
 * This module is deliberately framework-free. The receiving dialog, the demo
 * store operation and the database verification suite all use the same rules, so
 * "required field" and "that is the same product" cannot mean three different
 * things.
 *
 * A catalogue product is not a batch. The form asks for what identifies the
 * product; the delivery still supplies its own batch number, expiry and
 * quantities afterwards. Nothing here creates stock.
 */

export interface NewProductDraft {
  name: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  barcode: string;
  unitName: string;
  prescriptionClass: PrescriptionClass;
  /** Kept as typed so a partly-entered price is never rounded behind the user. */
  sellingPrice: string;
}

export interface NewProductInput {
  name: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  barcode: string | null;
  unitName: string;
  unitKey: string;
  prescriptionClass: PrescriptionClass;
  /** Per one base unit. Zero means "not priced yet". */
  sellingPrice: number;
}

export type NewProductField = keyof NewProductDraft;
export type NewProductErrors = Partial<Record<NewProductField, string>>;

export type NewProductValidation =
  | { ok: true; value: NewProductInput }
  | { ok: false; errors: NewProductErrors };

export type ProductDuplicateKind = 'barcode' | 'same_product' | 'similar';

export interface ProductDuplicate {
  medicine: Medicine;
  kind: ProductDuplicateKind;
  reason: string;
}

/** A sensible starting point for a catalogue row that has no delivery yet. */
export function defaultProductExpiryDate(): string {
  return isoDate(new Date(Date.now() + 365 * 86_400_000));
}

export function emptyNewProductDraft(name = ''): NewProductDraft {
  return {
    name,
    genericName: '',
    strength: '',
    dosageForm: '',
    barcode: '',
    unitName: '',
    // OTC is the database default, but it is shown as a field so it is a choice
    // rather than something that happened silently.
    prescriptionClass: 'otc',
    sellingPrice: '',
  };
}

/** Collapse the differences a human does not mean: case and extra spaces. */
export function normaliseProductText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/**
 * A stable identifier for one tradeable unit.
 *
 * The database requires a non-empty key and uses it in receipts and sale lines.
 * The name is what people read; the key is deliberately derived once here rather
 * than asking the user to invent an identifier.
 */
export function productUnitKey(name: string): string {
  const key = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return key || 'unit';
}

/** The label used by the existing Medicine type. */
const PRESCRIPTION_STATUS: Record<PrescriptionClass, PrescriptionStatus> = {
  otc: 'OTC',
  prescription: 'Prescription',
  controlled: 'Controlled',
};

export function prescriptionStatusForClass(value: PrescriptionClass): PrescriptionStatus {
  return PRESCRIPTION_STATUS[value];
}

export const PRESCRIPTION_CLASS_LABEL: Record<PrescriptionClass, string> = {
  otc: 'OTC (over the counter)',
  prescription: 'Prescription only',
  controlled: 'Controlled medicine',
};

function required(error: string, max: number, value: string): string | null {
  if (value.trim() === '') return error;
  if (value.trim().length > max) return `Use ${max} characters or fewer.`;
  return null;
}

/**
 * Validate a draft and produce exactly what is sent to the database.
 *
 * `sellingPrice` is optional. When it is blank the product is created unpriced
 * (zero), which is the same state as an unpriced receipt: usable in inventory,
 * visibly not ready for sale until the owner sets a price.
 */
export function validateNewProductDraft(draft: NewProductDraft): NewProductValidation {
  const errors: NewProductErrors = {};

  const nameError = required('Product name is required.', 120, draft.name);
  if (nameError) errors.name = nameError;

  const genericError = draft.genericName.trim().length > 120
    ? 'Use 120 characters or fewer.'
    : null;
  if (genericError) errors.genericName = genericError;

  const strengthError = required('Strength is required.', 60, draft.strength);
  if (strengthError) errors.strength = strengthError;

  const formError = required('Dosage form is required.', 60, draft.dosageForm);
  if (formError) errors.dosageForm = formError;

  const barcode = draft.barcode.trim();
  if (barcode.length > 64) errors.barcode = 'Use 64 characters or fewer.';

  const unitError = required('Unit of measurement is required.', 40, draft.unitName);
  if (unitError) errors.unitName = unitError;

  if (!['otc', 'prescription', 'controlled'].includes(draft.prescriptionClass)) {
    errors.prescriptionClass = 'Choose how this product may be supplied.';
  }

  let sellingPrice = 0;
  const priceText = draft.sellingPrice.trim().replace(/,/g, '');
  if (priceText !== '') {
    const parsed = Number(priceText);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.sellingPrice = 'Selling price must be zero or more.';
    } else if (money(parsed) !== parsed) {
      errors.sellingPrice = 'Selling price supports at most two decimal places.';
    } else if (parsed > 999_999_999) {
      errors.sellingPrice = 'That selling price is too large.';
    } else {
      sellingPrice = money(parsed);
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const name = draft.name.trim().replace(/\s+/g, ' ');
  const unitName = draft.unitName.trim().replace(/\s+/g, ' ');

  return {
    ok: true,
    value: {
      name,
      genericName: draft.genericName.trim().replace(/\s+/g, ' '),
      strength: draft.strength.trim().replace(/\s+/g, ' '),
      dosageForm: draft.dosageForm.trim().replace(/\s+/g, ' '),
      barcode: barcode === '' ? null : barcode,
      unitName,
      unitKey: productUnitKey(unitName),
      prescriptionClass: draft.prescriptionClass,
      sellingPrice,
    },
  };
}

type ProductIdentity = Pick<
  NewProductDraft,
  'name' | 'genericName' | 'strength' | 'dosageForm' | 'barcode'
>;

/**
 * Products that look like the one being typed.
 *
 * `same_product` and `barcode` are blocking: creating one would make two rows a
 * person cannot tell apart, or reuse a unique barcode. `similar` is shown as a
 * warning only, because two strengths or two brands sharing a generic name are
 * legitimately different products.
 */
export function findProductDuplicates(
  medicines: readonly Medicine[],
  draft: ProductIdentity,
): ProductDuplicate[] {
  const name = normaliseProductText(draft.name);
  const generic = normaliseProductText(draft.genericName);
  const strength = normaliseProductText(draft.strength);
  const form = normaliseProductText(draft.dosageForm);
  const barcode = draft.barcode.trim().toLocaleLowerCase();

  const duplicates: ProductDuplicate[] = [];

  for (const medicine of medicines) {
    const candidateBarcode = (medicine.barcode ?? '').trim().toLocaleLowerCase();
    const candidateName = normaliseProductText(medicine.name);
    const candidateGeneric = normaliseProductText(medicine.genericName);
    const candidateStrength = normaliseProductText(medicine.strength);
    const candidateForm = normaliseProductText(medicine.dosageForm);

    if (barcode !== '' && candidateBarcode === barcode) {
      duplicates.push({
        medicine,
        kind: 'barcode',
        reason: 'This barcode already belongs to another product.',
      });
      continue;
    }

    if (name !== '' && candidateName === name && candidateStrength === strength && candidateForm === form) {
      duplicates.push({
        medicine,
        kind: 'same_product',
        reason: 'The same name, strength and dosage form already exists.',
      });
      continue;
    }

    const sameGenericProduct =
      generic !== '' &&
      candidateGeneric === generic &&
      candidateStrength === strength &&
      candidateForm === form;

    if ((name !== '' && candidateName === name) || sameGenericProduct) {
      duplicates.push({
        medicine,
        kind: 'similar',
        reason: sameGenericProduct
          ? 'A product with the same generic name, strength and form already exists.'
          : 'A product with this name already exists.',
      });
    }
  }

  return duplicates;
}

export function blockingDuplicates(duplicates: readonly ProductDuplicate[]): ProductDuplicate[] {
  return duplicates.filter((entry) => entry.kind === 'barcode' || entry.kind === 'same_product');
}
