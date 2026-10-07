import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ArrowUpDown, Lock, Receipt, Search, Users, Wallet } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
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
import {
  Money,
  PageHeader,
  SaleStatusBadge,
  SectionTitle,
  StatTile,
} from '~/components/app/primitives';
import { formatRelative, formatWhen, sum } from '~/domain/money';
import type { Customer, Medicine } from '~/domain/types';
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';
import { useSeedQuery } from '~/lib/use-seed-query';
import { useMedicines } from '~/hooks/use-medicines';
import { useIsOwner } from '~/hooks/use-is-owner';

export const Route = createFileRoute('/_app/customers')({
  // Seeded by the header's global search, so a customer result opens the
  // filtered list.
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  component: CustomersScreen,
});

type SortKey = 'name' | 'debt' | 'spent' | 'purchases' | 'lastPurchase';

const SORTS: { key: SortKey; label: string; ownerOnly?: boolean }[] = [
  { key: 'name', label: 'Name' },
  { key: 'debt', label: 'Debt', ownerOnly: true },
  { key: 'spent', label: 'Total spent', ownerOnly: true },
  { key: 'purchases', label: 'Purchases' },
  { key: 'lastPurchase', label: 'Last purchase' },
];

function matches(customer: Customer, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    customer.name.toLowerCase().includes(needle) ||
    customer.code.toLowerCase().includes(needle) ||
    customer.phone.includes(needle) ||
    (customer.email ?? '').toLowerCase().includes(needle)
  );
}

/** Descending compare that never subtracts money. */
function byDescending(bigger: number, smaller: number): number {
  if (bigger === smaller) return 0;
  return bigger > smaller ? -1 : 1;
}

function compare(a: Customer, b: Customer, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'debt':
      return byDescending(b.outstandingDebt, a.outstandingDebt);
    case 'spent':
      return byDescending(b.totalSpent, a.totalSpent);
    case 'purchases':
      return byDescending(b.purchaseCount, a.purchaseCount);
    case 'lastPurchase':
      return (b.lastPurchaseDate ?? '').localeCompare(a.lastPurchaseDate ?? '');
  }
}

