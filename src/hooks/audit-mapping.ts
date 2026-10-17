import { ACTION_LABEL, ACTION_TONE } from '~/domain/audit-labels';
import type { ActionTone, AuditAction, AuditEvent, Role } from '~/domain/types';
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
 * ## `action` is unconstrained in the database, and every row gets a label
 *
 * `audit_events.action` is plain `text`, and the database writes values the UI
 * does not know: `pf_audit_role_change` writes `role.membership_created`,
 * `role.membership_removed` and `role.changed`, and the platform RPCs write
 * `pharmacy_created`, `pharmacy_status_changed` and `pharmacy_activated`. None
 * of those is a member of the `AuditAction` union on this side.
 *
 * The row is never dropped, and its action is never blank. `toAuditEvent` sets
 * `actionLabel` and `actionTone` on every row it maps:
 *
 *   * a known action keeps its reviewed label and tone from `ACTION_LABEL` /
 *     `ACTION_TONE`;
 *   * an unknown one is **humanised from the raw string** — `role.changed`
 *     becomes "Role changed" — and given a **neutral tone**, so the cell always
 *     reads as something and never rests on colour alone.
 *
 * `AuditAction` is deliberately *not* widened: it names the actions the app
 * itself records, and inventing members for platform events would put them on a
 * level with a sale or a void. The union stays the vocabulary the database must
 * be reconciled against; the display fields carry the truth until then.
 */

export function toAuditEvent(row: AuditEventWithActor): AuditEvent {
  const actor = row.profiles;
  const metadata = asMetadata(row.metadata);

  return {
    id: row.id,
    timestamp: row.created_at,
    actorName: actor?.full_name ?? UNKNOWN_ACTOR_NAME,
    actorRole: actor?.role ?? UNKNOWN_ACTOR_ROLE,
    // The cast is where the union meets unconstrained text: a known value is a
    // member, an unknown one keeps its raw string at runtime. Nothing the
    // screens show depends on that — they read the two display fields below —
    // so the cast cannot make a label wrong.
    action: row.action as AuditAction,
    actionLabel: labelFor(row.action),
    actionTone: toneFor(row.action),
    description: row.description,
    ...(metadata ? { metadata } : {}),
  };
}

/** Wholesale list -> domain mapping, keeping the query's order. */
export function toAuditEvents(rows: AuditEventWithActor[]): AuditEvent[] {
  return rows.map(toAuditEvent);
}

/**
 * The label to show for an event's action — for every row, known or not.
 *
 * Prefers the value `toAuditEvent` set; falls back for the seeded log, which has
 * no display fields and whose actions are all known members.
 */
export function actionLabelOf(event: AuditEvent): string {
  return event.actionLabel ?? labelFor(event.action);
}

/** The badge tone for an event's action. An action the UI does not know is neutral. */
export function actionToneOf(event: AuditEvent): ActionTone {
  return event.actionTone ?? toneFor(event.action);
}

/** Known label, else the humanised raw string. Never empty. */
function labelFor(action: string): string {
  return (ACTION_LABEL as Record<string, string>)[action] ?? humanise(action);
}

/** Known tone, else neutral. Never undefined, so `Badge` always gets a variant. */
function toneFor(action: string): ActionTone {
  return (ACTION_TONE as Record<string, ActionTone>)[action] ?? NEUTRAL_TONE;
}

/**
 * Turn a raw `audit_events.action` into something an owner can read:
 * `role.membership_created` -> "Role membership created". Splits on `.`, `_` and
 * `-`, and before a capital letter so a camelCase value is handled too. The
 * result is sentence-cased; an empty or symbol-only value falls back to a plain
 * phrase rather than rendering nothing.
 */
function humanise(action: string): string {
  const words = action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\-\s]+/)
    .filter(Boolean);
  if (words.length === 0) return UNKNOWN_ACTION_LABEL;
  const sentence = words.join(' ').toLowerCase();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** See the note on the mapper: an unreadable actor is named, never guessed at. */
const UNKNOWN_ACTOR_NAME = 'Unknown';
const UNKNOWN_ACTOR_ROLE: Role = 'assistant';

/** An action the UI does not recognise is shown in the neutral badge tone. */
const NEUTRAL_TONE: ActionTone = 'secondary';
const UNKNOWN_ACTION_LABEL = 'Unknown action';

/**
 * `metadata` is `jsonb`, so it is any JSON value: an object, an array or a
 * scalar. The domain carries a plain object or nothing at all, so an array or a
 * primitive is dropped rather than forced into a shape it is not.
 */
function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
