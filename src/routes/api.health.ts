import { createFileRoute } from '@tanstack/react-router';

/**
 * Proves the Worker is actually executing — not just that the client bundle
 * built. Hit /api/health and a JSON body means TanStack Start SSR is running
 * inside workerd.
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () =>
        Response.json({
          ok: true,
          runtime: 'cloudflare-worker',
          at: new Date().toISOString(),
        }),
    },
  },
});
