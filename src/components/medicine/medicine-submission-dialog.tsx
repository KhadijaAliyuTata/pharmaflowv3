import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  FileText,
  FlaskConical,
  Search,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Skeleton } from '~/components/ui/skeleton';
import { Textarea } from '~/components/ui/textarea';
import {
  CATALOGUE_PAGE_SIZE,
  CLINICAL_SECTION_LABEL,
  EMPTY_CATALOGUE_FILTERS,
  SOURCE_TYPE_LABEL,
  blocksSubmission,
  duplicateMatchLabel,
  emptySubmissionDraft,
  missingClinicalSections,
  todayIso,
  validateSubmissionDraft,
  type DuplicateCandidate,
  type SubmissionDraft,
  type SubmissionErrors,
  type SubmissionField,
} from '~/domain/medicine-catalogue';
import { useMedicineCatalogueSearch } from '~/hooks/use-medicine-catalogue';
import { useCurrentBranchId } from '~/lib/supabase/branch-context';
import {
  findMedicineDuplicates,
  saveMedicineSubmission,
} from '~/lib/supabase/medicine-catalogue';
import type {
  MedicineSubmissionRow,
  MedicineSourceType,
  PrescriptionClass,
} from '~/lib/db.types';
import { useSession } from '~/lib/session';
import { VerificationBadge } from '~/components/medicine/catalogue-status';

type Step = 'search' | 'form';

export interface MedicineSubmissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A draft being edited. Absent for a new submission. */
  initial?: MedicineSubmissionRow | null;
  /** The catalogue term the owner was already searching, if any. */
  initialSearch?: string;
  onSaved?: () => void;
  onOpenProduct?: (productId: string) => void;
}

/**
 * Owner-facing "Add medicine" flow.
 *
 * Step one searches the shared catalogue so the owner does not add a duplicate.
 * Step two submits a missing product with a citable source. The flow does not
 * author clinical text, does not choose a verification state, and does not make
 * anything visible in the shared verified catalogue: only a reviewer can publish.
 */
