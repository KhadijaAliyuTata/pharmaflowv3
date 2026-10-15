# Live-data plan — the §1.1 seeded-data screens

What each screen that reads `localStorage` should become when the app runs against
Supabase, and in what order. Companion to `docs/STAGING-VALIDATION.md` §1.1 and
`docs/PHASE-0-DATA-MIGRATION.md`.

Three verbs are used throughout:

- **A — back it with a live query.** Name the table/view, the columns, and the RLS
  predicate; say whether the query already exists.
- **B — hide or disable it in live mode**, with honest copy explaining why.
- **C — merge it into another screen** that already has a live backend.

Every claim below is verified in the repo source. Where a claim is not verifiable
without a running staging environment it is marked **[needs live test]**.

---

## 0. Ground truth this plan rests on

**The forced decision.** In live mode the screens read `localStorage`, and "the list
a pharmacist is looking at came from Postgres; the collection an edit mutates is the
seeded prototype copy" (`src/lib/catalogue-writes.ts:3–21`). Before any screen can be
*backed*, `createSeedState()` must stop running in live mode (§2). Otherwise a live
query and a seeded fallback would coexist and the screen would show fictional rows on
any slow or failed fetch.

**Repository inventory** (`grep 'export ... function' src/lib/supabase`):

| Backend | Function | State |
|---|---|---|
| `medicines` / batches | `listMedicines`, `listBatches`, `listExpiring` | exists, wired (`useMedicines`) |
| `suppliers` | `listSuppliers` | exists, wired (`useSuppliers`) |
| `profiles` + `branch_memberships` | `listStaff`, `listInvitations`, `listBranchStaff` | exists, wired (`useStaff`) |
| branch | `loadCurrentBranch`, `loadTenantContext`, `listAvailableBranches`, `useBranchName` | exists |
| `sales` + `sale_items` | `listSales`, `getSale` | exists but **broken** (below) |
| owner cost | `listSaleItemCosts`, `listMedicineCosts`, `listBatchCosts` | exists |
| `customers` | `listCustomers`, `getMyCustomerRecord` | exists |
| `credit_accounts` + `credit_ledger` | `listCreditAccounts`, `listCreditLedger`, `recordCreditPayment` | exists |
| `audit_events` | `listAuditEvents`, `recordAuditEvent` | exists |
| `notifications` | — | **must be written** |
| `customer_orders` + `order_items` | — | **must be written** |
| `medicine_requests` | — | **must be written** |
| `stock_receipts` | — | **must be written** |
| `stock_movements` | — (realtime subscribe only) | **must be written** |

**The blocking bug.** `listSales`/`getSale` do `select('*, sale_items(*)')`
(`src/lib/supabase/sales.ts:37,49`). The grant on `sale_items` excludes
`cost_per_base_unit_snapshot` (initial schema — the only excluded column). A `*`
expansion requires SELECT on every column, so this embed fails with
`42501 permission denied for table sale_items` — the same failure class `catalog.ts`
documents at the top of its file. **`/sales` cannot be backed until `listSales` names
its columns** (a `SALE_ITEM_COLUMNS` constant, mirroring `MEDICINE_COLUMNS`).

**RLS predicates** (`20261002160000_initial_schema.sql`):

- `sales`: `branch_id = pf_current_branch() or customer_id in (select id from customers where auth_user_id = auth.uid())`
- `sale_items`: `exists (select 1 from sales s where s.id = sale_id)`
- `customers`: `auth_user_id = auth.uid() or branch_id = pf_current_branch()`
- `profiles`: `id = auth.uid() or (not is_customer and branch_id = pf_current_branch())`
- `suppliers`, `medicines`, `medicine_batches`, `stock_receipts`, `stock_movements`, `medicine_requests`: `branch_id = pf_current_branch()`
- `credit_accounts`, `credit_ledger`, `audit_events`: `pf_is_owner() and branch_id = pf_current_branch()`
- `customer_orders`: `branch_id = pf_current_branch() or customer_id in (select id from customers where auth_user_id = auth.uid())`
- `order_items`: `exists (select 1 from customer_orders o where o.id = order_id)`
- `notifications`: `recipient_id = auth.uid() or (recipient_id is null and branch_id = pf_current_branch())`
- `branches`: `pf_is_customer() or id = pf_current_branch()`

