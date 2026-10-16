/**
 * Platform order monitoring.
 *
 * ## Why this screen may say "not available" rather than "0 orders"
 *
 * The `pf_platform_orders` view is real and correct: it reads persisted
 * `customer_orders` rows, joins the pharmacy name, and returns an item **count**
 * rather than customer identity. The view is not the problem.
 *
 * The problem is upstream. The customer-order workflow still writes orders to
 * `localStorage`, so `customer_orders` has never been written to. An empty table
 * therefore means "never recorded", not "the platform has taken no orders".
 *
 * Rendering `0` here would be a false statement about real pharmacies, so this
 * screen distinguishes the two cases and says which one it is looking at. It
 * also does not fall back to local data: a browser's own orders are not a
 * platform-wide view, and presenting them as one would be the exact mistake this
 * screen exists to avoid.
 *
 * When order persistence lands, the empty-state branch below is what should be
 * deleted ? not the view, and not the caveat.
 */

import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { listOrders, type PlatformOrder } from '~/lib/supabase/platform';

export const Route = createFileRoute('/platform/orders')({
  component: PlatformOrders,
});

function PlatformOrders() {
  const [rows, setRows] = useState<PlatformOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listOrders();
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">
          Customer orders recorded in the database, across every pharmacy.
        </p>
      </div>

      {/* Always shown, not only when empty. An operator reading a populated
          table later still needs to know what is and is not covered. */}
      <Card>
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Cross-pharmacy order monitoring is not yet available.</p>
            <p className="text-muted-foreground">
              Customer orders are still recorded in the browser&apos;s local
              storage rather than in the database. There is therefore nothing here
              to read yet. This screen will populate as soon as order persistence
              lands ? it will not start showing a plausible-looking number before
              then.
            </p>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>
            Persisted orders
            {rows.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {rows.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading?</p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No orders are recorded in the database. This is the unavailability
              described above ? not a count of zero orders taken.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pharmacy</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Fulfilment</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.pharmacy_name}</TableCell>
                    <TableCell data-numeric className="tabular">
                      {o.order_number}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{o.state.replace(/_/g, ' ')}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={o.payment_state === 'paid' ? 'success' : 'warning'}>
                        {o.payment_state.replace(/_/g, ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{o.delivery_type}</TableCell>
                    <TableCell data-numeric className="tabular text-right">
                      {o.item_count}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Customer names, phone numbers and prescription content are never included
        in the platform order view. Supervising fulfilment does not require them,
        and a pharmacy&apos;s customers are not the platform&apos;s to read.
      </p>
    </div>
  );
}