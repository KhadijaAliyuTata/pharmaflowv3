import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/**
 * TanStack Start calls this on both the server render and the client
 * hydration, and awaits it — so it may be async.
 *
 * Must stay named `getRouter`: the build resolves this file through the
 * `#tanstack-router-entry` virtual module and hard-requires that export.
 *
 * The error boundary is NOT set here — this router version has no
 * `defaultCatchBoundary`. It is a route option, so `errorComponent` lives on
 * the root route in `src/routes/__root.tsx`.
 */
export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
