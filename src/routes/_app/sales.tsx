import { Fragment, useMemo, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { Banknote, CalendarDays, ChevronDown, ChevronRight, Lock, Receipt, TrendingUp } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
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
import {
  MaybeMoney,
  Money,
  PageHeader,
  SectionTitle,
  StatTile,
} from '~/components/app/primitives';
import { formatPercent } from '~/domain/money';
import {
  PERIOD_LABEL,
  REPORT_PERIODS,
  saleLines,
  salesInPeriod,
  type ReportPeriod,
} from '~/domain/dashboard';
import { summariseSales } from '~/domain/selectors';
import type { SaleLineRow } from '~/domain/dashboard';
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';

/**
 * Sales ledger — the detail behind the owner dashboard's "Today's Sales" card.
 *
 * ## Why this is a new screen
 *
 * The app had no sales ledger. Sales appeared as a recent-sales list on the
 * dashboard and as per-product aggregates on /reports, but nothing showed the
 * transaction itself: who rang it up, at what time, in which unit, by what
 * payment method. An owner asking "what did we take today, and who took it" had
 * nowhere to go.
 *
 * ## Cost safety
 *
 * This table deliberately carries no cost or margin columns. What it shows —
 * product, quantity, unit sold, staff, time, payment method, sale total — is
 * exactly what the cashier saw when they rang the sale up, so it needs no role
 * gate. The owner-only money is on /reports, reached from the "Gross Profit
 * Today" card.
 *
 * `todaySaleLines` never reads `costPerBaseUnitSnapshot`, so that omission is
 * structural rather than a matter of remembering to hide a field.
 */
export const Route = createFileRoute('/_app/sales')({
  // The dashboard card deep-links with `?period=today`. An arbitrary date-range
  // picker is deliberately not offered: the recorded ledger supports these
  // windows, and faking a free-form range would mean quietly selecting sales by
  // a rule the owner cannot see.
  validateSearch: (search: Record<string, unknown>): { period: ReportPeriod } => {
    const raw = search.period;
    return {
      period: REPORT_PERIODS.includes(raw as ReportPeriod) ? (raw as ReportPeriod) : 'today',
    };
  },
  component: SalesScreen,
});

/** Payment methods as the owner reads them, not as the enum stores them. */
const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  transfer: 'Transfer',
  pos: 'POS terminal',
  credit: 'On account',
  mobile_money: 'Mobile money',
  part_paid: 'Part paid',
};

function paymentLabel(method: string): string {
  return PAYMENT_LABEL[method] ?? method;
}

