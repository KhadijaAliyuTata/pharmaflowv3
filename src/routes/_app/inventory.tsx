import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Lock,
  LockOpen,
  MoreHorizontal,
  PencilLine,
  Search,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Checkbox } from '~/components/ui/checkbox';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';
import { Field, FieldError, FieldLabel } from '~/components/ui/field';
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
import { Separator } from '~/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { Textarea } from '~/components/ui/textarea';
import {
  MaybeMoney,
  MaybePercent,
  Money,
  PageHeader,
  SectionTitle,
  StatusBadge,
} from '~/components/app/primitives';
import { daysUntil, formatCount, formatDate, formatNaira } from '~/domain/money';
import { formatStockQuantity } from '~/domain/units';
import { marginPercent, searchMedicines, sellableQuantity, stockStatus } from '~/domain/selectors';
import type { Medicine, MedicineBatch, StockStatus } from '~/domain/types';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';
import { useMedicines } from '~/hooks/use-medicines';
import { useIsOwner } from '~/hooks/use-is-owner';
import {
  CATALOGUE_WRITE_UNAVAILABLE,
  catalogueWritesAvailable,
} from '~/lib/catalogue-writes';
import { useSeedQuery } from '~/lib/use-seed-query';

export const Route = createFileRoute('/_app/inventory')({
  // Seeds the list's own search box from the header's global search, so a
  // result for "paracetamol" lands on the filtered list rather than all of it.
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  component: Inventory,
});

const PAGE_SIZE = 12;

type SortKey =
  | 'name'
  | 'category'
  | 'stock'
  | 'price'
  | 'cost'
  | 'margin'
  | 'expiry'
  | 'supplier';

type Sort = { key: SortKey; dir: 'asc' | 'desc' };

type StatusFilter = 'all' | StockStatus;
type PrescriptionFilter = 'all' | Medicine['prescriptionStatus'];

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_stock', label: 'In stock' },
  { value: 'low_stock', label: 'Low' },
  { value: 'out_of_stock', label: 'Out' },
  { value: 'expiring_soon', label: 'Expiring' },
  { value: 'expired', label: 'Expired' },
];

const PRESCRIPTION_FILTERS: { value: PrescriptionFilter; label: string }[] = [
  { value: 'all', label: 'Any prescription status' },
  { value: 'OTC', label: 'OTC' },
  { value: 'Prescription', label: 'Prescription' },
  { value: 'Controlled', label: 'Controlled' },
];

/** Every mutation the product panel can start. One dialog serves all four. */
type Pending =
  | { kind: 'price'; medicine: Medicine }
  | { kind: 'stock'; medicine: Medicine }
  | { kind: 'lock'; medicine: Medicine; lock: boolean }
  | { kind: 'recall'; medicine: Medicine; batch: MedicineBatch; recall: boolean };