---

## 1. Per-screen decision

### Staff app

**1. Dashboard — `src/routes/_app/index.tsx` (§1.1 L113–125)**
**Decision: A, composite.** Seven reads, each with a real backend; the database's RLS
already decides what each role sees.

| tile | table | columns | RLS | query |
|---|---|---|---|---|
| revenue/sales | `sales` + `sale_items` | `receipt_number, sold_at, attendant_id, customer_id, subtotal, discount, total, payment_method, state, amount_paid, outstanding` + line `medicine_name, unit_name, quantity, unit_price, line_total` | `sales_read` → `sale_items_read` | `listSales` — **fix the embed** |
| activity ledger | `audit_events` | `actor_id, action, description, metadata, created_at` (+ `profiles.full_name/role`) | `audit_read` (**owner**) | `listAuditEvents` exists; add profiles embed |
| notifications | `notifications` | `kind, title, body, severity, link, read_at, created_at` | `notifications_read` | **write** `listNotifications` |
| credit tile | `credit_accounts` | `outstanding_balance, credit_limit` | `credit_read` (**owner**) | `listCreditAccounts` exists |
| suppliers | `suppliers` | `name, …` | `suppliers_read` | `useSuppliers` (wired) |
| demand radar | `medicine_requests` | `medicine_name, urgency, state, recorded_at` | `requests_read` | **write** `listMedicineRequests` |
| team table | `profiles` | `full_name, role, phone` | `profiles_read` | `useStaff` (wired) |

The audit and credit tiles are owner-only in the database. The dashboard already gates
the "View Full Audit Log" link; the **tiles must be gated on `useIsOwner()`** so an
assistant sees a role-appropriate card, not an empty owner card.

**2. Credit accounts — `_app/credit-accounts.tsx` (§1.1 L66)**
**Decision: A.** `credit_accounts(id, name, kind, contact_person, phone, credit_limit,
outstanding_balance, is_suspended)` + `credit_ledger(account_id, entry_at, kind, amount,
balance_after, note, recorded_by)`. RLS `pf_is_owner() and branch_id = pf_current_branch()`
(both). **Queries exist.** Needs a hook; ledger fetched per account on selection.
Owner-only. *P2 — only required if the pilot extends credit.*

**3. Customers — `_app/customers.tsx` (§1.1 L96–97)**
**Decision: A.** `customers(…)` + `sales` for purchase history. RLS spans both arms of
`customers_read`. **`listCustomers` exists**; needs a `useCustomers` hook. Also feeds
the POS customer picker and global search.

**4. Sales — `_app/sales.tsx` (§1.1 L96)**
**Decision: A (after fixing the query).** `sales` header + `sale_items` lines +
`profiles` (attendant name) + `customers` (name). **`listSales` exists but is broken**
— see §0. Fix = explicit sale-item column list and aliased `profiles`/`customers`
embeds.

**5. Reports — `_app/reports.tsx` (§1.1 L81,85)**
**Decision: A (owner).** `sales` + `sale_items` + **`pf_sale_item_costs`** (owner-gated
view — cost is not selectable from `sale_items` directly) + `suppliers`. **`listSales`
+ `listSaleItemCosts` exist.**

**6. Notifications — `_app/notifications.tsx` (§1.1 L61)**
**Decision: A.** `notifications(…)`. RLS `notifications_read`; mark-read is an UPDATE
covered by `notifications_staff_write`. **Must be written:** `listNotifications`,
`markNotificationRead`, `markAllNotificationsRead`. The `kind` column is unconstrained
text; the mapper needs a defined fallback for unknown kinds.

