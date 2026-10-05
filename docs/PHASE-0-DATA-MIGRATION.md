# Phase 0 — Supabase data-access foundation

What this phase delivered, and what still has to happen before the running app can
stop using `localStorage`.

**Nothing in the application was rewired.** The screens still read and write the
localStorage store exactly as before. What is new is the layer they will be
pointed at: accurate database types, a repository layer, and a tenant/session
resolver. Nothing here is imported by any screen yet, so none of the working
behaviour — POS, inventory, Shelf Sense, expiry intelligence, customer ordering,
credit, audit — can regress from it.

---

## 0a. Multi-unit inventory — migration `20261005120000_unit_hierarchy.sql`

Additive only; both earlier migrations untouched and all three remain safe to
re-run. Packaging is a **conversion layer over one canonical base unit**, never a
second quantity system.

**Full documentation: [`UNIT-SYSTEM.md`](./UNIT-SYSTEM.md).** Summary:

- `stock_receipts` gained `received_quantity`, `received_unit_key`,
  `received_unit_name`, `received_unit_multiplier` — the delivery note is kept
  as a snapshot so a later repackaging cannot reinterpret an old receipt.
  Backfilled for existing rows as "counted in base units".
- `pf_check_base_unit` (which only checked element 0) was replaced by
  `pf_validate_medicine_units`, which checks every unit: positive integer
  factors, unique non-blank keys, non-blank names, non-negative prices, exactly
  one base unit, first in the list.
- **Security:** `medicines.units` was in the plain UPDATE grant, so any attendant
  could redefine packaging and restate every price, margin and stock figure in
  the branch. Now owner-only via `pf_guard_unit_write`, using the existing
  per-branch role model and the same `auth.uid() IS NULL` bootstrap exemption as
  `pf_guard_cost_write`. No parallel authorization was introduced.
- **Two defects fixed** (see `UNIT-SYSTEM.md` §13): `sale_items.batch_id` was
  never granted, leaving the FEFO write path unreachable; and the receipt unit
  columns needed explicit grants.
- Client side: `src/domain/units.ts` is the single home for conversion,
  validation and display. `receiving` now counts in any packaging unit, `checkout`
  re-derives and verifies each line's base total, and `updateUnitPrice` configures
  a unit's price independently of the proportional calculation.
- The owner-only cost rule is untouched: `calculateUnitCost` returns `null` when
  cost is absent, and `updateUnitPrice` fails closed rather than skipping the
  "above cost" check.

---

## 0. Follow-up fixes — migration `20261004090000_stock_ledger_and_fefo_foundation.sql`

Additive only. `20261002160000_initial_schema.sql` is untouched; both run in
order and both are safe to re-run (verified: 0 failures on a second pass).

### Fixed

**Credit ledger invariant.** `pf_check_credit_ledger_balance` was defined with no
trigger invoking it. It had existed at `40db6aa` and was **lost during the Phase 0
rewrite** — a regression introduced there, not a pre-existing gap. Restored, and
the other half of the invariant added: `pf_check_credit_account_ledger` catches an
owner changing `credit_accounts.outstanding_balance` directly while the ledger
describes a different figure. Both directions now fail loudly.

**Sale → batch relationship.** `sale_items.batch_id uuid references
medicine_batches(id) on delete set null`, plus a partial index. Nullable so
historical sales survive; `SET NULL` so deleting a lot never deletes the record
that it was sold. `pf_check_sale_item_batch` enforces that the lot belongs to the
same product as the line — two independent foreign keys cannot express that, and
without it a paracetamol line could point at an amoxicillin lot and silently
corrupt every expiry and recall report built on the link.

