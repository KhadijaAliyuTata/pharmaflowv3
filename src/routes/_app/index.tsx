import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Banknote,
  Bell,
  ChevronRight,
  Coins,
  Inbox,
  Lock,
  Package,
  Radio,
  ShieldCheck,
  TriangleAlert,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { OwnerHeader } from '~/components/app/owner-header';
import {
  MaybeMoney,
  Money,
  SectionTitle,
  StatTile,
} from '~/components/app/primitives';
import { formatPercent, formatRelative } from '~/domain/money';
import { ACTION_LABEL, ACTION_TONE, LEDGER_ACTION_ORDER } from '~/domain/audit-labels';
import {
  EMPTY_LEDGER_FILTER,
  demandRadar,
  demandRadarSummary,
  expiringStockSummary,
  grossProfitToday,
  ledgerActors,
  operationalActivities,
  stockValuation,
  stockValuationTotals,
  teamMembers,
  type LedgerFilter,
} from '~/domain/dashboard';
import { dashboardSnapshot, reorderSuggestions } from '~/domain/selectors';
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/')({
  component: Dashboard,
});

const ALL = 'all';

/**
 * The owner dashboard.
 *
 * ## Structure follows the owner's question order
 *
 * Which pharmacy am I looking at → what did I take today → what did I keep →
 * what is my money sitting on → what happened → who did it → what needs
 * attention. Identity and money lead; reference lists trail. Every metric is a
 * link into the screen that explains it, because a dashboard figure that cannot
 * be opened is decoration.
 *
 * ## One audit log, not two
 *
 * "Recent Pharmacy Activities" and "Operational Activities" both read
 * `state.auditEvents` through `operationalActivities`. The first is the latest
 * handful with a link to the full log on /staff; the second is the same log with
 * the staff and action filters, so "who did what, and when" is answerable without
 * leaving the dashboard. Neither writes a record — every entry here was already
 * recorded by the operation that caused it.
 *
 * ## Cost safety
 *
 * Cost-derived figures go through `MaybeMoney`, which renders `—`. An
 * assistant's session has no `costPerBaseUnit` in the first place, so gross
 * profit and stock value read as unavailable rather than as ₦0.
 */
