import {
  Link,
  Navigate,
  Outlet,
  createFileRoute,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { Pill } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { PORTAL_NAV } from '~/lib/portal';
import { isDemoMode, peekSession, useSession } from '~/lib/session';
import { useBranchName } from '~/lib/supabase/branch-context';
import { usePharmacy } from '~/store/pharmacy';

/**
 * Pathless layout route for the customer half of the app.
 *
 * `_portal` contributes no URL segment, so its children decide the scheme.
 * The children live under `portal/`, which makes every customer URL
 * `/portal/*`. That prefix is not cosmetic: the staff app already owns `/`,
 * `/orders` and `/settings`, so a pathless-and-unprefixed customer app would
 * collide with three live screens. `src/lib/nav.ts` is untouched, so the staff
 * sidebar and ⌘K never see these links.
 *
 * This is a different shell to `_app.tsx` on purpose. Staff get a sidebar
 * because they navigate constantly between dense tables. A patient on a phone
 * gets a top bar and a bottom tab bar; on `md` and up the tabs become a plain
 * horizontal nav row.
 *
 * Auth: this layout had no guard at all, so `/portal/*` rendered one named
 * customer's debt, wallet balance and receipt line items to anyone who typed the
 * URL. It now applies the same two-part session check as `_app`: `peekSession` in
 * `beforeLoad` for client navigations, and a `Navigate` once `status` resolves
 * for the server-rendered first paint. See the comment in `_app.tsx` for why the
 * server is allowed to render and only the client redirects.
 *
 * Live mode: the portal is hidden. `usePortalCustomer()` reads `state.customers[0]`
 * — one seeded prototype customer — and any signed-in user may reach this route, so
 * against a real database the portal would show one real customer's balance, debt
 * and receipts to whoever happens to be signed in. That is a data-exposure defect,
 * not a missing feature, so every non-demo build renders `PortalNotInBuild` in place
 * of the shell and mounts no portal screen at all. Unhiding it needs customer
 * identity first — `getMyCustomerRecord()` plus a guard requiring `is_customer`; see
 * docs/LIVE-DATA-PLAN.md §13.
 */
export const Route = createFileRoute('/_portal')({
  beforeLoad: () => {
    // A live deployment serves no portal to anyone, so the session is irrelevant:
    // the shell renders `PortalNotInBuild` rather than bouncing an anonymous
    // visitor to a login screen that could not unlock anything. See the note above.
    if (!isDemoMode()) return;

    if (peekSession().status === 'anonymous') {
      throw redirect({ to: '/login' });
    }
  },
  component: PortalShell,
});

function PortalShell() {
  const { status } = useSession();
  const storedBranch = usePharmacy((state) => state.branch);
  // Compatibility boundary, same as the sidebar: Supabase first, the prototype's
  // localStorage branch as fallback. Display only.
  const activeBranchName = useBranchName();
  const branchName = activeBranchName ?? storedBranch.name;
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Below the other hooks on purpose: an early return above them would be a
  // conditional hook, and React tears the route down when the session resolves.
  //
  // The build gate comes first: a live deployment serves no portal to anyone, so
  // there is nothing to consult the session about. `isDemoMode()` is a build-time
  // constant on both the server and the client, so the first paint agrees.
  if (!isDemoMode()) return <PortalNotInBuild />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <Link
            to="/portal"
            className="flex min-w-0 items-center gap-2 font-semibold tracking-tight"
          >
            <Pill className="size-5 shrink-0 text-muted-foreground" />
            <span className="truncate">PharmaFlow</span>
          </Link>

          {/* Which counter this portal is pointed at. One branch exists in the
              state today, so there is no branch picker to offer. */}
          <span className="text-muted-foreground hidden truncate text-xs md:inline">
            {branchName}
          </span>

          <Badge variant="secondary" className="hidden sm:inline-flex">
            Customer
          </Badge>
        </div>

        {/* Desktop nav. Same items as the mobile tab bar, same source. */}
        <nav aria-label="Customer sections (top)" className="hidden border-t md:block">
          <ul className="mx-auto flex w-full max-w-5xl items-center gap-1 px-4">
            {PORTAL_NAV.map((item) => {
              const active = pathname === item.to;
              const Icon = item.icon;

              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    className={
                      active
                        ? 'text-foreground inline-flex h-10 items-center gap-2 border-b-2 border-foreground text-sm font-medium'
                        : 'text-muted-foreground hover:text-foreground inline-flex h-10 items-center gap-2 border-b-2 border-transparent text-sm font-medium'
                    }
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      {/* pb-24 clears the fixed tab bar; safe-b inside the bar clears the
          home indicator. Without both, the last row of every screen is
          unreachable on a notched phone. */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-24 md:pb-10">
        <Outlet />
      </main>

      {/* Two navs render the same links. They need distinct accessible names,
          or a screen reader lists two identical "Customer sections" landmarks. */}
      <nav
        aria-label="Customer sections (bottom bar)"
        className="border-t bg-background safe-b fixed inset-x-0 bottom-0 z-40 md:hidden"
      >
        <ul className="flex items-stretch">
          {PORTAL_NAV.map((item) => {
            const active = pathname === item.to;
            const Icon = item.icon;

            return (
              <li key={item.to} className="flex-1">
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'text-foreground flex flex-col items-center gap-1 py-2 text-xs font-medium'
                      : 'text-muted-foreground flex flex-col items-center gap-1 py-2 text-xs font-medium'
                  }
                >
                  <Icon className="size-5" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/**
 * Shown in place of the entire portal when this build is not a demo.
 *
 * Deliberately plain and deliberately final: there is no retry, because no amount
 * of reloading makes a build contain a feature it does not contain, and no link
 * back to the staff app, because the portal is not a child of it. The copy states
 * what is true — the customer side is not connected to a live database yet —
 * rather than implying the visitor did something wrong.
 */
function PortalNotInBuild() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Not part of this build</h1>
        <p className="text-sm text-muted-foreground">
          The customer portal is not connected to the pharmacy database yet. Accounts,
          balances, orders and reminders have no live source, so this deployment does not
          serve them. Ask your pharmacist at the counter.
        </p>
      </div>
    </div>
  );
}
