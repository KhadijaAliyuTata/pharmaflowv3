import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
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
        {/* Navy, not black: the page title is the one piece of text on screen
            that should feel like the brand speaking rather than the data. */}
        <h1 className="text-xl font-semibold tracking-tight text-navy dark:text-brand-navy">
          {title}
        </h1>
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

/**
 * Metric tone.
 *
 * Two parts, deliberately: the number carries the semantic colour, and a small
 * rule above the label echoes it. Colour alone would fail the accessibility
 * requirement, so the tile also gains a coloured edge — a glance across the
 * dashboard reads red/amber/green without anyone having to read a digit.
 *
 * `neutral` stays plain foreground: most tiles are neither good nor bad news,
 * and colouring all of them is how a dashboard turns into confetti.
 */
const TONE = {
  neutral: {
    value: 'text-foreground',
    icon: 'text-muted-foreground',
    edge: 'before:bg-border',
  },
  positive: {
    value: 'text-success',
    icon: 'text-success',
    edge: 'before:bg-success',
  },
  warning: {
    value: 'text-warning',
    icon: 'text-warning',
    edge: 'before:bg-warning',
  },
  critical: {
    value: 'text-destructive',
    icon: 'text-destructive',
    edge: 'before:bg-destructive',
  },
  brand: {
    value: 'text-navy dark:text-brand-navy',
    icon: 'text-brand-blue dark:text-brand-blue',
    edge: 'before:bg-brand-blue',
  },
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
  /**
   * Makes the whole tile a link to an existing route.
   *
   * A dashboard metric that cannot be opened is decoration, so the owner
   * dashboard passes this on every card that has somewhere to go. Rendered as a
   * real `<a>` (not a click handler) so it is keyboard-reachable, announces as a
   * link, and supports middle-click and open-in-new-tab.
   */
  to?: string;
  /** Extra hint appended after the label, e.g. "Open stock value". */
  actionHint?: string;
  loading?: boolean;
}

export function StatTile({
  label,
  value,
  hint,
  icon,
  tone: toneProp = 'neutral',
  change,
  higherIsBetter = true,
  to,
  actionHint,
  loading,
}: StatTileProps) {
  const good =
    change === undefined
      ? null
      : change.direction === 'up'
        ? higherIsBetter
        : !higherIsBetter;

  const tone = TONE[toneProp];

  const card = (
    <Card
      size="sm"
      className={cn(
        'relative gap-0 overflow-hidden',
        // The semantic edge. Two pixels, so it reads as a marker and not a border.
        'before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:content-[""]',
        tone.edge,
        // The affordance. Ring rather than border so it does not shift the card
        // by a pixel on hover, and so it still reads on a keyboard focus.
        to &&
          'h-full transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:shadow-md',
      )}
    >
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pt-1 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        {icon ? (
          <span aria-hidden="true" className={cn('shrink-0', tone.icon)}>
            {icon}
          </span>
        ) : to ? (
          // The arrow is the only cue that the card is clickable, and it sits
          // where the icon would, so a linked tile is distinguishable at a glance
          // without adding chrome to the unlinked ones.
          <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : null}
      </CardHeader>
      <CardContent className="space-y-1">
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <p data-numeric className={cn('text-2xl font-semibold tracking-tight', tone.value)}>
            {value}
          </p>
        )}

        {(hint || change || (to && actionHint)) && (
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
            {to && actionHint && <span className="text-muted-foreground">{actionHint}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (!to) return card;

  return (
    <Link
      to={to}
      // The label is the accessible name; the value and hint are decorative
      // context inside it.
      aria-label={label}
      className="block h-full rounded-xl focus-visible:outline-none"
    >
      {card}
    </Link>
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

/* --------------------------------------------------- possibly-unknown figures */

/**
 * Placeholder for a figure that could not be computed.
 *
 * An em dash, deliberately not `₦0`. Cost is owner-only in the database, so an
 * attendant's margin is not hidden — it does not exist. Showing zero would put a
 * confident, wrong number on the screen; showing nothing without explanation
 * would read as a layout bug.
 */
export function Unavailable({ className }: { className?: string }) {
  return (
    <span className={cn('text-muted-foreground', className)} title="Not available for your role">
      &mdash;
    </span>
  );
}

/**
 * Money for a value that may be unknown, because it depends on cost.
 *
 * `Money` stays strictly `number`. This variant is the only sanctioned way to
 * render a possibly-absent figure, which keeps the distinction visible at every
 * call site instead of widening the primitive and losing the signal entirely.
 */
export function MaybeMoney({
  value,
  compact,
  className,
  signed,
}: {
  value: number | null | undefined;
  compact?: boolean;
  className?: string;
  signed?: boolean;
}) {
  if (value === null || value === undefined) return <Unavailable className={className} />;
  return <Money value={value} compact={compact} className={className} signed={signed} />;
}

/** Percentage for a value that may be unknown, because it depends on cost. */
export function MaybePercent({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <Unavailable />;
  return <Percent value={value} />;
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
      <h2 className="text-sm font-semibold tracking-tight text-navy dark:text-brand-navy">
        {children}
      </h2>
      {action}
    </div>
  );
}
