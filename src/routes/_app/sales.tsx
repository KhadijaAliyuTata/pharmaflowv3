import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  Banknote,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Lock,
  Receipt,
  RotateCcw,
  TrendingUp,
} from 'lucide-react';
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
import { formatNaira, formatPercent } from '~/domain/money';
import {
  PERIOD_LABEL,
  REPORT_PERIODS,
  saleLines,
  salesInPeriod,
  type ReportPeriod,
} from '~/domain/dashboard';
import { summariseSales } from '~/domain/selectors';
import type { SaleLineRow } from '~/domain/dashboard';
import {
  RETURN_REASON_LABEL,
  RETURN_STATUS_LABEL,
  canStartReturn,
  returnedValue,
  saleReturns,
  saleReturnState,
  returnStateLabel,
} from '~/domain/returns';
import type { Sale, SaleReturn } from '~/domain/types';
import { SaleReturnDialog } from '~/components/app/sale-return-dialog';
import { SaleReturnReviewDialog } from '~/components/app/sale-return-review-dialog';
import { useIsOwner } from '~/hooks/use-is-owner';
import { useSales } from '~/hooks/use-sales';
import { toSale } from '~/hooks/sales-mapping';
import {
  getSale,
  listPendingReturns,
  type PendingReturnQueueRow,
} from '~/lib/supabase/sales';

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
  // The ledger from Supabase in live mode, the seeded sales in demo mode. Empty
  // and flagged while it loads or if it fails, never the prototype's receipts.
  // The ledger stays a recent window, but the owner review queue is its own
  // branch-wide read. A busy trading day must not hide a pending return behind
  // the ledger limit.
  const { sales, loading, error, refresh, source } = useSales(200);
  const live = source === 'supabase';
  const isOwner = useIsOwner();

  /** Which multi-item receipt is expanded. `null` = all collapsed. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The sale whose return dialog is open. */
  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  /** A pending return selected by an owner for approval/rejection. */
  const [reviewTarget, setReviewTarget] = useState<{ sale: Sale; entry: SaleReturn } | null>(null);
  /** Confirmation from the server, never an optimistic guess. */
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingQueue, setPendingQueue] = useState<PendingReturnQueueRow[]>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    if (!live || !isOwner) {
      setPendingQueue([]);
      setPendingError(null);
      return;
    }
    const result = await listPendingReturns();
    if (result.ok) {
      setPendingQueue(result.data);
      setPendingError(null);
      return;
    }
    setPendingQueue([]);
    setPendingError(result.error);
  }, [live, isOwner]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const inPeriod = useMemo(() => salesInPeriod(sales, period), [sales, period]);
  const summary = useMemo(() => summariseSales(inPeriod), [inPeriod]);

  const rows = useMemo(() => saleLines({ sales }, period), [sales, period]);
  const salesById = useMemo(() => new Map(sales.map((sale) => [sale.id, sale])), [sales]);
  const settledReturns = useMemo(
    () =>
      inPeriod
        .flatMap((sale) =>
          saleReturns(sale)
            .filter((entry) => entry.status !== 'pending_review')
            .map((entry) => ({ sale, entry })),
        )
        .sort((a, b) => b.entry.createdAt.localeCompare(a.entry.createdAt)),
    [inPeriod],
  );

  async function openReview(row: PendingReturnQueueRow) {
    setNotice(null);
    const result = await getSale(row.sale_id);
    if (!result.ok) {
      setNotice(`The pending return could not be opened: ${result.error}`);
      return;
    }
    const sale = toSale(result.data, '');
    const entry = sale.returns?.find((candidate) => candidate.id === row.id);
    if (!entry) {
      setNotice('The pending return was not found on its sale.');
      return;
    }
    setReviewTarget({ sale, entry });
  }

  function recordNotice(message: string) {
    setNotice(message);
    // The ledger, return badges and pending queue are separate reads.
    refresh();
    void loadPending();
  }

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

      {notice && (
        <p
          role="status"
          className="rounded-lg border border-success-border bg-success-subtle px-3 py-2 text-sm text-success"
        >
          {notice}
        </p>
      )}

      {isOwner && pendingError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
        >
          Pending returns could not be loaded: {pendingError}
        </p>
      )}

      {isOwner && pendingQueue.length > 0 && (
        <Card>
          <CardHeader className="border-b pb-3">
            <SectionTitle>Returns awaiting your review</SectionTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-3">
            {pendingQueue.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {row.return_number} - {row.sales?.receipt_number ?? 'Sale'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {RETURN_REASON_LABEL[row.reason]} - {row.medicine_return_items.length} line
                    {row.medicine_return_items.length === 1 ? '' : 's'} - value{' '}
                    <Money value={Number(row.refund_value)} />
                  </p>
                  {row.note && <p className="mt-1 text-sm">{row.note}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="warning">{RETURN_STATUS_LABEL.pending_review}</Badge>
                  <Button size="sm" variant="outline" onClick={() => void openReview(row)}>
                    Review
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {settledReturns.length > 0 && (
        <Card>
          <CardHeader className="border-b pb-3">
            <SectionTitle>Returns in this period</SectionTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-3">
            {settledReturns.map(({ sale, entry }) => {
              const restocked = entry.items.reduce(
                (total, item) => total + item.restockedUnits,
                0,
              );
              const quarantined = entry.items.reduce(
                (total, item) => total + item.quarantinedUnits,
                0,
              );
              return (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {entry.returnNumber} · {sale.receiptNumber}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {RETURN_REASON_LABEL[entry.reason]} ·{' '}
                      {entry.items.length} line{entry.items.length === 1 ? '' : 's'} · value{' '}
                      <Money value={entry.refundValue} />
                      {entry.creditApplied > 0 && ` · credit ${formatNaira(entry.creditApplied)}`}
                      {entry.refundAmount > 0 && ` · refund ${formatNaira(entry.refundAmount)}`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {restocked} restocked
                      {quarantined > 0 ? ` · ${quarantined} quarantined` : ''}
                    </p>
                  </div>
                  <Badge variant={entry.status === 'completed' ? 'secondary' : 'outline'}>
                    {RETURN_STATUS_LABEL[entry.status]}
                  </Badge>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Takings and counts are always safe: money taken in is not a secret, and
          an attendant already sees it on the POS. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Net sales"
          value={<Money value={summary.netAfterReturns} compact />}
          hint={
            summary.returned > 0
              ? `${summary.count} transaction${summary.count === 1 ? '' : 's'} · ${formatNaira(summary.returned)} returned`
              : `${summary.count} transaction${summary.count === 1 ? '' : 's'}`
          }
          icon={<Banknote className="size-4" />}
          tone="positive"
        />
        {summary.returned > 0 && (
          <StatTile
            label="Returns"
            value={<Money value={summary.returned} compact />}
            hint="Accepted in this period"
            icon={<RotateCcw className="size-4" />}
            tone="warning"
          />
        )}
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
          {error ? (
            <p role="alert" className="px-4 py-8 text-center text-sm text-muted-foreground">
              {error}
            </p>
          ) : loading && receipts.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Loading sales…
            </p>
          ) : receipts.length === 0 ? (
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
                    <TableHead className="text-right">Return</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.map(([saleId, lines]) => {
                    const first = lines[0];
                    const open = expanded === saleId;
                    const multi = lines.length > 1;
                    const sale = salesById.get(saleId);
                    const returnState = sale ? saleReturnState(sale) : 'none';
                    const returnedAmount = sale ? returnedValue(sale) : 0;

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
                                {returnState !== 'none' && (
                                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                    <Badge
                                      variant={returnState === 'pending' ? 'warning' : 'secondary'}
                                    >
                                      {returnStateLabel(returnState)}
                                    </Badge>
                                    {returnedAmount > 0 && (
                                      <span className="text-xs text-muted-foreground">
                                        {formatNaira(returnedAmount)} returned
                                      </span>
                                    )}
                                  </div>
                                )}
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
                          <TableCell className="text-right">
                            {live && sale && canStartReturn(sale) && returnState !== 'returned' && (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => {
                                  setNotice(null);
                                  setReturnSale(sale);
                                }}
                              >
                                <RotateCcw className="size-3.5" />
                                Return
                              </Button>
                            )}
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
                              <TableCell />
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

      <SaleReturnDialog
        sale={returnSale}
        isOwner={isOwner}
        onClose={() => setReturnSale(null)}
        onRecorded={recordNotice}
      />

      {reviewTarget && (
        <SaleReturnReviewDialog
          sale={reviewTarget.sale}
          entry={reviewTarget.entry}
          onClose={() => setReviewTarget(null)}
          onRecorded={recordNotice}
        />
      )}
    </div>
  );
}
