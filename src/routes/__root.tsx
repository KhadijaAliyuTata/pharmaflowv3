import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router';
import { ScriptOnce } from '@tanstack/react-router';
import { AuthProvider } from '~/components/auth-provider';
import { ThemeProvider } from '~/lib/theme';
import { TooltipProvider } from '~/components/ui/tooltip';
import { DefaultCatchBoundary } from '~/components/DefaultCatchBoundary';
import { NotFound } from '~/components/NotFound';
import appCss from '~/index.css?url';

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
function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ScriptOnce>{themeInit}</ScriptOnce>
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
        <Scripts />
      </body>
    </html>
  );
}
