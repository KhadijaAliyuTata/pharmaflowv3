import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Boxes, Lock, Package, ShieldAlert, Star, Truck } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
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
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/suppliers')({
  component: SuppliersScreen,
});

function SuppliersScreen() {
  const suppliers = usePharmacy((state) => state.suppliers);
  const medicines = usePharmacy((state) => state.medicines);
  const { role } = useCurrentUser();

  // medicine.supplier holds the supplier id, so this is a plain join.
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
              {suppliers.map((supplier) => {
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
              })}
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
                const supplier = suppliers.find((s) => s.id === medicine.supplier);
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