**Stock movement ledger.** Movements are now **derived from `medicine_batches`**
by `pf_record_stock_movement`, not written alongside it. One source of truth, so
a receipt, adjustment, disposal or sale all produce a movement for free as long as
they change a lot. `stock_movements.batch_id` added for traceability;
`performed_by` made nullable because a trigger cannot know who edited a lot
outside any authenticated request, and NULL is defined as "written by the
database, no authenticated actor". The `movements_staff_write` INSERT policy is
**dropped** and the grant revoked — the ledger has exactly one writer, so a client
insert could only ever be a duplicate or a fabrication. A no-op batch edit records
nothing.

**Multi-branch architecture.** `branch_memberships(user_id, branch_id, role,
is_default)` makes membership many-to-many; `profiles.branch_id` becomes the
*active* selection that `pf_current_branch()` already reads.
`pf_set_active_branch(uuid)` is the only sanctioned way to switch and refuses any
branch the caller has no membership of. `pf_my_branches` returns exactly the
branches this session may open. `pf_sync_profile_membership` mirrors a branch
assignment into a membership so staff added after the migration are not stranded.
`pf_guard_profile_privileges` permits a switch the membership table backs and
still refuses self-promotion.

Role is **per branch**: an owner at head office can be an assistant at a counter,
and `pf_is_owner()` reads whichever branch is active.

No pharmacy/owner id was added. `branches` remains the tenant root and
`is_main_hub` marks the primary site; a second tenancy level now would mean
migrating 14 `branch_id` columns later.

**Realtime decision.** `medicines`, `medicine_batches` and `stock_receipts` stay
**out** of the publication — all three hold `cost_per_base_unit`, and Realtime
`postgres_changes` filters by RLS but **not** by column grants, so publishing them
leaks purchase price to assistants.

Rather than leave live stock broken, `stock_movements` is published. It carries no
cost and no branch secret, so subscribing gives every till the signal that
something moved and therefore the ability to re-fetch the affected products — the
live behaviour the dashboard wanted, with nothing sensitive in the payload.
`subscribeToStockChanges()` wraps it.

---

## 1. What exists now

```
src/lib/db.types.ts            18 tables, 5 views, 10 enums, 6 RPCs, explicit
                                Insert/Update types
src/lib/supabase/
  client.ts                     typed client + session precheck
  result.ts                     Result<T>, never throws, never swallows an RLS error
  tenant.ts                     user / branch / role resolution
  branches.ts                   multi-branch: availableBranches + switchBranch
  catalog.ts                    medicines, batches, stock, costs
  sales.ts                      sales, sale lines, credit
  parties.ts                    customers, suppliers, audit
  realtime.ts                   live stock via stock_movements
  index.ts                      the public surface
```

The pre-existing `src/lib/supabase.ts` is untouched, because `src/lib/session.ts`
imports `getSupabase` from it and that file drives the login flow. The new layer
sits alongside it and re-exports the same singleton, so there is one client.

---

## 2. Entity map

`AppState` has 14 keys. The schema has 17 tables. Everything maps; nothing is
orphaned.

| localStorage entity | Supabase | Shape difference |
|---|---|---|
| `state.branch` | `branches` | **singular vs multi-branch** — see risk R1 |
| `state.users` | `profiles` | DB also holds customer rows (`is_customer`) |
| `state.medicines` | `medicines` + `medicine_batches` | nested array vs two tables |
| `state.suppliers` | `suppliers` | direct |
| `state.customers` | `customers` | direct |
| `state.creditAccounts` | `credit_accounts` + `credit_ledger` | nested ledger vs table |
| `state.sales` | `sales` + `sale_items` | nested items vs table |
| `state.stockReceipts` | `stock_receipts` | direct |
| `state.stockMovements` | `stock_movements` | direct |
| `state.customerOrders` | `customer_orders` + `order_items` | nested items vs table |
| `state.medicineRequests` | `medicine_requests` | direct |
| `state.auditEvents` | `audit_events` | direct |
| `state.notifications` | `notifications` | direct |

### Fields needing transformation

