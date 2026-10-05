import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  AlertOctagon,
  ArrowRight,
  Ban,
  PackagePlus,
  ShieldAlert,
  Timer,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '~/components/ui/field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Textarea } from '~/components/ui/textarea';
import { MaybeMoney, Money, PageHeader, SectionTitle, StatTile } from '~/components/app/primitives';
import { daysUntil, formatCount, formatDate, multiply, sum } from '~/domain/money';
import { expiryBuckets } from '~/domain/selectors';
import type { Medicine, MedicineBatch } from '~/domain/types';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/expiry')({
  component: Expiry,
});

interface ExpiryRow {
  id: string;
  medicine: Medicine;
  batch: MedicineBatch | null;
  expiryDate: string;
  daysRemaining: number;
  quantity: number;
  /** Value at risk at cost, or null when this session cannot read cost. */
  valueAtCost: number | null;
}

type Group = 'expired' | 'under_30' | 'days_30_90';

const GROUP_META: Record<
  Group,
  { title: string; note: string; empty: string; tone: 'critical' | 'warning' | 'muted' }
> = {
  expired: {
    title: 'Expired',
    note: 'Do not sell. Pull from the shelf and dispose.',
    empty: 'Nothing past date.',
    tone: 'critical',
  },
  under_30: {
    title: 'Under 30 days',
    note: 'Sell first. Move to the front of the shelf.',
    empty: 'Nothing inside 30 days.',
    tone: 'warning',
  },
  days_30_90: {
    title: '30 to 90 days',
    note: 'Sell first. Plan the next order around these.',
    empty: 'Nothing between 30 and 90 days.',
    tone: 'muted',
  },
};

const GROUPS: Group[] = ['expired', 'under_30', 'days_30_90'];

