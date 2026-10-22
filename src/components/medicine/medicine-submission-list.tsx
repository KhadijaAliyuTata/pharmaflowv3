import { useState } from 'react';
import { ChevronRight, FileText, RefreshCw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import { SectionTitle } from '~/components/app/primitives';
import { SubmissionStatusBadge } from '~/components/medicine/catalogue-status';
import { formatWhen } from '~/domain/money';
import { useMedicineSubmissions } from '~/hooks/use-medicine-catalogue';
import { withdrawMedicineSubmission } from '~/lib/supabase/medicine-catalogue';
import type { MedicineSubmissionRow } from '~/lib/db.types';

/**
 * The pharmacy's own submissions.
 *
 * This is deliberately not a review queue. It shows what the owner has sent and
 * lets them continue a draft or withdraw a request. Accepting or rejecting is a
 * reviewer action and belongs with the clinical review workflow.
 */
export function MedicineSubmissionList({
  onEdit,
  onOpenProduct,
}: {
  onEdit: (submission: MedicineSubmissionRow) => void;
  onOpenProduct: (productId: string) => void;
}) {
  const { submissions, loading, error, refresh } = useMedicineSubmissions();
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  async function withdraw(submission: MedicineSubmissionRow) {
    const confirmed = window.confirm(
      'Withdraw this submission? It will no longer be awaiting review. The audit trail is kept.',
    );
    if (!confirmed) return;

    setWithdrawing(submission.id);
    const result = await withdrawMedicineSubmission(submission.id);
    setWithdrawing(null);

    if (!result.ok) {
      toast.error('The submission could not be withdrawn.');
      return;
    }

    toast.success('Submission withdrawn.');
    refresh();
  }

  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <SectionTitle
          action={
            <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw />
              Refresh
            </Button>
          }
        >
          Pharmacy submissions
        </SectionTitle>
        <p className="text-xs text-muted-foreground">
          Drafts and review requests from this pharmacy. They are not part of the verified
          shared catalogue until a clinical reviewer accepts them.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={refresh}>
              Try again
            </Button>
          </div>
        ) : submissions.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No submissions from this pharmacy yet.
          </p>
        ) : (
          <ul className="divide-y">
            {submissions.map((submission) => (
              <li
                key={submission.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">
                      {submission.product_name ?? submission.generic_name ?? 'Untitled submission'}
                    </p>
                    <SubmissionStatusBadge status={submission.status} />
                    {submission.product_id && (
                      <Badge variant="outline">Correction linked</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[
                      submission.generic_name,
                      submission.strength_text,
                      submission.dosage_form,
                      submission.route,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Identity not complete'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {submission.source_title
                      ? `Source: ${submission.source_title}`
                      : 'No source attached'}{' '}
                    · updated {formatWhen(submission.updated_at)}
                  </p>
                  {submission.review_reason && (
                    <p className="text-xs text-muted-foreground">
                      Reviewer note: {submission.review_reason}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {submission.status === 'draft' && (
                    <Button variant="outline" size="sm" onClick={() => onEdit(submission)}>
                      <FileText />
                      Edit draft
                    </Button>
                  )}
                  {submission.status === 'submitted' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={withdrawing === submission.id}
                      onClick={() => void withdraw(submission)}
                    >
                      <Undo2 />
                      {withdrawing === submission.id ? 'Withdrawing…' : 'Withdraw'}
                    </Button>
                  )}
                  {submission.status === 'accepted' && submission.accepted_product_id && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenProduct(submission.accepted_product_id!)}
                    >
                      Open record
                      <ChevronRight />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
