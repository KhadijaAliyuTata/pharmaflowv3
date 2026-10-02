import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ClipboardList, FileText, Lock, Package, Truck } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent } from '~/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet';
import { Money, OrderStatusBadge, StatTile } from '~/components/app/primitives';
import { formatWhen } from '~/domain/money';
import type { CustomerOrder } from '~/domain/types';
import { usePortalCustomer } from '~/lib/portal';
import { usePharmacy } from '~/store/pharmacy';

export const Route = createFileRoute('/_portal/portal/orders')({
  component: PortalOrders,
});

const DELIVERY: Record<CustomerOrder['deliveryType'], string> = {
  pickup: 'Collect at the counter',
  delivery: 'Delivery',
};

const PAYMENT: Record<CustomerOrder['paymentStatus'], { label: string; variant: 'success' | 'warning' }> = {
  paid: { label: 'Paid', variant: 'success' },
  pending: { label: 'Not paid yet', variant: 'warning' },
};

const PAYMENT_METHOD: Record<CustomerOrder['paymentMethod'], string> = {
  pay_on_delivery: 'Pay on delivery',
  bank_transfer: 'Bank transfer',
  card: 'Card',
};

function PortalOrders() {
  const customer = usePortalCustomer();
  const orders = usePharmacy((state) => state.customerOrders);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mine = orders
    .filter((order) => order.customerId === customer?.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const selected = mine.find((order) => order.id === selectedId) ?? null;

  const open = mine.filter(
    (order) => order.orderStatus !== 'completed' && order.orderStatus !== 'cancelled',
  );
  const unpaid = mine.filter((order) => order.paymentStatus === 'pending');

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">My orders</h1>
        <p className="text-sm text-muted-foreground">
          Everything you have ordered from the pharmacy.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Open" value={open.length} hint="Awaiting pickup or delivery" />
        <StatTile label="Unpaid" value={unpaid.length} hint="Settle at the counter" />
        <StatTile label="All orders" value={mine.length} />
      </div>

      {mine.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardList />
            </EmptyMedia>
            <EmptyTitle>No orders yet</EmptyTitle>
            <EmptyDescription>
              Ordering from this portal is not available yet. Ask the counter to place one
              for you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-3">
          {mine.map((order) => (
            <li key={order.id}>
              <Card>
                <CardContent className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p data-numeric className="tabular text-sm font-semibold">
                        {order.orderNumber}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {order.items.length} item{order.items.length === 1 ? '' : 's'} ·{' '}
                        {DELIVERY[order.deliveryType]}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <OrderStatusBadge status={order.orderStatus} />
                      <Money value={order.total} className="text-sm font-medium" />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant={PAYMENT[order.paymentStatus].variant}>
                      {PAYMENT[order.paymentStatus].label}
                    </Badge>
                    {order.prescriptionUploaded && (
                      <Badge variant="outline">
                        <FileText className="size-3" />
                        Prescription attached
                      </Badge>
                    )}
                    {order.deliveryType === 'delivery' && (
                      <Badge variant="secondary">
                        <Truck className="size-3" />
                        Delivery
                      </Badge>
                    )}
                  </div>

                  {/* The timeline the state actually has: two timestamps. It
                      is not a fabricated step tracker. */}
                  <p className="text-xs text-muted-foreground">
                    Placed {formatWhen(order.createdAt)} · last update{' '}
                    {formatWhen(order.updatedAt)}
                  </p>

                  <button
                    type="button"
                    onClick={() => setSelectedId(order.id)}
                    className="text-foreground hover:text-muted-foreground text-sm font-medium underline-offset-4 hover:underline"
                  >
                    View items
                  </button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Lock className="mt-0.5 size-3 shrink-0" />
        Cancelling an order or paying online is not built. Bring the order number to the
        counter.
      </p>

      <Sheet
        open={selected !== null}
        onOpenChange={(openState) => {
          if (!openState) setSelectedId(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.orderNumber}</SheetTitle>
                <SheetDescription>
                  {DELIVERY[selected.deliveryType]} · {selected.branchName}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 overflow-y-auto px-4 pb-4">
                <ul className="divide-y">
                  {selected.items.map((item) => (
                    <li
                      key={`${item.medicineId}-${item.unitName}`}
                      className="flex items-start justify-between gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.medicineName}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.unitName} × {item.quantity}
                        </p>
                      </div>
                      <Money value={item.lineTotal} className="shrink-0 text-sm" />
                    </li>
                  ))}
                </ul>

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

                <div className="flex flex-wrap items-center gap-1">
                  <OrderStatusBadge status={selected.orderStatus} />
                  <Badge variant={PAYMENT[selected.paymentStatus].variant}>
                    {PAYMENT[selected.paymentStatus].label}
                  </Badge>
                  <Badge variant="outline">{PAYMENT_METHOD[selected.paymentMethod]}</Badge>
                </div>

                {selected.deliveryAddress && (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Package className="mt-0.5 size-3 shrink-0" />
                    Deliver to {selected.deliveryAddress}
                  </p>
                )}

                {selected.prescriptionUploaded && (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <FileText className="mt-0.5 size-3 shrink-0" />
                    A prescription was attached to this order. Viewing the image is not
                    built — the counter holds it.
                  </p>
                )}

                <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
                  <p>Placed {formatWhen(selected.createdAt)}</p>
                  <p>Last updated {formatWhen(selected.updatedAt)}</p>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
