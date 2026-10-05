import { useState } from 'react';
import { Navigate, Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { AppHeader } from '~/components/app-header';
import { AppSidebar } from '~/components/app-sidebar';
import { GlobalSearch } from '~/components/app/global-search';
import { CommandMenu } from '~/components/command-menu';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { SidebarInset, SidebarProvider } from '~/components/ui/sidebar';
import { Toaster } from '~/components/ui/sonner';
import { useHotkeys } from '~/lib/use-hotkeys';
import { peekSession, signOut, useSession } from '~/lib/session';
import {
  resolveActiveBranch,
  useActiveBranch,
} from '~/lib/supabase/branch-context';

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
  beforeLoad: () => {
    if (peekSession().status === 'anonymous') {
      throw redirect({ to: '/login' });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { user, status } = useSession();
  const branch = useActiveBranch();
  const navigate = useNavigate();
  const [commandOpen, setCommandOpen] = useState(false);
  // Two independent dialogs. Search finds records; the palette jumps to screens.
  // Neither shares state with the other or with the theme toggle.
  const [searchOpen, setSearchOpen] = useState(false);

  // The server has no session, so it renders `loading` and this falls back to
  // `owner` — the same role the seeded store reports. Matching that on the
  // client's first render is what keeps hydration quiet; the real role lands in
  // the effect inside `useSession` and re-filters the nav.
  const role = user?.role ?? 'owner';

  // ⌘K / Ctrl+K opens the screen palette; "/" opens record search. The hook skips
  // editable targets, so neither hijacks typing inside the POS cart or a form.
  useHotkeys({
    'mod+k': () => setCommandOpen((open) => !open),
    '/': () => setSearchOpen(true),
  });

  // Below the hooks on purpose: an early return above them is a conditional
  // hook, and React tears the whole route down when the session resolves.
  if (status === 'anonymous') return <Navigate to="/login" replace />;

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
                  signOut();
                  void navigate({ to: '/login' });
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
          <Outlet />
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