import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  BookOpen,
  CircleSlash,
  ExternalLink,
  Info,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import {
  RegistrationBadge,
  SectionStatusBadge,
  VerificationBadge,
} from '~/components/medicine/catalogue-status';
import { SectionTitle } from '~/components/app/primitives';
import {
  CLINICAL_SECTION_LABEL,
  CLINICAL_SECTION_ORDER,
  FOOD_INSTRUCTION_LABEL,
  SOURCE_TYPE_LABEL,
  displayOrNotEstablished,
  displayOrNotRecorded,
  isVerifiedStatus,
  safeExternalUrl,
} from '~/domain/medicine-catalogue';
import { formatDate } from '~/domain/money';
import {
  useCanReviewClinical,
  useMedicineProduct,
} from '~/hooks/use-medicine-catalogue';
import type {
  MedicineClinicalSectionRow,
  MedicineDosageRow,
  MedicineSourceRow,
} from '~/lib/db.types';

/**
 * One shared catalogue dossier.
 *
 * Warnings and verification state come before any clinical text. A reader must
 * be able to see that nothing here is a prescription and that an unverified
 * section is not evidence before they reach the text itself.
 */
export function MedicineCatalogueDetail({ productId }: { productId: string }) {
  const { detail, loading, error, refresh } = useMedicineProduct(productId);

  if (loading) return <DetailSkeleton />;

  if (error) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6">
          <p className="flex items-start gap-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>{error}</span>
          </p>
          <Button variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Select a medicine to open its dossier.
        </CardContent>
      </Card>
    );
  }

  const { product, ingredients, sources, sections, dosages, aliases } = detail;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const verification = product.clinical_review_status;
  const registration = product.nafdac_registration_status;

  return (
    <div className="space-y-4">
      <Card className="border-warning-border bg-warning-subtle/40">
        <CardContent className="flex items-start gap-2 py-3 text-sm">
          <BookOpen className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Professional reference only</p>
            <p className="text-muted-foreground">
              This is not a prescription and not patient-specific advice. Check the current
              product label and the prescriber’s directions before dispensing. Content marked
              not verified has not been clinically reviewed and must not be used as if it had.
            </p>
          </div>
        </CardContent>
      </Card>

      {verification === 'outdated' && (
        <Card className="border-warning-border bg-warning-subtle">
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>
              This record is marked <strong>outdated</strong>. It remains visible for
              traceability, but a newer reference should be checked before clinical use.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight">{product.product_name}</h2>
              <p className="text-sm text-muted-foreground">
                {product.generic_name}
                {product.strength_text ? ` · ${product.strength_text}` : ''}
                {product.dosage_form ? ` · ${product.dosage_form}` : ''}
                {product.route ? ` · ${product.route}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="brand">Shared catalogue</Badge>
              <VerificationBadge status={verification} />
              <RegistrationBadge status={registration} />
              <Badge variant={product.prescription_class === 'otc' ? 'secondary' : 'warning'}>
                {prescriptionLabel(product.prescription_class)}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-3">
            <Fact label="Generic" value={product.generic_name} />
            <Fact label="Brand" value={displayOrNotRecorded(product.brand_name)} />
            <Fact label="Strength" value={displayOrNotRecorded(product.strength_text)} />
            <Fact label="Form" value={displayOrNotRecorded(product.dosage_form)} />
            <Fact label="Route" value={displayOrNotRecorded(product.route)} />
            <Fact label="Pack size" value={displayOrNotRecorded(product.pack_size)} />
            <Fact label="Manufacturer" value={displayOrNotRecorded(product.manufacturer)} />
            <Fact
              label="Authorisation holder"
              value={displayOrNotRecorded(product.marketing_authorisation_holder)}
            />
            <Fact label="NAFDAC reg." value={displayOrNotRecorded(product.nafdac_reg_number)} />
            <Fact label="Category" value={displayOrNotRecorded(product.category)} />
            <Fact
              label="Registration checked"
              value={
                product.nafdac_verified_at ? formatDate(product.nafdac_verified_at) : 'Not verified'
              }
            />
            <Fact
              label="Last clinical review"
              value={
                product.last_clinical_review_date
                  ? formatDate(product.last_clinical_review_date)
                  : 'Not reviewed'
              }
            />
            <Fact label="Record version" value={String(product.version)} />
          </dl>

          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Registration and clinical review are separate. A NAFDAC registration can be
                verified while the clinical sections are not, and vice versa. Neither status
                replaces a pharmacist’s professional judgement.
              </span>
            </p>
          </div>

          {ingredients.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Active ingredients</p>
              <div className="flex flex-wrap gap-1.5">
                {ingredients.map((ingredient) => (
                  <Badge key={ingredient.id} variant="outline">
                    {ingredient.ingredient_name}
                    {ingredient.strength_value !== null
                      ? ` ${ingredient.strength_value}${ingredient.strength_unit ?? ''}`
                      : ''}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {aliases.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Also known as</p>
              <div className="flex flex-wrap gap-1.5">
                {aliases.map((alias) => (
                  <Badge key={alias.id} variant="secondary">
                    {alias.alias}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" render={<Link to="/notifications" />}>
              <CircleSlash />
              Report a mismatch
            </Button>
            <ReviewerNote only={!isVerifiedStatus(verification)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <SectionTitle>Clinical sections</SectionTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {CLINICAL_SECTION_ORDER.map((key) => {
              const section = sections.find((candidate) => candidate.section === key) ?? null;
              const source = section?.source_id ? sourceById.get(section.source_id) ?? null : null;
              return (
                <ClinicalSectionCard
                  key={key}
                  sectionKey={key}
                  section={section}
                  source={source}
                />
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <SectionTitle>Dosage records</SectionTitle>
        </CardHeader>
        <CardContent>
          {dosages.length === 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                No dosage record is established for this product. Do not infer a dose from the
                strength or from another product.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Population</th>
                    <th className="py-2 pr-3 font-medium">Indication</th>
                    <th className="py-2 pr-3 font-medium">Dose</th>
                    <th className="py-2 pr-3 font-medium">Frequency</th>
                    <th className="py-2 pr-3 font-medium">Max</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {dosages.map((dosage) => (
                    <DosageRow
                      key={dosage.id}
                      dosage={dosage}
                      source={dosage.source_id ? sourceById.get(dosage.source_id) ?? null : null}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Dosage records are population-level reference text. They are not an instruction to
            dispense a particular quantity to a particular patient.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <SectionTitle>Sources</SectionTitle>
        </CardHeader>
        <CardContent>
          {sources.length === 0 ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              No sources are recorded for this product. Treat every clinical statement as
              unverified.
            </p>
          ) : (
            <ul className="space-y-3">
              {sources.map((source) => (
                <SourceItem key={source.id} source={source} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewerNote({ only }: { only: boolean }) {
  const canReview = useCanReviewClinical();
  if (!only) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <ShieldCheck className="size-3.5" />
      {canReview
        ? 'A reviewer can correct this record through the review workflow.'
        : 'A clinical reviewer must verify this before it is treated as established.'}
    </p>
  );
}

function ClinicalSectionCard({
  sectionKey,
  section,
  source,
}: {
  sectionKey: keyof typeof CLINICAL_SECTION_LABEL;
  section: MedicineClinicalSectionRow | null;
  source: MedicineSourceRow | null;
}) {
  const status = section?.status ?? 'not_established';
  const content = section?.content ?? '';
  const hasContent = content.trim().length > 0;
  const foodInstruction = section?.food_instruction ?? null;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-medium">{CLINICAL_SECTION_LABEL[sectionKey]}</h3>
        <SectionStatusBadge status={status} />
      </div>
      <div className="mt-2 space-y-2 text-sm">
        {hasContent ? (
          <p className="whitespace-pre-line">{content}</p>
        ) : (
          <p className="text-muted-foreground">
            {status === 'not_applicable'
              ? 'Not applicable to this product.'
              : 'Not established in this catalogue.'}
          </p>
        )}
        {foodInstruction && (
          <p className="text-xs text-muted-foreground">
            Food: {FOOD_INSTRUCTION_LABEL[foodInstruction] ?? foodInstruction}
          </p>
        )}
        {source ? (
          <SourceLine source={source} />
        ) : (
          <p className="text-xs text-muted-foreground">No source linked.</p>
        )}
      </div>
    </div>
  );
}

function DosageRow({ dosage, source }: { dosage: MedicineDosageRow; source: MedicineSourceRow | null }) {
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="py-2 pr-3 font-medium">{dosage.population.replaceAll('_', ' ')}</td>
      <td className="py-2 pr-3">{displayOrNotEstablished(dosage.indication)}</td>
      <td className="py-2 pr-3">{displayOrNotEstablished(dosage.dose_text)}</td>
      <td className="py-2 pr-3">{displayOrNotEstablished(dosage.frequency)}</td>
      <td className="py-2 pr-3">{displayOrNotEstablished(dosage.max_dose)}</td>
      <td className="py-2 pr-3">
        <SectionStatusBadge status={dosage.status} />
      </td>
      <td className="py-2">{source ? <SourceLine source={source} compact /> : 'No source'}</td>
    </tr>
  );
}

function SourceItem({ source }: { source: MedicineSourceRow }) {
  const url = source.url ? safeExternalUrl(source.url) : null;
  return (
    <li className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 underline underline-offset-4"
              >
                {source.title}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : (
              source.title
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {SOURCE_TYPE_LABEL[source.source_type] ?? source.source_type}
            {source.publisher ? ` · ${source.publisher}` : ''}
            {' · retrieved '}
            {formatDate(source.retrieved_at)}
          </p>
        </div>
        {source.section && (
          <Badge variant="outline">{CLINICAL_SECTION_LABEL[source.section] ?? source.section}</Badge>
        )}
      </div>
      {source.document_reference && (
        <p className="mt-1 text-xs text-muted-foreground">
          Document: {source.document_reference}
        </p>
      )}
      {source.notes && <p className="mt-1 text-xs text-muted-foreground">{source.notes}</p>}
    </li>
  );
}

function SourceLine({ source, compact = false }: { source: MedicineSourceRow; compact?: boolean }) {
  const url = source.url ? safeExternalUrl(source.url) : null;
  return (
    <p className="text-xs text-muted-foreground">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-4"
        >
          {source.title}
        </a>
      ) : (
        source.title
      )}
      {!compact && source.document_reference ? ` · ${source.document_reference}` : ''}
    </p>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

function prescriptionLabel(value: string): string {
  if (value === 'otc') return 'OTC';
  if (value === 'prescription') return 'Prescription';
  if (value === 'controlled') return 'Controlled';
  return value;
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-20 w-full rounded-xl" />
      <Card>
        <CardContent className="space-y-3 py-6">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <div className="grid grid-cols-2 gap-3 pt-2 md:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid grid-cols-1 gap-3 py-6 md:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