| Frontend | Database | Transform |
|---|---|---|
| `Medicine.supplier: string` (name) | `supplier_id: uuid` | join `suppliers` |
| `MedicineBatch.supplier: string` | `supplier_id: uuid` | join |
| `StockReceipt.supplier: string`, `receivedBy`, `pricedBy` | uuids | join `suppliers` / `profiles` |
| `Medicine.doNotSell: {active, reason, lockedBy, lockedAt}` | 4 flat columns | flatten / regroup |
| `Medicine.costPerBaseUnit: number` (required) | not selectable on `medicines` | read `pf_medicine_costs`; **absent for assistants** |
| `SaleItem.costPerBaseUnitSnapshot` | not selectable on `sale_items` | read `pf_sale_item_costs` |
| `AppNotification.read: boolean` | `read_at: timestamptz` | boolean → timestamp (information lost: when it was read) |
| `CreditAccount.status: 'active'\|'suspended'` | `is_suspended: boolean` | **inverted** |
| `StockMovement.notes` (plural) | `note` | rename |
| `StockMovement.performedByRole` | — | no column; derive via `pf_current_role()` |
| `Sale.attendantName`, `customerName`, `customerPhone` | uuids only | join `profiles` / `customers` |
| `AuditEvent.actorName`, `actorRole` | `actor_id` only | join `profiles` |
| `CustomerOrder.branchName` (required) | `branch_id`, no name column | join `branches` |
| `medicine.prescriptionStatus: 'OTC'\|'Prescription'\|'Controlled'` | enum `'otc'\|'prescription'\|'controlled'` | **lowercase — a bare `.toLowerCase()` is safe here, but note the frontend casing differs from the DB** |
| `creditLedgerEntry.type` | `kind` | rename |
| `users[].email` | not in `profiles` — lives in `auth.users` | fetch via `auth.getUser()` |
| `SaleItem.batchId?` | **no column anywhere** | **cannot be persisted** — see R4 |
| `lowStockThreshold` | `medicines.low_stock_threshold` | direct, but no write path exists in the UI |
| `averageDailySales` | `medicines.average_daily_sales` | direct, but currently a **seeded constant**, not computed — see §6 |

### Money columns

Every money column is `numeric(14,2)` and arrives in JS as a **string** from
PostgREST, not a number. `numeric` is a base-10 type; JSON has no decimal, so
supabase-js hands it back as `"200.00"`. Every value must pass through
`money()` in `src/domain/money.ts` on the way in, and be re-rounded on the way
out. Skipping this reintroduces `0.1 + 0.2 !== 0.3` at the boundary, which is
the exact problem that module exists to prevent.

---

## 3. Where cost and margin now come from

This is the part with no localStorage equivalent.

`cost_per_base_unit` is **not selectable** on `medicines`, `medicine_batches` or
`stock_receipts`, and `cost_per_base_unit_snapshot` is not selectable on
`sale_items`. The column grants withhold them because a Postgres grant cannot be
conditional on which user is signed in.

Four owner-gated views expose them:

| View | Returns for an owner | Returns for an assistant |
|---|---|---|
| `pf_medicine_costs` | `id, branch_id, cost_per_base_unit` | **0 rows** |
| `pf_batch_costs` | `id, medicine_id, branch_id, cost_per_base_unit` | **0 rows** |
| `pf_receipt_costs` | `id, branch_id, cost, price` | **0 rows** |
| `pf_sale_item_costs` | `id, sale_id, branch_id, cost_per_base_unit_snapshot` | **0 rows** |

An empty result is **not an error** and must not be surfaced as one. Margin
reporting is owner-only by design; `summariseSales` in `selectors.ts` needs the
snapshot and correctly produces nothing for an assistant.

### 3.1 The cost-absence rule

Because the column is genuinely absent rather than zeroed, the client type had to
follow. `Medicine.costPerBaseUnit` and `MedicineBatch.costPerBaseUnit` are
**optional**, and this is the rule every later screen must obey:

