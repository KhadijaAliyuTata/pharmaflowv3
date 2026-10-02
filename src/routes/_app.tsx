import { useEffect, useState } from 'react';
import { Navigate, Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { AppHeader } from '~/components/app-header';
import { AppSidebar } from '~/components/app-sidebar';
import { CommandMenu } from '~/components/command-menu';
import { SidebarInset, SidebarProvider } from '~/components/ui/sidebar';
import { Toaster } from '~/components/ui/sonner';
import { peekSession, useSession } from '~/lib/session';

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
  const [commandOpen, setCommandOpen] = useState(false);

  // The server has no session, so it renders `loading` and this falls back to
  // `owner` — the same role the seeded store reports. Matching that on the
  // client's first render is what keeps hydration quiet; the real role lands in
  // the effect inside `useSession` and re-filters the nav.
  const role = user?.role ?? 'owner';

  // ⌘K / Ctrl+K. Skipped while typing in a field so it does not hijack
  // keyboard input mid-entry.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      setCommandOpen((open) => !open);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Below the hooks on purpose: an early return above them is a conditional
  // hook, and React tears the whole route down when the session resolves.
  if (status === 'anonymous') return <Navigate to="/login" replace />;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader role={role} onOpenCommand={() => setCommandOpen(true)} />
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>

      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        role={role}
      />
      <Toaster position="bottom-right" />
    </SidebarProvider>
  );
}