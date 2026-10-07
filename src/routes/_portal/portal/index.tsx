import { useMemo } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowRight, Lock } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { PortalSearchBox } from '~/components/portal-search';
import { Money, StatTile, StatusBadge } from '~/components/app/primitives';
import { formatRelative } from '~/domain/money';
import { refillRows, usePortalCustomer } from '~/lib/portal';
import { useMedicines } from '~/hooks/use-medicines';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_portal/portal/')({
  component: PortalHome,
});

function PortalHome() {
  // No auth. `usePortalCustomer` reads state.customers[0] — see ~/lib/portal.
  const customer = usePortalCustomer();
  const branch = usePharmacy((state) => state.branch);
  const orders = usePharmacy((state) => state.customerOrders);
  // Catalogue from Supabase, sales still local (Sales is a later migration step).
  const { medicines } = useMedicines();
  const sales = usePharmacy((state) => state.sales);
  const rows = useMemo(
    () => (customer === null ? [] : refillRows(customer, medicines, sales)),
    [customer, medicines, sales],
  );

  const myOrders = orders.filter((order) => order.customerId === customer?.id);
  const openOrders = myOrders.filter(
    (order) => order.orderStatus !== 'completed' && order.orderStatus !== 'cancelled',
  );

  // Anything the branch cannot sell today, or has under two weeks of cover.
  const nudges = rows.filter(
    (row) =>
      row.status === 'out_of_stock' ||
      row.status === 'expired' ||
      row.status === 'low_stock' ||
      row.daysUntilRefill <= 14,
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {customer ? `Hello, ${customer.name.split(' ')[0]}` : 'Hello'}
        </h1>
        <p className="text-sm text-muted-foreground">
          What {branch.name} has for you today.
        </p>
      </div>

      {customer === null ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No customer record exists yet. Ask the pharmacist to register you at the counter.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              label="Outstanding"
              value={<Money value={customer.outstandingDebt} />}
              hint={
                customer.outstandingDebt > 0 ? 'Settle at the counter' : 'Nothing owed'
              }
            />
            <StatTile
              label="Wallet"
              value={<Money value={customer.walletBalance} />}
              hint="Credit on your account"
            />
            <StatTile
              label="Total spent"
              value={<Money value={customer.totalSpent} />}
              hint={`${customer.purchaseCount} purchases`}
            />
          </div>

          {/* Search is the one thing a patient wants on every screen, so it is
              a real field here rather than a jump to a search screen. */}
          <PortalSearchBox />

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-tight">Refill soon</h2>
              <Button variant="ghost" size="sm" render={<Link to="/portal/reminders" />}>
                All reminders
                <ArrowRight className="size-4" />
              </Button>
            </div>

            {nudges.length === 0 ? (
              <Card>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Nothing you take is low. We check against live shelf stock, not a
                    fixed list.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <ul className="space-y-2">
                {nudges.slice(0, 4).map((row) => (
                  <li key={row.medicine.id}>
                    <Card size="sm">
                      <CardContent className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {row.medicine.name}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {row.medicine.strength} ·{' '}
                            {row.lastDispensedAt
                              ? `last dispensed ${formatRelative(row.lastDispensedAt)}`
                              : 'no record of a purchase here'}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <StatusBadge status={row.status} />
                          <span className="text-xs text-muted-foreground">
                            {row.status === 'out_of_stock' || row.status === 'expired'
                              ? 'Ask at the counter'
                              : `${row.daysUntilRefill} days of cover left`}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-tight">My orders</h2>
              <Button variant="ghost" size="sm" render={<Link to="/portal/orders" />}>
                All orders
                <ArrowRight className="size-4" />
              </Button>
            </div>

            <Card>
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {openOrders.length} open · {myOrders.length} in total.
                </p>
                {customer.consentForReminders ? (
                  <Badge variant="success">Consented to reminders</Badge>
                ) : (
                  <Badge variant="secondary">No reminder consent</Badge>
                )}
              </CardContent>
            </Card>
          </section>

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3 shrink-0" />
            This portal is read only. Placing an order, uploading a prescription and paying
            a wallet balance are not built — there is no operation behind them yet.
          </p>
        </>
      )}
    </div>
  );
}
