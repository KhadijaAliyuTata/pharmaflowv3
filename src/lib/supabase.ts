import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';

/**
 * Supabase client.
 *
 * Two rules this file exists to enforce:
 *
 * 1. `persistSession: true` is what makes offline-first possible. Supabase
 *    writes the session to localStorage, so a signed-in attendant can still
 *    open the app when the pharmacy's connection drops. Do not turn it off to
 *    "fix" a hydration warning — a mismatch there means the server-rendered
 *    HTML and the client disagree about the user, which is a real bug worth
 *    finding.
 *
 * 2. Only `PUBLIC_SUPABASE_*` variables are read. There is no service-role key
 *    anywhere in this app, so the anon key is all a browser can ever see, and
 *    RLS plus the column grants are the real security boundary.
 *
 * If these are missing, `getSupabase()` throws rather than degrading quietly.
 * Whether that absence means "broken deployment" or "demo build" is decided in
 * `~/lib/session`, which is the only place that makes that judgement — see
 * `resolveDeploymentMode` there for why the decision is opt-in.
 *
 * This function only answers "are both halves present". It deliberately does NOT
 * decide whether the app may proceed; a caller that treats `false` as "fall back
 * to something local" is exactly the bug this separation prevents.
 */
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

export function isSupabaseConfigured(): boolean {
  return (
    typeof url === 'string' &&
    url.trim().length > 0 &&
    typeof anonKey === 'string' &&
    anonKey.trim().length > 0
  );
}

export const SUPABASE_URL = url ?? null;

let client: SupabaseClient<Database> | null = null;

/**
 * Lazy singleton. Created on first use rather than at module scope, so that a
 * missing config throws at the point of use with a useful message instead of
 * during SSR of an unrelated page.
 */
export function getSupabase(): SupabaseClient<Database> {
  if (client) return client;

  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured. Set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY ' +
        'in .env, then restart. See supabase/README.md.',
    );
  }

  client = createClient<Database>(url!, anonKey!, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Reconnection backoff. A Nigerian pharmacy connection drops often, so
      // the client should keep trying quietly instead of giving up and leaving
      // the app stranded offline.
      detectSessionInUrl: false,
    },
    db: {
      schema: 'public',
    },
    global: {
      headers: { 'x-application-name': 'pharmaflow' },
    },
  });

  return client;
}

/** Table names, typed against the schema. Keeps typos out of queries. */
export const TABLES = {
  branches: 'branches',
  profiles: 'profiles',
  customers: 'customers',
  suppliers: 'suppliers',
  medicines: 'medicines',
  batches: 'medicine_batches',
  receipts: 'stock_receipts',
  movements: 'stock_movements',
  sales: 'sales',
  saleItems: 'sale_items',
  creditAccounts: 'credit_accounts',
  creditLedger: 'credit_ledger',
  orders: 'customer_orders',
  orderItems: 'order_items',
  requests: 'medicine_requests',
  auditEvents: 'audit_events',
  notifications: 'notifications',
} as const;