**7. Orders — `_app/orders.tsx` (§1.1 L65–66)**
**Decision: B — hide in live mode with honest copy.** `customer_orders` + `order_items`
and `medicine_requests` have correct tables and RLS, but **nothing in the app inserts a
row of either**. A screen that can only ever render its empty state is worse than an
honest "not yet available".

**7b. Demand Radar — `_app/demand-radar.tsx`**
Same reasoning: it reads `medicine_requests` and nothing records a request. **B.**

**8. Pricing — `_app/pricing.tsx` (§1.1 L51)**
**Decision: A, but gated behind Tier 7.** `stock_receipts(…)` + the `received_*` snapshot
columns. RLS `receipts_read`. **Must be written:** `listStockReceipts`. Two constraints:
`cost_per_base_unit` is **not selectable** on `stock_receipts` (owner reads it via
`pf_receipt_costs`); and the queue only fills once something *inserts* a receipt — the
receiving write path is local-only today. So `/pricing` is **effectively hidden until
Tier 7 lands**.

**9. Staff — `_app/staff.tsx` (§1.1 L88–89)**
**Decision: A.** Team half is live (`useStaff` → `profiles` + `branch_memberships`).
Audit half is `audit_events` via `listAuditEvents` (**exists**), `audit_read`
owner-only. Needs the `profiles` embed for actor name and owner gating.

**10. Stock receiving — `_app/stock-receiving.tsx` (§1.1 L72–75)**
**Decision: A for reads, B for writes.** Reads: `suppliers` (live), `stock_receipts`
(**write** `listStockReceipts`), `stock_movements` (**write** `listStockMovements`),
`medicine_batches` (`listBatches` exists). Writes: the local `receiveStock` action must
be **disabled with the same honest copy as `catalogue-writes.ts`** rather than allowed
to "succeed" against `localStorage`. The real write path is Tier 7.

**11. Stock intelligence — `_app/stock-intelligence.tsx` (§1.1 L76)**
**Decision: B — hide.** The screen's substance (`reorderSuggestions`, days-of-cover)
derives from `medicines.average_daily_sales`, which is `0` until a velocity job exists.
In live mode it would show a false all-clear or a fiction. *Alternative: A-lite — real
stock levels and lead times, reorder from `low_stock_threshold` only, velocity column
labelled "not yet measured".*

**12. Global search — `src/components/app/global-search.tsx` (§1.1 L73–75)**
**Decision: A (partial).** Degrades cleanly without blocking: `medicines` live;
`suppliers` and staff live now; `customers` goes live with Tier 2. Until then search
covers three of five categories rather than falling back to seed.

### Customer portal

**13. `_portal.tsx` + `_portal/portal/{index,orders,profile,reminders,search}` (§1.1 `_portal/*`)**
**Decision: B — hide in live mode. This is a data-exposure defect, not a migration gap.**
`usePortalCustomer()` returns `state.customers[0]` (`src/lib/portal.ts:15–18`), and
`_portal.tsx` admits **any signed-in user**. In live mode that renders one real
customer's wallet balance, outstanding debt, lifetime spend and receipts to *whoever is
signed in*. The correct A path is short and half-built: identity from
`getMyCustomerRecord()` (`customers.auth_user_id = auth.uid()`,
`customers_auth_user_idx` exists for exactly this), the customer arms of
`sales_read`/`orders_read`, and `branches_read`'s `pf_is_customer()` arm. That needs
**`/portal` to require `is_customer`**. Until then: `_portal.tsx` redirects to an honest
"not part of this build" screen and the "Staff side" cross-link is removed.

---

## Q1. First run in live mode, before any data exists

Assuming §2's gating and Tier 1–2 are in: `loadTenantContext` resolves
`profiles.branch_id` + the caller's `branch_memberships`, `useActiveBranch` reports
`ready`, `isOwner()` returns true for the owner. Then:

- **Owner dashboard (`/`)** — every figure is zero, every list empty, and each says so:
  "No sales recorded yet", "No activity recorded yet", "Nothing recorded yet", "No
  credit accounts", "You are all caught up". Team shows one row — the owner themselves.
