import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Boxes, Lock, Package, Search, ShieldAlert, Star, Truck } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { PageHeader, StatTile } from '~/components/app/primitives';
import { formatDate, money, sum } from '~/domain/money';
import { stockStatus } from '~/domain/selectors';
import { useSuppliers } from '~/hooks/use-suppliers';
import type { Supplier } from '~/domain/types';
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';
import { useSeedQuery } from '~/lib/use-seed-query';
import { useMedicines } from '~/hooks/use-medicines';

export const Route = createFileRoute('/_app/suppliers')({
  // Seeded by the header's global search so a supplier result opens the
  // directory filtered to that supplier.
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  component: SuppliersScreen,
});

function SuppliersScreen() {
  // Suppliers now come from Supabase, scoped by `suppliers_read`
  // (`branch_id = pf_current_branch()`), and fall back to the store while the
  // branch context resolves or when no backend is configured. Medicines are still
  // localStorage — see docs/PHASE-0-DATA-MIGRATION.md.
  const { suppliers, loading, error, source } = useSuppliers();
  // Catalogue from Supabase in live mode; useMedicines has no local
  // fallback there, so a failed read surfaces as an error, not as seed data.
  const { medicines } = useMedicines();
  const { role } = useCurrentUser();
  const [query, setQuery] = useSeedQuery(Route.useSearch().q);

  // Matches on the same fields the global search matches on, so a result that
  // appeared in the search box is guaranteed to still be visible here.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return suppliers;
    return suppliers.filter((supplier) =>
      [supplier.name, supplier.contactPerson, supplier.phone, supplier.address].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [suppliers, query]);

  // medicine.supplier holds the supplier id, so this is a plain join. Keyed on id
  // *and* on name so it survives ids changing from seed strings ('sup-abc') to
  // database uuids — both sides come from the same source in practice, so this is
  // belt-and-braces rather than a second lookup path.
  const supplierByKey = useMemo(() => {
    const map = new Map<string, Supplier>();
    for (const supplier of suppliers) {
      map.set(supplier.id, supplier);
      map.set(supplier.name.toLowerCase(), supplier);
    }
    return map;
  }, [suppliers]);

  const resolveSupplier = useMemo(
    () => (key: string) => supplierByKey.get(key) ?? supplierByKey.get(key.toLowerCase()),
    [supplierByKey],
  );

  const supplierIds = useMemo(() => new Set(suppliers.map((s) => s.id)), [suppliers]);

  const suppliedBy = useMemo(() => {
    const map = new Map<string, typeof medicines>();
    for (const medicine of medicines) {
      const list = map.get(medicine.supplier) ?? [];
      list.push(medicine);
      map.set(medicine.supplier, list);
    }
    return map;
  }, [medicines]);

  const averageLeadTime = suppliers.length
    ? Math.round(sum(suppliers.map((s) => s.leadTimeDays)) / suppliers.length)
    : 0;

  const averageRating = suppliers.length
    ? money(sum(suppliers.map((s) => s.rating)) / suppliers.length)
    : 0;

  if (role !== 'owner') {
    return (
      <div className="space-y-6">
        <PageHeader title="Suppliers" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldAlert />
            </EmptyMedia>
            <EmptyTitle>Not available for your role</EmptyTitle>
            <EmptyDescription>
              Supplier terms and lead times are owner-only. Switch to the owner account to
              see them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description="Who supplies what, and how long they take."
        meta={
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Read only. Adding or editing suppliers is not wired up.
          </p>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Suppliers"
          value={suppliers.length}
          icon={<Truck className="size-4" />}
        />
        <StatTile
          label="Average lead time"
          value={`${averageLeadTime} days`}
          hint="Feeds the reorder engine"
        />
        <StatTile
          label="Average rating"
          value={averageRating}
          hint="Out of 5"
          icon={<Star className="size-4" />}
        />
        <StatTile
          label="Products covered"
          value={medicines.length}
          hint={`${medicines.filter((m) => !supplierIds.has(m.supplier)).length} unsourced`}
          icon={<Package className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader className="border-b pb-3">
          <h2 className="text-sm font-semibold tracking-tight">Supplier directory</h2>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, contact, phone or address"
              aria-label="Search suppliers"
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Lead time</TableHead>
                <TableHead className="text-right">Rating</TableHead>
                <TableHead>Products supplied</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No supplier matches “{query.trim()}”.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((supplier) => {
                const supplied = suppliedBy.get(supplier.id) ?? [];

                return (
                  <TableRow key={supplier.id}>
                    <TableCell className="font-medium">{supplier.name}</TableCell>
                    <TableCell>{supplier.contactPerson}</TableCell>
                    <TableCell data-numeric className="tabular">
                      {supplier.phone}
                    </TableCell>
                    <TableCell data-numeric className="tabular text-right">
                      {supplier.leadTimeDays} days
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1">
                        <Star className="size-3 text-muted-foreground" />
                        <span data-numeric className="tabular">
                          {supplier.rating}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {supplied.length === 0 ? (
                        <span className="text-sm text-muted-foreground">Nothing</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant="secondary">
                            <Boxes className="size-3" />
                            {supplied.length}
                          </Badge>
                          <span className="max-w-64 truncate text-xs text-muted-foreground">
                            {supplied.map((m) => m.name).join(', ')}
                          </span>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <h2 className="text-sm font-semibold tracking-tight">Supply by product</h2>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead className="text-right">Expiry</TableHead>
                <TableHead>Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {medicines.map((medicine) => {
                const supplier = resolveSupplier(medicine.supplier);
                const batch = medicine.batches[0];

                return (
                  <TableRow key={medicine.id}>
                    <TableCell>
                      <p className="font-medium">{medicine.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {medicine.strength} · {medicine.dosageForm}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {supplier?.name ?? 'Unsourced'}
                    </TableCell>
                    <TableCell data-numeric className="tabular text-muted-foreground">
                      {batch?.batchNumber ?? '—'}
                    </TableCell>
                    <TableCell data-numeric className="tabular text-right text-muted-foreground">
                      {formatDate(medicine.expiryDate)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          medicine.totalQuantity === 0
                            ? 'destructive'
                            : stockStatus(medicine) === 'low_stock'
                              ? 'warning'
                              : 'secondary'
                        }
                      >
                        {medicine.totalQuantity} units
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
