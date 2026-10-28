import { useEffect, useState } from 'react';
import { Navigate, Outlet, createFileRoute, redirect, useLocation, useNavigate } from '@tanstack/react-router';
import { AppHeader } from '~/components/app-header';
import { AppSidebar } from '~/components/app-sidebar';
import { GlobalSearch } from '~/components/app/global-search';
import { SuspendedBanner, SuspendedNotice, useMyBranchSuspended } from '~/components/app/suspended-banner';
import { CommandMenu } from '~/components/command-menu';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { SidebarInset, SidebarProvider } from '~/components/ui/sidebar';
import { Toaster } from '~/components/ui/sonner';
import { toast } from 'sonner';
import { useHotkeys } from '~/lib/use-hotkeys';
import { findNavItem } from '~/lib/nav';
import { peekSession, useSession } from '~/lib/session';
import { signOutSafely } from '~/lib/sign-out';
import {
  effectiveRole,
  resolveActiveBranch,
  roleForBranch,
  useActiveBranch,
} from '~/lib/supabase/branch-context';
import type { StaffRole } from '~/domain/types';

/**
 * Pathless layout route. Everything under `src/routes/_app/` renders inside
 * this shell; routes placed outside it (login, onboarding) do not.
 *
 * `_app` has no path segment, so `/pos` is the URL, not `/_app/pos`.
 */
