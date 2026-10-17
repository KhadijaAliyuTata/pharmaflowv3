import type { AuditAction, AuditEvent, Role } from '~/domain/types';
import type { AuditEventWithActor } from '~/lib/supabase/audit';

/**
 * `audit_events` row -> domain `AuditEvent`.
 *
 * The same one-way translation as the other `*-mapping.ts` modules: the screens
 * keep reading camelCase domain objects, and the snake_case row is converted
 * once, here. Two renames carry the meaning — `created_at` is `timestamp`, and
 * the embedded `profiles` row is flattened to `actorName` / `actorRole`.
 *
 * ## The actor may be unreadable, and the event is still shown
 *
 * `audit_events` holds only `actor_id`; the name and role come from an embedded
 * `profiles` read whose policy (`id = auth.uid() or (not is_customer and
 * branch_id = pf_current_branch())`) is *narrower* than the audit read itself.
 * An actor who has since left the branch — or who has been turned into a
 * customer — is therefore not readable, and the embed is `null`. That must not
 * drop the event: the action, description and timestamp are the record, and the
 * attribution is what degrades.
 *
 *   * a missing name becomes **`Unknown`**, not blank. The name is not guessed:
 *     the point of the row is that it may have been somebody who is no longer
 *     here, and inventing a colleague's name would be worse than admitting the
 *     gap. `Unknown` also keeps the dashboard's actor filter from offering an
 *     empty option.
 *   * a missing role becomes **`assistant`**, the least-privileged role, so an
 *     unreadable actor is never shown as an owner on `/staff`. It is a display
 *     default for an edge case, not a claim about the person.
 *
 * ## `action` is unconstrained in the database
 *
 * `audit_events.action` is plain `text`, and the database writes values the UI
 * does not know: `pf_audit_role_change` writes `role.membership_created`,
 * `role.membership_removed` and `role.changed`, and the platform RPCs write
 * `pharmacy_created`, `pharmacy_status_changed` and `pharmacy_activated`. None
 * of those is a member of the `AuditAction` union on this side.
 *
 * The row is **never dropped** for it — the description is human-readable and
 * carries the meaning regardless. The action is passed through as-is; where the
 * union is missing a value, `ACTION_LABEL` / `ACTION_TONE` render nothing for
 * that cell. That gap is reported rather than papered over with a fallback
 * action, because every member of `AuditAction` names a specific event and there
 * is no honest member to borrow. Reconciling the union with what the database
 * actually writes is a follow-up, not something to fake here.
 */

export function toAuditEvent(row: AuditEventWithActor): AuditEvent {
  const actor = row.profiles;
  const metadata = asMetadata(row.metadata);

  return {
    id: row.id,
    timestamp: row.created_at,
    actorName: actor?.full_name ?? UNKNOWN_ACTOR_NAME,
    actorRole: actor?.role ?? UNKNOWN_ACTOR_ROLE,
    action: row.action as AuditAction,
    description: row.description,
    ...(metadata ? { metadata } : {}),
  };
}

/** Wholesale list -> domain mapping, keeping the query's order. */
export function toAuditEvents(rows: AuditEventWithActor[]): AuditEvent[] {
  return rows.map(toAuditEvent);
}

/** See the note above: an unreadable actor is named, never guessed at. */
const UNKNOWN_ACTOR_NAME = 'Unknown';
const UNKNOWN_ACTOR_ROLE: Role = 'assistant';

/**
 * `metadata` is `jsonb`, so it is any JSON value: an object, an array or a
 * scalar. The domain carries a plain object or nothing at all, so an array or a
 * primitive is dropped rather than forced into a shape it is not.
 */
function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
