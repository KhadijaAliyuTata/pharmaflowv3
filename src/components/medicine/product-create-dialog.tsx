import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { medicineLabel } from '~/domain/medicine-search';
import {
  blockingDuplicates,
  emptyNewProductDraft,
  findProductDuplicates,
  PRESCRIPTION_CLASS_LABEL,
  validateNewProductDraft,
  type NewProductDraft,
  type NewProductErrors,
  type NewProductInput,
} from '~/domain/product-create';
import type { Medicine } from '~/domain/types';
import type { PrescriptionClass } from '~/lib/db.types';

export type ProductCreateOutcome =
  | { ok: true; medicine: Medicine }
  | { ok: false; error: string };

interface ProductCreateDialogProps {
  open: boolean;
  initialName: string;
  existing: readonly Medicine[];
  canPrice: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: NewProductInput) => Promise<ProductCreateOutcome>;
  onCreated: (medicine: Medicine) => void;
}

/**
 * Create a catalogue product without leaving Stock Receiving.
 *
 * The dialog owns the draft so a refused save leaves every field exactly as the
 * user typed it. It does not own persistence: the route chooses the live RPC or
 * the demo operation, and both return the saved `Medicine` that must be selected
 * before any receipt can be submitted.
 */
export function ProductCreateDialog({
  open,
  initialName,
  existing,
  canPrice,
  onOpenChange,
  onSubmit,
  onCreated,
}: ProductCreateDialogProps) {
  const [draft, setDraft] = useState<NewProductDraft>(() => emptyNewProductDraft(initialName));
  const [errors, setErrors] = useState<NewProductErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    // Reset only on opening, not on every render. A failed save must survive.
    if (open && !wasOpen.current) {
      setDraft(emptyNewProductDraft(initialName));
      setErrors({});
      setFormError(null);
      setSaving(false);
    }
    wasOpen.current = open;
  }, [open, initialName]);

  const duplicates = useMemo(() => findProductDuplicates(existing, draft), [existing, draft]);
  const blocking = blockingDuplicates(duplicates);
  const similar = duplicates.filter((entry) => entry.kind === 'similar');

  function update<K extends keyof NewProductDraft>(key: K, value: NewProductDraft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setFormError(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const checked = validateNewProductDraft(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});

    const firstBlocking = blocking[0];
    if (firstBlocking) {
      setFormError(
        `${firstBlocking.medicine.name} · ${firstBlocking.medicine.strength} already exists. Select it from the product search instead.`,
      );
      return;
    }

    setSaving(true);
    try {
      const result = await onSubmit(checked.value);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      onCreated(result.medicine);
      onOpenChange(false);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'The product could not be saved. Check your connection and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  const unit = draft.unitName.trim() || 'unit';

  return (
    <Dialog open={open} onOpenChange={(next) => (!saving || next ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-4" />
            Add a new product
          </DialogTitle>
          <DialogDescription>
            This adds the product to your pharmacy catalogue. It does not receive stock; the
            quantity, batch and expiry below still create the delivery.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="new-product-name">Product name</FieldLabel>
              <Input
                id="new-product-name"
                value={draft.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="e.g. Paracetamol Tablets"
                autoComplete="off"
                maxLength={120}
                aria-invalid={Boolean(errors.name)}
              />
              {errors.name && <FieldError>{errors.name}</FieldError>}
            </Field>

            <Field>
              <FieldLabel htmlFor="new-product-generic">
                Generic name <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input
                id="new-product-generic"
                value={draft.genericName}
                onChange={(event) => update('genericName', event.target.value)}
                placeholder="e.g. Paracetamol"
                autoComplete="off"
                maxLength={120}
                aria-invalid={Boolean(errors.genericName)}
              />
              {errors.genericName && <FieldError>{errors.genericName}</FieldError>}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="new-product-strength">Strength</FieldLabel>
                <Input
                  id="new-product-strength"
                  value={draft.strength}
                  onChange={(event) => update('strength', event.target.value)}
                  placeholder="e.g. 500mg"
                  autoComplete="off"
                  maxLength={60}
                  aria-invalid={Boolean(errors.strength)}
                />
                {errors.strength && <FieldError>{errors.strength}</FieldError>}
              </Field>

              <Field>
                <FieldLabel htmlFor="new-product-form">Dosage form</FieldLabel>
                <Input
                  id="new-product-form"
                  value={draft.dosageForm}
                  onChange={(event) => update('dosageForm', event.target.value)}
                  placeholder="e.g. Tablet"
                  autoComplete="off"
                  maxLength={60}
                  aria-invalid={Boolean(errors.dosageForm)}
                />
                {errors.dosageForm && <FieldError>{errors.dosageForm}</FieldError>}
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="new-product-unit">Unit of measurement</FieldLabel>
                <Input
                  id="new-product-unit"
                  value={draft.unitName}
                  onChange={(event) => update('unitName', event.target.value)}
                  placeholder="e.g. Tablet"
                  autoComplete="off"
                  maxLength={40}
                  aria-invalid={Boolean(errors.unitName)}
                />
                {errors.unitName && <FieldError>{errors.unitName}</FieldError>}
              </Field>

              <Field>
                <FieldLabel htmlFor="new-product-class">Prescription class</FieldLabel>
                <Select
                  // Base UI needs the value/label map to render the friendly
                  // label for a programmatically chosen class.
                  items={(Object.keys(PRESCRIPTION_CLASS_LABEL) as PrescriptionClass[]).map(
                    (value) => ({ value, label: PRESCRIPTION_CLASS_LABEL[value] }),
                  )}
                  value={draft.prescriptionClass}
                  onValueChange={(value) =>
                    update('prescriptionClass', (value ?? 'otc') as PrescriptionClass)
                  }
                >
                  <SelectTrigger id="new-product-class" className="w-full" aria-label="Prescription class">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PRESCRIPTION_CLASS_LABEL) as PrescriptionClass[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {PRESCRIPTION_CLASS_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.prescriptionClass && <FieldError>{errors.prescriptionClass}</FieldError>}
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="new-product-barcode">
                  Barcode <span className="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Input
                  id="new-product-barcode"
                  value={draft.barcode}
                  onChange={(event) => update('barcode', event.target.value)}
                  placeholder="Scan or type"
                  autoComplete="off"
                  maxLength={64}
                  aria-invalid={Boolean(errors.barcode)}
                />
                {errors.barcode && <FieldError>{errors.barcode}</FieldError>}
              </Field>

              {canPrice && (
                <Field>
                  <FieldLabel htmlFor="new-product-price">
                    Selling price per {unit}{' '}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </FieldLabel>
                  <Input
                    id="new-product-price"
                    value={draft.sellingPrice}
                    onChange={(event) => update('sellingPrice', event.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-invalid={Boolean(errors.sellingPrice)}
                  />
                  {errors.sellingPrice && <FieldError>{errors.sellingPrice}</FieldError>}
                </Field>
              )}
            </div>

            {blocking.length > 0 && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>This product already exists</AlertTitle>
                <AlertDescription>
                  {blocking.slice(0, 3).map((entry) => (
                    <p key={entry.medicine.id}>
                      {medicineLabel(entry.medicine)} — {entry.reason} Select it from the product
                      search instead.
                    </p>
                  ))}
                </AlertDescription>
              </Alert>
            )}

            {blocking.length === 0 && similar.length > 0 && (
              <Alert>
                <TriangleAlert />
                <AlertTitle>Check for a duplicate</AlertTitle>
                <AlertDescription>
                  {similar.slice(0, 3).map((entry) => (
                    <p key={entry.medicine.id}>
                      {medicineLabel(entry.medicine)} — {entry.reason}
                    </p>
                  ))}
                  {similar.length > 3 && <p>And {similar.length - 3} more similar products.</p>}
                </AlertDescription>
              </Alert>
            )}

            {formError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Could not add the product</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || blocking.length > 0}>
              {saving ? <Loader2 className="animate-spin" /> : <Plus />}
              {saving ? 'Saving…' : 'Add product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