function SalesScreen() {
  const navigate = useNavigate();
  const { period } = Route.useSearch();
  const sales = usePharmacy((state) => state.sales);
  const { role } = useCurrentUser();
  const isOwner = role === 'owner';

  /** Which multi-item receipt is expanded. `null` = all collapsed. */
  const [expanded, setExpanded] = useState<string | null>(null);

  const inPeriod = useMemo(() => salesInPeriod(sales, period), [sales, period]);
  const summary = useMemo(() => summariseSales(inPeriod), [inPeriod]);

  const rows = useMemo(() => saleLines({ sales }, period), [sales, period]);

  /**
   * Group lines by receipt.
   *
   * A three-item sale is one transaction with three lines, and an owner reading
   * a ledger wants "who took ₦4,500 at 14:02" rather than three orphan rows, so
   * the sale is the unit of the table and lines nest inside it.
   */
  const receipts = useMemo(() => {
    const bySale = new Map<string, SaleLineRow[]>();
    for (const row of rows) {
      const list = bySale.get(row.saleId);
      if (list) list.push(row);
      else bySale.set(row.saleId, [row]);
    }

    // A group is only ever created alongside a row, so none are empty — this
    // narrows the type to "at least one line", which is what the rendering below
    // relies on for `lines[0]`. It is a type assertion, not defensive filtering.
    return [...bySale.entries()].filter(
      (entry): entry is [string, [SaleLineRow, ...SaleLineRow[]]] => entry[1].length > 0,
    );
  }, [rows]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales"
        description="Every recorded sale, by receipt."
        meta={
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Cost and margin figures live on Reports.
          </p>
        }
        actions={
          <Button render={<Link to="/reports" search={{ period }} />}>
            <TrendingUp className="size-4" />
            Profit report
          </Button>
        }
      />

      {/* Writes to the URL so the dashboard's deep link and a choice made here
          are the same thing. "All time" is omitted: a ledger this long is not
          the screen an owner opens to check on today. */}
      <div role="group" aria-label="Sales period" className="flex flex-wrap items-center gap-1.5">
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        <span className="mr-1 text-sm font-medium">Period</span>
        {REPORT_PERIODS.filter((option) => option !== 'all').map((option) => {
          const selected = option === period;
          return (
            <Button
              key={option}
              size="sm"
              variant={selected ? 'default' : 'outline'}
              aria-pressed={selected}
              onClick={() => void navigate({ to: '/sales', search: { period: option } })}
            >
              {PERIOD_LABEL[option]}
            </Button>
          );
        })}
      </div>

      {/* Takings and counts are always safe: money taken in is not a secret, and
          an attendant already sees it on the POS. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total sales"
          value={<Money value={summary.net} compact />}
          hint={`${summary.count} transaction${summary.count === 1 ? '' : 's'}`}
          icon={<Banknote className="size-4" />}
          tone="positive"
        />
        <StatTile
          label="Transactions"
          value={summary.count}
          hint={PERIOD_LABEL[period]}
          icon={<Receipt className="size-4" />}
        />
        <StatTile label="Line items" value={rows.length} hint="Across all receipts" />
        {isOwner && (
          <StatTile
            label="Gross profit"
            value={<MaybeMoney value={summary.margin} compact />}
            hint={
              summary.marginPercent === null
                ? 'Cost of goods not captured for some sales'
                : `${formatPercent(summary.marginPercent)} of net revenue`
            }
            to="/reports"
            actionHint="Open report"
          />
        )}
      </div>

      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle
            action={
              <Button variant="ghost" size="sm" render={<Link to="/pos" />}>
                Open POS
              </Button>
            }
          >
            Sales ledger
          </SectionTitle>
        </CardHeader>
        <CardContent className="px-0">
          {receipts.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Receipt />
                </EmptyMedia>
                <EmptyTitle>No sales in this period</EmptyTitle>
                <EmptyDescription>
                  Nothing was recorded for {PERIOD_LABEL[period].toLowerCase()}. Ring one up on
                  the POS and it will appear here.
                </EmptyDescription>
              </EmptyHeader>
              <Button size="sm" render={<Link to="/pos" />}>
                Open POS
              </Button>
            </Empty>
          ) : (
            // Horizontal scroll rather than a fixed min-width, so the table fits
            // a phone without the whole card overflowing the viewport.
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead>Unit sold</TableHead>
                    <TableHead>Staff</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Sale total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.map(([saleId, lines]) => {
                    const first = lines[0];
                    const open = expanded === saleId;
                    const multi = lines.length > 1;

                    return (
                      // Keyed Fragment, not a bare <>: a keyed fragment is what
                      // lets the receipt row and its nested line rows expand and
                      // collapse without React warning about a list.
                      <Fragment key={saleId}>
                        <TableRow className={multi ? 'bg-muted/40' : undefined}>
                          <TableCell>
                            <div className="flex items-start gap-1.5">
                              {multi && (
                                <button
                                  type="button"
                                  onClick={() => setExpanded(open ? null : saleId)}
                                  aria-expanded={open}
                                  aria-label={`${open ? 'Hide' : 'Show'} line items for ${first.receiptNumber}`}
                                  className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                  {open ? (
                                    <ChevronDown className="size-3.5" />
                                  ) : (
                                    <ChevronRight className="size-3.5" />
                                  )}
                                </button>
                              )}
                              <div className="min-w-0">
                                <p className="font-medium">{first.product}</p>
                                <p className="text-xs text-muted-foreground">
                                  {first.receiptNumber}
                                  {multi && ` · ${lines.length} items`}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell data-numeric className="tabular text-right">
                            {multi ? `${lines.length} lines` : first.quantity}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {multi ? 'Mixed' : first.unitName}
                          </TableCell>
                          <TableCell>{first.staffName}</TableCell>
                          <TableCell data-numeric className="tabular">
                            {first.time}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">
                              {paymentLabel(first.paymentMethod)}
                            </Badge>
                          </TableCell>
                          <TableCell
                            data-numeric
                            className="tabular text-right font-medium"
                          >
                            <Money value={first.saleTotal} />
                          </TableCell>
                        </TableRow>

                        {/* One row per line, so a multi-item receipt keeps each
                            product's own quantity and unit. */}
                        {open &&
                          lines.map((line, index) => (
                            <TableRow key={`${saleId}-${index}`}>
                              <TableCell className="pl-9 text-sm">{line.product}</TableCell>
                              <TableCell data-numeric className="tabular text-right">
                                {line.quantity}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {line.unitName}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {line.staffName}
                              </TableCell>
                              <TableCell
                                data-numeric
                                className="tabular text-muted-foreground"
                              >
                                {line.time}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {paymentLabel(line.paymentMethod)}
                              </TableCell>
                              <TableCell
                                data-numeric
                                className="tabular text-right text-muted-foreground"
                              >
                                <Money value={line.lineTotal} />
                              </TableCell>
                            </TableRow>
                          ))}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
