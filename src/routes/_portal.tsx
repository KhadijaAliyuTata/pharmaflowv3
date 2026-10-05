import {
  Link,
  Navigate,
  Outlet,
  createFileRoute,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { ArrowLeft, Pill } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { PORTAL_NAV } from '~/lib/portal';
import { peekSession, useSession } from '~/lib/session';
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
 */
export const Route = createFileRoute('/_portal')({
  beforeLoad: () => {
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

          <div className="ml-auto flex items-center gap-1">
            {/* The staff side is a different app surface, not a parent of this
                one. Back arrow, not breadcrumb. */}
            <Button variant="ghost" size="sm" render={<Link to="/" />}>
              <ArrowLeft className="size-4" />
              <span className="hidden sm:inline">Staff side</span>
            </Button>
          </div>
        </div>

        {/* Desktop nav. Same items as the mobile tab bar, same source. */}
        <nav aria-label="Customer sections" className="hidden border-t md:block">
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

      <nav
        aria-label="Customer sections"
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