- **POS (`/pos`)** — inert and honestly so: `useMedicines` returns `[]`, so a search
  finds nothing and "Complete sale" is disabled because there are no lines. It should
  say "This branch has no products yet — add stock in Inventory".
- **Inventory (`/inventory`)** — empty table, "No products in this branch yet." **The
  Add/Edit controls are disabled in live mode** (`catalogueWritesAvailable()` is false),
  so the only way to reach a non-empty inventory is a live write path, which does not
  exist yet. *This is the real day-one gap: an empty live database with no way to
  populate it from the app.*
- **Sidebar/header** — branch name from `useBranchName()` / the wired `state.branch`;
  user name from `setPharmacyCurrentUser`.

---

## Q2. `createSeedState()` gating — the diff

Three lines carry the seed into live mode (`src/store/pharmacy.ts`):

- **L23** `private state: AppState = createSeedState();`
- **L65** `this.state = { ...createSeedState(), ...parsed };`
- **L89** `this.state = createSeedState();` (in `reset()`)

The blocker to gating them is documented in `catalogue-writes.ts:23–29`: **`session.ts`
imports `setPharmacyCurrentUser` from `~/store/pharmacy`**, so the store importing
`isDemoMode` from `~/lib/session` closes an import cycle. The fix is a leaf module
(`src/lib/build-mode.ts`) that imports nothing from the app, which both `session.ts` and
the store may depend on.

**The diff (implemented in Tier 0):**

```ts
// src/store/pharmacy.ts
-import { createSeedState } from '~/domain/seed';
+import { createEmptyState, createSeedState } from '~/domain/seed';
+import { isDemoMode } from '~/lib/build-mode';   // leaf — NOT ~/lib/session

 class PharmacyStore {
-  private state: AppState = createSeedState();
+  private state: AppState = isDemoMode() ? createSeedState() : createEmptyState();
   ...
   hydrate(): void {
     ...
+    // Live mode has no legitimate localStorage state; the demo blob must never
+    // be merged into a live session (it would resurrect seeded rows on reload).
+    if (!isDemoMode()) return;
     ...
-      this.state = { ...createSeedState(), ...parsed };
+      this.state = { ...createSeedState(), ...parsed };
   ...
   reset() {
-    this.state = createSeedState();
+    this.state = isDemoMode() ? createSeedState() : createEmptyState();
```

**The fallback state** — a new `createEmptyState(): AppState` beside `createSeedState`
in `src/domain/seed.ts`, so the two stay in lockstep when `AppState` gains a field:

```ts
export function createEmptyState(): AppState {
  return {
    // `id: ''` fails closed against any `=== auth.uid()` comparison;
    // `role: 'assistant'` can never open owner UI. Real values are written by
    // `setPharmacyCurrentUser` when the session resolves.
    currentUser: { id: '', name: '', email: '', role: 'assistant', phone: '' },
    users: [],
    branch: { id: '', name: '', address: '', city: '', state: '', phone: '',
              openingHours: '', isOpenNow: false, rating: 0, reviewsCount: 0 },
    medicines: [], suppliers: [], creditAccounts: [], customers: [], sales: [],
    stockMovements: [], stockReceipts: [], auditEvents: [], notifications: [],
    customerOrders: [], medicineRequests: [],
  };
}
```

**Two consequences handled in the same change:**

1. `state.branch` and `state.users` become empty placeholders. Tier 0 wires them to the
   live sources (`loadCurrentBranch()`, `listStaff()`) so the header and settings are not
   blank. The placeholder remains the pre-resolution value.
2. The server snapshot: gating on a build-time constant means the server and the first
   client render both produce `createEmptyState()` in live mode, so SSR stays consistent.

---

## Q3. What must be live on pilot day one vs shipped hidden

