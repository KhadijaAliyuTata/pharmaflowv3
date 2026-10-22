import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Skeleton } from '~/components/ui/skeleton';
import { SectionTitle } from '~/components/app/primitives';
import { MedicineCatalogueDetail } from '~/components/medicine/medicine-catalogue-detail';
import { MedicineSubmissionDialog } from '~/components/medicine/medicine-submission-dialog';
import { MedicineSubmissionList } from '~/components/medicine/medicine-submission-list';
import {
  RegistrationBadge,
  VerificationBadge,
} from '~/components/medicine/catalogue-status';
import {
  EMPTY_CATALOGUE_FILTERS,
  cataloguePageBounds,
  displayOrNotRecorded,
  type CatalogueFilters,
} from '~/domain/medicine-catalogue';
import { useCanReviewClinical, useMedicineCatalogueSearch } from '~/hooks/use-medicine-catalogue';
import type { MedicineSubmissionRow, PrescriptionClass } from '~/lib/db.types';

/**
 * Shared catalogue browse/search/detail.
 *
 * The left column is a server-paged list; the right is one product's dossier.
 * No request fetches the whole catalogue, and no result is rendered from seed
 * data in live mode.
 */
export function MedicineCataloguePanel() {
  const canReview = useCanReviewClinical();
  const [query, setQuery] = useState('');
  const [verification, setVerification] = useState<'all' | 'verified' | 'outdated'>('all');
  const [prescriptionClass, setPrescriptionClass] = useState<'all' | PrescriptionClass>('all');
  const [dosageForm, setDosageForm] = useState('');
  const [strength, setStrength] = useState('');
  const [route, setRoute] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MedicineSubmissionRow | null>(null);
  const [submissionRefresh, setSubmissionRefresh] = useState(0);

  const filters = useMemo<CatalogueFilters>(
    () => ({
      ...EMPTY_CATALOGUE_FILTERS,
      query,
      verification: verification === 'all' ? '' : verification,
      prescriptionClass: prescriptionClass === 'all' ? '' : prescriptionClass,
      dosageForm,
      strength,
      route,
      category,
      page,
    }),
    [query, verification, prescriptionClass, dosageForm, strength, route, category, page],
  );

  const search = useMedicineCatalogueSearch(filters);
  const bounds = cataloguePageBounds(search.page, search.total, search.pageSize);
  const hasFilters =
    query.trim().length > 0 ||
    verification !== 'all' ||
    prescriptionClass !== 'all' ||
    dosageForm.trim().length > 0 ||
    strength.trim().length > 0 ||
    route.trim().length > 0 ||
    category.trim().length > 0;

  // A filter change is a new search. Staying on page 7 of the previous result
  // would usually show an empty page and look like a failed search, and keeping
  // the old detail open under a new query would show a record that is no longer
  // in the result set.
  useEffect(() => {
    setPage(1);
    setSelectedId(null);
  }, [query, verification, prescriptionClass, dosageForm, strength, route, category]);

  function clearFilters() {
    setQuery('');
    setVerification('all');
    setPrescriptionClass('all');
    setDosageForm('');
    setStrength('');
    setRoute('');
    setCategory('');
    setPage(1);
  }

  function openAddDialog() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openSubmission(submission: MedicineSubmissionRow) {
    setEditing(submission);
    setDialogOpen(true);
  }

  function handleDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) setEditing(null);
  }

  function handleSaved() {
    search.refresh();
    setSubmissionRefresh((value) => value + 1);
  }

  function openProduct(productId: string) {
    setSelectedId(productId);
  }

  return (
    <div className="space-y-4">
      <Card className="border-warning-border bg-warning-subtle/40">
        <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-2 text-sm">
            <BookOpen className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="space-y-1">
              <p className="font-medium">Professional reference, not a prescription</p>
              <p className="text-muted-foreground">
                Only verified or outdated shared records are listed. Unverified fields stay
                labelled. Do not generate a patient-specific dose or treat AI-generated text as
                verified; a named clinical reviewer must approve clinical content.
              </p>
            </div>
          </div>
          {canReview && (
            <Button className="shrink-0" onClick={openAddDialog}>
              <Plus />
              Add medicine
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
        <div className="space-y-3">
          <InputGroup>
            <InputGroupAddon>
              <Search className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, generic, NAFDAC or ingredient"
              aria-label="Search the shared medicine catalogue"
            />
          </InputGroup>

          <div className="grid grid-cols-2 gap-2">
            <Select
              value={verification}
              onValueChange={(value) =>
                setVerification((value ?? 'all') as 'all' | 'verified' | 'outdated')
              }
            >
              <SelectTrigger size="sm" aria-label="Filter by clinical review status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All review states</SelectItem>
                <SelectItem value="verified">Verified</SelectItem>
                <SelectItem value="outdated">Outdated</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={prescriptionClass}
              onValueChange={(value) =>
                setPrescriptionClass((value ?? 'all') as 'all' | PrescriptionClass)
              }
            >
              <SelectTrigger size="sm" aria-label="Filter by prescription class">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All classes</SelectItem>
                <SelectItem value="otc">OTC</SelectItem>
                <SelectItem value="prescription">Prescription</SelectItem>
                <SelectItem value="controlled">Controlled</SelectItem>
              </SelectContent>
            </Select>

            <Input
              value={dosageForm}
              onChange={(event) => setDosageForm(event.target.value)}
              placeholder="Form"
              aria-label="Filter by dosage form"
            />
            <Input
              value={route}
              onChange={(event) => setRoute(event.target.value)}
              placeholder="Route"
              aria-label="Filter by route"
            />
            <Input
              value={strength}
              onChange={(event) => setStrength(event.target.value)}
              placeholder="Strength"
              aria-label="Filter by strength"
            />
            <Input
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Category"
              aria-label="Filter by category"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SlidersHorizontal className="size-3.5" />
              {hasFilters ? 'Filters applied' : 'Showing verified and outdated records'}
            </p>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear
              </Button>
            )}
          </div>

          <Card className="overflow-hidden">
            <CardHeader className="border-b pb-2">
              <SectionTitle
                action={
                  <Button variant="ghost" size="sm" onClick={search.refresh} disabled={search.loading}>
                    <RefreshCw />
                    <span className="sr-only">Refresh results</span>
                  </Button>
                }
              >
                Results
              </SectionTitle>
              <p className="text-xs text-muted-foreground">
                Shared catalogue · verified by a named reviewer
              </p>
            </CardHeader>
            <CardContent className="p-2">
              {search.loading ? (
                <div className="space-y-1.5 p-1">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-16 w-full" />
                  ))}
                </div>
              ) : search.error ? (
                <div className="space-y-2 p-3">
                  <p className="flex items-start gap-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    {search.error}
                  </p>
                  <Button variant="outline" size="sm" onClick={search.refresh}>
                    Try again
                  </Button>
                </div>
              ) : search.items.length === 0 ? (
                <div className="space-y-2 p-4 text-center">
                  <FlaskConical className="mx-auto size-6 text-muted-foreground" />
                  <p className="text-sm font-medium">No shared record matches.</p>
                  <p className="text-xs text-muted-foreground">
                    Try a generic name, a brand, or a NAFDAC number. A missing result does not
                    prove the product is unregistered.
                  </p>
                  {canReview && (
                    <Button variant="outline" size="sm" onClick={openAddDialog}>
                      <Plus />
                      Add a missing medicine
                    </Button>
                  )}
                </div>
              ) : (
                <ul className="max-h-[34rem] space-y-1 overflow-y-auto">
                  {search.items.map((product) => {
                    const active = product.id === selectedId;
                    return (
                      <li key={product.id}>
                        <button
                          type="button"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => setSelectedId(product.id)}
                          className={`w-full rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            active ? 'bg-muted' : 'hover:bg-muted/60'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{product.productName}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {product.genericName} · {displayOrNotRecorded(product.strength)}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {[product.dosageForm, product.route, product.category]
                                  .filter(Boolean)
                                  .join(' · ') || 'Form not recorded'}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <VerificationBadge status={product.verificationStatus} />
                              <RegistrationBadge status={product.registrationStatus} />
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!search.loading && !search.error && search.total > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t px-2 pt-2">
                  <p className="text-xs text-muted-foreground">
                    Showing {bounds.from}–{bounds.to} of {bounds.total}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Previous page"
                      disabled={!bounds.hasPrevious}
                      onClick={() => {
                        setSelectedId(null);
                        setPage((value) => Math.max(1, value - 1));
                      }}
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Next page"
                      disabled={!bounds.hasNext}
                      onClick={() => {
                        setSelectedId(null);
                        setPage((value) => value + 1);
                      }}
                    >
                      <ChevronRight />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {!canReview && (
            <p className="flex items-start gap-1.5 px-1 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              Only an owner or an authorised clinical reviewer can add a shared medicine record.
              You can still use this reference catalogue.
            </p>
          )}
        </div>

        <div className="min-w-0">
          {selectedId ? (
            <MedicineCatalogueDetail productId={selectedId} />
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <FlaskConical className="mx-auto size-7 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">No medicine selected</p>
                <p className="text-xs text-muted-foreground">
                  Search the shared catalogue, then open a record to see its sources and
                  verification state.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">Shared catalogue</Badge>
        <p className="text-xs text-muted-foreground">
          Separate from this pharmacy’s inventory, prices and batches. The “My pharmacy” tab holds
          local stock records.
        </p>
      </div>

      {canReview && (
        <MedicineSubmissionList
          key={submissionRefresh}
          onEdit={openSubmission}
          onOpenProduct={openProduct}
        />
      )}

      <MedicineSubmissionDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        initial={editing}
        initialSearch={query}
        onSaved={handleSaved}
        onOpenProduct={openProduct}
      />
    </div>
  );
}
