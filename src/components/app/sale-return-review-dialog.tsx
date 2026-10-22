import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { Money } from '~/components/app/primitives';
import { RETURN_METHOD_OPTIONS, RETURN_REASON_LABEL } from '~/domain/returns';
import type { Sale, SaleReturn, SaleReturnMethod } from '~/domain/types';
import { reviewSaleReturn } from '~/lib/supabase/sales';

interface SaleReturnReviewDialogProps {
  sale: Sale;
  entry: SaleReturn | null;
  onClose: () => void;
  onRecorded: (message: string) => void;
}

/**
 * Owner approval/rejection of a pending return.
 *
 * A rejection is a real decision: it changes no stock and no money. An approval
 * is performed by the database under a row lock and revalidates the remaining
 * quantity, so two open tabs cannot approve the same units twice.
 */
export function SaleReturnReviewDialog({
  sale,
  entry,
  onClose,
  onRecorded,
}: SaleReturnReviewDialogProps) {
  const [note, setNote] = useState('');
  const [refundMethod, setRefundMethod] = useState<SaleReturnMethod>('cash');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    setNote('');
    setRefundMethod('cash');
    setError(null);
    setSubmitting(null);
  }, [entry]);

  async function decide(approve: boolean) {
    if (!entry || submitting) return;
    setError(null);

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('This decision needs a connection to the pharmacy server. Nothing has changed.');
      return;
    }

    setSubmitting(approve ? 'approve' : 'reject');
    const result = await reviewSaleReturn({
      returnId: entry.id,
      approve,
      note,
      refundMethod: approve ? refundMethod : null,
    });
    setSubmitting(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    const reviewed = result.data;
    if (!approve) {
      onRecorded(`${reviewed.returnNumber} was rejected. No stock or money moved.`);
    } else {
      onRecorded(
        `${reviewed.returnNumber} was approved. ` +
          (reviewed.creditApplied > 0
            ? `₦${reviewed.creditApplied.toLocaleString()} was applied to the sale balance. `
            : '') +
          (reviewed.refundAmount > 0
            ? `₦${reviewed.refundAmount.toLocaleString()} is refundable.`
            : 'No refund is due.'),
      );
    }
    onClose();
  }

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review return</DialogTitle>
          <DialogDescription>
            {entry?.returnNumber} · {sale.receiptNumber} ·{' '}
            {entry ? RETURN_REASON_LABEL[entry.reason] : ''}
          </DialogDescription>
        </DialogHeader>

        {entry && (
          <div className="space-y-4">
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              {entry.items.map((item) => (
                <div key={item.saleItemId} className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{item.medicineName}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.quantity} returned · {item.restockedUnits} restocked ·{' '}
                      {item.quarantinedUnits} quarantined
                    </p>
                  </div>
                  <Money value={item.returnValue} />
                </div>
              ))}
              <div className="flex items-center justify-between border-t pt-2 font-medium">
                <span>Return value</span>
                <Money value={entry.refundValue} />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Sale balance still owed</span>
                <Money value={sale.outstandingBalance} />
              </div>
            </div>

            {entry.note && (
              <p className="rounded-lg bg-muted/40 p-3 text-sm">{entry.note}</p>
            )}

            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{RETURN_REASON_LABEL[entry.reason]}</Badge>
              {sale.status === 'credit' || sale.status === 'part_paid' ? (
                <Badge variant="outline">Credit first, then refund</Badge>
              ) : (
                <Badge variant="outline">Refund due</Badge>
              )}
            </div>

            <Field>
              <FieldLabel htmlFor="review-refund-method">Refund method if money is due</FieldLabel>
              <Select
                value={refundMethod}
                onValueChange={(value) => setRefundMethod(value as SaleReturnMethod)}
              >
                <SelectTrigger id="review-refund-method" aria-label="Refund method">
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

            <Field>
              <FieldLabel htmlFor="review-note">Review note</FieldLabel>
              <Textarea
                id="review-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why this was approved or rejected"
              />
            </Field>

            {error && <FieldError>{error}</FieldError>}
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={Boolean(submitting)} />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => void decide(false)}
            disabled={Boolean(submitting)}
          >
            <X />
            {submitting === 'reject' ? 'Rejecting…' : 'Reject'}
          </Button>
          <Button onClick={() => void decide(true)} disabled={Boolean(submitting)}>
            <Check />
            {submitting === 'approve' ? 'Approving…' : 'Approve return'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