function Inventory() {
  const { q } = Route.useSearch();
  // Catalogue comes from Supabase in live mode; see useMedicines for why it has no
  // localStorage fallback there.
  const { medicines, loading: catalogueLoading, error: catalogueError } = useMedicines();
  const suppliers = usePharmacy((state) => state.suppliers);
  // Authoritative: `pf_is_owner()` resolves branch_memberships.role. Display
  // gating only — `profiles.role` is a cache and RLS is the boundary.
  const isOwner = useIsOwner();

  const [query, setQuery] = useSeedQuery(q);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [category, setCategory] = useState('all');
  const [prescription, setPrescription] = useState<PrescriptionFilter>('all');
  const [supplierId, setSupplierId] = useState('all');
  const [lockedOnly, setLockedOnly] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' });
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /**
   * Why a catalogue action was refused. Non-null means the user clicked something
   * that is not available yet, and nothing was changed.
   */
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const writesAvailable = catalogueWritesAvailable();

  const { updatePrice, adjustStock, setSafetyLock, setBatchRecall } = usePharmacyActions();

  const categories = useMemo(
    () => Array.from(new Set(medicines.map((medicine) => medicine.category))).sort(),
    [medicines],
  );

  const supplierNames = useMemo(
    () => new Map(suppliers.map((supplier) => [supplier.id, supplier.name])),
    [suppliers],
  );

  const statusCounts = useMemo(() => {
    const counts = new Map<StatusFilter, number>([['all', medicines.length]]);
    for (const medicine of medicines) {
      const key = stockStatus(medicine);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [medicines]);

  const filtered = useMemo(
    () =>
      searchMedicines(medicines, query).filter((medicine) => {
        if (status !== 'all' && stockStatus(medicine) !== status) return false;
        if (category !== 'all' && medicine.category !== category) return false;
        if (prescription !== 'all' && medicine.prescriptionStatus !== prescription) return false;
        if (supplierId !== 'all' && medicine.supplier !== supplierId) return false;
        if (lockedOnly && !medicine.doNotSell.active) return false;
        return true;
      }),
    [medicines, query, status, category, prescription, supplierId, lockedOnly],
  );

  const sorted = useMemo(() => {
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => factor * compare(a, b, sort.key, supplierNames));
  }, [filtered, sort, supplierNames]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = sorted.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  // Re-read by id so the panel follows the store after an edit.
  const selected = selectedId
    ? (medicines.find((medicine) => medicine.id === selectedId) ?? null)
    : null;

  function toggleSort(key: SortKey) {
    setSort((previous) =>
      previous.key === key
        ? { key, dir: previous.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  }

  /**
   * Every mutating catalogue action funnels through here.
   *
   * In live mode the list on screen came from Supabase while these actions would
   * rewrite `state.medicines` in localStorage — two different collections of rows.
   * So the action is refused with a visible reason instead of appearing to succeed
   * and then vanishing on the next render. Nothing is written in either case, and
   * `setPending` is never reached, so no dialog can submit a local mutation.
   *
   * Gating the single handler rather than each menu item covers the row menu and the
   * detail sheet together, and cannot be bypassed by a control added later.
   */
  function openAction(next: Pending) {
    if (!writesAvailable) {
      setActionNotice(CATALOGUE_WRITE_UNAVAILABLE);
      return;
    }
    setActionNotice(null);
    setPending(next);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Products"
        description="Catalogue, batches and pricing."
        actions={
          <Button variant="outline" render={<Link to="/stock-receiving" />}>
            Receive stock
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-full sm:w-64">
              <InputGroupAddon>
                <Search className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder="Name, generic or barcode"
                aria-label="Search products"
              />
            </InputGroup>

            <Select
              value={category}
              onValueChange={(value) => {
                setCategory(value ?? 'all');
                setPage(0);
              }}
            >
              <SelectTrigger size="sm" className="w-40" aria-label="Category">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={prescription}
              onValueChange={(value) => {
                setPrescription((value ?? 'all') as PrescriptionFilter);
                setPage(0);
              }}
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Prescription status">
                <SelectValue placeholder="Prescription" />
              </SelectTrigger>
              <SelectContent>
                {PRESCRIPTION_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={supplierId}
              onValueChange={(value) => {
                setSupplierId(value ?? 'all');
                setPage(0);
              }}
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Supplier">
                <SelectValue placeholder="Supplier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All suppliers</SelectItem>
                {suppliers.map((supplier) => (
                  <SelectItem key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label className="gap-2 text-muted-foreground">
              <Checkbox
                checked={lockedOnly}
                onCheckedChange={(checked) => {
                  setLockedOnly(checked === true);
                  setPage(0);
                }}
              />
              Locked only
            </Label>

            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              <SlidersHorizontal className="size-3.5" />
              {sorted.length} of {medicines.length}
            </span>
          </div>

          <Tabs
            value={status}
            onValueChange={(value) => {
              setStatus(value as StatusFilter);
              setPage(0);
            }}
          >
            <TabsList className="max-w-full justify-start overflow-x-auto">
              {STATUS_FILTERS.map((option) => (
                <TabsTrigger key={option.value} value={option.value} className="flex-none">
                  {option.label}
                  <Badge variant="secondary" className="ml-0.5">
                    {statusCounts.get(option.value) ?? 0}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {catalogueError ? (
            /* A failed read is never disguised as an empty catalogue. The seeded
               demo products are deliberately not shown instead: they belong to a
               different pharmacy and would look like real stock. */
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TriangleAlert />
                </EmptyMedia>
                <EmptyTitle>Catalogue unavailable</EmptyTitle>
                <EmptyDescription>
                  {catalogueError} Nothing is shown in its place — an empty list here
                  would look like a pharmacy that has never stocked anything.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : catalogueLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading the catalogue…
            </p>
          ) : rows.length === 0 ? (
            medicines.length === 0 ? (
              /* Distinct from "nothing matches": an empty pharmacy is a real state,
                 and it needs different words from a filter that excluded everything. */
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search />
                  </EmptyMedia>
                  <EmptyTitle>No products yet</EmptyTitle>
                  <EmptyDescription>
                    Nothing has been added to this pharmacy&rsquo;s catalogue.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search />
                  </EmptyMedia>
                  <EmptyTitle>Nothing matches</EmptyTitle>
                  <EmptyDescription>Clear the search or widen the filters.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Product" sortKey="name" sort={sort} onSort={toggleSort} />
                    <TableHead>Generic</TableHead>
                    <SortHead label="Category" sortKey="category" sort={sort} onSort={toggleSort} />
                    <SortHead label="Stock" sortKey="stock" sort={sort} onSort={toggleSort} align="right" />
                    <SortHead label="Price" sortKey="price" sort={sort} onSort={toggleSort} align="right" />
                    {isOwner && (
                      <>
                        <SortHead label="Cost" sortKey="cost" sort={sort} onSort={toggleSort} align="right" />
                        <SortHead label="Margin" sortKey="margin" sort={sort} onSort={toggleSort} align="right" />
                      </>
                    )}
                    <SortHead label="Expiry" sortKey="expiry" sort={sort} onSort={toggleSort} />
                    <SortHead label="Supplier" sortKey="supplier" sort={sort} onSort={toggleSort} />
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((medicine) => {
                    const sellable = sellableQuantity(medicine);
                    const remaining = daysUntil(medicine.expiryDate);
                    return (
                      <TableRow
                        key={medicine.id}
                        className="cursor-pointer"
                        onClick={() => setSelectedId(medicine.id)}
                      >
                        <TableCell className="max-w-56">
                          <p className="flex items-center gap-1.5 truncate font-medium">
                            <span className="truncate">{medicine.name}</span>
                            {medicine.doNotSell.active && (
                              <Lock className="size-3 shrink-0 text-destructive" />
                            )}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {medicine.strength} · {medicine.dosageForm}
                          </p>
                        </TableCell>
                        <TableCell className="max-w-44">
                          <span className="block truncate text-muted-foreground">
                            {medicine.genericName}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-muted-foreground">
                            {medicine.category}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <p data-numeric className="tabular font-medium">
                            {formatCount(medicine.totalQuantity)}
                          </p>
                          {/* The same number, said the way a pharmacist would:
                              498 base units reads as "4 x Box (100) · 9 x
                              Card (10)". Read-only — the canonical figure above
                              is what stock, pricing and FEFO all use. */}
                          {medicine.units.length > 1 && (
                            <p
                              data-numeric
                              className="tabular text-xs text-muted-foreground"
                              title="Same quantity, expressed in packaging units"
                            >
                              {formatStockQuantity(
                                medicine.units,
                                medicine.totalQuantity,
                              )}
                            </p>
                          )}
                          {sellable !== medicine.totalQuantity && (
                            <p className="text-xs text-muted-foreground">
                              {formatCount(sellable)} sellable
                            </p>
                          )}
                          <div className="mt-1 flex justify-end">
                            <StatusBadge status={stockStatus(medicine)} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={medicine.pricePerBaseUnit} className="font-medium" />
                        </TableCell>
                        {isOwner && (
                          <>
                            <TableCell className="text-right text-muted-foreground">
                              <MaybeMoney value={medicine.costPerBaseUnit} />
                            </TableCell>
                            <TableCell className="text-right">
                              <MaybePercent value={marginPercent(medicine)} />
                            </TableCell>
                          </>
                        )}
                        <TableCell
                          className={
                            remaining < 0
                              ? 'font-medium text-destructive'
                              : 'text-muted-foreground'
                          }
                        >
                          {formatDate(medicine.expiryDate)}
                        </TableCell>
                        <TableCell className="max-w-40">
                          <span className="block truncate text-muted-foreground">
                            {supplierNames.get(medicine.supplier) ?? medicine.supplier}
                          </span>
                        </TableCell>
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          <RowActions
                            medicine={medicine}
                            isOwner={isOwner}
                            onOpen={() => setSelectedId(medicine.id)}
                            onAction={openAction}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {currentPage * PAGE_SIZE + 1}–
                  {Math.min((currentPage + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setPage((value) => Math.max(0, value - 1))}
                    disabled={currentPage === 0}
                    aria-label="Previous page"
                  >
                    <ChevronLeft />
                  </Button>
                  <span className="px-1 text-xs text-muted-foreground">
                    {currentPage + 1} / {pageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                    disabled={currentPage >= pageCount - 1}
                    aria-label="Next page"
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <ProductSheet
        medicine={selected}
        isOwner={isOwner}
        onClose={() => setSelectedId(null)}
        onAction={openAction}
      />

      {/* A refused catalogue action. Shown instead of a success toast, and it clears
          on the next attempt, so it never misreports a change that did not happen. */}
      {actionNotice && (
        <p
          role="alert"
          className="rounded-lg border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning"
        >
          {actionNotice}
        </p>
      )}

      {pending && (
        <ActionDialog
          key={actionKey(pending)}
          pending={pending}
          isOwner={isOwner}
          onClose={() => setPending(null)}
          updatePrice={updatePrice}
          adjustStock={adjustStock}
          setSafetyLock={setSafetyLock}
          setBatchRecall={setBatchRecall}
        />
      )}
    </div>
  );
}

function actionKey(pending: Pending): string {
  const target = pending.kind === 'recall' ? pending.batch.id : pending.medicine.id;
  const flag = pending.kind === 'lock' ? String(pending.lock) : pending.kind === 'recall' ? String(pending.recall) : '';
  return `${pending.kind}-${target}-${flag}`;
}

/* ------------------------------------------------------------------ sorting */

function compare(
  a: Medicine,
  b: Medicine,
  key: SortKey,
  supplierNames: Map<string, string>,
): number {
  switch (key) {
    case 'stock':
      return a.totalQuantity - b.totalQuantity;
    case 'price':
      return a.pricePerBaseUnit - b.pricePerBaseUnit;
    case 'cost': {
      // Unknown cost sorts last in both directions. Falling back to 0 would
      // interleave cost-free-looking rows into the middle of a ranked list, and
      // they are not cost-free — they are unpriced to this session.
      const left = a.costPerBaseUnit;
      const right = b.costPerBaseUnit;
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined) return -1;
      return left - right;
    }
    case 'margin': {
      const left = marginPercent(a);
      const right = marginPercent(b);
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return left - right;
    }
    case 'expiry':
      return a.expiryDate.localeCompare(b.expiryDate);
    case 'supplier':
      return (supplierNames.get(a.supplier) ?? '').localeCompare(
        supplierNames.get(b.supplier) ?? '',
      );
    case 'category':
      return a.category.localeCompare(b.category);
    default:
      return a.name.localeCompare(b.name);
  }
}

function SortHead({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Button
        variant="ghost"
        size="xs"
        className="-mx-1.5 h-6 px-1.5 text-xs text-muted-foreground"
        onClick={() => onSort(sortKey)}
      >
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ChevronUp />
          ) : (
            <ChevronDown />
          )
        ) : (
          <ArrowUpDown className="opacity-40" />
        )}
      </Button>
    </TableHead>
  );
}

/* ------------------------------------------------------------------ actions */

function RowActions({
  medicine,
  isOwner,
  onOpen,
  onAction,
}: {
  medicine: Medicine;
  isOwner: boolean;
  onOpen: () => void;
  onAction: (pending: Pending) => void;
}) {
  const oldestBatch = medicine.batches[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${medicine.name}`} />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onOpen}>Open</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction({ kind: 'stock', medicine })}>
          Adjust stock
        </DropdownMenuItem>
        {isOwner && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onAction({ kind: 'price', medicine })}>
              <PencilLine />
              Edit price
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onAction({ kind: 'lock', medicine, lock: !medicine.doNotSell.active })
              }
            >
              {medicine.doNotSell.active ? <LockOpen /> : <Lock />}
              {medicine.doNotSell.active ? 'Release lock' : 'Lock from sale'}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!oldestBatch}
              onClick={() => {
                if (oldestBatch) onAction({ kind: 'recall', medicine, batch: oldestBatch, recall: true });
              }}
            >
              Recall oldest batch
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------- product sheet */

function ProductSheet({
  medicine,
  isOwner,
  onClose,
  onAction,
}: {
  medicine: Medicine | null;
  isOwner: boolean;
  onClose: () => void;
  onAction: (pending: Pending) => void;
}) {
  return (
    <Sheet
      open={medicine !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="sm:max-w-xl">
        {medicine && (
          <>
            <SheetHeader>
              <SheetTitle>{medicine.name}</SheetTitle>
              <SheetDescription>
                {medicine.genericName} · {medicine.strength} · {medicine.dosageForm}
              </SheetDescription>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusBadge status={stockStatus(medicine)} />
                <Badge variant={medicine.prescriptionStatus === 'OTC' ? 'secondary' : 'warning'}>
                  {medicine.prescriptionStatus}
                </Badge>
                {medicine.doNotSell.active && (
                  <Badge variant="destructive">
                    <Lock />
                    Locked
                  </Badge>
                )}
                {medicine.isBrand && <Badge variant="outline">Brand</Badge>}
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-4 overflow-y-auto px-4">
              {medicine.doNotSell.active && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-sm font-medium text-destructive">Blocked from sale</p>
                  <p className="text-sm">{medicine.doNotSell.reason}</p>
                  {medicine.doNotSell.lockedBy && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {medicine.doNotSell.lockedBy} · {formatDate(medicine.doNotSell.lockedAt ?? '')}
                    </p>
                  )}
                </div>
              )}

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Fact label="Category" value={medicine.category} />
                <Fact label="NAFDAC" value={medicine.nafdacRegNumber ?? 'Not recorded'} />
                <Fact label="Manufacturer" value={medicine.manufacturer ?? 'Not recorded'} />
                <Fact label="Supplier" value={medicine.supplier} />
                <Fact label="Price / unit" value={formatNaira(medicine.pricePerBaseUnit)} />
                {isOwner && (
                  <Fact
                    label="Cost / unit"
                    value={
                      medicine.costPerBaseUnit === undefined
                        ? 'Not available for your role'
                        : formatNaira(medicine.costPerBaseUnit)
                    }
                  />
                )}
                <Fact
                  label="On hand"
                  value={`${formatCount(medicine.totalQuantity)} · low at ${formatCount(
                    medicine.lowStockThreshold,
                  )}`}
                />
                <Fact label="Selling" value={`${formatCount(medicine.averageDailySales)}/day`} />
              </dl>

              <section className="space-y-2">
                <SectionTitle>Units</SectionTitle>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Unit</TableHead>
                      <TableHead className="text-right">Contains</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {medicine.units.map((unit, index) => (
                      <TableRow key={unit.key}>
                        <TableCell>{unit.name}</TableCell>
                        <TableCell className="text-right">
                          {index === 0 ? (
                            <Badge variant="outline">Base unit</Badge>
                          ) : (
                            <span className="text-muted-foreground">{unit.multiplier}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={unit.sellingPrice} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>

              <section className="space-y-2">
                <SectionTitle>Batches</SectionTitle>
                {medicine.batches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No batches on record.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Batch</TableHead>
                        <TableHead>Expiry</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        {isOwner && <TableHead className="text-right">Cost</TableHead>}
                        <TableHead className="text-right">State</TableHead>
                        {isOwner && <TableHead />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {medicine.batches.map((batch) => {
                        const remaining = daysUntil(batch.expiryDate);
                        return (
                          <TableRow key={batch.id}>
                            <TableCell>
                              <p className="font-medium">{batch.batchNumber}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {batch.recallReason ?? batch.supplier}
                              </p>
                            </TableCell>
                            <TableCell
                              className={remaining < 0 ? 'text-destructive' : undefined}
                            >
                              {formatDate(batch.expiryDate)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCount(batch.quantity)}
                            </TableCell>
                            {isOwner && (
                              <TableCell className="text-right text-muted-foreground">
                                <MaybeMoney value={batch.costPerBaseUnit} />
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
                            {isOwner && (
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() =>
                                    onAction({
                                      kind: 'recall',
                                      medicine,
                                      batch,
                                      recall: !batch.isRecalled,
                                    })
                                  }
                                >
                                  {batch.isRecalled ? 'Release' : 'Recall'}
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </section>

              <Separator />

              <section className="space-y-2">
                <SectionTitle>Clinical</SectionTitle>
                <p className="text-sm">{medicine.commonUse}</p>
                <p className="text-sm text-muted-foreground">{medicine.storage}</p>
                {medicine.warnings.length > 0 && (
                  <ul className="space-y-1 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm">
                    {medicine.warnings.map((warning) => (
                      <li key={warning} className="flex gap-2">
                        <span aria-hidden="true" className="text-warning">
                          •
                        </span>
                        <span>{warning}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t">
              <Button variant="outline" onClick={() => onAction({ kind: 'stock', medicine })}>
                Adjust stock
              </Button>
              {isOwner && (
                <>
                  <Button onClick={() => onAction({ kind: 'price', medicine })}>
                    <PencilLine />
                    Edit price
                  </Button>
                  <Button
                    variant={medicine.doNotSell.active ? 'outline' : 'destructive'}
                    onClick={() =>
                      onAction({ kind: 'lock', medicine, lock: !medicine.doNotSell.active })
                    }
                  >
                    {medicine.doNotSell.active ? <LockOpen /> : <Lock />}
                    {medicine.doNotSell.active ? 'Release lock' : 'Lock from sale'}
                  </Button>
                </>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------- action dialog */

type OperationResult = { ok: true } | { ok: false; error: string };

interface ActionDialogProps {
  pending: Pending;
  /**
   * Authoritative ownership, from `pf_is_owner()` — which reads
   * `branch_memberships.role`. Not `profiles.role`, which is a display cache that a
   * demotion never repairs. Display gating only; the local actions below still run
   * their own `canApprovePricing` checks, and the database is the boundary.
   */
  isOwner: boolean;
  onClose: () => void;
  updatePrice: (medicineId: string, price: number) => OperationResult;
  adjustStock: (medicineId: string, quantity: number, reason: string) => OperationResult;
  setSafetyLock: (medicineId: string, locked: boolean, reason?: string) => OperationResult;
  setBatchRecall: (batchId: string, recalled: boolean, reason?: string) => OperationResult;
}

const OWNER_ONLY: Record<Pending['kind'], boolean> = {
  price: true,
  stock: false,
  lock: true,
  recall: true,
};

function ActionDialog({
  pending,
  isOwner,
  onClose,
  updatePrice,
  adjustStock,
  setSafetyLock,
  setBatchRecall,
}: ActionDialogProps) {
  const [reason, setReason] = useState('');
  const [price, setPrice] = useState(String(pending.medicine.pricePerBaseUnit));
  const [quantity, setQuantity] = useState(String(pending.medicine.totalQuantity));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);

    // Enforced against the authoritative role, not only by hiding the control.
    if (OWNER_ONLY[pending.kind] && !isOwner) {
      setError('Only an owner can change prices, locks or recalls');
      return;
    }

    const result =
      pending.kind === 'price'
        ? updatePrice(pending.medicine.id, Number(price))
        : pending.kind === 'stock'
          ? adjustStock(pending.medicine.id, Number(quantity), reason)
          : pending.kind === 'lock'
            ? setSafetyLock(pending.medicine.id, pending.lock, reason)
            : setBatchRecall(pending.batch.id, pending.recall, reason);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{actionTitle(pending)}</DialogTitle>
          <DialogDescription>{actionDescription(pending)}</DialogDescription>
        </DialogHeader>

        {pending.kind === 'price' && (
          <Field>
            <FieldLabel htmlFor="action-price">Price per base unit</FieldLabel>
            <Input
              id="action-price"
              type="number"
              inputMode="decimal"
              min={0}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </Field>
        )}

        {pending.kind === 'stock' && (
          <Field>
            <FieldLabel htmlFor="action-quantity">New quantity, base units</FieldLabel>
            <Input
              id="action-quantity"
              type="number"
              inputMode="numeric"
              min={0}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Field>
        )}

        {pending.kind !== 'price' && (
          <Field>
            <FieldLabel htmlFor="action-reason">Reason</FieldLabel>
            <Textarea
              id="action-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={REASON_PLACEHOLDER[pending.kind]}
            />
          </Field>
        )}

        {error && <FieldError>{error}</FieldError>}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant={pending.kind === 'price' ? 'default' : 'destructive'} onClick={submit}>
            {pending.kind === 'stock' ? 'Save' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const REASON_PLACEHOLDER: Record<Exclude<Pending['kind'], 'price'>, string> = {
  stock: 'Stock count correction',
  lock: 'NAFDAC alert, pending re-verification',
  recall: 'Manufacturer recall, wrong marking',
};

function actionTitle(pending: Pending): string {
  switch (pending.kind) {
    case 'price':
      return 'Edit price';
    case 'stock':
      return 'Adjust stock';
    case 'lock':
      return pending.lock ? 'Lock from sale' : 'Release lock';
    case 'recall':
      return pending.recall ? 'Recall batch' : 'Release batch';
  }
}

function actionDescription(pending: Pending): string {
  switch (pending.kind) {
    case 'price':
      return `${pending.medicine.name} · per base unit`;
    case 'stock':
      return `${pending.medicine.name} · ${formatCount(pending.medicine.totalQuantity)} on hand`;
    case 'lock':
      return pending.medicine.name;
    case 'recall':
      return `${pending.batch.batchNumber} · ${formatCount(pending.batch.quantity)} units`;
  }
}
