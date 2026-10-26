import type { Medicine } from '~/domain/types';

/**
 * What the product picker matches on.
 *
 * An attendant usually knows the name on the pack, but sometimes only the
 * generic name or the barcode. Keeping all three in one lowercase string means
 * the search does not quietly become name-only when the label happens to differ
 * from the catalogue entry.
 */
function searchableText(medicine: Medicine): string {
  return [
    medicine.name,
    medicine.genericName,
    medicine.strength,
    medicine.barcode ?? '',
  ]
    .join(' ')
    .toLocaleLowerCase();
}

/** True when the query is empty or appears anywhere in the product's searchable text. */
export function matchesMedicineQuery(medicine: Medicine, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle === '' || searchableText(medicine).includes(needle);
}

/**
 * The value shown once a product is chosen.
 *
 * The strength is what separates two packs with the same product name, so it
 * belongs in the selected label, not only in the dropdown row.
 */
export function medicineLabel(medicine: Medicine): string {
  return `${medicine.name} · ${medicine.strength}`;
}
