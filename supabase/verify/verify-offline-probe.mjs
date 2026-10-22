/**
 * Phase 2 — `probeServer()`: browser online vs server reachable, separately.
 *
 * The Phase 0 spike found that a fetch() can RESOLVE with an edge/proxy 502
 * during a real outage; a successful-resolution proxy response must never read
 * as "server reachable". Every ambiguous outcome (timeout, transport error,
 * non-2xx) is pinned here as NOT CONFIRMED reachable. The probe is also
 * credential-free by construction — an auth health check that carries no
 * token, and proves nothing about writes.
 */

import { probeServer } from '../../src/offline/probe.ts';
import { createReporter } from './harness.mjs';

const { check, section, finish } = createReporter('verify-offline-probe');

/** A fetch that resolves with `status` (controlled responses). */
const fetchResponding = (status) => async () => new Response(null, { status });

/** A fetch that rejects like a transport failure. */
const fetchTransportError = async () => {
  throw new TypeError('Failed to fetch');
};

/** A fetch that never completes until its signal aborts. */
const fetchHanging = (signal) =>
  new Promise((resolve, reject) => {
    if (signal && signal.addEventListener) {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
  });

const fakeNavigator = (onLine) => ({ onLine });
const BASE = 'https://supabase.example';

section('reachability requires a real 2xx — never an ambiguous answer');

check(
  'a healthy auth endpoint returns confirmed reachable',
  (async () => {
    const r = await probeServer({
      baseUrl: BASE,
      fetchImpl: fetchResponding(200),
      navigatorRef: fakeNavigator(true),
    });
    return r.serverReachable === true && r.detail === 'HTTP OK' && r.browserOnline === true;
  })(),
);

check(
  'an edge/proxy 502 during an outage is NOT confirmed reachable (spike finding)',
  (async () => {
    const r = await probeServer({
      baseUrl: BASE,
      fetchImpl: fetchResponding(502),
      navigatorRef: fakeNavigator(true),
    });
    return r.serverReachable === false && r.detail === 'HTTP 502';
  })(),
);

check(
  'a 401 from the health endpoint is ambiguous, not confirmation',
  (async () => {
    const r = await probeServer({
      baseUrl: BASE,
      fetchImpl: fetchResponding(401),
      navigatorRef: fakeNavigator(true),
    });
    return r.serverReachable === false;
  })(),
);

check(
  'a transport error (Wi-Fi up, upstream dead) is not confirmed reachable',
  (async () => {
    const r = await probeServer({
      baseUrl: BASE,
      fetchImpl: fetchTransportError,
      navigatorRef: fakeNavigator(true),
    });
    return r.serverReachable === false && r.detail === 'TypeError';
  })(),
);

check(
  'a timeout resolves to NOT confirmed reachable, with the honest detail',
  (async () => {
    const r = await probeServer({
      baseUrl: BASE,
      fetchImpl: fetchHanging,
      timeoutMs: 25,
      navigatorRef: fakeNavigator(true),
    });
    return r.serverReachable === false && r.detail === 'timeout';
  })(),
);

section('browser online is a SEPARATE axis from server reachable');

check(
  'browser-online + server-unreachable is reported honestly as both states',
  (async () => {
    const r = await probeServer({
      baseUrl: BASE,
      fetchImpl: fetchTransportError,
      navigatorRef: fakeNavigator(true),
    });
    return r.browserOnline === true && r.serverReachable === false;
  })(),
);

check(
  'browser-offline is advisory only; a reachable server can still confirm',
  (async () => {
    const r = await probeServer({
      baseUrl: BASE,
      fetchImpl: fetchResponding(200),
      navigatorRef: fakeNavigator(false),
    });
    return r.browserOnline === false && r.serverReachable === true;
  })(),
);

section('configuration honesty');

check(
  'an unconfigured server URL reports itself as such, never as an outage',
  (async () => {
    // No baseUrl and a bun runtime without PUBLIC_SUPABASE_URL configured.
    const r = await probeServer({ fetchImpl: fetchResponding(200), navigatorRef: fakeNavigator(true) });
    return r.serverReachable === false && r.detail === 'server-unconfigured';
  })(),
);

check(
  'the health request is credential-free (no Authorization header, no body)',
  (async () => {
    let seen = null;
    await probeServer({
      baseUrl: BASE,
      fetchImpl: async (url, init) => {
        seen = init;
        return new Response(null, { status: 200 });
      },
      navigatorRef: fakeNavigator(true),
    });
    return (
      seen.method === 'GET' &&
      !Object.hasOwn(seen, 'body') &&
      !(seen.headers && Object.hasOwn(seen.headers ?? {}, 'Authorization'))
    );
  })(),
);

process.exit(await finish());
