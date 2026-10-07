import { ShieldCheck } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import type { User } from '~/domain/types';

/**
 * The greeting at the top of the owner dashboard.
 *
 * ## What this no longer shows, and why
 *
 * It used to lead with the pharmacy: a "Pharmacy" label, the branch name as the
 * page's `<h1>`, and the address underneath, followed by a Premises Number / PCN
 * Number row. All of that is gone.
 *
 * The branch name and address were being read from the **local seed store**
 * (`usePharmacy(state => state.branch)`), not from Supabase, so on a real project
 * the header showed a different pharmacy from the one the rest of the app knew
 * about. The sidebar resolves the live branch through `useBranchName()` while
 * this header read `pharmaflow:state:v3`, and the two disagreed.
 *
 * Removing the block does not fix that, it hides it. The dashboard header is now
 * built from the signed-in user alone, which is the one thing the session
 * actually guarantees. If a pharmacy identity is wanted here again, it has to
 * come from the branch that the session resolved, not from seed data.
 *
 * The registration numbers went with it. A missing PCN or premises number is a
 * real compliance gap that should render as "Not set" somewhere visible; it
 * should not sit in a header that is now about who is signed in. Migration
 * 20261005160000 made both nullable precisely so an unconfigured value is honest
 * rather than invented, and that remains true wherever they are surfaced.
 *
 * The role badge stays: it is the one fact about the session that changes what
 * the user may do, and it is read from the signed-in user rather than from a
 * store, so it cannot disagree with authorization the way the branch name did.
 */

/** "Good morning" / "Good afternoon" / "Good evening" from the local clock. */
export function greeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function OwnerHeader({
  user,
  className,
}: {
  user: User;
  className?: string;
}) {
  return (
    <section
      className={
        className ??
        'rounded-xl border border-border bg-card px-4 py-4 sm:px-5 sm:py-5'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* The greeting leads, because it is now the only thing here. `user.name`
            comes from the session, so a different user signing in sees their own. */}
        <p className="min-w-0 text-sm text-muted-foreground">
          {greeting()},{' '}
          <span className="text-base font-medium text-foreground">{user.name}</span>
        </p>

        <Badge variant="outline" className="shrink-0 gap-1">
          <ShieldCheck className="size-3" />
          {user.role === 'owner' ? 'Owner' : 'Pharmacist / attendant'}
        </Badge>
      </div>
    </section>
  );
}
