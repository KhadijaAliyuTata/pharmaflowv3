import { useMemo } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Boxes, Coins, Lock, Package, TrendingUp } from 'lucide-react';
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
  Unavailable,
} from '~/components/app/primitives';
import { percentOf } from '~/domain/money';
import { stockValuation, stockValuationTotals } from '~/domain/dashboard';
import { useCurrentUser, usePharmacy } from '~/store/pharmacy';

/**
 * Stock value — the detail behind the owner dashboard's "Stock Value" card.
 *
 * ## Valued at cost, not at retail
 *
 * The whole point of the card is "what is my money on the shelf worth". Valuing
 * stock at its selling price would answer a different and more flattering
 * question, so the cost column leads and the retail columns are derived from it.
 *
 * ## Unknown cost stays unknown
 *
 * Purchase cost is owner-only in the database. For a session that cannot read
 * it, every cost-derived cell renders `—` via `MaybeMoney`, and the totals go
 * null through `sumKnown` so a partial figure is never presented as a total.
 * A stock value that silently priced everything at ₦0 would tell an owner their
 * entire inventory is worthless; a "potential profit" of the full retail value
 * would be worse, because it would look like a real number.
 *
 * ## Authorization
 *
 * The cost columns are owner-gated in the UI *and* the numbers arrive from data
 * that already lacks `costPerBaseUnit` for a non-owner, so hiding is the second
 * layer rather than the only one. See docs/PHASE-0-DATA-MIGRATION.md §3.1.
 */
export const Route = createFileRoute('/_app/stock-value')({
  component: StockValueScreen,
});

function StockValueScreen() {
  const medicines = usePharmacy((state) => state.medicines);
  const { role } = useCurrentUser();
  const isOwner = role === 'owner';

  const rows = useMemo(() => stockValuation({ medicines }), [medicines]);
  const totals = useMemo(() => stockValuationTotals(rows), [rows]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Value"
        description="What current inventory is worth at the price you paid."
        meta={
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Valued at current inventory cost, not selling price.
          </p>
        }
        actions={
          <Button variant="outline" render={<Link to="/inventory" />}>
            <Boxes className="size-4" />
            Inventory
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Stock at cost"
          value={<MaybeMoney value={totals.costValue} compact />}
          hint={
            totals.costValue === null
              ? 'Cost unavailable for this session'
              : `${totals.productCount} products in stock`
          }
          icon={<Coins className="size-4" />}
          tone="positive"
        />
        <StatTile
          label="Stock at selling price"
          value={<Money value={totals.sellingValue} compact />}
          hint="What it would fetch sold"
          icon={<TrendingUp className="size-4" />}
        />
        <StatTile
          label="Potential gross profit"
          value={<MaybeMoney value={totals.potentialProfit} compact />}
          hint={
            marginOnCost(totals.potentialProfit, totals.costValue) ?? 'Needs cost to calculate'
          }
          tone={totals.potentialProfit === null ? 'neutral' : 'positive'}
        />
        <StatTile
          label="Products in stock"
          value={totals.productCount}
          hint={`${totals.baseUnits} base units`}
          icon={<Package className="size-4" />}
        />
      </div>

      {totals.uncostedCount > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3 shrink-0" />
          {totals.uncostedCount} of {totals.productCount} products have no cost available for this
          session, so the cost total is withheld rather than under-reported.
        </p>
      )}

      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle>Valuation by product</SectionTitle>
        </CardHeader>
        <CardContent className="px-0">
          {rows.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Package />
                </EmptyMedia>
                <EmptyTitle>Nothing in stock</EmptyTitle>
                <EmptyDescription>
                  No product currently holds stock, so there is nothing to value. Receive stock or
                  clear an expiry block and this will fill in.
                </EmptyDescription>
              </EmptyHeader>
              <Button size="sm" render={<Link to="/stock-receiving" />}>
                Receive stock
              </Button>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead>Unit</TableHead>
                    {isOwner && <TableHead className="text-right">Buying price</TableHead>}
                    <TableHead className="text-right">Selling price</TableHead>
                    <TableHead className="text-right">Total cost value</TableHead>
                    <TableHead className="text-right">Total selling value</TableHead>
                    <TableHead className="text-right">Potential gross profit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.medicineId}>
                      <TableCell>
                        <p className="font-medium">{row.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.strength}
                          {row.genericName && ` · ${row.genericName}`}
                        </p>
                      </TableCell>
                      <TableCell data-numeric className="tabular text-right">
                        {row.quantity}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {/* The base unit on its own, plus the packaging
                            breakdown, so a quantity of 240 is never ambiguous
                            between "240 tablets" and "240 boxes". */}
                        <span className="block">{row.baseUnit}</span>
                        <span className="block text-xs">{row.inPackaging}</span>
                      </TableCell>
                      {isOwner && (
                        <TableCell data-numeric className="tabular text-right">
                          {/* MaybeMoney renders `—` rather than ₦0 when the
                              session has no cost for this product. */}
                          <MaybeMoney value={row.costPerBaseUnit} compact />
                        </TableCell>
                      )}
                      <TableCell data-numeric className="tabular text-right">
                        <Money value={row.pricePerBaseUnit} compact />
                      </TableCell>
                      <TableCell data-numeric className="tabular text-right font-medium">
                        {isOwner ? (
                          <MaybeMoney value={row.costValue} />
                        ) : (
                          <Unavailable />
                        )}
                      </TableCell>
                      <TableCell data-numeric className="tabular text-right">
                        <Money value={row.sellingValue} />
                      </TableCell>
                      <TableCell data-numeric className="tabular text-right">
                        {isOwner ? (
                          <MaybeMoney value={row.potentialProfit} />
                        ) : (
                          <Unavailable />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Footer totals, so the column sums are readable without scrolling a long
          catalogue. Same figures as the tiles above, never a second calculation. */}
      {rows.length > 0 && (
        <Card>
          <CardHeader className="border-b pb-3">
            <SectionTitle>Totals</SectionTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Total cost value</dt>
                <dd data-numeric className="text-lg font-semibold">
                  {isOwner ? (
                    <MaybeMoney value={totals.costValue} />
                  ) : (
                    <Unavailable />
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Total selling value</dt>
                <dd data-numeric className="text-lg font-semibold">
                  <Money value={totals.sellingValue} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Potential gross profit</dt>
                <dd data-numeric className="text-lg font-semibold">
                  {isOwner ? (
                    <MaybeMoney value={totals.potentialProfit} />
                  ) : (
                    <Unavailable />
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Margin on cost, or null when either side is unknown — never a fake 0%. */
function marginOnCost(profit: number | null, cost: number | null): string | null {
  if (profit === null || cost === null || cost === 0) return null;
  return `${percentOf(profit, cost).toFixed(0)}% on cost`;
}