> **Cost present → cost calculations may run.**
> **Cost absent → cost calculations return `null`. Never `0`, never `NaN`.**

`0` is the specific failure to avoid: it is indistinguishable from a genuinely
free product, and it flows silently into `stockValue`, `unitMargin` and every
margin report as a confident number built on nothing.

What settled on, and why:

| Piece | Shape | Reason |
|---|---|---|
| `hasCost(medicine)` | type predicate | The single guard. Narrows to `Medicine & { costPerBaseUnit: number }`. |
| `unitMargin` / `marginPercent` / `stockValue` | `number \| null`, **overloaded** | Overloaded on the narrowed medicine so a guarded call site gets `number` with no cast. |
| `portfolioValue` / `expiringValue` | `number \| null` | Null when **any** row lacks cost. A partial total silently understates capital at risk. |
| `sumKnown(values)` | `number \| null` | Same rule for ad-hoc sums. Also rejects `NaN` rather than propagating it. |
| `saleCost` / `summariseSales` | `cost`/`margin`/`marginPercent` nullable | Revenue (`gross`, `discount`, `net`, `outstanding`) is **never** null — money taken in is not a secret. |
| `ExpiryBucket.valueAtCost`, `ReorderSuggestion.estimatedCost` | `number \| null` | Reorder **quantity** stays correct without cost; only its price is unknown. |
| `<MaybeMoney>` / `<MaybePercent>` | render `—` | `Money`/`Percent` stay strictly `number`, so the distinction stays visible at each call site instead of being widened away. |
| `updatePrice` | **fails closed** | With no cost, the "price must be above cost" rule cannot be checked. Skipping it would allow selling below cost; it refuses instead. |

Sorting by a nullable column puts unknowns **last in both directions** —
treating them as 0 would interleave unpriced rows into the middle of a ranked list.

Verified by `%TEMP%\pfdb\verify-cost-absent.ts` (41 assertions),
`verify-cost-boundary.ts` (16) and `verify-pos-checkout.ts` (14).

---

## 4. Read-migrated screens

### Suppliers — READ MIGRATED

| | |
|---|---|
| **Source** | Supabase `public.suppliers` |
| **Repository** | `listSuppliers()` in `src/lib/supabase/parties.ts` |
| **Hook** | `useSuppliers()` in `src/hooks/use-suppliers.ts` |
| **Branch scope** | `suppliers_read` — `branch_id = pf_current_branch()`, `TO authenticated`. No client-side filter: RLS is the boundary |
| **UI integration** | `src/routes/_app/suppliers.tsx` reads the hook instead of `state.suppliers`. Layout, tables, stat tiles, role gate and copy unchanged |
| **Writes** | **Not migrated.** The screen says so; creation/edit/delete are unimplemented on both paths |
| **Verified** | 11 read tests against real Postgres |

Field mapping — one column to one field, no transform:

| DB column | Frontend `Supplier` |
|---|---|
| `id` | `id` |
| `name` | `name` |
| `contact_person` | `contactPerson` |
| `phone` | `phone` |
| `address` | `address` |
| `lead_time_days` | `leadTimeDays` |
| `rating` | `rating` |

`email`, `branch_id`, `created_at`, `updated_at` have no frontend counterpart and
are dropped. `rating` is `numeric(3,1)`, which PostgREST returns as a **string** —
the mapping applies `Number()`. Confirmed by test rather than assumed.

**localStorage compatibility.** `AppState.suppliers` is untouched and still holds
the seed data. The hook reads Supabase when a branch is active and falls back to
the store in demo mode or while the branch resolves; `source` reports which.
Results are **not** written back into the store — doing so would create a second,
editable copy of tenant data, which is the thing this migration removes. In the
current demo build `source` is always `'local'` and nothing changes visually.

