import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ClipboardList, Hand, Lock, Package, Siren } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  Money,
  OrderStatusBadge,
  PageHeader,
  SectionTitle,
  StatTile,
} from '~/components/app/primitives';
import { formatRelative, formatWhen } from '~/domain/money';
import type { CustomerOrder, MedicineRequest } from '~/domain/types';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/orders')({
  component: OrdersScreen,
});

const URGENCY: Record<
  MedicineRequest['urgency'],
  { label: string; variant: 'destructive' | 'warning' | 'secondary' }
> = {
  emergency: { label: 'Emergency', variant: 'destructive' },
  urgent: { label: 'Urgent', variant: 'warning' },
  routine: { label: 'Routine', variant: 'secondary' },
};

const REQUEST_STATUS: Record<
  MedicineRequest['status'],
  { label: string; variant: 'warning' | 'success' | 'secondary' }
> = {
  pending_restock: { label: 'Pending restock', variant: 'warning' },
  restocked: { label: 'Restocked', variant: 'success' },
  notified: { label: 'Customer notified', variant: 'secondary' },
};

const DELIVERY: Record<CustomerOrder['deliveryType'], string> = {
  pickup: 'Pickup',
  delivery: 'Delivery',
};

const PAYMENT: Record<CustomerOrder['paymentStatus'], { label: string; variant: 'success' | 'warning' }> = {
  paid: { label: 'Paid', variant: 'success' },
  pending: { label: 'Unpaid', variant: 'warning' },
};

function OrdersScreen() {
  const orders = usePharmacy((state) => state.customerOrders);
  const requests = usePharmacy((state) => state.medicineRequests);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const openOrders = useMemo(
    () =>
      orders.filter(
        (order) => order.orderStatus !== 'completed' && order.orderStatus !== 'cancelled',
      ),
    [orders],
  );

  const openRequests = useMemo(
    () => requests.filter((request) => request.status === 'pending_restock'),
    [requests],
  );

  const sortedRequests = useMemo(
    () =>
      [...requests].sort((a, b) => {
        const rank = { emergency: 0, urgent: 1, routine: 2 } as const;
        return rank[a.urgency] - rank[b.urgency] || b.quantityRequested - a.quantityRequested;
      }),
    [requests],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Online Orders"
        description="Customer orders and the requests they leave when the shelf is empty."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open orders"
          value={openOrders.length}
          hint={`${orders.length} total`}
          icon={<ClipboardList className="size-4" />}
        />
        <StatTile
          label="Awaiting review"
          value={orders.filter((o) => o.orderStatus === 'pending_review').length}
          hint="Nothing confirms these yet"
        />
        <StatTile
          label="Requests open"
          value={openRequests.length}
          hint={`${requests.filter((r) => r.urgency === 'urgent' || r.urgency === 'emergency').length} urgent or emergency`}
          icon={<Hand className="size-4" />}
        />
        <StatTile
          label="Unpaid orders"
          value={orders.filter((o) => o.paymentStatus === 'pending').length}
          hint="Settle on delivery"
        />
      </div>

      <Card>
        <CardHeader className="border-b pb-3">
          <SectionTitle>Customer orders</SectionTitle>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No online orders yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow
                    key={order.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelectedId(order.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId(order.id);
                      }
                    }}
                  >
                    <TableCell>
                      <p data-numeric className="tabular font-medium">
                        {order.orderNumber}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {DELIVERY[order.deliveryType]} · {formatRelative(order.createdAt)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{order.customerName}</p>
                      <p data-numeric className="tabular text-xs text-muted-foreground">
                        {order.customerPhone}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{order.branchName}</TableCell>
                    <TableCell data-numeric className="tabular text-right">
                      {order.items.length}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={order.total} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={PAYMENT[order.paymentStatus].variant}>
                        {PAYMENT[order.paymentStatus].label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <OrderStatusBadge status={order.orderStatus} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle>Medicine requests</SectionTitle>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" />
              Status changes are not wired up.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No requests logged.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Urgency</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Logged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRequests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <p className="font-medium">{request.medicineName}</p>
                      {request.genericName && (
                        <p className="text-xs text-muted-foreground">{request.genericName}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {request.customerName ?? 'Walk-in'}
                    </TableCell>
                    <TableCell data-numeric className="tabular text-right">
                      {request.quantityRequested}
                    </TableCell>
                    <TableCell>
                      <Badge variant={URGENCY[request.urgency].variant}>
                        {request.urgency !== 'routine' && <Siren className="size-3" />}
                        {URGENCY[request.urgency].label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={REQUEST_STATUS[request.status].variant}>
                        {REQUEST_STATUS[request.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelative(request.recordedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.orderNumber}</SheetTitle>
                <SheetDescription>
                  {selected.customerName} · {DELIVERY[selected.deliveryType]} ·{' '}
                  {selected.branchName}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 overflow-y-auto px-4 pb-4">
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label="Items" value={selected.items.length} />
                  <StatTile label="Total" value={<Money value={selected.total} />} />
                </div>

                {selected.deliveryAddress && (
                  <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                    Deliver to {selected.deliveryAddress}
                  </p>
                )}

                <div className="space-y-2">
                  <SectionTitle>Line items</SectionTitle>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Line total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selected.items.map((item) => (
                        <TableRow key={`${item.medicineId}-${item.unitName}`}>
                          <TableCell>
                            <p className="font-medium">{item.medicineName}</p>
                            <p className="text-xs text-muted-foreground">{item.unitName}</p>
                          </TableCell>
                          <TableCell data-numeric className="tabular text-right">
                            {item.quantity}
                          </TableCell>
                          <TableCell className="text-right">
                            <Money value={item.lineTotal} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Subtotal</dt>
                    <dd>
                      <Money value={selected.subtotal} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Delivery</dt>
                    <dd>
                      <Money value={selected.deliveryFee} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2 font-medium">
                    <dt>Total</dt>
                    <dd>
                      <Money value={selected.total} />
                    </dd>
                  </div>
                </dl>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{DELIVERY[selected.deliveryType]}</Badge>
                  <Badge variant={PAYMENT[selected.paymentStatus].variant}>
                    {PAYMENT[selected.paymentStatus].label}
                  </Badge>
                  <OrderStatusBadge status={selected.orderStatus} />
                  {selected.prescriptionUploaded && <Badge variant="outline">Rx uploaded</Badge>}
                </div>

                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Package className="size-3" />
                  Placed {formatWhen(selected.createdAt)} · updated {formatWhen(selected.updatedAt)}
                </p>

                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="size-3" />
                  Confirming, packing and marking an order delivered are not wired up.
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
