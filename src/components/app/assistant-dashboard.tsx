import { useMemo, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Banknote,
  CalendarClock,
  Package,
  Receipt,
  ScanBarcode,
  ShoppingCart,
  Tablets,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { PageHeader, SaleStatusBadge, SectionTitle, StatTile } from './primitives';
import { formatNaira, formatRelative } from '~/domain/money';
import { expiringStockSummary } from '~/domain/dashboard';
import {
  expiryBuckets,
  salesSince,
  stockStatus,
  summariseSales,
} from '~/domain/selectors';
import { useMedicines } from '~/hooks/use-medicines';
import { useSales } from '~/hooks/use-sales';
import { useCurrentUser } from '~/store/pharmacy';
import { useBranchName } from '~/lib/supabase/branch-context';

/**
 * The attendant's landing screen.
 *
 * The owner dashboard answers "how is the business doing?" with money, margin and
 * audit history. An attendant starts the day with a different question: what is
 * happening at the counter right now, and what needs attention on the shelf?
 *
 * This view therefore shows takings, transaction count, low stock and expiry - all
 * of which a counter role is entitled to see - and deliberately never renders
 * cost, margin, stock valuation, credit balances or the audit ledger. Hiding those
 * figures here is presentation, not security: RLS still refuses the underlying
 * reads for an attendant.
 *
 * It is a separate component rather than a set of `isOwner` conditionals in the
 * owner dashboard so the owner-only queries and audit feed are never mounted for
 * an assistant in the first place.
 */
export function AssistantDashboard() {
  const user = useCurrentUser();
  const branchName = useBranchName();
  const { medicines, loading: medicinesLoading } = useMedicines();
  const { sales, loading: salesLoading, error: salesError } = useSales();

  const todaySales = useMemo(() => salesSince(sales, 24), [sales]);
  const today = useMemo(() => summariseSales(todaySales), [todaySales]);
  const unitsSold = useMemo(
    () =>
      todaySales.reduce(
        (total, sale) =>
          sale.status === 'voided'
            ? total
            : total + sale.items.reduce((lineTotal, item) => lineTotal + item.quantity, 0),
        0,
      ),
    [todaySales],
  );

  const lowStock = useMemo(
    () =>
      medicines.filter((medicine) => {
        const status = stockStatus(medicine);
        return status === 'low_stock' || status === 'out_of_stock';
      }),
    [medicines],
  );

  const expiring = useMemo(() => expiryBuckets(medicines).slice(0, 5), [medicines]);
  const expiringSummary = useMemo(() => expiringStockSummary({ medicines }), [medicines]);

  const recentSales = useMemo(
    () =>
      [...sales]
        .filter((sale) => sale.status !== 'voided')
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(0, 5),
    [sales],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Counter dashboard"
        description={
          branchName
            ? `Today at ${branchName}. Signed in as ${user.name}.`
            : `Signed in as ${user.name}.`
        }
        meta={
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">Assistant view</Badge>
            <span>Purchase costs and margins are hidden for this role.</span>
          </div>
        }
        actions={
          <Button render={<Link to="/pos" />}>
            <ShoppingCart />
            New sale
          </Button>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Today's takings"
          value={<span>{formatNaira(today.net)}</span>}
          hint={`${today.count} ${today.count === 1 ? 'transaction' : 'transactions'}`}
          icon={<Banknote className="size-4" />}
          tone="positive"
          to="/sales"
          loading={salesLoading}
        />
        <StatTile
          label="Items sold"
          value={unitsSold}
          hint="Units across today's sales"
          icon={<Tablets className="size-4" />}
          loading={salesLoading}
        />
        <StatTile
          label="Low stock"
          value={lowStock.length}
          hint={lowStock.length === 1 ? 'Product needs restocking' : 'Products need restocking'}
          icon={<Package className="size-4" />}
          tone={lowStock.length > 0 ? 'warning' : 'neutral'}
          to="/inventory"
          loading={medicinesLoading}
        />
        <StatTile
          label="Expiring soon"
          value={expiringSummary.productCount}
          hint={
            expiringSummary.expiredCount > 0
              ? `${expiringSummary.expiredCount} already expired`
              : 'Inside the expiry warning window'
          }
          icon={<CalendarClock className="size-4" />}
          tone={expiringSummary.expiredCount > 0 ? 'critical' : 'warning'}
          to="/expiry"
          loading={medicinesLoading}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle>Quick actions</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <QuickAction to="/pos" icon={<ShoppingCart className="size-4" />} label="Record a sale" />
          <QuickAction
            to="/stock-receiving"
            icon={<ScanBarcode className="size-4" />}
            label="Receive stock"
          />
          <QuickAction to="/inventory" icon={<Package className="size-4" />} label="Check products" />
          <QuickAction
            to="/expiry"
            icon={<CalendarClock className="size-4" />}
            label="Review expiry"
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SectionTitle>Recent sales</SectionTitle>
            <Button
              variant="ghost"
              size="sm"
              render={<Link to="/sales" search={{ period: 'today' }} />}
            >
              View all
            </Button>
          </CardHeader>
          <CardContent>
            {salesLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Loading today's sales...
              </p>
            ) : salesError ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Sales could not be loaded. Reconnect and try again.
              </p>
            ) : recentSales.length === 0 ? (
              <div className="py-8 text-center">
                <Receipt className="mx-auto size-8 text-muted-foreground/60" />
                <p className="mt-2 text-sm font-medium">No sales recorded yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Completed sales appear here for everyone at the counter.
                </p>
              </div>
            ) : (
              <ul className="divide-y">
                {recentSales.map((sale) => (
                  <li key={sale.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{sale.receiptNumber}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatRelative(sale.date)}
                        {sale.customerName ? ` - ${sale.customerName}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p data-numeric className="tabular text-sm font-semibold">
                        {formatNaira(sale.total)}
                      </p>
                      <SaleStatusBadge status={sale.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SectionTitle>Stock watch</SectionTitle>
            <span className="text-xs text-muted-foreground">No costs shown</span>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <TriangleAlert className="size-3.5 text-warning" />
                Low or out of stock
              </div>
              {medicinesLoading ? (
                <p className="py-3 text-sm text-muted-foreground">Checking stock...</p>
              ) : lowStock.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">Everything is above its reorder level.</p>
              ) : (
                <ul className="space-y-1.5">
                  {lowStock.slice(0, 5).map((medicine) => (
                    <li key={medicine.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate">{medicine.name}</span>
                      <Badge variant={stockStatus(medicine) === 'out_of_stock' ? 'destructive' : 'warning'}>
                        {stockStatus(medicine) === 'out_of_stock' ? 'Out of stock' : 'Low'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t pt-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <CalendarClock className="size-3.5 text-warning" />
                Expiring or expired
              </div>
              {medicinesLoading ? (
                <p className="py-3 text-sm text-muted-foreground">Checking expiry dates...</p>
              ) : expiring.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">No batches inside the warning window.</p>
              ) : (
                <ul className="space-y-1.5">
                  {expiring.map((bucket) => (
                    <li
                      key={bucket.medicine.id}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="truncate">{bucket.medicine.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {bucket.daysRemaining < 0
                          ? `Expired ${Math.abs(bucket.daysRemaining)}d ago`
                          : `${bucket.daysRemaining}d left`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Need a purchase cost, margin or stock valuation? Ask the owner - those figures
        are restricted to the owner role and are not available from this account.
      </p>
    </div>
  );
}

function QuickAction({
  to,
  icon,
  label,
}: {
  to: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button
      variant="outline"
      className="h-auto justify-start gap-3 p-4"
      render={<Link to={to} />}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </Button>
  );
}