**Remaining dependency on this screen.** Both tables join suppliers to
`state.medicines`, which is still localStorage. Once medicines migrate the join
runs on `medicine.supplier_id`; until then it falls back to matching supplier name,
and "Products supplied" will read `Nothing` for products whose seed supplier id
(`sup-abc`) no longer matches a database uuid. **That is the visible cost of
migrating suppliers ahead of medicines**, and the reason medicines should follow
immediately.

---

## 5. Recommended migration order

Ordered so that each step is independently verifiable and no step removes working
behaviour. **None of this has been done.**

### Step 1 — Multi-branch selection, then tenant context
`availableBranches()` and `switchBranch()` already exist. Add `currentBranchId` and
a switcher to `AppState`, wire them, then point `loadTenantContext()` into
`src/lib/session.ts` so identity comes from `profiles` instead of `DEMO_USERS`.

Do this **first**: every later step inherits the tenant scope, and a multi-branch
owner pointed at the database before this exists would see only their home counter.

*Verify:* switching branches changes which rows the app reads; the header shows the
real name and the per-branch role.

### Step 2 � One read-only screen: Suppliers � DONE
`/suppliers` reads `listSuppliers()` via `useSuppliers()`, falling back to the
store. See section 4.
*Verified:* identical rendering, 11 read tests, no console errors.

### Step 3 � Products, read-only � NEXT
`listMedicines()` with the `medicine_batches(*)` embed already returns the nested
shape the store uses, so this is close to a drop-in. Fetch `pf_medicine_costs`
separately and merge cost in only when `isOwner()`.
*Verify:* `/inventory` matches, and cost columns are absent for an assistant.

**Do this next.** Suppliers is live but its product counts still join against
localStorage medicines, so this step is what makes that join meaningful.

### Step 4 — Batches and stock movements
The `applyStockDelta` bug (audit P0) means the store's `totalQuantity` and batch
quantities disagree after any sale. The database cannot: `pf_guard_total_quantity`
recomputes the total from batches on every write, and `pf_sync_total_quantity` now
handles DELETE. **Adopting the database fixes the bug.** Verify by selling and
confirming both numbers move.

### Step 5 — Sales, read-only
`listSales()` with `sale_items(*)` returns the header-plus-lines shape `Sale`
already uses. Do not write yet — see R3.

### Step 6 — Sales writes
`createSale()` writes the header then the lines. This is the first write path and
the first place the transaction problem in R3 bites.

### Step 7 — Customers, credit, audit
Mechanical once the above work.

### Step 8 — Customers/supplier/staff creation, order status changes
These are the read-only screens flagged in the audit. They are new features, not
migration.

### Step 9 — Delete the localStorage store
Only after every screen reads from the database. **Keep the seed data as fixtures
until then** — it is the only thing making the app demoable offline.

---

## 6. Architectural risks

### R1 — `AppState.branch` is a single branch. **Partly resolved.**
The schema is multi-branch: 18 tables now carry `branch_id`, and every RLS policy
scopes to `pf_current_branch()`. The frontend still has one `Branch` object and no
`branchId` field on any entity.

*Resolved on the database side:* `branch_memberships` plus
`pf_set_active_branch()` mean the active branch is genuinely switchable, and the
client cannot assert its own tenant.

*Outstanding on the frontend side:* `AppState` has no `branches[]` and no
`currentBranchId`, and no branch switcher exists. `availableBranches()` and
`switchBranch()` are built and unwired. **Step 1 of the migration order should be
this**, before any screen is pointed at the database — otherwise a multi-branch
owner sees only their home counter.

### R2 — Cost silently disappears for assistants. **RESOLVED.**
Today an assistant's store simply has no cost. After migration, `Medicine.costPerBaseUnit`
is typed as **required** in `types.ts` but is genuinely **absent** from the row.
Every margin computation (`unitMargin`, `marginPercent`, `stockValue`,
`portfolioValue`, `saleCost`, `summariseSales`) would produce `NaN` silently rather
than erroring. The UI hides margin from assistants so it is invisible — until a
screen forgets to gate, and then it renders `₦NaN`. Fix the types before Step 3.