function Expiry() {
  const medicines = usePharmacy((state) => state.medicines);
  const role = usePharmacy((state) => state.currentUser.role);
  const isOwner = role === 'owner';
  const { adjustStock } = usePharmacyActions();

  const [writeOff, setWriteOff] = useState<ExpiryRow | null>(null);

  const buckets = useMemo(() => expiryBuckets(medicines), [medicines]);

  // One row per batch, because a disposal is a batch decision. Products with
  // no batches still get a row off their own expiry date.
  const rows = useMemo(() => {
    const expanded: ExpiryRow[] = [];

    for (const bucket of buckets) {
      if (bucket.medicine.batches.length === 0) {
        expanded.push({
          id: `${bucket.medicine.id}-product`,
          medicine: bucket.medicine,
          batch: null,
          expiryDate: bucket.medicine.expiryDate,
          daysRemaining: bucket.daysRemaining,
          quantity: bucket.quantity,
          valueAtCost: bucket.valueAtCost,
        });
        continue;
      }

      for (const batch of bucket.medicine.batches) {
        expanded.push({
          id: batch.id,
          medicine: bucket.medicine,
          batch,
          expiryDate: batch.expiryDate,
          daysRemaining: daysUntil(batch.expiryDate),
          quantity: batch.quantity,
          valueAtCost: typeof batch.costPerBaseUnit === 'number'
            ? multiply(batch.costPerBaseUnit, batch.quantity)
            : null,
        });
      }
    }

    return expanded;
  }, [buckets]);

  const grouped = useMemo(
    () => ({
      expired: rows.filter((row) => row.daysRemaining < 0),
      under_30: rows.filter((row) => row.daysRemaining >= 0 && row.daysRemaining < 30),
      days_30_90: rows.filter((row) => row.daysRemaining >= 30 && row.daysRemaining <= 90),
    }),
    [rows],
  );

  // Total value at risk, or null if any row's cost is unknown. Summing only the
  // known rows would understate the exposure while still looking like a total.
  const valueAtRisk = useMemo(() => {
    const values: number[] = [];
    for (const row of rows) {
      if (row.valueAtCost === null) return null;
      values.push(row.valueAtCost);
    }
    return sum(values);
  }, [rows]);
  const unitsAffected = useMemo(() => sum(rows.map((row) => row.quantity)), [rows]);

  const expiringCount = grouped.under_30.length + grouped.days_30_90.length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Expiry"
        description="Expired stock is a loss and a hazard. Everything else is a sell-through problem."
        actions={
          <Button variant="outline" render={<Link to="/inventory" />}>
            Open catalogue
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {isOwner ? (
          <StatTile
            label="Value at risk"
            value={<MaybeMoney value={valueAtRisk} compact className="" />}
            hint="Expired and expiring, at cost"
            icon={<ShieldAlert className="size-4" />}
          />
        ) : (
          <StatTile
            label="Lines at risk"
            value={rows.length}
            hint="Batches expired or expiring"
            icon={<ShieldAlert className="size-4" />}
          />
        )}
        <StatTile
          label="Expiring soon"
          value={expiringCount}
          hint="Inside 90 days"
          icon={<Timer className="size-4" />}
        />
        <StatTile
          label="Already expired"
          value={grouped.expired.length}
          hint="Blocked from sale"
          icon={<Ban className="size-4" />}
        />
        <StatTile
          label="Units affected"
          value={formatCount(unitsAffected)}
          hint="Across all batches"
          icon={<AlertOctagon className="size-4" />}
        />
      </div>

      {grouped.expired.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-start gap-3">
            <AlertOctagon className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">
                {grouped.expired.length} past date
              </p>
              <p className="text-sm text-muted-foreground">
                The till already refuses these. Take them off the shelf and record the disposal.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {GROUPS.map((group) => (
        <ExpiryGroupCard
          key={group}
          group={group}
          rows={grouped[group]}
          isOwner={isOwner}
          onWriteOff={setWriteOff}
        />
      ))}

      {writeOff && (
        <WriteOffDialog
          row={writeOff}
          role={role}
          onClose={() => setWriteOff(null)}
          adjustStock={adjustStock}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- groups */

function ExpiryGroupCard({
  group,
  rows,
  isOwner,
  onWriteOff,
}: {
  group: Group;
  rows: ExpiryRow[];
  isOwner: boolean;
  onWriteOff: (row: ExpiryRow) => void;
}) {
  const meta = GROUP_META[group];

  return (
    <Card className={meta.tone === 'critical' ? 'border-destructive/40' : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>
            <span className="flex items-center gap-2">
              {meta.tone === 'critical' && <AlertOctagon className="size-4 text-destructive" />}
              {meta.title}
              <Badge
                variant={meta.tone === 'critical' ? 'destructive' : 'secondary'}
                className="ml-1"
              >
                {rows.length}
              </Badge>
            </span>
          </SectionTitle>
          <span className="text-xs text-muted-foreground">{meta.note}</span>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{meta.empty}</p>
        ) : (
          <ExpiryTable rows={rows} isOwner={isOwner} onWriteOff={onWriteOff} />
        )}
      </CardContent>
    </Card>
  );
}

function ExpiryTable({
  rows,
  isOwner,
  onWriteOff,
}: {
  rows: ExpiryRow[];
  isOwner: boolean;
  onWriteOff: (row: ExpiryRow) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead>Batch</TableHead>
          <TableHead>Expiry</TableHead>
          <TableHead className="text-right">Left</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          {isOwner && <TableHead className="text-right">Value at cost</TableHead>}
          <TableHead className="text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const expired = row.daysRemaining < 0;
          return (
            <TableRow
              key={row.id}
              className={expired ? 'bg-destructive/5 hover:bg-destructive/10' : undefined}
            >
              <TableCell>
                <p
                  className={
                    expired ? 'font-medium text-destructive line-through' : 'font-medium'
                  }
                >
                  {row.medicine.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.medicine.strength} · {row.medicine.dosageForm}
                </p>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.batch?.batchNumber ?? '—'}
                {row.batch?.isRecalled && (
                  <Badge variant="destructive" className="ml-1.5">
                    Recalled
                  </Badge>
                )}
              </TableCell>
              <TableCell className={expired ? 'font-medium text-destructive' : undefined}>
                {formatDate(row.expiryDate)}
              </TableCell>
              <TableCell
                className={
                  expired
                    ? 'text-right font-medium text-destructive'
                    : row.daysRemaining < 30
                      ? 'text-right font-medium text-warning'
                      : 'text-right text-muted-foreground'
                }
              >
                {expired ? `${Math.abs(row.daysRemaining)}d over` : `${row.daysRemaining}d`}
              </TableCell>
              <TableCell className="text-right">
                {formatCount(row.quantity)}
              </TableCell>
              {isOwner && (
                <TableCell className="text-right text-muted-foreground">
                  <MaybeMoney value={row.valueAtCost} />
                </TableCell>
              )}
              <TableCell className="text-right">
                {expired ? (
                  isOwner ? (
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => onWriteOff(row)}
                    >
                      <Ban />
                      Write off
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Owner only</span>
                  )
                ) : (
                  <Button variant="outline" size="xs" render={<Link to="/stock-intelligence" />}>
                    <PackagePlus />
                    Reorder
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

/* ----------------------------------------------------------------- write off */

type OperationResult = { ok: true } | { ok: false; error: string };

function WriteOffDialog({
  row,
  role,
  onClose,
  adjustStock,
}: {
  row: ExpiryRow;
  role: 'owner' | 'assistant';
  onClose: () => void;
  adjustStock: (medicineId: string, quantity: number, reason: string) => OperationResult;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const current = row.medicine.totalQuantity;
  const remaining = Math.max(0, current - row.quantity);

  function submit() {
    setError(null);

    if (role !== 'owner') {
      setError('Only an owner can write off stock');
      return;
    }

    const result = adjustStock(row.medicine.id, remaining, reason);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Write off expired stock</DialogTitle>
          <DialogDescription>
            {row.medicine.name} · batch {row.batch?.batchNumber ?? 'n/a'} ·{' '}
            {formatCount(row.quantity)} units
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertOctagon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>
            On hand drops from {formatCount(current)} to {formatCount(remaining)}. The batch stays
            on record as a stock movement.
          </p>
        </div>

        <Field>
          <FieldLabel htmlFor="write-off-reason">Reason</FieldLabel>
          <Textarea
            id="write-off-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Past expiry date, pulled from shelf for disposal"
          />
        </Field>

        {error && <FieldError>{error}</FieldError>}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={submit}>
            Write off {formatCount(row.quantity)} units
            <ArrowRight />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