**Must be live (P0)** — without these a pharmacy cannot operate:
1. Auth + branch resolution — *done.*
2. Inventory / catalogue read — *done* (`useMedicines`).
3. POS sale write — *done* (`pf_complete_sale`).
4. **Sales ledger** (`/sales`) — *after* fixing `listSales`. Takings must be visible; the
   dashboard revenue tiles read the same data.
5. **Dashboard** — seeded-free (empty-safe); sales tile live, owner tiles gated on
   `useIsOwner()`.
6. Suppliers — *done.*
7. Staff — *done* (team live; audit panel owner-gated once `listAuditEvents` is wired).

**Can ship hidden with honest copy (P1/P2):** portal (`/portal/*` — no customer auth +
data exposure), orders (`/orders`) and Demand Radar (no capture path), stock intelligence
(velocity unmeasured), pricing (`/pricing` — queue can't fill until Tier 7), credit
accounts (live-if-credit-is-offered, else hidden), reports (owner-only; live once sales
is live), notifications (ships live as empty, or hidden-with-copy).

**The unstated day-one dependency:** *how does stock enter an empty live database?*
Receiving writes are local-only and catalogue writes are disabled in live mode. Either
Tier 7 ships before the pilot, or the runbook documents a seed/import step performed
outside the app. This is a go/no-go item, not a UI detail.

---

## Q4. Dependency order — which live backends unblock which screens

**Tier 0 (done):** branch context, `medicines`, `suppliers`, `staff`, POS write, auth/invite.

**Tier 1 — Sales read** (`SALE_ITEM_COLUMNS` fix + `useSales`). Widest fan-out: unblocks
**`/sales`, dashboard revenue tiles, `/reports`, customer purchase history, dashboard
per-member totals, stock-intelligence velocity, portal sales**.

**Tier 2 — Customers read** (`useCustomers` over existing `listCustomers`). Unblocks
**`/customers`, global search, the POS customer picker, portal identity**, and the names
on sales/orders.

**Tier 3 — Notifications** (`listNotifications` + mark-read; new). Unblocks
**`/notifications` and the dashboard bell**. Lowest risk.

**Tier 4 — Audit read** (`listAuditEvents` + `profiles` embed + `useAuditEvents`;
owner-only). Unblocks the **`/staff` audit panel and the dashboard activity ledger**.

**Tier 5 — Credit accounts/ledger** (`useCreditAccounts` over existing queries;
owner-only). Unblocks **`/credit-accounts` and the dashboard credit tile**. *Before
wiring, verify the R6 invariant — `pf_check_credit_ledger_balance` is defined but
`sales.ts:305` says it "is never attached"* **[needs live test]**.

**Tier 6 — Receipts + movements read** (`listStockReceipts`, `listStockMovements`).
Unblocks **`/stock-receiving` history and the `/pricing` queue** in read terms only.

**Tier 7 — Receiving write path** (`receiveStock` → an atomic `pf_receive_stock` RPC
inserting receipt + batch + movement; `pf_set_stock_price`). Unblocks **`/pricing` (it
creates the queue)** and **`/stock-receiving` writes**, and answers Q3's "how does stock
enter the database" question.

**Tier 8 — Orders + requests** (`listCustomerOrders`, `listMedicineRequests` + a capture
path). Unblocks **`/orders` and `/demand-radar`**. The read is easy; the capture is the
work.

**Tier 9 — Customer identity** (`getMyCustomerRecord()` + a `/portal` guard requiring
`is_customer`). Unblocks **the entire portal** and the customer arms of
`sales_read`/`orders_read`. Also the fix for the §1.1 portal data-exposure defect.

**Chain:** `Tier 9 → portal` · `Tier 1 → most read screens` · `Tier 7 → pricing +
receiving loop` · `Tier 8 → orders (needs Tier 9 for the customer side)` · `Tiers 3/4/5
→ independent of each other`.

**Build order for pilot readiness:** Tier 1 → Tier 2 → Tier 3 → Tier 4 → Tier 7 →
Tier 9 (portal unhide) → Tier 5 → Tier 8 → Tier 6.
