/**
 * Server reachability probe — the "can the server actually answer?" half of
 * the connectivity question.
 *
 * `navigator.onLine` answers ONLY "does the OS think some network exists" — a
 * Wi-Fi portal, a captive edge proxy, or a NAT without upstream all report
 * online while nothing is Truly reachable (an outage also surfaces as a
 * *successful* proxy/edge 502 — a real Phase 0 spike finding). Any decision
 * that must not fire optimistically (starting a sync run, showing "online")
 * needs the two answers SEPARATELY:
 *
 *   browserOnline  — cheap, advisory, from `navigator.onLine`.
 *   serverReachable — a real, time-boxed request to the Supabase auth health
 *                     endpoint, confirmed ONLY on `response.ok`.
 *
 * A probe that resolves is NOT proof an *authenticated write* will succeed:
 * the probe carries no credentials and settles nothing about RLS, role, or
 * operation validity. It is a gate for "worth trying", never evidence of
 * success (the engine's completion rules enforce that separately).
 *
 * ## Honesty rules (pinned by verify-offline-sync.mjs)
 *
 * - Timeouts, transport errors, and non-2xx responses are all treated exactly
 *   the same way: **not confirmed reachable**. Ambiguity resolves to `false`.
 * - The probe sends no access token, no user material, and logs nothing about
 *   the session.
 */

export interface ProbeResult {
  /** OS-level network presence (`navigator.onLine`). Advisory only. */
  browserOnline: boolean;
  /** TRUE only after a 2xx from the server within the timeout window. */
  serverReachable: boolean;
  checkedAt: number;
  latencyMs: number | null;
  /** Short non-sensitive detail ('HTTP OK', 'timeout', 'HTTP 500', …). */
  detail: string;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

export interface ProbeOptions {
  /** Defaults to the build-time `PUBLIC_SUPABASE_URL`. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable stand-in for the global navigator (tests / workers). */
  navigatorRef?: { onLine?: boolean };
}

/** Reads the configured Supabase base URL at call time (never at import). */
function configuredBaseUrl(): string | null {
  const raw = (import.meta.env?.PUBLIC_SUPABASE_URL as string | undefined) ?? '';
  const trimmed = String(raw).trim();
  // The demo build uses the single-space sentinel: "not configured" is truth,
  // not an outage, so an empty/masked value reports itself as such.
  if (!trimmed || !/^https?:\/\//.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

export async function probeServer(options: ProbeOptions = {}): Promise<ProbeResult> {
  const nav = options.navigatorRef ?? navigator;
  const browserOnline = (nav?.onLine ?? true) !== false;
  const base = options.baseUrl ?? configuredBaseUrl();
  const checkedAt = Date.now();

  if (!base) {
    return {
      browserOnline,
      serverReachable: false,
      checkedAt,
      latencyMs: null,
      detail: 'server-unconfigured',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    // Public, credential-free health endpoint; `no-store` so an intermediary
    // cannot synthesize a stale "fine" answer.
    const response = await fetchImpl(`${base}/auth/v1/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      // 401/404/500/502… — reachable-ish but NOT CONFIRMED: any non-2xx is
      // ambiguous, and ambiguity resolves to false by policy.
      return {
        browserOnline,
        serverReachable: false,
        checkedAt,
        latencyMs,
        detail: `HTTP ${response.status}`,
      };
    }
    return {
      browserOnline,
      serverReachable: true,
      checkedAt,
      latencyMs,
      detail: 'HTTP OK',
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const detail = name === 'AbortError' ? 'timeout' : name || 'network-error';
    return {
      browserOnline,
      serverReachable: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail,
    };
  } finally {
    clearTimeout(timer);
  }
}
