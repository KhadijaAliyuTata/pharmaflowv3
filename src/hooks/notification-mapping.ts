import type { NotificationSelect } from '~/lib/supabase/notifications';
import type { AppNotification, NotificationType } from '~/domain/types';

/**
 * `notifications` row -> domain `AppNotification`.
 *
 * The same translation as the other `*-mapping.ts` modules: the screens keep
 * reading camelCase domain objects, and the snake_case row is converted once,
 * here. Three renames carry the meaning — `body` is what the screen calls
 * `message`, `link` is `to`, and `created_at` is `date`.
 *
 * `read` is derived rather than stored: the table has no boolean, only
 * `read_at`, and "unread" is exactly `read_at is null`. A row that has been
 * cleared keeps the moment it was cleared, which is what lets the screen order
 * and label read and unread separately.
 *
 * `branch_id` and `recipient_id` are dropped. The read policy has already chosen
 * the rows the caller may see — their own plus the branch's — so neither id is
 * something the UI may act on.
 *
 * ## The `kind` fallback, stated plainly
 *
 * `kind` is unconstrained `text` in the database: no CHECK, no enum, so a writer
 * may put any string in it. `NotificationType` on this side is a closed union
 * and the screen's `TYPE_META` is keyed exhaustively by it, so an unmapped kind
 * would leave `TYPE_META[type]` undefined and crash that row's render.
 *
 * An unknown kind therefore maps to **`low_stock`, and the row is never
 * dropped**. Everything that carries meaning — title, body, severity, timestamp —
 * is still shown verbatim; only the icon, the category label and the deep link
 * are generic. `low_stock` is the fallback because its label ("Stock") and its
 * destination (`/inventory`) are the least specific of the six, so an
 * unrecognised operational alert lands somewhere useful rather than dressing up
 * as a recall or a pricing task.
 *
 * If the fallback ever fires in production it is a drift signal: the database
 * wrote a `kind` the UI does not know, and the two need reconciling. It is not
 * intended as a resting place, which is why it is named once, here.
 */

const KIND_TO_TYPE: Record<string, NotificationType> = {
  pending_pricing: 'pending_pricing',
  low_stock: 'low_stock',
  expiry_risk: 'expiry_risk',
  cost_increase: 'cost_increase',
  recall: 'recall',
  medicine_request: 'medicine_request',
};

/** See the note above: recognised-but-mapped-to-nothing is `low_stock`, not dropped. */
const FALLBACK_TYPE: NotificationType = 'low_stock';

export function toNotification(row: NotificationSelect): AppNotification {
  return {
    id: row.id,
    type: KIND_TO_TYPE[row.kind] ?? FALLBACK_TYPE,
    title: row.title,
    message: row.body,
    date: row.created_at,
    read: row.read_at !== null,
    severity: row.severity,
    ...(row.link ? { to: row.link } : {}),
  };
}

/** Wholesale list->domain mapping, keeping the query's order. */
export function toNotifications(rows: NotificationSelect[]): AppNotification[] {
  return rows.map(toNotification);
}
