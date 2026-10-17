import type { AuditEventRow, Json, ProfileRow } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, ok, type Result } from './result';

/**
 * The audit trail, read and appended.
 *
 * ## Where isolation comes from
 *
 * `audit_read` is `pf_is_owner() and branch_id = pf_current_branch()`. So the
 * select below carries no owner or branch filter of its own: the database has
 * already decided that only an owner of the caller's own branch sees a row, and
 * an assistant gets zero rows rather than an error. Adding `.eq('branch_id', …)`
 * here would be a second, weaker restatement of a rule the database already
 * applies.
 *
 * ## The actor's name is a second relation, and its read is narrower
 *
 * `audit_events` stores only `actor_id`. The screens need the actor's name and
 * role, so the row embeds `profiles`. That policy is
 * `id = auth.uid() or (not is_customer and branch_id = pf_current_branch())` —
 * narrower than the audit policy itself — so the embed names its columns
 * explicitly (`id, full_name, role`) rather than asking for `profiles(*)`, and
 * the embed may be `null`: an actor who has since left the branch, or been
 * turned into a customer, is no longer readable, and the event must still
 * render rather than vanish.
 *
 * `branch_id` is deliberately not fetched, for the same reason as the
 * notification read: the policy has already chosen the rows, and the id is
 * nothing the screen may act on.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/**
 * Named, not `*`, for the reason every other read in this codebase names its
 * columns. `branch_id` is absent because the read policy has already selected
 * the rows that matter; naming it would invite a caller to filter on it.
 */
export const AUDIT_EVENT_COLUMNS = 'id,actor_id,action,description,metadata,created_at';

/** The `profiles` columns an event's actor is shown by. See the note above. */
export const AUDIT_ACTOR_COLUMNS = 'id,full_name,role';

/**
 * The shape `AUDIT_EVENT_COLUMNS` selects — narrower than `AuditEventRow`,
 * because `branch_id` is not fetched.
 */
export type AuditEventSelect = Pick<
  AuditEventRow,
  'id' | 'actor_id' | 'action' | 'description' | 'metadata' | 'created_at'
>;

/** The actor columns `AUDIT_ACTOR_COLUMNS` selects. */
export type AuditActor = Pick<ProfileRow, 'id' | 'full_name' | 'role'>;

/**
 * An audit row with the actor's profile embedded, or `null` when that profile is
 * not readable by this caller — `profiles_read` is narrower than `audit_read`.
 * The mapper, not the query, decides what an unreadable actor looks like.
 */
export type AuditEventWithActor = AuditEventSelect & {
  profiles: AuditActor | null;
};

/** The branch's audit trail, newest first. Owner-only, enforced by `audit_read`. */
export async function listAuditEvents(limit = 100): Promise<Result<AuditEventWithActor[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('audit_events')
    .select(`${AUDIT_EVENT_COLUMNS},profiles(${AUDIT_ACTOR_COLUMNS})`)
    .order('created_at', { ascending: false })
    .limit(limit);

  // `audit_events` declares no `Relationship` in `db.types`, so the parsed row
  // type does not carry the `profiles` key even though PostgREST returns it. The
  // cast is the same one `sales.ts` uses for its embed; the mapper reads the key.
  return fromList<AuditEventWithActor>({
    data: (query.data ?? null) as unknown as AuditEventWithActor[] | null,
    error: query.error,
  });
}

/**
 * Append an audit event.
 *
 * `audit_insert` requires `actor_id = auth.uid()`, so the actor is not a choice
 * the caller can make — an assistant cannot forge an event against somebody
 * else's name. The argument is still taken so the repository has an explicit
 * signature, and it is cross-checked against the session before sending.
 */
export async function recordAuditEvent(input: {
  branch_id: string;
  action: string;
  description: string;
  metadata?: Json;
}): Promise<Result<AuditEventRow>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data: userData, error: userError } = await client().auth.getUser();
  if (userError || !userData.user) return { ok: false, error: 'Not signed in' };

  const { data, error } = await client()
    .from('audit_events')
    .insert({
      branch_id: input.branch_id,
      actor_id: userData.user.id,
      action: input.action,
      description: input.description,
      metadata: input.metadata ?? {},
    })
    .select()
    .single();

  if (error) return { ok: false, error: error.message, code: error.code } as const;
  return ok(data);
}
