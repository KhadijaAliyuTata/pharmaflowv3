import type { CustomerRow } from '~/lib/db.types';
import type { Customer } from '~/domain/types';

/**
 * `customers` row -> domain `Customer`.
 *
 * The same translation as `medicine-mapping.ts` and `sales-mapping.ts`: the
 * screens keep reading camelCase domain objects, and the snake_case row is
 * converted once, here.
 *
 * Two things worth being explicit about:
 *
 *   * **Identity is the database id**, not the customer `code`. `code` is the
 *     human label the table prints; `id` is the uuid that `sales.customer_id`
 *     and `customer_orders.customer_id` point at, so a sale resolves to this
 *     row by `id`.
 *
 *   * **`branch_id` is dropped.** Rows are already branch-scoped by
 *     `customers_read`, which the database applies — carrying the id would
 *     suggest a caller might filter on it, standing in for the policy. Same
 *     reasoning as `toSupplier` and `toMedicine`.
 *
 * `auth_user_id` is dropped as well: it links a row to a portal login, which is
 * never rendered on the staff side. `created_at` / `updated_at` are not on the
 * domain type and are not invented onto it.
 *
 * A null `email` or `notes` becomes an *absent* key rather than an empty string,
 * so "no email on file" and "an email that happens to be blank" stay distinct.
 */

export function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    ...(row.email ? { email: row.email } : {}),
    walletBalance: Number(row.wallet_balance),
    outstandingDebt: Number(row.outstanding_debt),
    totalSpent: Number(row.total_spent),
    purchaseCount: row.purchase_count,
    registeredDate: row.registered_date,
    ...(row.last_purchase_date ? { lastPurchaseDate: row.last_purchase_date } : {}),
    consentForReminders: row.consent_for_reminders,
    chronicMedications: Array.isArray(row.chronic_medications) ? row.chronic_medications : [],
    ...(row.notes ? { notes: row.notes } : {}),
  };
}

/** Wholesale list->domain mapping, keeping the query's order. */
export function toCustomers(rows: CustomerRow[]): Customer[] {
  return rows.map(toCustomer);
}