function CustomersScreen() {
  const customers = usePharmacy((state) => state.customers);
  const sales = usePharmacy((state) => state.sales);
  // Catalogue from Supabase in live mode; useMedicines has no local
  // fallback there, so a failed read surfaces as an error, not as seed data.
  const { medicines } = useMedicines();
  // Authoritative: pf_is_owner() reads branch_memberships.role.
  const isOwner = useIsOwner();

  const [query, setQuery] = useSeedQuery(Route.useSearch().q);
  const [sort, setSort] = useState<SortKey>('name');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visible = useMemo(
    () => customers.filter((c) => matches(c, query)).sort((a, b) => compare(a, b, sort)),
    [customers, query, sort],
  );

  const selected = customers.find((c) => c.id === selectedId) ?? null;

  const history = useMemo(
    () => (selected ? sales.filter((sale) => sale.customerId === selected.id) : []),
    [sales, selected],
  );

  const chronic = useMemo(
    () =>
      (selected?.chronicMedications ?? [])
        .map((id) => medicines.find((m) => m.id === id))
        .filter((m): m is Medicine => m !== undefined),
    [medicines, selected],
  );

  const sorts = SORTS.filter((option) => isOwner || !option.ownerOnly);

  const walletFloat = sum(customers.map((c) => c.walletBalance));
  const debtOwed = sum(customers.map((c) => c.outstandingDebt));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Wallets, debts and purchase history."
        meta={
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Read only. Registering and editing customers is not wired up.
          </p>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {isOwner && (
          <StatTile
            label="Wallet float"
            value={<Money value={walletFloat} />}
            hint={`${customers.filter((c) => c.walletBalance > 0).length} customers holding a balance`}
            icon={<Wallet className="size-4" />}
          />
        )}
        {isOwner && (
          <StatTile
            label="Debt owed"
            value={<Money value={debtOwed} />}
            hint={`${customers.filter((c) => c.outstandingDebt > 0).length} with an outstanding balance`}
            icon={<Receipt className="size-4" />}
          />
        )}
        <StatTile
          label="Customers"
          value={customers.length}
          hint={`${visible.length} shown`}
          icon={<Users className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader className="border-b pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, code or phone"
                aria-label="Search customers"
                className="h-8 sm:max-w-64"
              />
            </div>
            <div className="flex items-center gap-2">
              <ArrowUpDown className="size-4 shrink-0 text-muted-foreground" />
              <Select
                value={sort}
                onValueChange={(value) => {
                  if (value) setSort(value as SortKey);
                }}
              >
                <SelectTrigger size="sm" aria-label="Sort customers">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  {sorts.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No customer matches that search.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Phone</TableHead>
                  {isOwner && <TableHead className="text-right">Wallet</TableHead>}
                  {isOwner && <TableHead className="text-right">Debt</TableHead>}
                  {isOwner && <TableHead className="text-right">Total spent</TableHead>}
                  <TableHead className="text-right">Purchases</TableHead>
                  <TableHead>Last purchase</TableHead>
                  <TableHead>Reminders</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((customer) => (
                  <TableRow
                    key={customer.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelectedId(customer.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId(customer.id);
                      }
                    }}
                  >
                    <TableCell>
                      <p className="font-medium">{customer.name}</p>
                      <p data-numeric className="tabular text-xs text-muted-foreground">
                        {customer.code}
                      </p>
                    </TableCell>
                    <TableCell data-numeric className="tabular">
                      {customer.phone}
                    </TableCell>
                    {isOwner && (
                      <TableCell className="text-right">
                        <Money value={customer.walletBalance} />
                      </TableCell>
                    )}
                    {isOwner && (
                      <TableCell className="text-right">
                        <Money value={customer.outstandingDebt} />
                      </TableCell>
                    )}
                    {isOwner && (
                      <TableCell className="text-right">
                        <Money value={customer.totalSpent} />
                      </TableCell>
                    )}
                    <TableCell data-numeric className="tabular text-right">
                      {customer.purchaseCount}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {customer.lastPurchaseDate
                        ? formatRelative(customer.lastPurchaseDate)
                        : 'Never'}
                    </TableCell>
                    <TableCell>
                      {customer.consentForReminders ? (
                        <Badge variant="success">Yes</Badge>
                      ) : (
                        <Badge variant="secondary">No</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name}</SheetTitle>
                <SheetDescription>
                  {selected.code} · {selected.phone}
                  {selected.email ? ` · ${selected.email}` : ''}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 overflow-y-auto px-4 pb-4">
                {isOwner && (
                  <div className="grid grid-cols-2 gap-2">
                    <StatTile label="Wallet" value={<Money value={selected.walletBalance} />} />
                    <StatTile label="Debt" value={<Money value={selected.outstandingDebt} />} />
                    <StatTile label="Total spent" value={<Money value={selected.totalSpent} />} />
                    <StatTile label="Purchases" value={selected.purchaseCount} />
                  </div>
                )}

                {selected.notes && (
                  <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {selected.notes}
                  </p>
                )}

                <div className="space-y-2">
                  <SectionTitle>Chronic medications</SectionTitle>
                  {chronic.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None recorded.</p>
                  ) : (
                    <ul className="divide-y">
                      {chronic.map((medicine) => (
                        <li
                          key={medicine.id}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{medicine.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {medicine.strength} · {medicine.commonUse}
                            </p>
                          </div>
                          <Badge variant="outline" className="shrink-0">
                            {medicine.prescriptionStatus}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-2">
                  <SectionTitle>Purchase history</SectionTitle>
                  {history.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No sales recorded against this customer.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Receipt</TableHead>
                          <TableHead>When</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {history.map((sale) => (
                          <TableRow key={sale.id}>
                            <TableCell data-numeric className="tabular">
                              {sale.receiptNumber}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatWhen(sale.date)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Money value={sale.total} />
                            </TableCell>
                            <TableCell>
                              <SaleStatusBadge status={sale.status} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
