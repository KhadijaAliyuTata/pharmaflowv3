import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router';
import { ScriptOnce } from '@tanstack/react-router';
import { AuthProvider } from '~/components/auth-provider';
import { isDemoMode } from '~/lib/build-mode';
import { ThemeProvider } from '~/lib/theme';
import { TooltipProvider } from '~/components/ui/tooltip';
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary';
import { NotFound } from '~/components/NotFound';
import appCss from '~/index.css?url';
import { demoSeedAnchor } from '~/domain/seed';

/**
 * Resolves the theme before first paint.
 *
 * Without this the page renders light, then snaps to dark once React hydrates —
 * a visible flash on every load for anyone using a dark OS theme. Must be in
 * <head> and must run synchronously, so it cannot be a React effect.
 */
const themeInit = `
(function(){
  try {
    var s = localStorage.getItem('pf-theme');
    var d = s === 'dark' || (s !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', d);
    document.documentElement.style.colorScheme = d ? 'dark' : 'light';
  } catch (e) {}
})();`;

export const Route = createRootRoute({
  // Catches every unmatched route and every thrown error, since all routes
  // nest under the root. These are separate options — errorComponent does not
  // cover not-found.
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: NotFound,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { title: 'PharmaFlow' },
      {
        name: 'description',
        content:
          'Pharmacy operations, control and intelligence platform for Nigerian community pharmacies.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
});

/**
 * The root route owns the document. `HeadContent` must be rendered or every
 * entry in `head()` is dropped — including the stylesheet link.
 */
/**
 * Offline-shell registration — SPIKE.
 *
 * Registered only in a production build, so `vite dev` is never affected. The
 * worker itself lives at `public/sw.js`. Real implementation will move to a
 * dedicated module with update/consent handling.
 */
const registerSw = `
if ('serviceWorker' in navigator && ${JSON.stringify(import.meta.env.PROD)}) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}`;

/**
 * The fixed DEMO MODE indicator. Rendered only when `isDemoMode()` is true —
 * which is constant-folded to false in every production build and in any dev
 * server with Supabase configured ("live") — so no real deployment can ever
 * display it. This is the persistent demo indicator shown alongside the demo
 * the owner/attendant experiences, which otherwise look exactly like the real
 * product (deliberately — they ARE the real product running on seeded data).
 */
function DemoModeBadge() {
  if (!isDemoMode()) return null;
  return (
    <div
      aria-live="polite"
      className="fixed bottom-0 left-0 z-[100] rounded-tr-lg bg-[#043263] px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-white shadow-lg"
    >
      DEMO MODE — sample data only
    </div>
  );
}

function RootComponent() {
  return (
    <html
      lang="en"
      data-demo-now={isDemoMode() ? demoSeedAnchor().toISOString() : undefined}
      suppressHydrationWarning
    >
      <head>
        <ScriptOnce>{themeInit}</ScriptOnce>
        <ScriptOnce>{registerSw}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider>
          <TooltipProvider>
            <AuthProvider>
              <Outlet />
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
        <DemoModeBadge />
        <Scripts />
      </body>
    </html>
  );
}
