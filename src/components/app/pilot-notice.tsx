import { Construction } from 'lucide-react';
import { PageHeader } from '~/components/app/primitives';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';

/**
 * The card a screen renders in place of itself when this build does not serve it.
 *
 * ## Why a screen is withheld rather than shown empty
 *
 * Several screens are still built on seeded state — `state.customerOrders`,
 * `state.medicineRequests`, `state.stockReceipts`, `state.sales` — that has no
 * live source yet. In a live build that state is empty, so the screen would
 * render a confident "0 open orders" or a bare table over a pharmacy that may
 * have plenty, and a zero is a statement, not an absence. Saying "not part of
 * this pilot" is the honest option: it names the situation instead of inventing
 * a figure.
 *
 * ## Why the gate sits at the route, not inside the screen
 *
 * Each caller renders this *instead of* the screen, so the screen's hooks never
 * mount and no query is issued for data that will not be shown. `isDemoMode()` is
 * a build-time constant, so the same branch is taken on every render and on both
 * the server and the client. This mirrors `_portal.tsx`, which renders
 * `PortalNotInBuild` for the same reason.
 *
 * The copy is deliberately final — no retry, no "coming soon" spinner — because
 * reloading does not add a data source, and the person cannot make it appear.
 */
export function PilotNotice({
  title,
  description,
}: {
  /** The screen's own page title, so the header does not jump when the gate lifts. */
  title: string;
  /** What the screen does and why this deployment does not serve it. */
  description: string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Construction />
          </EmptyMedia>
          <EmptyTitle>Not part of this pilot</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
