import type { ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  BadgeCheck,
  CalendarDays,
  Hash,
  Lock,
  Mail,
  Phone,
  Receipt,
  User,
  Wallet,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Separator } from '~/components/ui/separator';
import { Money, StatTile, StatusBadge } from '~/components/app/primitives';
import { formatDate, formatRelative } from '~/domain/money';
import { refillRows, usePortalCustomer } from '~/lib/portal';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_portal/portal/profile')({
  component: PortalProfile,
});

function PortalProfile() {
  const customer = usePortalCustomer();
  const branch = usePharmacy((state) => state.branch);
  const sales = usePharmacy((state) => state.sales);
  const rows = usePharmacy((state) =>
    customer === null ? [] : refillRows(customer, state.medicines, state.sales),
  );

  if (customer === null) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No customer record. Ask the pharmacist to register you at the counter.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const mySales = sales.filter((sale) => sale.customerId === customer.id);
  const unpaid = mySales.filter(
    (sale) => sale.status === 'credit' || sale.status === 'part_paid',
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          What {branch.name} has on file for you.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total spent" value={<Money value={customer.totalSpent} />} />
        <StatTile
          label="Purchases"
          value={customer.purchaseCount}
          hint={`${mySales.length} receipts held at this branch`}
        />
        <StatTile
          label="Outstanding"
          value={<Money value={customer.outstandingDebt} />}
          hint={unpaid.length > 0 ? `${unpaid.length} unpaid receipt(s)` : 'Nothing owed'}
        />
        <StatTile
          label="Wallet"
          value={<Money value={customer.walletBalance} />}
          hint="Spend at the counter"
        />
      </div>

      <Card>
        <CardHeader className="border-b pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight">Details</h2>
            <Badge variant="outline">Read only</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail icon={<User className="size-3.5" />} label="Name">
              {customer.name}
            </Detail>
            <Detail icon={<Hash className="size-3.5" />} label="Customer code">
              <span data-numeric className="tabular">
                {customer.code}
              </span>
            </Detail>
            <Detail icon={<Phone className="size-3.5" />} label="Phone">
              <span data-numeric className="tabular">
                {customer.phone}
              </span>
            </Detail>
            <Detail icon={<Mail className="size-3.5" />} label="Email">
              {customer.email ?? 'Not on file'}
            </Detail>
            <Detail icon={<CalendarDays className="size-3.5" />} label="Registered">
              {formatDate(customer.registeredDate)}
            </Detail>
            <Detail icon={<Receipt className="size-3.5" />} label="Last purchase">
              {customer.lastPurchaseDate
                ? `${formatDate(customer.lastPurchaseDate)} · ${formatRelative(customer.lastPurchaseDate)}`
                : 'Never'}
            </Detail>
            <Detail icon={<Wallet className="size-3.5" />} label="Reminder consent">
              {customer.consentForReminders ? 'Yes' : 'No'}
            </Detail>
            <Detail icon={<BadgeCheck className="size-3.5" />} label="Identity verified">
              {/* Not a claim. Nothing in the app has verified this person. */}
              <span className="text-muted-foreground">Not verified</span>
            </Detail>
          </dl>

          {customer.notes && (
            <>
              <Separator className="my-4" />
              <p className="text-xs text-muted-foreground">{customer.notes}</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b pb-3">
          <h2 className="text-sm font-semibold tracking-tight">Regular medicines</h2>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None recorded. The pharmacist adds these from your prescription history.
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.medicine.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.medicine.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.medicine.strength} · {row.medicine.dosageForm}
                    </p>
                  </div>
                  <StatusBadge status={row.status} className="shrink-0" />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b pb-3">
          <h2 className="text-sm font-semibold tracking-tight">Not available yet</h2>
        </CardHeader>
        <CardContent className="space-y-2">
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>Editing these details</li>
            <li>Identity verification against a BVN, NIN or passport</li>
            <li>Changing reminder consent from the portal</li>
            <li>Signing in as this customer at all</li>
          </ul>
          <p className="text-xs text-muted-foreground">
            There is no operation behind any of them. Update your details at the counter.
          </p>
          <Button variant="outline" size="sm" disabled>
            <Lock className="size-3.5" />
            Edit profile
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {icon}
        {label}
      </dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}