**Fixed before Step 3.** See §3.1 for the rule and the shape it settled on.

### R3 — No transaction across a sale header and its lines.
`createSale()` does two requests. If the line insert fails, the sale persists
without lines. PostgREST cannot span requests. This needs a `SECURITY DEFINER`
function taking `jsonb` for the whole sale. **Do not put a sale on the database
without it** — an unlineable sale breaks margin reporting and stock deduction.

### R4 — FEFO cannot yet choose a lot. **Foundation done, algorithm not.**
`SaleItem.batchId?` previously had **no column anywhere**; `sale_items` had no
link to `medicine_batches`. That is fixed: `sale_items.batch_id` exists, is
nullable, is validated against the line's product, and `pf_apply_sale_item_stock`
decrements the named lot and records the movement.

**Update (2026-10-05):** the *write path* was also dead. The initial migration's
column grant on `sale_items` predated `batch_id` and was never extended, so no
client could set it — and a sale without `batch_id` moves no stock by design.
Fixed in `20261005120000_unit_hierarchy.sql` by granting INSERT **and** SELECT on
`batch_id` (SELECT is required for `RETURNING batch_id`, and reading it back is
how a client confirms which lot a line consumed).

What is **not** built is FEFO itself — choosing *which* lot when several qualify
by expiry. The caller still supplies `batch_id`. `src/domain/operations.ts`
`applyStockDelta` does not know how to pick a lot, and never decrements an
existing batch, so a local sale is not yet attributed to a lot. That is Phase 1
work. See `docs/UNIT-SYSTEM.md` §8.

### R5 — `stock_movements` is written by trigger now. **Resolved.**
The migration header claimed every stock change must write a movement and nothing
implemented it. `pf_record_stock_movement` derives movements from batch changes,
and the client can no longer write them, so the ledger has one writer.

One gap remains: a sale that does **not** name a `batch_id` moves no stock and
writes no movement. Once `createSale()` is migrated it must supply one per line,
or `pf_apply_sale_item_stock()` has nothing to decrement.

### R6 — `pf_check_credit_ledger_balance` was unhooked. **Resolved.**
Both directions of the invariant are now enforced by triggers, and both fail with
`check_violation`. Verified: a wrong `balance_after` is rejected, a correct one is
accepted, and drifting the account balance underneath the ledger is rejected.

One caveat for the migration: `pf_check_credit_account_ledger` compares the
account balance to the **latest** ledger row, so an account whose balance moves
before its first ledger row is unconstrained. That is the opening state and is
intentional — there is nothing yet to disagree with.

### R7 — `medicines.state` and `stockStatus` can disagree.
The trigger can emit `out_of_stock` where `selectors.stockStatus` emits `expired`
— specifically when batches exist but all are recalled or expired. Two
implementations of the same concept; pick one per screen.

### R8 — `average_daily_sales` is seeded, not computed.
`reorderSuggestions()` and all velocity logic read it, but nothing derives it from
`sale_items`. Real demand needs a periodic rollup over sales history. Until that
exists, reordering is only as good as a hand-entered number.

### R9 — Offline writes have nowhere to go.
`persistSession: true` keeps the app readable offline but there is no queue. A
sale taken while offline is lost. `src/lib/session.ts` itself notes v2 had an
IndexedDB store and write queue that v3 dropped. This is the single largest gap
between the current build and the product's "affordable pharmacy OS" promise for
Nigerian connectivity.

### R10 — `medicines.total_quantity` cannot be set directly.
`pf_guard_total_quantity` overwrites it from batches. A stock count or adjustment
must therefore be expressed as batch rows, not an aggregate write. `adjustStock`
in `operations.ts` sets an absolute quantity and will not translate.

