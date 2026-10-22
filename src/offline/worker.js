/**
 * Offline application-shell service worker — Phase 0.
 *
 * This file is assembled at build time, not bundled. A Vite plugin
 * (src/offline/sw-plugin.ts) reads this file, substitutes the placeholder below
 * with the precache manifest it generated from the emitted client chunks, and
 * writes the result to dist/client/sw.js, where the Cloudflare assets binding
 * serves it at `/sw.js` (scope `/` — verified in the Phase 0 spike).
 *
 * ## Why a custom worker at all
 *
 * Two rules generated recipes (workbox `generateSW` runtime caching) cannot
 * express cleanly, both learned from the read-only spike:
 *
 *   1. `fetch()` RESOLVES with a 5xx from a proxy or edge — it only rejects on a
 *      transport failure. A handler that caches whatever `fetch` returns let a
 *      502 from a dead origin overwrite the good cached shell. Here a response
 *      is cached only when it is present AND `response.ok`; anything else is
 *      treated exactly like a transport failure and falls back to the cache.
 *
 *   2. Server functions (`/api/*`, `/_server`, Cloudflare's own `/cdn-cgi/*`)
 *      and every cross-origin request (Supabase auth/data) must NEVER be
 *      intercepted — a stale SSR data response or auth token is a correctness
 *      bug, not a cache hit.
 *
 * ## Caches
 *
 *   - `pf-offline-v1-precache` — every hashed client chunk, font and stylesheet,
 *     installed from the build-time manifest. Covers **cold routes**: a route
 *     never visited online still has its JavaScript available offline; only its
 *     SSR document is missing, and that is handled without pretending otherwise.
 *   - `pf-offline-v1-docs` — SSR documents actually served, network-first and
 *     ok-gated. This is the offline navigation surface.
 *   - `pf-offline-v1-data` — any other first-party GET, cache-first, filled by
 *     the same ok-gated rule.
 *
 * ## Cold routes (documented limitation, not a silent failure)
 *
 * A route never opened online has no cached SSR document, so the navigation
 * falls back to the precached shell of the app's root document. Hydrating one
 * route's document at another route's URL is not attempted here — that is a
 * Phase 1+ design item with its own update path, not something to improvise in
 * a fetch handler.
 */

const VERSION = 'pf-offline-v1';
const PRECACHE = `${VERSION}-precache`;
const DOCS = `${VERSION}-docs`;
const DATA = `${VERSION}-data`;

// Build-time substitution point: a JSON array of first-party gift URLs.
const MANIFEST_URLS = '__OFFLINE_SHELL_MANIFEST__';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await Promise.allSettled(MANIFEST_URLS.map((url) => cache.add(url)));
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PRECACHE, DOCS, DATA]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      self.clients.claim();
    })(),
  );
});

async function putIfOk(cacheName, request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
}

async function navigationFallback(request) {
  return (await caches.match(request, { cacheName: DOCS })) || (await caches.match('/', { cacheName: DOCS })) || (await caches.match('/', { cacheName: PRECACHE }));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Server functions: dynamic, never cached, and the SW must not sit in their path.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/_server') ||
    url.pathname.startsWith('/cdn-cgi/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok) {
            await putIfOk(DOCS, request, res);
            return res;
          }
          return (await navigationFallback(request)) ?? res;
        } catch {
          return (
            (await navigationFallback(request)) ??
            new Response('Offline and no cached shell.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit =
        (await caches.match(request, { cacheName: PRECACHE })) ||
        (await caches.match(request, { cacheName: DOCS })) ||
        (await caches.match(request, { cacheName: DATA }));
      if (hit) return hit;
      try {
        const res = await fetch(request);
        await putIfOk(DATA, request, res);
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })(),
  );
});
