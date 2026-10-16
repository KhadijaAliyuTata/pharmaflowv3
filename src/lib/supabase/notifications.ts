import type { NotificationRow } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fail, fromList, ok, type Result } from './result';

/**
 * Notifications, read and cleared.
 *
 * ## Where isolation comes from
 *
 * `notifications_read` is
 * `recipient_id = auth.uid() or (recipient_id is null and branch_id =
 * pf_current_branch())`. So the select below is deliberately un-filtered on the
 * client: a person sees the rows addressed to them personally **plus** the
 * branch-wide rows addressed to nobody in particular. Adding `.eq('branch_id', …)`
 * or `.eq('recipient_id', …)` here would be a second, weaker restatement of a
 * rule the database already applies — and the wrong one for a row whose
 * `recipient_id` is null.
 *
 * ## Cleared is an UPDATE, and it is narrower than the read
 *
 * Reading spans those two arms; clearing does not. UPDATE is
 * `notifications_staff_update`, `using (recipient_id = auth.uid())`, so a
 * branch-wide row is visible but is nobody's to mark read. An RLS-filtered
 * UPDATE reports success while matching zero rows, which is why both mutators
 * return the ids they actually changed rather than a bare boolean — otherwise
 * "mark all read" would claim to have cleared alerts it never touched.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/**
 * Named, not `*`, for the reason every other read in this codebase names its
 * columns. `branch_id` and `recipient_id` are absent because the read policy has
 * already selected the rows that matter and neither id tells the screen anything
 * it can act on.
 */
export const NOTIFICATION_COLUMNS = 'id,kind,title,body,severity,link,read_at,created_at';

/**
 * The shape `NOTIFICATION_COLUMNS` selects. Narrower than `NotificationRow`
 * because the two ids the policy already used to choose the rows — `branch_id`
 * and `recipient_id` — are deliberately not fetched; naming them would invite a
 * caller to filter on them. The mapper and the hook take this type, so their
 * absence is checked by the compiler rather than assumed.
 */
export type NotificationSelect = Pick<
  NotificationRow,
  'id' | 'kind' | 'title' | 'body' | 'severity' | 'link' | 'read_at' | 'created_at'
>;

/** This caller's notifications — theirs plus the branch's — newest first. */
export async function listNotifications(limit = 50): Promise<Result<NotificationSelect[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  return fromList<NotificationSelect>(
    await client()
      .from('notifications')
      .select(NOTIFICATION_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

/**
 * Mark one notification read. Returns the ids the update changed.
 *
 * `read_at is null` is in the predicate so a second click cannot rewrite the
 * timestamp — the row is already cleared, and "when the owner first saw it"
 * should not move. That also makes the zero-row case unambiguous: either the row
 * is already read, or it is a branch-wide row this caller cannot clear.
 */
export async function markNotificationRead(id: string): Promise<Result<string[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client()
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .is('read_at', null)
    .select('id');

  if (error) return fail(error.message, error.code);
  return ok(((data ?? []) as { id: string }[]).map((row) => row.id));
}

/**
 * Mark every unread notification this caller may clear. Returns the ids changed.
 *
 * No `.eq('recipient_id', …)` is needed: the UPDATE policy already restricts the
 * statement to the caller's own rows, so the branch-wide ones are left standing
 * by the database rather than by a client filter that a different caller could
 * forget.
 */
export async function markAllNotificationsRead(): Promise<Result<string[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client()
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null)
    .select('id');

  if (error) return fail(error.message, error.code);
  return ok(((data ?? []) as { id: string }[]).map((row) => row.id));
}
