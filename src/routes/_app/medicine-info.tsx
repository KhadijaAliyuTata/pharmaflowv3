import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  Building2,
  CircleSlash,
  FlaskConical,
  Info,
  Search,
  ShieldAlert,
  Snowflake,
  Syringe,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group';
import { Separator } from '~/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Money, PageHeader, SectionTitle, StatusBadge } from '~/components/app/primitives';
import { daysUntil, formatCount, formatDate } from '~/domain/money';
import { searchMedicines, sellableQuantity, stockStatus } from '~/domain/selectors';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/medicine-info')({
  component: MedicineInfo,
});

function MedicineInfo() {
  const medicines = usePharmacy((state) => state.medicines);
  const role = usePharmacy((state) => state.currentUser.role);
  const isOwner = role === 'owner';

  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);

  const results = useMemo(() => searchMedicines(medicines, query), [medicines, query]);

  const selected = useMemo(
    () => results.find((medicine) => medicine.id === selectedId) ?? results[0] ?? null,
    [results, selectedId],
  );

  const equivalent = selected?.genericEquivalentId
    ? (medicines.find((medicine) => medicine.id === selected.genericEquivalentId) ?? null)
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Medicine info"
        description="Clinical dossier and registration record. Check warnings before dispensing."
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="space-y-3 lg:col-span-1">
          <InputGroup>
            <InputGroupAddon>
              <Search className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, generic or barcode"
              aria-label="Search medicines"
            />
          </InputGroup>

          {results.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">No medicine matches.</p>
          ) : (
            <ul className="max-h-[32rem] space-y-0.5 overflow-y-auto rounded-lg border p-1">
              {results.map((medicine) => {
                const active = medicine.id === selected?.id;
                return (
                  <li key={medicine.id}>
                    <Button
                      variant="ghost"
                      className="h-auto w-full items-start justify-start whitespace-normal px-2 py-1.5 text-left"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelectedId(medicine.id)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {medicine.name}
                        </span>
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          {medicine.genericName} · {medicine.strength}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="lg:col-span-3">
          {!selected ? (
            <Card>
              <CardContent>
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FlaskConical />
                    </EmptyMedia>
                    <EmptyTitle>No medicine selected</EmptyTitle>
                    <EmptyDescription>
                      Search the catalogue to open a dossier.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {/* Warnings first. Everything else on this screen is less
                  important than what can hurt a patient. */}
              {selected.warnings.length > 0 ? (
                <Card className="border-destructive/50 bg-destructive/5">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <TriangleAlert className="size-5 shrink-0 text-destructive" />
                      <h2 className="text-sm font-semibold tracking-tight text-destructive">
                        Warnings
                      </h2>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1.5 text-sm">
                      {selected.warnings.map((warning) => (
                        <li key={warning} className="flex gap-2">
                          <CircleSlash
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-destructive"
                          />
                          <span>{warning}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="flex items-center gap-2">
                    <Info className="size-4 shrink-0 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      No warnings recorded for this product.
                    </p>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold tracking-tight">
                        {selected.name}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {selected.genericName} · {selected.strength} · {selected.dosageForm}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={stockStatus(selected)} />
                      <Badge
                        variant={
                          selected.prescriptionStatus === 'OTC' ? 'secondary' : 'warning'
                        }
                      >
                        {selected.prescriptionStatus}
                      </Badge>
                      {selected.isBrand && <Badge variant="outline">Brand</Badge>}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-3">
                    <Fact label="Generic" value={selected.genericName} />
                    <Fact label="Strength" value={selected.strength} />
                    <Fact label="Form" value={selected.dosageForm} />
                    <Fact label="Category" value={selected.category} />
                    <Fact label="Manufacturer" value={selected.manufacturer ?? 'Not recorded'} />
                    <Fact
                      label="NAFDAC reg."
                      value={selected.nafdacRegNumber ?? 'Not recorded'}
                    />
                  </dl>

                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => setVerifyOpen(true)}>
                      <ShieldAlert />
                      Verify with NAFDAC
                    </Button>
                    {equivalent && (
                      <Button
                        variant="outline"
                        onClick={() => setSelectedId(equivalent.id)}
                      >
                        <ArrowLeftRight />
                        {selected.isBrand ? 'Generic equivalent' : 'Brand equivalent'} ·{' '}
                        {equivalent.name}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader className="pb-2">
                    <SectionTitle>Clinical</SectionTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <FlaskConical className="size-3.5" />
                        Common use
                      </p>
                      <p className="mt-0.5">{selected.commonUse}</p>
                    </div>
                    <div>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Snowflake className="size-3.5" />
                        Storage
                      </p>
                      <p className="mt-0.5">{selected.storage}</p>
                    </div>
                    <div>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Syringe className="size-3.5" />
                        Supply
                      </p>
                      <p className="mt-0.5">
                        {selected.prescriptionStatus === 'OTC'
                          ? 'Over the counter.'
                          : selected.prescriptionStatus === 'Prescription'
                            ? 'Prescription required. Record the prescriber.'
                            : 'Controlled. Record the prescriber and quantity.'}
                      </p>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <SectionTitle>On hand</SectionTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">Sellable</span>
                      <span data-numeric className="tabular font-semibold">
                        {formatCount(sellableQuantity(selected))}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">On hand</span>
                      <span data-numeric className="tabular">
                        {formatCount(selected.totalQuantity)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">Price / unit</span>
                      <Money value={selected.pricePerBaseUnit} className="font-semibold" />
                    </div>
                    {isOwner && (
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-muted-foreground">Cost / unit</span>
                        <Money value={selected.costPerBaseUnit} />
                      </div>
                    )}
                    <Separator />
                    <p className="text-xs text-muted-foreground">
                      {selected.units.map((unit) => unit.name).join(' · ')}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <SectionTitle
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        render={<Link to="/inventory" />}
                      >
                        Catalogue
                      </Button>
                    }
                  >
                    Batches
                  </SectionTitle>
                </CardHeader>
                <CardContent>
                  {selected.batches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No batches on record.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Batch</TableHead>
                          <TableHead>Expiry</TableHead>
                          <TableHead className="text-right">Days</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          {isOwner && <TableHead className="text-right">Cost</TableHead>}
                          <TableHead className="text-right">State</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selected.batches.map((batch) => {
                          const remaining = daysUntil(batch.expiryDate);
                          return (
                            <TableRow key={batch.id}>
                              <TableCell>
                                <p className="font-medium">{batch.batchNumber}</p>
                                {batch.recallReason && (
                                  <p className="text-xs text-destructive">
                                    {batch.recallReason}
                                  </p>
                                )}
                              </TableCell>
                              <TableCell>{formatDate(batch.expiryDate)}</TableCell>
                              <TableCell
                                className={
                                  remaining < 0
                                    ? 'text-right font-medium text-destructive'
                                    : 'text-right text-muted-foreground'
                                }
                              >
                                {remaining}
                              </TableCell>
                              <TableCell className="text-right">
                                {formatCount(batch.quantity)}
                              </TableCell>
                              {isOwner && (
                                <TableCell className="text-right text-muted-foreground">
                                  <Money value={batch.costPerBaseUnit} />
                                </TableCell>
                              )}
                              <TableCell className="text-right">
                                {batch.isRecalled ? (
                                  <Badge variant="destructive">Recalled</Badge>
                                ) : remaining < 0 ? (
                                  <Badge variant="destructive">Expired</Badge>
                                ) : (
                                  <Badge variant="success">Live</Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>

      {selected && (
        <NafdacDialog
          open={verifyOpen}
          onOpenChange={setVerifyOpen}
          regNumber={selected.nafdacRegNumber ?? null}
          manufacturer={selected.manufacturer ?? null}
        />
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label === 'Manufacturer' && <Building2 className="size-3.5" />}
        {label}
      </dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

/**
 * NAFDAC verification is not wired up. There is no domain operation and no
 * external call, so this says so rather than inventing a result.
 */
function NafdacDialog({
  open,
  onOpenChange,
  regNumber,
  manufacturer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  regNumber: string | null;
  manufacturer: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Verify with NAFDAC</DialogTitle>
          <DialogDescription>
            This screen cannot confirm a registration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <p className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                Verification is not wired up. No call is made to the NAFDAC database, so nothing on
                this screen is proof of registration.
              </span>
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Fact label="Registration" value={regNumber ?? 'Not recorded'} />
            <Fact label="Manufacturer" value={manufacturer ?? 'Not recorded'} />
          </dl>

          <p className="text-muted-foreground">
            Until it is, check the number on the NAFDAC register yourself, and treat an unrecorded
            registration as unverified.
          </p>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          <Button
            variant="outline"
            render={<Link to="/notifications" />}
            onClick={() => onOpenChange(false)}
          >
            Report a mismatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
