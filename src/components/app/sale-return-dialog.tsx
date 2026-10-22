import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '~/components/ui/button';
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
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { Money } from '~/components/app/primitives';
import {
  RETURN_METHOD_OPTIONS,
  RETURN_REASON_OPTIONS,
} from '~/domain/returns';
import type { Sale, SaleReturnMethod, SaleReturnReason } from '~/domain/types';
import {
  createSaleReturn,
  listSaleReturnable,
  type ReturnableLine,
} from '~/lib/supabase/sales';

function newReturnKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `return-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface SaleReturnDialogProps {
  sale: Sale | null;
  isOwner: boolean;
  onClose: () => void;
  /** Called only after the server confirms a return was recorded. */
  onRecorded: (message: string) => void;
}

/**
 * Record a partial or full customer return.
 *
 * Quantities are read from `pf_sale_returnable`, not from the client's copy of
 * the sale. That is what makes the remaining figure include accepted and pending
 * returns, and why the create call can still be refused if another device
 * reserved the same unit first. The dialog never announces success optimistically:
 * nothing is reported until the RPC returns.
 */
export function SaleReturnDialog({
  sale,
  isOwner,
  onClose,
  onRecorded,
}: SaleReturnDialogProps) {
  const [lines, setLines] = useState<ReturnableLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<SaleReturnReason>('customer_changed_mind');
  const [note, setNote] = useState('');
  const [refundMethod, setRefundMethod] = useState<SaleReturnMethod>('cash');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef(newReturnKey());

  useEffect(() => {
    if (!sale) return;

    let cancelled = false;
    setLines([]);
    setQuantities({});
    setReason('customer_changed_mind');
    setNote('');
    setRefundMethod('cash');
    setError(null);
    setLoadError(null);
    setLoading(true);
    idempotencyKey.current = newReturnKey();

    void (async () => {
      const result = await listSaleReturnable(sale.id);
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setLines(result.data);
    })();

    return () => {
      cancelled = true;
    };
  }, [sale]);

  const hasRemaining = lines.some((line) => line.quantityRemaining > 0);

  const selected = useMemo(
    () =>
      lines
        .map((line) => {
          const raw = quantities[line.saleItemId] ?? '';
          const quantity = Number(raw);
          return {
            line,
            quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 0,
          };
        })
        .filter((entry) => entry.quantity > 0),
    [lines, quantities],
  );

  const estimatedValue = selected.reduce(
    (total, entry) => total + entry.line.returnValuePerUnit * entry.quantity,
    0,
  );

  const invalidQuantity = lines.some((line) => {
    const raw = quantities[line.saleItemId];
    if (!raw) return false;
    const quantity = Number(raw);
    return !Number.isInteger(quantity) || quantity < 0 || quantity > line.quantityRemaining;
  });

  async function submit() {
    if (!sale || submitting) return;
    setError(null);

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('Returns need a connection to the pharmacy server. Nothing has been recorded.');
      return;
    }
    if (selected.length === 0) {
      setError('Enter a return quantity for at least one item.');
      return;
    }
    if (invalidQuantity) {
      setError('A return quantity is above the remaining amount or is not a whole number.');
      return;
    }

    setSubmitting(true);

    const result = await createSaleReturn({
      saleId: sale.id,
      items: selected.map((entry) => ({
        saleItemId: entry.line.saleItemId,
        quantity: entry.quantity,
      })),
      reason,
      note,
      refundMethod: isOwner ? refundMethod : null,
      idempotencyKey: idempotencyKey.current,
    });

    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    const created = result.data;
    onRecorded(
      created.status === 'pending_review'
        ? `${created.returnNumber} was sent to an owner for approval. Stock and money have not moved yet.`
        : `${created.returnNumber} was completed. ` +
            (created.creditApplied > 0
              ? `₦${created.creditApplied.toLocaleString()} was applied to the outstanding balance. `
              : '') +
            (created.refundAmount > 0
              ? `₦${created.refundAmount.toLocaleString()} is refundable by ${refundMethod.replace('_', ' ')}.`
              : 'No refund is due.'),
    );
    onClose();
  }

  return (
    <Dialog
      open={sale !== null}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="size-4" />
            Return items
          </DialogTitle>
          <DialogDescription>
            {sale
              ? [sale.receiptNumber, sale.customerName].filter(Boolean).join(' · ')
              : 'Select a sale.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Loading returnable quantities…
          </p>
        ) : loadError ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            {loadError}
          </p>
        ) : lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This sale has no lines that can be returned.
          </p>
        ) : !hasRemaining ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Everything on this sale is already returned or awaiting review.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Sold</th>
                    <th className="px-3 py-2 text-right font-medium">Returned</th>
                    <th className="px-3 py-2 text-right font-medium">Pending</th>
                    <th className="px-3 py-2 text-right font-medium">Remaining</th>
                    <th className="px-3 py-2 text-right font-medium">Return now</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.saleItemId} className="border-t">
                      <td className="px-3 py-2">
                        <p className="font-medium">{line.medicineName}</p>
                        <p className="text-xs text-muted-foreground">
                          {line.unitName} · {line.quantitySold} sold
                        </p>
                      </td>
                      <td data-numeric className="tabular px-3 py-2 text-right">
                        {line.quantitySold}
                      </td>
                      <td data-numeric className="tabular px-3 py-2 text-right text-muted-foreground">
                        {line.quantityReturned}
                      </td>
                      <td data-numeric className="tabular px-3 py-2 text-right text-muted-foreground">
                        {line.quantityPending}
                      </td>
                      <td data-numeric className="tabular px-3 py-2 text-right font-medium">
                        {line.quantityRemaining}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={line.quantityRemaining}
                          step={1}
                          disabled={line.quantityRemaining <= 0}
                          value={quantities[line.saleItemId] ?? ''}
                          onChange={(event) =>
                            setQuantities((current) => ({
                              ...current,
                              [line.saleItemId]: event.target.value,
                            }))
                          }
                          aria-label={`Return quantity for ${line.medicineName}`}
                          className="ml-auto h-8 w-20 text-right"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="return-reason">Reason</FieldLabel>
                <Select
                  value={reason}
                  onValueChange={(value) => setReason(value as SaleReturnReason)}
                >
                  <SelectTrigger id="return-reason" aria-label="Return reason">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RETURN_REASON_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {isOwner && (
                <Field>
                  <FieldLabel htmlFor="return-method">Refund method if money is due</FieldLabel>
                  <Select
                    value={refundMethod}
                    onValueChange={(value) => setRefundMethod(value as SaleReturnMethod)}
                  >
                    <SelectTrigger id="return-method" aria-label="Refund method">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RETURN_METHOD_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>

            <Field>
              <FieldLabel htmlFor="return-note">Note</FieldLabel>
              <Textarea
                id="return-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What happened, and what condition the stock is in"
              />
            </Field>

            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Estimated return value</p>
                <p className="text-xs text-muted-foreground">
                  Final value is calculated by the server from the original sale.
                </p>
              </div>
              <Money value={estimatedValue} className="text-lg font-semibold" />
            </div>

            {!isOwner && (
              <p className="text-xs text-muted-foreground">
                This will be sent to an owner for approval. Nothing moves until they
                approve it.
              </p>
            )}

            {error && <FieldError>{error}</FieldError>}
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button
            onClick={() => void submit()}
            disabled={loading || submitting || Boolean(loadError) || lines.length === 0}
          >
            {submitting ? 'Recording…' : isOwner ? 'Complete return' : 'Send for approval'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