---

## 7. Features already in the schema

Present and enforced: branch isolation on all 17 tables · owner/assistant roles ·
Do-Not-Sell and batch recall · owner-only pricing approval · cost column hiding ·
audit trail with actor enforced · credit limits with ledger · stock totals derived
from batches · generic-equivalent self-reference · NAFDAC number storage ·
prescription/controlled classification · order state machine · medicine requests
(`Notify me when in stock`).

## 8. Not in the schema

FEFO / Shelf Sense (R4) · purchase orders · returns as a first-class flow
(`movement_kind` has `return` and `disposal` but nothing emits them) · WhatsApp ·
SMS · payment gateway · printer/ESC-POS · offline queue (R9) · price history
(`medicine_batches.cost` exists but nothing writes a new batch when a price
changes) · demand rollup (R8) · NAFDAC **verification** (the number is stored, no
call is made).

## 9. Demand Radar � status

**Not implemented. Do not look for it.**

No file, symbol or string matching `Demand Radar`, `demandRadar`, or `Shelf Sense`
exists anywhere in `src/`. The idea is present in three pieces under other names,
and it is worth being precise about what they are:

| What exists | Where | What it is |
|---|---|---|
| "Stock Intelligence" screen | `src/routes/_app/stock-intelligence.tsx`, `/stock-intelligence` | reorder queue — the closest thing to a demand radar |
| `reorderSuggestions()` | `src/domain/selectors.ts:117-162` | days-of-cover, lead-time-adjusted stockout, 4 priority bands, recommended quantity |
| `medicine.averageDailySales` | `medicines.average_daily_sales` | the velocity input — **a seeded constant today, not derived from sales** (R8) |
| FEFO / Shelf Sense | — | **algorithm absent**; the data foundation landed in the follow-up migration (R4) |

So: reorder intelligence exists and works against seed data. True demand
forecasting does not, because nothing computes velocity from transaction history.

**Its eventual data flow**, once sales are persisted:

```
sale_items ──▶ historical sales ──▶ sales velocity (units/day)
           ──▶ demand trend (per product, per week)
           ──▶ reorder prediction (cover vs lead time)
           ──▶ Demand Radar
```

Each stage has a home: `sale_items` for history, `medicines.average_daily_sales`
for the cached velocity, `medicines.low_stock_threshold` for the target. The last
two are currently hand-entered. **Do not seed or fake any of it** — the honest
version needs persisted sales, which is why it is deferred.

---

## 10. Still deferred

| Item | Blocked on |
|---|---|
| Full localStorage → Supabase migration | per the order in §4; Step 1 should be branch selection |
| FEFO algorithm | R4 — foundation landed, lot *selection* not built |
| Demand Radar | §8 — needs persisted `sale_items` |
| Real sales velocity | `average_daily_sales` is still seeded |
| Complete offline synchronisation | R9 — no queue, no service worker |
| Sale header + lines in one transaction | R3 — needs a `SECURITY DEFINER` function |
| Product / customer / supplier / staff creation | read-only screens; these are new features |

## 11. What the layer deliberately does not do

- **No service-role key, anywhere.** It bypasses RLS; in browser code it would
  void every policy in the migration.
- **No `branch_id` filter parameter.** RLS already scopes every row. A filter the
  client controls is a check a hostile client omits.
- **No `total_quantity` or `state` writes.** Triggers own both.
- **No cost read from base tables.** Owner-gated views only.
- **No writes wired into screens.** Adopting a write path is a per-screen
  decision, not a layer-wide one.

## 12. Still on localStorage

Everything. All 14 `AppState` keys, read and written by
`src/store/pharmacy.ts` under `pharmaflow:state:v3`. The store remains the source
of truth and the app remains fully functional offline on seed data.

One Supabase call existed before this phase — a `profiles` read in
`src/lib/session.ts`. The new layer adds none that any screen invokes.
