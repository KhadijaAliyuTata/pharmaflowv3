import { Link, createFileRoute } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Banknote,
  ChevronRight,
  Package,
  TrendingUp,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  Money,
  PageHeader,
  SectionTitle,
  StatTile,
  StatusBadge,
} from '~/components/app/primitives';
import { formatRelative } from '~/domain/money';
import { dashboardSnapshot, expiryBuckets, reorderSuggestions } from '~/domain/selectors';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/')({
  component: Dashboard,
});

function Dashboard() {
  // One selector per concern, so a stock edit does not re-render the sales
  // tiles. This is the main reason the store is not a context.
  const snapshot = usePharmacy(dashboardSnapshot);
  const reorder = usePharmacy((state) => reorderSuggestions(state.medicines, state.suppliers));
  const expiring = usePharmacy((state) => expiryBuckets(state.medicines).slice(0, 5));
  const notifications = usePharmacy((state) => state.notifications.filter((n) => !n.read).slice(0, 4));
  const recentSales = usePharmacy((state) => state.sales.slice(0, 5));
  const creditAccounts = usePharmacy((state) => state.creditAccounts);
  const suppliers = usePharmacy((state) => state.suppliers);

  const overLimit = creditAccounts.filter(
    (a) => a.outstandingBalance > a.creditLimit,
  );
  const avgLeadTime = suppliers.length
    ? Math.round(
        suppliers.reduce((total, s) => total + s.leadTimeDays, 0) / suppliers.length,
      )
    : 0;

  const urgent = reorder.filter((r) => r.priority === 'urgent').slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Today at a glance. Anything that needs a decision is at the top."
        actions={
          <Button render={<Link to="/pos" />}>
            New sale
            <ArrowRight />
          </Button>
        }
      />

      {/* What is broken, before what is fine. */}
      {(snapshot.pendingPricing > 0 || snapshot.outOfStockCount > 0 || urgent.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-warning/40 bg-warning/10 px-2 py-2">
          <p className="flex items-center gap-2 px-2 text-sm font-medium text-warning-foreground">
            <TriangleAlert className="size-4 shrink-0" />
            Needs attention
          </p>
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {snapshot.pendingPricing > 0 && (
              <AttentionItem
                to="/pricing"
                count={snapshot.pendingPricing}
                label={snapshot.pendingPricing === 1 ? 'receipt awaiting pricing' : 'receipts awaiting pricing'}
              />
            )}
            {snapshot.outOfStockCount > 0 && (
              <AttentionItem
                to="/inventory"
                count={snapshot.outOfStockCount}
                label={snapshot.outOfStockCount === 1 ? 'product out of stock' : 'products out of stock'}
              />
            )}
            {urgent.length > 0 && (
              <AttentionItem to="/stock-intelligence" count={urgent.length} label="at restock risk" />
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Revenue today"
          value={<Money value={snapshot.todayRevenue} compact className="" />}
          hint={`${snapshot.todayTransactions} transaction${snapshot.todayTransactions === 1 ? '' : 's'}`}
          icon={<Banknote className="size-4" />}
        />
        <StatTile
          label="Margin today"
          value={<Money value={snapshot.todayMargin} compact className="" />}
          hint="After cost of goods"
          icon={<TrendingUp className="size-4" />}
        />
        <StatTile
          label="Outstanding"
          value={<Money value={snapshot.outstandingCredit} compact className="" />}
          hint="Credit accounts and customer debt"
          icon={<Users className="size-4" />}
        />
        <StatTile
          label="Expiring stock"
          value={<Money value={snapshot.expiringValueAtCost} compact className="" />}
          hint={`${snapshot.expiringCount} product${snapshot.expiringCount === 1 ? '' : 's'} within 90 days`}
          icon={<AlertTriangle className="size-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <SectionTitle
              action={
                <Button variant="ghost" size="sm" render={<Link to="/stock-intelligence" />}>
                  See all
                </Button>
              }
            >
              Reorder urgently
            </SectionTitle>
          </CardHeader>
          <CardContent>
            {urgent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing is at risk of running out.
              </p>
            ) : (
              <ul className="divide-y">
                {urgent.map((item) => (
                  <li key={item.medicine.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.medicine.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.reason}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <StatusBadge status="out_of_stock" />
                      <p data-numeric className="tabular mt-1 text-xs text-muted-foreground">
                        <Money value={item.estimatedCost} compact />
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <SectionTitle
              action={
                <Button variant="ghost" size="sm" render={<Link to="/expiry" />}>
                  See all
                </Button>
              }
            >
              Expiring soon
            </SectionTitle>
          </CardHeader>
          <CardContent>
            {expiring.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing is expiring in the next 90 days.
              </p>
            ) : (
              <ul className="divide-y">
                {expiring.map((bucket) => (
                  <li key={bucket.medicine.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{bucket.medicine.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {bucket.daysRemaining < 0
                          ? 'Expired'
                          : `${bucket.daysRemaining} days left`}
                        {' · '}
                        {bucket.quantity} units
                      </p>
                    </div>
                    <StatusBadge status={stockStatusFor(bucket.daysRemaining)} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <SectionTitle
              action={
                <Button variant="ghost" size="sm" render={<Link to="/pos" />}>
                  Open POS
                </Button>
              }
            >
              Recent sales
            </SectionTitle>
          </CardHeader>
          <CardContent>
            {recentSales.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No sales yet.</p>
            ) : (
              <ul className="divide-y">
                {recentSales.map((sale) => (
                  <li key={sale.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p data-numeric className="truncate text-sm font-medium">
                        {sale.receiptNumber}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {sale.attendantName} · {formatRelative(sale.date)}
                        {sale.customerName ? ` · ${sale.customerName}` : ''}
                      </p>
                    </div>
                    <Money value={sale.total} className="shrink-0 text-sm font-medium" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <SectionTitle
              action={
                snapshot.unreadNotifications > 0 ? (
                  <Button variant="ghost" size="sm" render={<Link to="/notifications" />}>
                    {snapshot.unreadNotifications} unread
                  </Button>
                ) : undefined
              }
            >
              Notifications
            </SectionTitle>
          </CardHeader>
          <CardContent>
            {notifications.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                You are all caught up.
              </p>
            ) : (
              <ul className="divide-y">
                {notifications.map((notification) => (
                  <li key={notification.id} className="py-2.5">
                    <div className="flex items-start gap-2">
                      <Bell className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">{notification.title}</p>
                          <Badge
                            variant={
                              notification.severity === 'urgent'
                                ? 'destructive'
                                : notification.severity === 'warning'
                                  ? 'warning'
                                  : 'secondary'
                            }
                          >
                            {notification.severity}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {notification.message}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelative(notification.date)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QuickStat
          to="/inventory"
          icon={<Package className="size-4" />}
          label="Products"
          value={snapshot.stockCount}
          note={`${snapshot.lowStockCount} low`}
        />
        <QuickStat
          to="/orders"
          icon={<Package className="size-4" />}
          label="Customer orders"
          value={snapshot.openRequests}
          note="medicine requests open"
        />
        <QuickStat
          to="/credit-accounts"
          icon={<Users className="size-4" />}
          label="Credit accounts"
          value={creditAccounts.length}
          note={`${overLimit.length} over limit`}
        />
        <QuickStat
          to="/suppliers"
          icon={<Package className="size-4" />}
          label="Suppliers"
          value={suppliers.length}
          note={`${avgLeadTime}-day average lead time`}
        />
      </div>
    </div>
  );
}

function stockStatusFor(daysRemaining: number) {
  if (daysRemaining < 0) return 'expired' as const;
  if (daysRemaining <= 30) return 'expiring_soon' as const;
  return 'low_stock' as const;
}

function AttentionItem({
  to,
  count,
  label,
}: {
  to: string;
  count: number;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto gap-1.5 px-2 py-1 text-warning-foreground hover:bg-warning/20 hover:text-warning-foreground"
      render={<Link to={to} />}
    >
      <span data-numeric className="tabular font-semibold">
        {count}
      </span>
      {label}
      <ChevronRight className="size-3.5 opacity-50" />
    </Button>
  );
}

function QuickStat({
  to,
  icon,
  label,
  value,
  note,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  note: string;
}) {
  return (
    <Button
      variant="outline"
      className="h-auto justify-start gap-3 p-4 text-left"
      render={<Link to={to} />}
    >
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span data-numeric className="tabular block text-sm font-semibold">
          {value}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{note}</span>
      </span>
    </Button>
  );
}