function Dashboard() {
  // One selector per concern, so a stock edit does not re-render the sales
  // figures. This is the main reason the store is not a context.
  const snapshot = usePharmacy(dashboardSnapshot);
  const reorder = usePharmacy((state) => reorderSuggestions(state.medicines, state.suppliers));
  const notifications = usePharmacy((state) =>
    state.notifications.filter((n) => !n.read).slice(0, 4),
  );
  const creditAccounts = usePharmacy((state) => state.creditAccounts);
  const suppliers = usePharmacy((state) => state.suppliers);
  const medicines = usePharmacy((state) => state.medicines);
  const sales = usePharmacy((state) => state.sales);
  const auditEvents = usePharmacy((state) => state.auditEvents);
  const medicineRequests = usePharmacy((state) => state.medicineRequests);
  const users = usePharmacy((state) => state.users);
  const branch = usePharmacy((state) => state.branch);
  const user = useCurrentUser();
  const isOwner = user.role === 'owner';

  // Operational Activities filters.
  const [ledgerFilter, setLedgerFilter] = useState<LedgerFilter>(EMPTY_LEDGER_FILTER);

  const overLimit = creditAccounts.filter((a) => a.outstandingBalance > a.creditLimit);
  const avgLeadTime = suppliers.length
    ? Math.round(suppliers.reduce((total, s) => total + s.leadTimeDays, 0) / suppliers.length)
    : 0;
  const urgent = reorder.filter((r) => r.priority === 'urgent').slice(0, 5);

  /* ----------------------------------------------------------- dashboard money */

  const profit = useMemo(() => grossProfitToday({ sales }), [sales]);
  const valuation = useMemo(() => stockValuation({ medicines }), [medicines]);
  const valuationTotals = useMemo(() => stockValuationTotals(valuation), [valuation]);

  const expiring = useMemo(() => expiringStockSummary({ medicines }), [medicines]);
  const radar = useMemo(() => demandRadar({ medicineRequests }, 7), [medicineRequests]);
  const radarSummary = useMemo(() => demandRadarSummary(radar), [radar]);
  const team = useMemo(() => teamMembers({ users, sales }), [users, sales]);

  /* ------------------------------------------------------------ audit ledger */

  const ledger = useMemo(
    () => operationalActivities(auditEvents, ledgerFilter),
    [auditEvents, ledgerFilter],
  );
  const recentActivity = useMemo(
    () => operationalActivities(auditEvents, EMPTY_LEDGER_FILTER).slice(0, 6),
    [auditEvents],
  );
  const actors = useMemo(() => ledgerActors(auditEvents), [auditEvents]);
  // Only offer an action filter for actions actually present, so the dropdown
  // cannot offer a filter that returns nothing.
  const actionOptions = useMemo(() => {
    const present = new Set(auditEvents.map((event) => event.action));
    return LEDGER_ACTION_ORDER.filter((action) => present.has(action));
  }, [auditEvents]);

  return (
    <div className="space-y-6">
      {/* 1–3. Which pharmacy, who is signed in. */}
      <OwnerHeader branch={branch} user={user} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button render={<Link to="/pos" />}>
          New sale
          <ArrowRight />
        </Button>
        <p className="text-xs text-muted-foreground">
          {user.role === 'owner'
            ? 'Owner view · cost and margin figures are shown.'
            : 'Volume view · cost and margin figures are hidden.'}
        </p>
      </div>

      {/* What is broken, before what is fine. */}
      {(snapshot.pendingPricing > 0 || snapshot.outOfStockCount > 0 || urgent.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-warning-border bg-warning-subtle px-2 py-2">
          <p className="flex items-center gap-2 px-2 text-sm font-medium text-warning">
            <TriangleAlert className="size-4 shrink-0" />
            Needs attention
          </p>
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {snapshot.pendingPricing > 0 && (
              <AttentionItem
                to="/pricing"
                count={snapshot.pendingPricing}
                label={
                  snapshot.pendingPricing === 1
                    ? 'receipt awaiting pricing'
                    : 'receipts awaiting pricing'
                }
              />
            )}
            {snapshot.outOfStockCount > 0 && (
              <AttentionItem
                to="/inventory"
                count={snapshot.outOfStockCount}
                label={
                  snapshot.outOfStockCount === 1
                    ? 'product out of stock'
                    : 'products out of stock'
                }
              />
            )}
            {urgent.length > 0 && (
              <AttentionItem
                to="/stock-intelligence"
                count={urgent.length}
                label="at restock risk"
              />
            )}
          </div>
        </div>
      )}

      {/* 4–6. The three headline figures. Each opens the screen that explains it. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {/* Today's Sales. Takings are always knowable — money taken in is not a
            secret — so this card is not owner-gated. */}
        <StatTile
          label="Today's Sales"
          value={<Money value={profit.sales} compact />}
          hint={`${profit.transactionCount} transaction${profit.transactionCount === 1 ? '' : 's'} · ${profit.lineCount} line${profit.lineCount === 1 ? '' : 's'}`}
          icon={<Banknote className="size-4" />}
          tone="positive"
          to="/sales"
          actionHint="Open sales ledger"
        />

        {/* Gross Profit Today. From `summariseSales`, which returns null when any
            sale line lacks a cost snapshot — so this reads "—" rather than a
            fabricated profit for a session that cannot see cost. */}
        <StatTile
          label="Gross Profit Today"
          value={
            isOwner ? (
              <MaybeMoney value={profit.grossProfit} compact />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-base text-muted-foreground">
                <Lock className="size-4" />
                Owner only
              </span>
            )
          }
          hint={
            isOwner
              ? profit.grossMarginPercent === null
                ? 'Cost of goods not captured for some sales'
                : `${formatPercent(profit.grossMarginPercent)} margin`
              : 'Cost and margin are hidden'
          }
          icon={<TrendingUp className="size-4" />}
          tone={isOwner && profit.grossProfit !== null ? 'positive' : 'neutral'}
          to="/reports"
          actionHint="Open profit report"
        />

        {/* Stock Value, at current inventory cost. */}
        <StatTile
          label="Stock Value"
          value={
            isOwner ? (
              <MaybeMoney value={valuationTotals.costValue} compact />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-base text-muted-foreground">
                <Lock className="size-4" />
                Owner only
              </span>
            )
          }
          hint={
            isOwner
              ? `At cost · ${valuationTotals.productCount} product${valuationTotals.productCount === 1 ? '' : 's'} in stock`
              : 'Stock valuation is owner-only'
          }
          icon={<Coins className="size-4" />}
          tone={isOwner ? 'positive' : 'neutral'}
          to="/stock-value"
          actionHint="Open stock value"
        />
      </div>

      {/* 7. Recent Pharmacy Activities. */}
      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle
            action={
              <Button variant="ghost" size="sm" render={<Link to="/staff" />}>
                View Full Audit Log
                <ChevronRight className="size-3.5" />
              </Button>
            }
          >
            Recent Pharmacy Activities
          </SectionTitle>
        </CardHeader>
        <CardContent className="px-0">
          {recentActivity.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No activity recorded yet.
            </p>
          ) : (
            <ul className="divide-y">
              {recentActivity.map((event) => (
                <li
                  key={event.id}
                  className="flex items-start gap-3 px-4 py-2.5"
                >
                  <Badge variant={ACTION_TONE[event.action]} className="mt-0.5 shrink-0">
                    {ACTION_LABEL[event.action]}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{event.description}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {event.actorName}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelative(event.timestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 8. Pharmacy Team / staff accountability. */}
      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle
            action={
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link to="/staff" />}
                >
                  <UserPlus className="size-3.5" />
                  Add Staff
                </Button>
              </div>
            }
          >
            Pharmacy Team — {team.length} member{team.length === 1 ? '' : 's'}
          </SectionTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-0">
          {team.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No staff on this branch yet.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="text-right">Sales total</TableHead>
                      <TableHead className="text-right">Discounts</TableHead>
                      <TableHead>Access</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {team.map((member) => (
                      <TableRow key={member.userId}>
                        <TableCell className="font-medium">{member.name}</TableCell>
                        <TableCell data-numeric className="tabular text-muted-foreground">
                          {member.phone}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {member.roleLabel}
                        </TableCell>
                        {/* Takings and discounts given are what the audit log
                            already proves, so they are the accountability
                            figures. Discounts are owner-only. */}
                        <TableCell data-numeric className="tabular text-right">
                          {isOwner ? (
                            <Money value={member.salesTotal} compact />
                          ) : (
                            <span className="text-muted-foreground">
                              {member.transactionCount} sales
                            </span>
                          )}
                        </TableCell>
                        <TableCell data-numeric className="tabular text-right">
                          {isOwner ? (
                            <Money value={member.discountTotal} compact />
                          ) : (
                            <Lock className="ml-auto size-3.5 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="success" className="gap-1">
                            <ShieldCheck className="size-3" />
                            Active
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Why this is not a form. Adding a staff member needs an
                  authentication account created server-side; there is no
                  client-side operation for it, and inventing one would either
                  fail silently or write a fake user. */}
              <p className="flex items-start gap-1.5 px-4 text-xs text-muted-foreground">
                <Lock className="mt-0.5 size-3 shrink-0" />
                Creating a staff account, and revoking access when someone leaves,
                need the Supabase admin API and are not wired up. Until they are,
                no credential or impersonation control is offered here — see
                /staff for the audit trail.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* 9. Operational Activities — the filterable ledger. */}
      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle
            action={
              <Button variant="ghost" size="sm" render={<Link to="/staff" />}>
                Full audit log
                <ChevronRight className="size-3.5" />
              </Button>
            }
          >
            Operational Activities
          </SectionTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-0">
          {/* Two filters plus a free-text box, over the one audit log. */}
          <div className="grid grid-cols-1 gap-2 px-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label
                htmlFor="ledger-actor"
                className="text-xs font-medium text-muted-foreground"
              >
                Staff
              </label>
              <Select
                value={ledgerFilter.actorName ?? ALL}
                onValueChange={(value) =>
                  setLedgerFilter((current) => ({
                    ...current,
                    actorName: value === ALL ? null : value,
                  }))
                }
              >
                <SelectTrigger id="ledger-actor" className="w-full">
                  <SelectValue placeholder="All Staff" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All Staff</SelectItem>
                  {actors.map((actor) => (
                    <SelectItem key={actor} value={actor}>
                      {actor}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="ledger-action"
                className="text-xs font-medium text-muted-foreground"
              >
                Action Type
              </label>
              <Select
                value={ledgerFilter.action ?? ALL}
                onValueChange={(value) =>
                  setLedgerFilter((current) => ({
                    ...current,
                    action: value === ALL ? null : value,
                  }))
                }
              >
                <SelectTrigger id="ledger-action" className="w-full">
                  <SelectValue placeholder="All Action Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All Action Types</SelectItem>
                  {actionOptions.map((action) => (
                    <SelectItem key={action} value={action}>
                      {ACTION_LABEL[action]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label htmlFor="ledger-query" className="text-xs font-medium text-muted-foreground">
                Search
              </label>
              <Input
                id="ledger-query"
                value={ledgerFilter.query}
                placeholder="Search activity"
                onChange={(event) =>
                  setLedgerFilter((current) => ({ ...current, query: event.target.value }))
                }
              />
            </div>
          </div>

          {ledger.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No activity matches these filters.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>What happened</TableHead>
                    <TableHead>Staff</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.slice(0, 100).map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatRelative(event.timestamp)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={ACTION_TONE[event.action]}>
                          {ACTION_LABEL[event.action]}
                        </Badge>
                      </TableCell>
                      <TableCell>{event.description}</TableCell>
                      <TableCell className="whitespace-nowrap">{event.actorName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {ledger.length > 100 && (
            <p className="px-4 text-xs text-muted-foreground">
              Showing the 100 most recent of {ledger.length} matching entries.{' '}
              <Link to="/staff" className="underline underline-offset-2">
                Open the full audit log
              </Link>{' '}
              for the rest.
            </p>
          )}
        </CardContent>
      </Card>

      {/* 10. Expiring Stock — a concise card, not the detailed list. The per-batch
          table stays on /expiry, so there is one expiry calculation in the app. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatTile
          label="Expiring Stock"
          value={
            <span>
              {expiring.productCount}{' '}
              <span className="text-base font-normal text-muted-foreground">
                product{expiring.productCount === 1 ? '' : 's'}
              </span>
              {' · '}
              {expiring.unitsAffected}{' '}
              <span className="text-base font-normal text-muted-foreground">units</span>
            </span>
          }
          hint={
            expiring.expiredCount > 0
              ? `${expiring.expiredCount} already past date · ${expiring.criticalCount} within 30 days`
              : `${expiring.criticalCount} within 30 days · next 90 days`
          }
          icon={<AlertTriangle className="size-4" />}
          tone={
            expiring.expiredCount > 0 ? 'critical' : expiring.productCount > 0 ? 'warning' : 'neutral'
          }
          to="/expiry"
          actionHint="Open expiry screen"
        />

        {/* 11. Demand Radar. Real recorded requests, or an honest zero. */}
        <StatTile
          label="Demand Radar"
          value={
            <span>
              {radarSummary.openCount}{' '}
              <span className="text-base font-normal text-muted-foreground">
                unmet request{radarSummary.openCount === 1 ? '' : 's'} this week
              </span>
            </span>
          }
          hint={
            radarSummary.requestCount === 0
              ? 'No customer requests recorded'
              : `${radarSummary.productCount} product${radarSummary.productCount === 1 ? '' : 's'} · ${radarSummary.unitsRequested} units asked for`
          }
          icon={<Radio className="size-4" />}
          tone={radarSummary.emergencies > 0 ? 'warning' : 'neutral'}
          to="/demand-radar"
          actionHint="Open demand radar"
        />
      </div>

      {/* Operational detail that did not earn a headline slot. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                  <li
                    key={item.medicine.id}
                    className="flex items-start justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.medicine.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{item.reason}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <Badge variant="destructive">Out of stock</Badge>
                      {/* Estimated cost is a purchase price, so it follows the
                          same owner gate as everywhere else. */}
                      {isOwner && (
                        <p data-numeric className="tabular mt-1 text-xs text-muted-foreground">
                          <MaybeMoney value={item.estimatedCost} compact />
                        </p>
                      )}
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QuickStat
          to="/inventory"
          icon={<Package className="size-4" />}
          label="Products"
          value={snapshot.stockCount}
          note={`${snapshot.lowStockCount} low`}
        />
        <QuickStat
          to="/orders"
          icon={<Inbox className="size-4" />}
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
          icon={<Activity className="size-4" />}
          label="Suppliers"
          value={suppliers.length}
          note={`${avgLeadTime}-day average lead time`}
        />
      </div>

    </div>
  );
}

function AttentionItem({ to, count, label }: { to: string; count: number; label: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto gap-1.5 px-2 py-1 text-warning hover:bg-warning/15 hover:text-warning"
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
      <span className="shrink-0 text-muted-foreground">{icon}</span>
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
