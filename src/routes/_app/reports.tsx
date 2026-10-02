import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Banknote, Lock, Receipt, TrendingDown } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '~/components/ui/chart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Money, PageHeader, Percent, SectionTitle, StatTile } from '~/components/app/primitives';
import { add, formatDate, formatNaira, formatPercent, percentOf } from '~/domain/money';
import { dailyRevenue, marginPercent, summariseSales, unitMargin } from '~/domain/selectors';
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/reports')({
  component: ReportsScreen,
});

const REVENUE_CONFIG = {
  revenue: { label: 'Revenue', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const MARGIN_CONFIG = {
  margin: { label: 'Margin', color: 'var(--chart-1)' },
  cost: { label: 'Cost of goods', color: 'var(--chart-3)' },
} satisfies ChartConfig;

/** Anything below this is a pricing conversation, not a margin. */
const THIN_MARGIN = 20;

function shortLabel(name: string): string {
  return name.length > 20 ? `${name.slice(0, 19)}…` : name;
}

/** Descending compare that never subtracts money. */
function byDescending(bigger: number, smaller: number): number {
  if (bigger === smaller) return 0;
  return bigger > smaller ? -1 : 1;
}

const compact = (value: number) => formatNaira(Number(value), { compact: true });

function ReportsScreen() {
  const sales = usePharmacy((state) => state.sales);
  const medicines = usePharmacy((state) => state.medicines);
  const suppliers = usePharmacy((state) => state.suppliers);
  const { role } = useCurrentUser();
  const isOwner = role === 'owner';

  const supplierName = (id: string) =>
    suppliers.find((supplier) => supplier.id === id)?.name ?? 'Unsourced';

  const summary = useMemo(() => summariseSales(sales), [sales]);

  const daily = useMemo(
    () => dailyRevenue(sales, 7).map((day) => ({ date: day.date, revenue: day.value })),
    [sales],
  );

  const marginSplit = useMemo(
    () => [
      { label: 'Margin', value: summary.margin, fill: 'var(--chart-1)' },
      { label: 'Cost of goods', value: summary.cost, fill: 'var(--chart-3)' },
    ],
    [summary],
  );

  const topProducts = useMemo(() => {
    const totals = new Map<string, { name: string; revenue: number; units: number }>();

    for (const sale of sales) {
      if (sale.status === 'voided') continue;
      for (const item of sale.items) {
        const entry = totals.get(item.medicineId) ?? {
          name: item.medicineName,
          revenue: 0,
          units: 0,
        };
        entry.revenue = add(entry.revenue, item.lineTotal);
        entry.units += item.quantity;
        totals.set(item.medicineId, entry);
      }
    }

    return Array.from(totals.entries())
      .map(([medicineId, entry]) => ({
        medicineId,
        name: entry.name,
        label: shortLabel(entry.name),
        revenue: entry.revenue,
        units: entry.units,
      }))
      .sort((a, b) => byDescending(b.revenue, a.revenue))
      .slice(0, 6);
  }, [sales]);

  const thinMargins = useMemo(
    () =>
      medicines
        .map((medicine) => ({ medicine, percent: marginPercent(medicine) }))
        .filter((entry) => entry.percent < THIN_MARGIN)
        .sort((a, b) => byDescending(a.percent, b.percent)),
    [medicines],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={
          isOwner
            ? 'Revenue, margin and what is losing money.'
            : 'Volume only. Revenue and cost figures are owner-only.'
        }
        meta={
          <p className="text-xs text-muted-foreground">
            Derived from recorded sales. Export and date-range filters are not wired up.
          </p>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Transactions"
          value={summary.count}
          hint="Recorded sales, voids excluded"
          icon={<Receipt className="size-4" />}
        />
        {isOwner && (
          <>
            <StatTile
              label="Net revenue"
              value={<Money value={summary.net} compact />}
              hint={`${formatPercent(percentOf(summary.discount, summary.gross))} of gross discounted off`}
              icon={<Banknote className="size-4" />}
            />
            <StatTile
              label="Gross margin"
              value={<Money value={summary.margin} compact />}
              hint={`${formatPercent(summary.marginPercent)} of net revenue`}
            />
            <StatTile
              label="Discounts given"
              value={<Money value={summary.discount} compact />}
              hint="Across all sales"
            />
            <StatTile
              label="Outstanding"
              value={<Money value={summary.outstanding} compact />}
              hint="Credit and part-paid sales"
            />
          </>
        )}
      </div>

      {!isOwner && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3" />
          Revenue, margin and cost figures are hidden for assistants.
        </p>
      )}

      {isOwner ? (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <SectionTitle>Daily revenue, last 7 days</SectionTitle>
              </CardHeader>
              <CardContent className="px-2">
                <ChartContainer config={REVENUE_CONFIG} className="aspect-auto h-64 w-full">
                  <BarChart data={daily}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={16}
                      tickFormatter={(value) => formatDate(String(value))}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={56}
                      tickFormatter={compact}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          labelFormatter={(value) => formatDate(String(value))}
                          formatter={(value) => formatNaira(Number(value))}
                        />
                      }
                    />
                    <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <SectionTitle>Where each naira goes</SectionTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <ChartContainer config={MARGIN_CONFIG} className="aspect-square w-full max-h-56">
                  <PieChart>
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          hideLabel
                          formatter={(value) => formatNaira(Number(value))}
                        />
                      }
                    />
                    <Pie
                      data={marginSplit}
                      dataKey="value"
                      nameKey="label"
                      innerRadius={52}
                      outerRadius={80}
                      strokeWidth={2}
                    >
                      {marginSplit.map((slice) => (
                        <Cell key={slice.label} fill={slice.fill} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>

                <ul className="space-y-1.5">
                  {marginSplit.map((slice) => (
                    <li
                      key={slice.label}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="bg-muted-foreground/40 size-2 rounded-xs" />
                        {slice.label}
                      </span>
                      <span className="flex items-center gap-2">
                        <Money value={slice.value} compact />
                        <Percent value={percentOf(slice.value, summary.net)} />
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <SectionTitle>Top products by revenue</SectionTitle>
            </CardHeader>
            <CardContent className="px-2">
              {topProducts.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No sales yet.</p>
              ) : (
                <ChartContainer config={REVENUE_CONFIG} className="aspect-auto h-72 w-full">
                  <BarChart data={topProducts} layout="vertical">
                    <CartesianGrid horizontal={false} />
                    <XAxis
                      type="number"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={compact}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      width={128}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          hideLabel
                          formatter={(value) => formatNaira(Number(value))}
                        />
                      }
                    />
                    <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <SectionTitle>Top sellers</SectionTitle>
        </CardHeader>
        <CardContent>
          {topProducts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No sales yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  {isOwner && <TableHead className="text-right">Revenue</TableHead>}
                  {isOwner && <TableHead className="text-right">Share of net</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {topProducts.map((product) => (
                  <TableRow key={product.medicineId}>
                    <TableCell className="font-medium">{product.name}</TableCell>
                    <TableCell data-numeric className="tabular text-right">
                      {product.units}
                    </TableCell>
                    {isOwner && (
                      <TableCell className="text-right">
                        <Money value={product.revenue} />
                      </TableCell>
                    )}
                    {isOwner && (
                      <TableCell className="text-right text-muted-foreground">
                        <Percent value={percentOf(product.revenue, summary.net)} />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isOwner && (
        <Card>
          <CardHeader className="pb-2">
            <SectionTitle
              action={
                <Badge variant={thinMargins.length === 0 ? 'success' : 'warning'}>
                  {thinMargins.length} below {THIN_MARGIN}%
                </Badge>
              }
            >
              Low-margin watchlist
            </SectionTitle>
          </CardHeader>
          <CardContent>
            {thinMargins.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Every product clears {THIN_MARGIN}% margin.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                    <TableHead className="text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {thinMargins.map(({ medicine, percent }) => (
                    <TableRow key={medicine.id}>
                      <TableCell className="font-medium">{medicine.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {supplierName(medicine.supplier)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={medicine.costPerBaseUnit} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={medicine.pricePerBaseUnit} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={unitMargin(medicine)} />
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="inline-flex items-center gap-1 text-destructive">
                          <TrendingDown className="size-3" />
                          <Percent value={percent} />
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