export const Route = createFileRoute('/_app')({
  // The session guard, in two halves.
  //
  // `peekSession` rather than `useSession`: `beforeLoad` runs outside React and
  // reads `localStorage` directly on the client, so an anonymous user is turned
  // away *before* the route renders — no flash of the shell, and it covers
  // every client-side navigation.
  //
  // It returns `loading` on the server, and that is the load-bearing part: the
  // Worker has no session to inspect, so it must not redirect. `/` keeps
  // server-rendering for everyone.
  //
  // It also does not run for the initial load of a server-rendered page —
  // TanStack rehydrates those matches rather than re-executing `beforeLoad` —
  // so the component below repeats the check once `status` is known. That
  // second check is the only path that can show the shell to a signed-out
  // user, and only for the one paint before the effect resolves.
  beforeLoad: ({ location }) => {
    const session = peekSession();
    if (session.status === 'anonymous') {
      throw redirect({ to: '/' });
    }

    // A role restriction is not only a hidden sidebar link. A bookmark or typed
    // URL reaches the same route, so owner-only screens reject it here before
    // they render. A cached/offline session is skipped because its role is
    // deliberately downgraded and still provisional; those screens gate their
    // own contents and RLS is the authority in every case.
    const role = session.user?.role ?? null;
    if (role && !session.offline) {
      const item = findNavItem(location.pathname);
      if (item?.roles && !item.roles.includes(role)) {
        throw redirect({ to: '/dashboard' });
      }
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { user, status, offline } = useSession();
  const branch = useActiveBranch();
  const navigate = useNavigate();
  const location = useLocation();
  const [commandOpen, setCommandOpen] = useState(false);
  // Two independent dialogs. Search finds records; the palette jumps to screens.
  // Neither shares state with the other or with the theme toggle.
  const [searchOpen, setSearchOpen] = useState(false);
  // `null` until the database answers. A suspended pharmacy and a pharmacy with
  // no membership both resolve to `no-branches`, so this is the only way to say
  // which one the user is looking at.
  const suspended = useMyBranchSuspended();

  // The server has no session, so it renders `loading` and this falls back to
  // `owner` — the same role the seeded store reports. Matching that on the
  // client's first render is what keeps hydration quiet; the real role lands in
  // the effect inside `useSession` and re-filters the nav.
  //
  // A cached branch is different: it is stale authorisation, so even if the
  // profile cache is missing or unreadable the offline shell must never render
  // owner-only navigation. The server still enforces RLS, but the UI must not
  // invite an unverified session into owner screens.
  const role = effectiveRole(
    branch.source,
    roleForBranch(branch.currentBranchId),
    user?.role ?? null,
    'owner',
  ) as StaffRole;

  // The router `beforeLoad` above sees the session as it was before `startSession`
  // ran. On a direct load or refresh, the demo key has not been read yet, so the
  // shell must repeat the check once the session resolves. Without this, typing an
  // owner-only URL as the Assistant rendered that screen before the role arrived.
  // Only a server-confirmed session may be rejected from a route. A live reload
  // paints the cached profile as an offline/assistant placeholder before
  // `adoptSession` returns the real owner. Redirecting during that window sent an
  // owner who opened `/staff` directly back to `/dashboard`; the guard now waits
  // for the real role, and the screen itself withholds its contents meanwhile.
  const confirmed = status === 'authenticated' && !offline;
  const requestedItem = findNavItem(location.pathname);
  const restricted = Boolean(
    confirmed && requestedItem?.roles && role && !requestedItem.roles.includes(role),
  );

  // ⌘K / Ctrl+K opens the screen palette; "/" opens record search. The hook skips
  // editable targets, so neither hijacks typing inside the POS cart or a form.
  useHotkeys({
    'mod+k': () => setCommandOpen((open) => !open),
    '/': () => setSearchOpen(true),
  });

  // Redirect to login when session becomes anonymous. Use useEffect so the
  // navigation happens after the render is committed, not during render.
  // This avoids throwing a redirect exception during render, which can freeze
  // the UI when the session change originates from a microtask (e.g., logout click).
  useEffect(() => {
    if (status === 'anonymous') {
      void navigate({ to: '/', replace: true });
    }
  }, [status, navigate]);

  if (restricted) {
    return <Navigate to="/dashboard" replace />;
  }

  // Below the hooks on purpose: an early return above them is a conditional
  // hook, and React tears the whole route down when the session resolves.

  // No tenant, no app.
  //
  // `resolveActiveBranch()` returns `no-branches` when the database says this
  // session has no branch membership, and `error` when it could not establish one.
  // Rendering the shell in either case would look like a working pharmacy while
  // every query returns nothing — the screens would show empty lists and the user
  // would reasonably conclude their stock had vanished. Saying so is the honest
  // state, and it is fixable by an owner granting a membership.
  //
  // `loading` and `idle` deliberately fall through: the branch resolves in an
  // effect after first paint, and blocking on it would blank the screen on every
  // load for a value the prototype already knows in demo mode.
  if (branch.status === 'no-branches' || branch.status === 'error') {
    // Suspension is the one case here that is not the user's to fix, and the
    // message that says "ask an owner to add you to a counter" would be actively
    // misleading: an owner cannot add them to a counter that is withdrawn.
    if (suspended === true) {
      return <SuspendedNotice onRetry={() => void resolveActiveBranch()} />;
    }

    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>
              {branch.status === 'no-branches'
                ? 'No branch assigned'
                : 'Could not reach the pharmacy'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {branch.status === 'no-branches'
                ? 'Your account is not assigned to any branch yet, so there is nothing to show. Ask a pharmacy owner to add you to a counter.'
                : (branch.error ?? 'The active branch could not be resolved.')}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void resolveActiveBranch()}>
                Try again
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void signOutSafely().then((result) => {
                    if (result.warning) toast.warning(result.warning);
                    void navigate({ to: '/' });
                  });
                }}
              >
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader
          role={role}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenCommand={() => setCommandOpen(true)}
        />
        <main className="flex-1 p-4 md:p-6">
          <SuspendedBanner />
          {branch.source === 'cache' && (
            <div
              role="status"
              className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
            >
              <span className="font-medium">Saved branch — server not reachable.</span>{' '}
              The till can reopen offline from this device. Reconnect to verify that access and
              prices are still current; when a saved catalogue is available, its stock is only a
              cached estimate and is not reserved.
            </div>
          )}
          {branch.source === 'server' && branch.snapshotError && (
            <div
              role="status"
              className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
            >
              <span className="font-medium">Offline reload is not saved on this device.</span>{' '}
              {branch.snapshotError} The online till still works; reconnect before reloading if the
              connection drops.
            </div>
          )}
          {branch.source === 'cache' && location.pathname !== '/pos' ? (
            // Offline scope is deliberately narrow: the sale-intent safety net
            // on POS is supported; inventory, reports, returns and pricing are
            // not. Letting them render against a cached branch would show stale
            // or empty data as if it were current.
            <Card className="max-w-lg">
              <CardHeader>
                <CardTitle>Only the Point of Sale works offline</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  This device cannot reach the pharmacy server. Other screens need the server, so
                  they are unavailable until the connection returns. The POS can still reopen from
                  this device using its saved branch and queued sales.
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => void navigate({ to: '/pos' })}>
                    Open Point of Sale
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void resolveActiveBranch()}>
                    Check connection
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Outlet />
          )}
        </main>
      </SidebarInset>

      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        role={role}
      />
      <Toaster position="bottom-right" />
    </SidebarProvider>
  );
}