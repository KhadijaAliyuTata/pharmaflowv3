import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';
import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';
import { formatNaira, formatPercent } from '~/domain/money';
import { STOCK_STATUS_LABEL } from '~/domain/selectors';
import type { StockStatus } from '~/domain/types';

/* ------------------------------------------------------------ PageHeader */

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Rendered between the title block and the actions. */
  meta?: ReactNode;
}

export function PageHeader({ title, description, actions, meta }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
        {meta}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- StatTile */

const TONE = {
  neutral: 'text-foreground',
  positive: 'text-foreground',
  warning: 'text-foreground',
  critical: 'text-foreground',
} as const;

export interface StatTileProps {
  label: string;
  /** Accepts a node so callers can use <Money /> for tabular formatting. */
  value: ReactNode;
  /** Pre-formatted secondary line, e.g. "12 transactions". */
  hint?: string;
  icon?: ReactNode;
  tone?: keyof typeof TONE;
  /** Percentage change, with an explicit direction. */
  change?: { percent: number; direction: 'up' | 'down' };
  /** Whether a rise is good. Defaults to true; set false for costs and counts. */
  higherIsBetter?: boolean;
  to?: string;
  loading?: boolean;
}

export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
  change,
  higherIsBetter = true,
  loading,
}: StatTileProps) {
  const good =
    change === undefined
      ? null
      : change.direction === 'up'
        ? higherIsBetter
        : !higherIsBetter;

  return (
    <Card className="gap-0" size="sm">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        {icon && (
          <span aria-hidden="true" className="text-muted-foreground shrink-0">
            {icon}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <p
            data-numeric
            className={cn('text-2xl font-semibold tracking-tight', TONE[tone])}
          >
            {value}
          </p>
        )}

        {(hint || change) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            {change && (
              <span
                data-numeric
                className={cn(
                  'inline-flex items-center gap-0.5 font-medium',
                  good ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {change.direction === 'up' ? (
                  <ArrowUpRight className="size-3" />
                ) : (
                  <ArrowDownRight className="size-3" />
                )}
                {formatPercent(Math.abs(change.percent))}
              </span>
            )}
            {hint && <span className="text-muted-foreground">{hint}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------ status maps */

const STATUS_VARIANT: Record<StockStatus, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  in_stock: 'success',
  low_stock: 'warning',
  expiring_soon: 'warning',
  out_of_stock: 'destructive',
  expired: 'destructive',
};

export function StatusBadge({ status, className }: { status: StockStatus; className?: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className={className}>
      {STOCK_STATUS_LABEL[status]}
    </Badge>
  );
}

/* ------------------------------------------------------- Payment / status */

const SALE_STATUS: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }
> = {
  paid: { label: 'Paid', variant: 'success' },
  part_paid: { label: 'Part paid', variant: 'warning' },
  credit: { label: 'On credit', variant: 'warning' },
  refunded: { label: 'Refunded', variant: 'secondary' },
  voided: { label: 'Voided', variant: 'destructive' },
};

export function SaleStatusBadge({ status }: { status: string }) {
  const meta = SALE_STATUS[status] ?? { label: status, variant: 'secondary' as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

const ORDER_STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' }> = {
  pending_review: { label: 'Needs review', variant: 'warning' },
  confirmed: { label: 'Confirmed', variant: 'secondary' },
  ready_for_pickup: { label: 'Ready', variant: 'success' },
  out_for_delivery: { label: 'Out for delivery', variant: 'secondary' },
  completed: { label: 'Completed', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const meta = ORDER_STATUS[status] ?? { label: status, variant: 'outline' as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

/* -------------------------------------------------------------- utilities */

/** Money with tabular figures, so a column of prices lines up. */
export function Money({
  value,
  compact,
  className,
  signed,
}: {
  value: number;
  compact?: boolean;
  className?: string;
  /** Show a leading + for a gain, - for a cost. */
  signed?: boolean;
}) {
  const text = formatNaira(Math.abs(value), { compact });
  return (
    <span data-numeric className={cn('tabular', className)}>
      {signed ? (value < 0 ? `−${text}` : `+${text}`) : value < 0 ? `−${text}` : text}
    </span>
  );
}

export function Percent({ value }: { value: number }) {
  return (
    <span data-numeric className="tabular">
      {formatPercent(value)}
    </span>
  );
}

/** Section heading for a group of cards inside a screen. */
export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}