export function MedicineSubmissionDialog({
  open,
  onOpenChange,
  initial = null,
  initialSearch = '',
  onSaved,
  onOpenProduct,
}: MedicineSubmissionDialogProps) {
  const { user } = useSession();
  const branchId = useCurrentBranchId();
  const editing = Boolean(initial);
  const [step, setStep] = useState<Step>(initial ? 'form' : 'search');
  const [searchQuery, setSearchQuery] = useState('');
  const [draft, setDraft] = useState<SubmissionDraft>(() =>
    initial ? draftFromSubmission(initial) : emptySubmissionDraft(),
  );
  const [errors, setErrors] = useState<SubmissionErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [duplicateState, setDuplicateState] = useState<'idle' | 'checking' | 'done' | 'error'>(
    'idle',
  );
  const [duplicateError, setDuplicateError] = useState<string | null>(null);

  const search = useMedicineCatalogueSearch(
    { ...EMPTY_CATALOGUE_FILTERS, query: searchQuery },
    Math.min(8, CATALOGUE_PAGE_SIZE),
    open && !editing && step === 'search',
  );

  useEffect(() => {
    if (!open) return;
    setStep(initial ? 'form' : 'search');
    setSearchQuery(initialSearch.trim());
    setDraft(initial ? draftFromSubmission(initial) : emptySubmissionDraft());
    setErrors({});
    setFormError(null);
    setSaving(false);
    setDuplicates([]);
    setDuplicateState('idle');
    setDuplicateError(null);
  }, [open, initial, initialSearch]);

  // A duplicate result belongs to the identity that produced it. Once that
  // identity changes, showing the old result would be worse than showing none.
  useEffect(() => {
    setDuplicates([]);
    setDuplicateState('idle');
    setDuplicateError(null);
  }, [
    draft.genericName,
    draft.brandName,
    draft.strength,
    draft.dosageForm,
    draft.route,
    draft.manufacturer,
    draft.nafdacRegNumber,
  ]);

  const missing = useMemo(() => missingClinicalSections(draft), [draft]);
  const exactDuplicate = duplicates.find((candidate) => blocksSubmission(candidate.matchScore)) ?? null;
  const possibleDuplicates = duplicates.filter((candidate) => !blocksSubmission(candidate.matchScore));
  const canSave = Boolean(user && branchId);

  function update<K extends keyof SubmissionDraft>(key: K, value: SubmissionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[errorFieldFor(key)];
      delete next.identity;
      return next;
    });
    setFormError(null);
  }

  async function checkDuplicates(): Promise<DuplicateCandidate[] | null> {
    setDuplicateState('checking');
    setDuplicateError(null);
    const result = await findMedicineDuplicates(draft);
    if (!result.ok) {
      setDuplicateState('error');
      setDuplicateError('Duplicates could not be checked. Try again before submitting.');
      return null;
    }
    setDuplicates(result.data);
    setDuplicateState('done');
    return result.data;
  }

  async function handleSave(intent: 'draft' | 'submitted') {
    const validation = validateSubmissionDraft(draft, intent);
    setErrors(validation.errors);
    setFormError(null);

    if (!validation.valid) {
      setFormError('Check the highlighted fields before continuing.');
      return;
    }

    // Disable the footer before the duplicate round-trip, not just before the
    // write. Otherwise a second click while the duplicate check is in flight
    // can create two submissions.
    setSaving(true);
    try {
      if (intent === 'submitted') {
        const candidates = await checkDuplicates();
        if (candidates === null) return;
        if (candidates.some((candidate) => blocksSubmission(candidate.matchScore))) {
          setFormError(
            'This looks like an exact duplicate. Open the existing shared record instead, or correct its identity before submitting.',
          );
          return;
        }
      }

      if (!user || !branchId) {
        setFormError('Your branch or session is not ready. Reload and try again.');
        return;
      }

      const result = await saveMedicineSubmission({
        submissionId: initial?.id ?? null,
        branchId,
        userId: user.id,
        draft,
        intent,
      });

      if (!result.ok) {
        setFormError(result.error);
        return;
      }

      toast.success(
        intent === 'submitted'
          ? 'Submitted for clinical review. Nothing has been published yet.'
          : 'Draft saved. You can finish it later.',
      );
      onSaved?.();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  function chooseExisting(productId: string) {
    onOpenProduct?.(productId);
    onOpenChange(false);
  }

  /**
   * Carry the search term into the identity field. It is only a starting point:
   * it may be a brand, a generic or a NAFDAC number, and the owner still has to
   * fill the structured fields. Nothing is submitted from the search term alone.
   */
  function startMissingMedicine() {
    const term = searchQuery.trim();
    if (term && !draft.productName.trim()) {
      setDraft((current) => ({ ...current, productName: term }));
    }
    setStep('form');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit draft submission' : 'Add a medicine'}</DialogTitle>
          <DialogDescription>
            {step === 'search'
              ? 'Search the shared catalogue first. Adding a duplicate splits the evidence and makes both records harder to trust.'
              : 'Your record stays a tenant submission until a clinical reviewer accepts it. No clinical content is published automatically.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'search' ? (
          <div className="space-y-4">
            <InputGroup>
              <InputGroupAddon>
                <Search className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Generic, brand, NAFDAC number or ingredient"
                aria-label="Search the shared catalogue before adding a medicine"
                autoFocus
              />
            </InputGroup>

            {search.loading ? (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : search.error ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                {search.error}
              </p>
            ) : searchQuery.trim().length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Search by generic or brand name, or by the NAFDAC registration number. If the
                product is already in the shared catalogue, open that record instead of adding a
                second one.
              </p>
            ) : search.items.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-sm">
                <p className="font-medium">No shared record matches.</p>
                <p className="mt-1 text-muted-foreground">
                  That does not prove the product is missing — the catalogue may not have it yet.
                  Continue only if the identity is clearly different from every result.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {search.items.map((product) => (
                  <li key={product.id}>
                    <button
                      type="button"
                      className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => chooseExisting(product.id)}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{product.productName}</p>
                          <p className="text-xs text-muted-foreground">
                            {product.genericName} · {product.strength || 'Strength not recorded'} ·{' '}
                            {product.dosageForm || 'Form not recorded'} ·{' '}
                            {product.route || 'Route not recorded'}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <VerificationBadge status={product.verificationStatus} />
                          {product.nafdacRegNumber && (
                            <Badge variant="outline">{product.nafdacRegNumber}</Badge>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="rounded-lg border border-info-border bg-info-subtle/50 p-3 text-sm">
              <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-info" />
                <span>
                  If a result is the same product, open it. If the product truly is missing, you
                  can submit it with a citable source. You cannot publish it directly.
                </span>
              </p>
            </div>
          </div>
        ) : (
          <fieldset disabled={saving} className="min-w-0 space-y-5 border-0 p-0">
            {formError && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
              >
                <p className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <span>{formError}</span>
                </p>
              </div>
            )}

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Product identity</h3>
                <p className="text-xs text-muted-foreground">
                  Use the label as printed. “Not applicable” is a valid value where a field
                  genuinely does not apply.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField
                  id="submission-generic"
                  label="Generic name"
                  required
                  error={errors.genericName}
                >
                  <Input
                    id="submission-generic"
                    value={draft.genericName}
                    onChange={(event) => update('genericName', event.target.value)}
                    placeholder="e.g. paracetamol"
                    aria-invalid={Boolean(errors.genericName)}
                  />
                </FormField>
                <FormField
                  id="submission-product"
                  label="Product / brand name"
                  required
                  error={errors.productName}
                >
                  <Input
                    id="submission-product"
                    value={draft.productName}
                    onChange={(event) => update('productName', event.target.value)}
                    placeholder="e.g. Panadol"
                    aria-invalid={Boolean(errors.productName)}
                  />
                </FormField>
                <FormField id="submission-brand" label="Brand name (if separate)">
                  <Input
                    id="submission-brand"
                    value={draft.brandName}
                    onChange={(event) => update('brandName', event.target.value)}
                  />
                </FormField>
                <FormField
                  id="submission-strength"
                  label="Strength"
                  required
                  error={errors.strength}
                >
                  <Input
                    id="submission-strength"
                    value={draft.strength}
                    onChange={(event) => update('strength', event.target.value)}
                    placeholder="e.g. 500 mg"
                    aria-invalid={Boolean(errors.strength)}
                  />
                </FormField>
                <FormField
                  id="submission-form"
                  label="Dosage form"
                  required
                  error={errors.dosageForm}
                >
                  <Input
                    id="submission-form"
                    value={draft.dosageForm}
                    onChange={(event) => update('dosageForm', event.target.value)}
                    placeholder="e.g. tablet"
                    aria-invalid={Boolean(errors.dosageForm)}
                  />
                </FormField>
                <FormField id="submission-route" label="Route" required error={errors.route}>
                  <Input
                    id="submission-route"
                    value={draft.route}
                    onChange={(event) => update('route', event.target.value)}
                    placeholder="e.g. oral"
                    aria-invalid={Boolean(errors.route)}
                  />
                </FormField>
                <FormField id="submission-pack" label="Pack size">
                  <Input
                    id="submission-pack"
                    value={draft.packSize}
                    onChange={(event) => update('packSize', event.target.value)}
                    placeholder="e.g. 10 tablets"
                  />
                </FormField>
                <FormField id="submission-category" label="Category">
                  <Input
                    id="submission-category"
                    value={draft.category}
                    onChange={(event) => update('category', event.target.value)}
                    placeholder="e.g. analgesic"
                  />
                </FormField>
                <FormField
                  id="submission-prescription"
                  label="Prescription class"
                  required
                  error={errors.prescriptionClass}
                >
                  <Select
                    value={draft.prescriptionClass || null}
                    onValueChange={(value) =>
                      update('prescriptionClass', (value ?? '') as '' | PrescriptionClass)
                    }
                  >
                    <SelectTrigger
                      id="submission-prescription"
                      className="w-full"
                      aria-invalid={Boolean(errors.prescriptionClass)}
                    >
                      <SelectValue placeholder="Choose a class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="otc">OTC</SelectItem>
                      <SelectItem value="prescription">Prescription</SelectItem>
                      <SelectItem value="controlled">Controlled</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField id="submission-nafdac" label="NAFDAC registration number">
                  <Input
                    id="submission-nafdac"
                    value={draft.nafdacRegNumber}
                    onChange={(event) => update('nafdacRegNumber', event.target.value)}
                    placeholder="Only if printed on the product"
                  />
                </FormField>
                <FormField id="submission-manufacturer" label="Manufacturer">
                  <Input
                    id="submission-manufacturer"
                    value={draft.manufacturer}
                    onChange={(event) => update('manufacturer', event.target.value)}
                  />
                </FormField>
                <FormField
                  id="submission-mah"
                  label="Marketing authorisation holder"
                  className="sm:col-span-2"
                >
                  <Input
                    id="submission-mah"
                    value={draft.marketingAuthorisationHolder}
                    onChange={(event) =>
                      update('marketingAuthorisationHolder', event.target.value)
                    }
                  />
                </FormField>
              </div>
              <p className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Registration starts <strong>unverified</strong>. Entering a NAFDAC number does
                  not verify it; a reviewer must check a regulator source.
                </span>
              </p>
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Source and evidence</h3>
                <p className="text-xs text-muted-foreground">
                  A source another person can check is required before review. File upload is not
                  available yet; use a public URL or a precise document reference.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField
                  id="submission-source-type"
                  label="Source type"
                  required
                  error={errors.sourceType}
                >
                  <Select
                    value={draft.sourceType || null}
                    onValueChange={(value) =>
                      update('sourceType', (value ?? '') as '' | MedicineSourceType)
                    }
                  >
                    <SelectTrigger
                      id="submission-source-type"
                      className="w-full"
                      aria-invalid={Boolean(errors.sourceType)}
                    >
                      <SelectValue placeholder="Choose a source type" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(SOURCE_TYPE_LABEL).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField
                  id="submission-source-date"
                  label="Retrieved on"
                  required
                  error={errors.sourceRetrievedAt}
                  hint="The date you actually checked this source."
                >
                  <Input
                    id="submission-source-date"
                    type="date"
                    value={draft.sourceRetrievedAt}
                    max={todayIso()}
                    onChange={(event) => update('sourceRetrievedAt', event.target.value)}
                    aria-invalid={Boolean(errors.sourceRetrievedAt)}
                  />
                </FormField>
                <FormField
                  id="submission-source-title"
                  label="Source title"
                  required
                  error={errors.sourceTitle}
                  className="sm:col-span-2"
                >
                  <Input
                    id="submission-source-title"
                    value={draft.sourceTitle}
                    onChange={(event) => update('sourceTitle', event.target.value)}
                    placeholder="e.g. NAFDAC Greenbook entry, or the product label"
                    aria-invalid={Boolean(errors.sourceTitle)}
                  />
                </FormField>
                <FormField
                  id="submission-source-url"
                  label="Source URL"
                  error={errors.sourceUrl}
                  hint="http(s) only."
                >
                  <Input
                    id="submission-source-url"
                    value={draft.sourceUrl}
                    onChange={(event) => update('sourceUrl', event.target.value)}
                    placeholder="https://…"
                    inputMode="url"
                    aria-invalid={Boolean(errors.sourceUrl)}
                  />
                </FormField>
                <FormField
                  id="submission-source-doc"
                  label="Document reference"
                  error={errors.sourceReference}
                  hint="Use this when the source is not a web page."
                >
                  <Input
                    id="submission-source-doc"
                    value={draft.sourceDocumentReference}
                    onChange={(event) =>
                      update('sourceDocumentReference', event.target.value)
                    }
                    placeholder="e.g. label batch 24A, section 3"
                    aria-invalid={Boolean(errors.sourceReference)}
                  />
                </FormField>
              </div>
              <FormField id="submission-notes" label="Notes for the reviewer">
                <Textarea
                  id="submission-notes"
                  value={draft.notes}
                  onChange={(event) => update('notes', event.target.value)}
                  placeholder="Anything the reviewer needs to know about this product or source. Do not enter patient information."
                  rows={3}
                />
              </FormField>
            </section>

            <section className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <p className="font-medium">Clinical content is not included in this submission.</p>
                  <p className="mt-1 text-muted-foreground">
                    A reviewer must add and verify these before the record can be used clinically:
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {missing.map((section) => (
                      <Badge key={section} variant="outline">
                        {CLINICAL_SECTION_LABEL[section]}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>

              {duplicateState === 'checking' && (
                <p className="text-xs text-muted-foreground">Checking for duplicates…</p>
              )}
              {duplicateError && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
                  {duplicateError}
                </p>
              )}
              {exactDuplicate && (
                <DuplicateList
                  title="Exact duplicate found — submission blocked"
                  tone="destructive"
                  candidates={[exactDuplicate]}
                  onOpen={chooseExisting}
                />
              )}
              {possibleDuplicates.length > 0 && (
                <DuplicateList
                  title="Possible matches — check before submitting"
                  tone="warning"
                  candidates={possibleDuplicates}
                  onOpen={chooseExisting}
                />
              )}
              {duplicateState === 'done' && duplicates.length === 0 && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Check className="size-3.5" />
                  No duplicate candidate found for this identity.
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void checkDuplicates()}
                disabled={!draft.genericName.trim() || duplicateState === 'checking'}
              >
                <FlaskConical />
                Check for duplicates
              </Button>
            </section>
          </fieldset>
        )}

        <DialogFooter className="flex-wrap">
          {step === 'search' ? (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button onClick={startMissingMedicine}>
                <FileText />
                None of these — add a missing medicine
              </Button>
            </>
          ) : (
            <>
              {!editing && (
                <Button
                  variant="ghost"
                  onClick={() => setStep('search')}
                  disabled={saving}
                >
                  <ArrowLeft />
                  Back to search
                </Button>
              )}
              <DialogClose render={<Button variant="outline" />} disabled={saving}>
                Cancel
              </DialogClose>
              <Button
                variant="outline"
                onClick={() => void handleSave('draft')}
                disabled={saving || !canSave}
              >
                {saving ? 'Saving…' : 'Save draft'}
              </Button>
              <Button
                onClick={() => void handleSave('submitted')}
                disabled={saving || !canSave || Boolean(exactDuplicate)}
              >
                {saving ? 'Saving…' : 'Submit for review'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateList({
  title,
  tone,
  candidates,
  onOpen,
}: {
  title: string;
  tone: 'warning' | 'destructive';
  candidates: DuplicateCandidate[];
  onOpen: (id: string) => void;
}) {
  return (
    <div
      className={
        tone === 'destructive'
          ? 'rounded-lg border border-destructive/40 bg-destructive/5 p-3'
          : 'rounded-lg border border-warning-border bg-warning-subtle p-3'
      }
    >
      <p className="text-xs font-medium">{title}</p>
      <ul className="mt-2 space-y-2">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">{candidate.productName}</p>
              <p className="text-xs text-muted-foreground">
                {candidate.genericName} · {candidate.strength} · {candidate.dosageForm} ·{' '}
                {duplicateMatchLabel(candidate.matchScore)}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpen(candidate.id)}>
              Open record
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function draftFromSubmission(row: MedicineSubmissionRow): SubmissionDraft {
  return {
    genericName: row.generic_name ?? '',
    brandName: row.brand_name ?? '',
    productName: row.product_name ?? '',
    strength: row.strength_text ?? '',
    dosageForm: row.dosage_form ?? '',
    route: row.route ?? '',
    packSize: row.pack_size ?? '',
    manufacturer: row.manufacturer ?? '',
    marketingAuthorisationHolder: row.marketing_authorisation_holder ?? '',
    nafdacRegNumber: row.nafdac_reg_number ?? '',
    category: row.category ?? '',
    prescriptionClass: row.prescription_class ?? '',
    sourceType: row.source_type ?? '',
    sourceTitle: row.source_title ?? '',
    sourceUrl: row.source_url ?? '',
    sourceDocumentReference: row.source_document_reference ?? '',
    sourceRetrievedAt: row.source_retrieved_at ?? '',
    notes: row.notes ?? '',
  };
}

function errorFieldFor(key: keyof SubmissionDraft): SubmissionField {
  switch (key) {
    case 'genericName':
    case 'productName':
    case 'strength':
    case 'dosageForm':
    case 'route':
    case 'prescriptionClass':
    case 'sourceType':
    case 'sourceTitle':
    case 'sourceUrl':
    case 'sourceRetrievedAt':
      return key;
    case 'sourceDocumentReference':
      return 'sourceReference';
    default:
      return 'identity';
  }
}

function FormField({
  id,
  label,
  required = false,
  error,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <Label htmlFor={id} className="text-xs">
        {label}
        {required && (
          <span className="text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
