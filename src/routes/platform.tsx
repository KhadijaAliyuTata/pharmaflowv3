/**
 * Platform administration — its own layout, outside `_app`.
 *
 * ## Why it is separate rather than another `_app` screen
 *
 * `_app` is the pharmacy: it resolves an active branch, shows the pharmacy's
 * customers, sales and stock, and its sidebar is declared in `nav.ts` for owners
 * and attendants. A platform administrator usually has **no branch at all** —
 * `pf_current_branch()` returns NULL for them — so every branch-scoped screen in
 * that shell would be empty, and the branch switcher would have nothing to show.
 *
 * It is a real path segment rather than a pathless `_platform` layout because a
 * pathless one would claim `/` and `/orders`, which `_app` already owns, and the
 * router refuses to build with two routes at the same path.
 *
 * ## This is not the security boundary
 *
 * Hiding the links, and refusing to render for a non-administrator, is a
 * courtesy. An owner who types `/platform` is turned away here; an owner who
 * calls `POST /api/platform/onboard-pharmacy` directly is refused by the Worker,
 * which asks the database. Both matter; only the second one is load-bearing.
 */

import { useEffect, useState } from 'react';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import {
  Activity,
  Building2,
  ClipboardList,
  LayoutDashboard,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isPlatformAdmin } from '~/lib/supabase/platform';
import { useSession } from '~/lib/session';

type PlatformLink = { to: string; label: string; icon: typeof LayoutDashboard };

const PLATFORM_LINKS: readonly PlatformLink[] = [
  { to: '/platform', label: 'Overview', icon: LayoutDashboard },
  { to: '/platform/pharmacies', label: 'Pharmacies', icon: Building2 },
  { to: '/platform/orders', label: 'Orders', icon: ClipboardList },
  { to: '/platform/activity', label: 'Activity', icon: Activity },
];

export const Route = createFileRoute('/platform')({
  component: PlatformShell,
});

function PlatformShell() {
  const { status } = useSession();
  // `null` until the database has answered. Nothing platform-related renders
  // while it is unknown, rather than flickering in and then out.
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (status !== 'authenticated' || !isSupabaseConfigured()) {
      setAllowed(false);
      return;
    }
    let cancelled = false;
    void isPlatformAdmin().then((v) => {
      if (!cancelled) setAllowed(v);
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  if (status === 'loading' || allowed === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Checking your platform access…
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5" />
              Not available
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              This area is for platform administrators. Your account does not have
              platform access, so nothing here is shown.
            </p>
            <p className="text-xs text-muted-foreground">
              If you believe you should have access, ask the platform operator to
              grant it. It cannot be granted from inside the app.
            </p>
            <Button render={<Link to="/dashboard" />}>Back to your pharmacy</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-warning" />
            <span className="text-sm font-semibold">PharmaFlow Platform</span>
          </div>

          {/* Deliberately its own list. Not `nav.ts`: an owner or attendant
              browsing this shell must not see platform destinations, and an
              operator must not see one pharmacy's counter. */}
          <nav aria-label="Platform" className="flex flex-wrap items-center gap-1">
            {PLATFORM_LINKS.map((link) => (
              <Button
                key={link.to}
                variant="ghost"
                size="sm"
                render={<Link to={link.to} />}
              >
                <link.icon className="size-4" />
                {link.label}
              </Button>
            ))}
          </nav>

          <div className="ml-auto">
            <Button variant="outline" size="sm" render={<Link to="/dashboard" />}>
              My pharmacy
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}