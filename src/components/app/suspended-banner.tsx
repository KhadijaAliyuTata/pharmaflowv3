/**
 * Explains a suspended pharmacy to the people who work there.
 *
 * ## What this is for
 *
 * Suspension is implemented by making `pf_current_branch()` return NULL and by
 * dropping the branch from `pf_my_branches`. Both deny access, which is the whole
 * point, but the *symptom* they produce is an app full of empty lists. A user
 * whose pharmacy was switched off would see no stock, no sales and no customers,
 * and would have no way to tell that apart from their data having disappeared.
 *
 * So when `pf_my_branch_status()` says `suspended`, this banner appears and says
 * what happened, that nothing was deleted, and who to contact.
 *
 * ## What this is not
 *
 * Not an authorization control. The database already refuses the reads and the
 * writes; hiding a navigation item or rendering a banner changes nothing about
 * that. If this banner failed to render, the pharmacy would still be locked -
 * it would just be confusingly empty.
 */

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { fetchMyBranchStatus } from '~/lib/supabase/branch-context';
import type { PharmacyStatus } from '~/lib/db.types';

/**
 * `null` while the answer is unknown, so the banner does not flash on every
 * page load for the overwhelmingly common case of a pharmacy that is fine.
 */
export function useMyBranchSuspended(): boolean | null {
  const [suspended, setSuspended] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMyBranchStatus().then((status: PharmacyStatus | null) => {
      if (!cancelled) setSuspended(status === 'suspended');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return suspended;
}

/**
 * The banner. Rendered above the app's main content by `_app`.
 *
 * Returns `null` for anything other than a confirmed suspension, including
 * `unknown`. Guessing "probably not suspended" on an error would hide the one
 * message the user needs, and the database is the authority either way.
 */
export function SuspendedBanner() {
  const suspended = useMyBranchSuspended();

  if (suspended !== true) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <Lock className="size-4" />
      <AlertTitle>This pharmacy is suspended</AlertTitle>
      <AlertDescription>
        <p>
          Access has been withdrawn by the platform operator, so the counter,
          stock and sales screens have nothing to show. Nothing has been deleted:
          every sale, customer and order is still recorded and returns intact if
          the pharmacy is reactivated.
        </p>
        <p className="mt-2">
          Contact the platform operator to have it reviewed.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The full-page variant, for when suspension leaves no branch at all to render
 * the shell around.
 *
 * `_app` cannot tell a suspended pharmacy from a pharmacy with no membership -
 * both resolve to `no-branches` - so this is rendered from inside that branch of
 * the tree once the database has confirmed which one it is.
 */
export function SuspendedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <Alert variant="destructive">
          <Lock className="size-4" />
          <AlertTitle>This pharmacy is suspended</AlertTitle>
          <AlertDescription>
            Access has been withdrawn by the platform operator. Nothing has been
            deleted - every sale, customer and order is still recorded and returns
            intact if the pharmacy is reactivated.
          </AlertDescription>
        </Alert>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onRetry}>
            Check again
          </Button>
          <p className="text-xs text-muted-foreground">
            Contact the platform operator to have it reviewed.
          </p>
        </div>
      </div>
    </div>
  );
}