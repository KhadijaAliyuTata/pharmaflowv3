import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  CircleCheck,
  Flame,
  Layers,
  PackageCheck,
  Phone,
  TrendingDown,
  TriangleAlert,
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
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { MaybeMoney, Money, PageHeader, SectionTitle, StatTile } from '~/components/app/primitives';
import { formatCount, sumKnown } from '~/domain/money';
import { reorderSuggestions, sellableQuantity, stockValue } from '~/domain/selectors';
import type { ReorderPriority, ReorderSuggestion } from '~/domain/types';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/stock-intelligence')({
  component: StockIntelligence,
});

const PRIORITIES: ReorderPriority[] = ['urgent', 'soon', 'watch', 'overstock'];

const PRIORITY_META: Record<
  ReorderPriority,
  { label: string; note: string; badge: 'destructive' | 'warning' | 'secondary' | 'outline' }
> = {
  urgent: {
    label: 'Urgent',
    note: 'The shelf empties before the supplier can deliver. Call today.',
    badge: 'destructive',
  },
  soon: {
    label: 'Soon',
    note: 'One lead time of cover left. Order before it becomes urgent.',
    badge: 'warning',
  },
  watch: {
    label: 'Watch',
    note: 'Healthy. Revisit at the next reorder cycle.',
    badge: 'secondary',
  },
  overstock: {
    label: 'Overstock',
    note: 'More than 90 days of cover. An observation, not a problem to fix.',
    badge: 'outline',
  },
};

