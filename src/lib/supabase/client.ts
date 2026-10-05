import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../db.types';
import { getSupabase, isSupabaseConfigured } from '../supabase';

/**
 * The single typed Supabase entry point for repositories.
 *
 * There is no service-role client here, and there must never be one: the
 * service-role key bypasses RLS by design, so a copy of it in browser code would
 * silently dismantle every policy in the migration. Authorization is the
 * database's job — `pf_current_branch()`, `pf_is_owner()` and the column grants
 * already decide what a given session can read. Repositories use the anon key and
 * the user's own JWT, and let Postgres refuse what it should refuse.
 */
export type Client = SupabaseClient<Database>;

export function client(): Client {
  return getSupabase();
}

export { isSupabaseConfigured };

/**
 * True when a session is attached, i.e. requests will carry a JWT and RLS can
 * evaluate `auth.uid()`.
 *
 * Without a session `auth.uid()` is NULL, so `pf_current_branch()` returns NULL,
 * every `branch_id = pf_current_branch()` comparison is NULL — and therefore not
 * true — and each table reads as empty. A repository that ran then would appear
 * to succeed with zero rows, which is a misleading thing to show a pharmacist.
 * Callers check this first.
 */
export async function hasSession(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  try {
    const { data, error } = await getSupabase().auth.getSession();
    return !error && !!data.session;
  } catch {
    return false;
  }
}