/**
 * Result type for every repository call.
 *
 * Repositories never throw and never return a bare value. A Supabase query fails
 * in two very different ways and the caller has to be able to tell them apart:
 *
 *   * an error the user can act on (signed out, RLS refused, no such row)
 *   * a missing configuration (the app is running on localStorage)
 *
 * Collapsing both into `null` is how a signed-out user ends up looking at an
 * empty product list instead of being told to sign in again.
 */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T>(error: string, code?: string): Result<T> {
  return { ok: false, error, code };
}

/**
 * Turns a Supabase `{ data, error }` pair into a Result.
 *
 * PostgREST reports an RLS refusal as a plain permission error, which reads as
 * "empty" if the caller ignores `error`. That is precisely the failure mode this
 * type exists to prevent, so the error is never discarded.
 */
export function fromQuery<T>(result: {
  data: T | null;
  error: { message: string; code?: string } | null;
}): Result<T> {
  if (result.error) return fail(result.error.message, result.error.code);
  if (result.data === null) return fail('No rows returned');
  return ok(result.data);
}

/** Same, for a list query where an empty result is legitimate. */
export function fromList<T>(result: {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}): Result<T[]> {
  if (result.error) return fail(result.error.message, result.error.code);
  return ok(result.data ?? []);
}