function StockIntelligence() {
  const medicines = usePharmacy((state) => state.medicines);
  const suppliers = usePharmacy((state) => state.suppliers);
  const role = usePharmacy((state) => state.currentUser.role);
  const isOwner = role === 'owner';

  const [priority, setPriority] = useState<ReorderPriority>('urgent');

  const suggestions = useMemo(
    () => reorderSuggestions(medicines, suppliers),
    [medicines, suppliers],
  );

  const supplierNames = useMemo(
    () => new Map(suppliers.map((supplier) => [supplier.id, supplier])),
    [suppliers],
  );

  const byPriority = useMemo(() => {
    const groups = new Map<ReorderPriority, ReorderSuggestion[]>();
    for (const item of suggestions) {
      const list = groups.get(item.priority) ?? [];
      list.push(item);
      groups.set(item.priority, list);
    }
    return groups;
  }, [suggestions]);

  const urgent = byPriority.get('urgent') ?? [];
  const soon = byPriority.get('soon') ?? [];
  const toOrder = useMemo(
    () => [...urgent, ...soon].filter((item) => item.recommendedQuantity > 0),
    [urgent, soon],
  );

  // Capital figures, null when any contributing row lacks cost. The reorder
  // quantities above stay correct either way — only the money is unknown.
  const orderCost = useMemo(() => sumKnown(toOrder.map((item) => item.estimatedCost)), [toOrder]);

  const overstockCapital = useMemo(
    () => sumKnown((byPriority.get('overstock') ?? []).map((item) => stockValue(item.medicine))),
    [byPriority],
  );

  const rows = byPriority.get(priority) ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stock intelligence"
        description="Reorder queue built from daily sales and each supplier's lead time."
        actions={
          <Button variant="outline" render={<Link to="/suppliers" />}>
            <Phone />
            Suppliers
          </Button>
        }
      />

      {/*
        There is no purchase-order domain operation, so this screen stops at
        the queue. Saying so up front is honest; a fake "PO created" would not
        be.
      */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Phone className="size-4 shrink-0 text-muted-foreground" />
          <p className="flex-1 text-sm text-muted-foreground">
            Nothing here raises a purchase order. Read the queue, then call the supplier to place
            it.
          </p>
          <Badge variant="outline">No PO module yet</Badge>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* Tones give the queue a readable order of urgency before a single
            number is read: red for "order today", amber for "order this week",
            green for the money, plain for the rest. */}
        <StatTile
          label="Urgent"
          value={urgent.length}
          hint="Out of cover before delivery"
          icon={<TriangleAlert className="size-4" />}
          tone={urgent.length > 0 ? 'critical' : 'neutral'}
        />
        <StatTile
          label="Soon"
          value={soon.length}
          hint="One lead time of cover left"
          icon={<TrendingDown className="size-4" />}
          tone={soon.length > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label={isOwner ? 'Cost to catch up' : 'Lines to order'}
          value={isOwner ? <MaybeMoney value={orderCost} compact className="" /> : toOrder.length}
          hint={isOwner ? `${toOrder.length} products` : 'Urgent and soon'}
          icon={<PackageCheck className="size-4" />}
          tone={isOwner ? 'positive' : 'neutral'}
        />
        {isOwner ? (
          <StatTile
            label="Tied up in overstock"
            value={<MaybeMoney value={overstockCapital} compact className="" />}
            hint="At cost, 90+ days of cover"
            icon={<Layers className="size-4" />}
            tone="warning"
          />
        ) : (
          <StatTile
            label="Overstock"
            value={(byPriority.get('overstock') ?? []).length}
            hint="90+ days of cover"
            icon={<Layers className="size-4" />}
          />
        )}
      </div>

      <Tabs
        value={priority}
        onValueChange={(value) => setPriority(value as ReorderPriority)}
      >
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {PRIORITIES.map((value) => (
            <TabsTrigger key={value} value={value} className="flex-none">
              {PRIORITY_META[value].label}
              <Badge variant="secondary" className="ml-0.5">
                {(byPriority.get(value) ?? []).length}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader className="pb-2">
          <SectionTitle
            action={
              <span className="text-xs text-muted-foreground">
                {PRIORITY_META[priority].note}
              </span>
            }
          >
            {PRIORITY_META[priority].label}
          </SectionTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleCheck />
                </EmptyMedia>
                <EmptyTitle>Nothing in this band</EmptyTitle>
                <EmptyDescription>
                  {priority === 'overstock'
                    ? 'No product is sitting on more than 90 days of cover.'
                    : 'No product needs attention here.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ReorderTable
              rows={rows}
              priority={priority}
              isOwner={isOwner}
              suppliers={supplierNames}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------- table */

function ReorderTable({
  rows,
  priority,
  isOwner,
  suppliers,
}: {
  rows: ReorderSuggestion[];
  priority: ReorderPriority;
  isOwner: boolean;
  suppliers: Map<string, { name: string; phone: string; leadTimeDays: number }>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Stock</TableHead>
          <TableHead className="text-right">Selling</TableHead>
          <TableHead className="text-right">Lead time</TableHead>
          <TableHead className="text-right">Cover</TableHead>
          <TableHead className="text-right">Order</TableHead>
          {isOwner && <TableHead className="text-right">Est. cost</TableHead>}
          <TableHead>Why</TableHead>
          <TableHead className="text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item) => {
          const supplier = suppliers.get(item.medicine.supplier);
          const leadTime = supplier?.leadTimeDays ?? 3;
          const cover = item.daysUntilStockout + leadTime;
          return (
            <TableRow key={item.medicine.id}>
              <TableCell>
                <p className="font-medium">{item.medicine.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {supplier?.name ?? item.medicine.supplier}
                </p>
              </TableCell>
              <TableCell
                className={
                  sellableQuantity(item.medicine) === 0
                    ? 'text-right font-medium text-destructive'
                    : 'text-right'
                }
              >
                {formatCount(sellableQuantity(item.medicine))}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                {formatCount(item.medicine.averageDailySales)}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">{leadTime}d</TableCell>
              <TableCell
                className={
                  item.daysUntilStockout <= 0
                    ? 'text-right font-medium text-destructive'
                    : item.daysUntilStockout <= leadTime
                      ? 'text-right font-medium text-warning'
                      : 'text-right'
                }
              >
                {cover}d
              </TableCell>
              <TableCell className="text-right font-medium">
                {item.recommendedQuantity > 0 ? formatCount(item.recommendedQuantity) : '—'}
              </TableCell>
              {isOwner && (
                <TableCell className="text-right text-muted-foreground">
                  {item.estimatedCost && item.estimatedCost > 0 ? (
                    <Money value={item.estimatedCost} />
                  ) : (
                    '—'
                  )}
                </TableCell>
              )}
              <TableCell className="max-w-64">
                <span className="block text-xs text-muted-foreground">{item.reason}</span>
              </TableCell>
              <TableCell className="text-right">
                {priority === 'overstock' ? (
                  <span className="text-xs text-muted-foreground">No order</span>
                ) : (
                  <Button
                    variant={priority === 'urgent' ? 'default' : 'outline'}
                    size="xs"
                    onClick={() =>
                      toast(
                        `${item.medicine.name}: ${formatCount(
                          item.recommendedQuantity,
                        )} units from ${supplier?.name ?? 'your supplier'}. Nothing is saved — call them to place the order.`,
                      )
                    }
                  >
                    {priority === 'urgent' && <Flame />}
                    Create purchase order
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
