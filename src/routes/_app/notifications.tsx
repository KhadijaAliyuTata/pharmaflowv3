import { Link, createFileRoute } from '@tanstack/react-router';
import {
  ArrowRight,
  Bell,
  BellOff,
  CheckCheck,
  CreditCard,
  PackageSearch,
  PackageX,
  Timer,
  TriangleAlert,
  UserPlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { PageHeader } from '~/components/app/primitives';
import { cn } from '~/lib/utils';
import { formatRelative } from '~/domain/money';
import type { AppNotification, NotificationType } from '~/domain/types';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/notifications')({
  component: NotificationsScreen,
});

/**
 * Notification type decides the icon and the tint, in one place. v2 stored a
 * `severity` string alongside the type and the two could disagree — a
 * `pending_pricing` notification marked `urgent` would still render with the
 * wrong treatment.
 */
const TYPE_META: Record<
  NotificationType,
  { icon: LucideIcon; label: string; to: string }
> = {
  pending_pricing: { icon: Timer, label: 'Pricing', to: '/pricing' },
  low_stock: { icon: PackageX, label: 'Stock', to: '/inventory' },
  expiry_risk: { icon: TriangleAlert, label: 'Expiry', to: '/expiry' },
  cost_increase: { icon: CreditCard, label: 'Pricing', to: '/pricing' },
  recall: { icon: PackageSearch, label: 'Recall', to: '/inventory' },
  medicine_request: { icon: UserPlus, label: 'Request', to: '/orders' },
};

function NotificationsScreen() {
  const notifications = usePharmacy((state) => state.notifications);
  const { markNotificationRead, markAllNotificationsRead } = usePharmacyActions();

  const unread = notifications.filter((n) => !n.read);
  const read = notifications.filter((n) => n.read);
  const hasAny = notifications.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={
          unread.length > 0
            ? `${unread.length} unread of ${notifications.length}`
            : `${notifications.length} total, all read`
        }
        actions={
          read.length > 0 && (
            <Button variant="outline" onClick={markAllNotificationsRead}>
              <CheckCheck />
              Mark all read
            </Button>
          )
        }
      />

      {!hasAny ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <BellOff className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Nothing to show</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Alerts appear here when stock runs low, batches approach expiry, a
              receipt is waiting on pricing, or a customer requests a product.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="unread">
          <TabsList>
            <TabsTrigger value="unread">
              Unread
              {unread.length > 0 && (
                <Badge variant="secondary" className="ml-1 tabular">
                  {unread.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="read">Read</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>

          <TabsContent value="unread">
            <NotificationList
              notifications={unread}
              onRead={markNotificationRead}
              emptyLabel="You are all caught up."
            />
          </TabsContent>
          <TabsContent value="read">
            <NotificationList
              notifications={read}
              onRead={markNotificationRead}
              emptyLabel="Nothing read yet."
            />
          </TabsContent>
          <TabsContent value="all">
            <NotificationList
              notifications={notifications}
              onRead={markNotificationRead}
              emptyLabel="No notifications."
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function NotificationList({
  notifications,
  onRead,
  emptyLabel,
}: {
  notifications: AppNotification[];
  onRead: (id: string) => void;
  emptyLabel: string;
}) {
  if (notifications.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <ul className="divide-y">
          {notifications.map((notification) => {
            const meta = TYPE_META[notification.type];
            const Icon = meta.icon;

            return (
              <li key={notification.id}>
                <div
                  className={cn(
                    'flex items-start gap-3 px-4 py-3 transition-colors',
                    !notification.read && 'bg-muted/40',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                      notification.severity === 'urgent' && 'bg-danger-subtle text-destructive',
                      notification.severity === 'warning' && 'bg-warning-subtle text-warning',
                      notification.severity === 'info' && 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>

                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p
                        className={cn(
                          'text-sm',
                          notification.read ? 'text-muted-foreground' : 'font-medium',
                        )}
                      >
                        {notification.title}
                      </p>
                      <Badge variant="outline">{meta.label}</Badge>
                      {!notification.read && (
                        <Badge variant="secondary" className="gap-1">
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-primary"
                          />
                          New
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{notification.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelative(notification.date)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {notification.to && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8"
                        onClick={() => onRead(notification.id)}
                        render={<Link to={notification.to} />}
                      >
                        Open
                        <ArrowRight />
                      </Button>
                    )}
                    {!notification.read && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8"
                        onClick={() => onRead(notification.id)}
                      >
                        Mark read
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}