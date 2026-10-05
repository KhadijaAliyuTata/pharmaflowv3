# Multi-unit inventory — architecture

One canonical base unit. Packaging is a conversion layer on top of it, never a
second source of truth.

---

## 1. The canonical base unit

Every quantity in PharmaFlow is an integer count of **base units**:

| Stored in base units | Where |
|---|---|
| `medicines.total_quantity` | the shelf |
| `medicine_batches.quantity` | each lot |
| `stock_movements.quantity_changed` | the ledger |
| `sale_items.base_units_total` | each sale line |
| `stock_receipts.base_units_received` | each receipt |
| `low_stock_threshold`, `average_daily_sales` | reorder maths |

Selling two loose tablets deducts **2 base units** whether the attendant picked
"Tablet" or the customer said "just two of them". A box is not a thing that is
counted; it is 100 base units that happen to be packaged together.

The base unit is the packaging unit whose `multiplier` is `1`. It must be the
**first** element of `medicines.units` — enforced in the database by
`pf_validate_medicine_units` and in the client by `validateUnitHierarchy`.

### Worked example

Paracetamol 500mg — `Piece` (1), `Card (10)` (10), `Box (100)` (100).

```
receive  5 × Box (100)   ->  500 base units
sell     2 × Piece       ->    2 base units deducted, 498 remain
display  498             ->  "4 × Box (100) · 9 × Card (10) · 8 × Piece"
```

498 is the only number anything else agrees with. The display is derived on read.

---

## 2. Unit hierarchy

A unit is:

```ts
interface TradeUnit {
  key: string;           // stable identifier, unique per medicine
  name: string;          // what the pharmacy calls it
  multiplier: number;    // base units in ONE of these — a positive integer
  sellingPrice: number;  // price for ONE of these, configured independently
}
```

### Why the factors are flat, not a chain

A chain (`box = 10 cards`, `card = 10 pieces`) was considered and rejected:

1. **It is already flattened in storage.** `medicines.units` has always stored
   base units per unit, and `pf_check_base_unit` has always keyed on
   `multiplier = 1` at index 0. A chain would mean re-deriving every existing
   multiplier for no behavioural gain.
2. **It removes a whole class of invalid states.** Flat factors cannot be
   circular or ambiguous. `validateUnitHierarchy` never has to reason about
   graph shape because there is no graph.
3. **It is integer-exact.** A chain multiplies factors together; a flat factor is
   stored once and multiplied exactly once at conversion time.
4. **It supports non-nested packaging.** A real pharmacy sells strips of 14 and
   courses of 6 for the same capsule. Neither divides the other, so a
   box→card→piece chain does not even fit. The flat model does not care:
   `[Capsule 1, Strip (14) 14, Course (6) 6]` is valid, and 30 capsules display as
   "2 × Strip (14) · 2 × Capsule".

The hierarchy is therefore **presentational**. `convertFromBaseUnits` walks the
factors largest-first to render it; the canonical number never changes.

### Validation rules

Enforced identically on both sides (`src/domain/units.ts` and
`pf_validate_medicine_units`):

| Rule | Why it matters |
|---|---|
| non-empty array | a product with no units cannot be counted or sold |
| `key` non-blank and unique | two units answering to one key make "box" ambiguous between the POS and a receipt |
| `name` non-blank | an unnamed unit cannot be picked at the till |
| `multiplier` a positive **integer** | `0` would delete stock on receipt or multiply it on sale; `10.5` invents half a tablet |
| `sellingPrice >= 0` | a credit note is not a catalogue entry |
| exactly one `multiplier === 1` | two base units make every deduction ambiguous |
| the base unit is first | the contract the database and the client both rely on |

---

## 3. Conversion functions

All in `src/domain/units.ts`. Pure, synchronous, no Supabase, no clock — so
offline and online cannot disagree.

| Function | Purpose |
|---|---|
| `validateUnitHierarchy(units)` | returns `{ok:true, units}` or `{ok:false, issues[]}` keyed per unit |
| `findBaseUnit(units)` | the `multiplier === 1` unit, or `null` |
| `findUnit(units, key)` | lookup, `null` when absent |
| `unitsBySize(units)` | smallest first, non-mutating |
| `convertToBaseUnits(units, key, qty)` | → `{ok:true, amount}` with a **snapshot** of the multiplier used |
| `convertFromBaseUnits(units, base)` | greedy decomposition, largest first |
| `formatStockQuantity(units, base)` | `"4 × Box (100) · 9 × Card (10)"` — presentation only |
| `calculateUnitPrice(medicine, key)` | the unit's configured price, never proportional |
| `calculateUnitCost(medicine, key)` | `costPerBaseUnit × multiplier`, or **`null`** |
| `calculateUnitMargin(medicine, key)` | price − unit cost, or **`null`** |

`convertToBaseUnits` refuses a non-integer quantity, a quantity ≤ 0, an unknown
unit, an invalid factor, and any product outside safe-integer range. It never
rounds: fractional inventory is refused, not silently invented.

`formatStockQuantity` uses `4 × Box (100)` rather than "4 Boxes" because unit
names legitimately carry counts (`Bottle (100ml)`, `Card (10)`) and no
pluralisation rule survives those.

**No component multiplies a `multiplier` by hand.** That is the rule the whole
module exists to enforce.

---

## 4. Receiving

`ReceiveInput` now takes `quantity` + `unitKey` — what the attendant actually
counted — instead of a pre-multiplied number. `receiveStock` validates the
hierarchy, converts once, and uses that one result for the receipt, the batch and
the stock movement.

A delivery note saying "5 boxes" produces:

```ts
{
  baseUnitsReceived: 500,        // canonical
  receivedQuantity: 5,           // snapshot
  receivedUnitKey: 'box',
  receivedUnitName: 'Box (100)',
  receivedUnitMultiplier: 100,   // snapshot
}
```

The `Stock Receiving` screen has a **Counted in** selector and shows the
conversion live (`5 × Box (100) = 500 × Tablet`) before the attendant commits, so
nobody discovers the multiplier on the batch afterwards.

---

## 5. POS

The POS already let the attendant choose a unit (and cycle with `u`); it now goes
through `convertToBaseUnits` instead of an inline multiply, and `checkout`
**re-derives the base total server-side of the operation** and refuses the sale
if it disagrees:

> *Paracetamol: the cart is out of date — 2 × Card (10) is now 24 base units, not
> 20. Re-add the item.*

That closes a real hole: the cart's `baseUnitsTotal` is the number stock is
deducted by, so a cart left open across a repackaging must not silently deduct
the old amount.

A mixed cart is normal and supported:

```
1 × Box (100)   -> 100 base units   ₦5,000
2 × Card (10)   ->  20 base units   ₦1,100
3 × Piece       ->   3 base units   ₦  180
                 --                 ------
                 123 base units     ₦6,280
```

---

## 6. Pricing

`TradeUnit.sellingPrice` is configured per unit and is **deliberately not**
`pricePerBaseUnit × multiplier`. A pharmacy may sell loose paracetamol at ₦60 and
the box at ₦5,000; that is a commercial decision, not an arithmetic error, and
nothing in the system "corrects" it.

`updateUnitPrice` is owner-only. It checks the new price against the cost of
**that unit** (`costPerBaseUnit × multiplier`) — comparing a box's price to the
price of one tablet would reject every correctly-priced box. Setting the base
unit's price also updates `Medicine.pricePerBaseUnit`, because those are the same
number and must not drift apart.

---

## 7. Cost and margin

The owner-only cost rule is unchanged and still enforced at the database:

- `costPerBaseUnit` is withheld by column grant and published through the
  owner-gated `pf_medicine_costs` view (0 rows for an assistant).
- `calculateUnitCost` returns **`null`** when cost is absent. Never `0`. A box
  reported as free to buy is worse than saying nothing.
- `updateUnitPrice` **fails closed** without cost: the "price must be above cost"
  rule cannot be checked, so it refuses rather than skipping the check.

---

## 8. Batches and FEFO

Unit conversion does not touch batch logic, because batches were always in base
units. There is exactly one quantity per lot and it is canonical:

```ts
MedicineBatch.quantity        // base units, always
// no boxCount, no unitCount, nothing parallel
```

A sale line records both the entered unit and the base total, so a lot
allocation consumes the right number of base units:

| batch  | expiry | base units |
|---|---|---|
| BN-A   | sooner | 300 |
| BN-B   | later  | 200 |

Selling 1 × Box (100) must remove **100** base units from BN-A, not 1. Verified
against real Postgres: `pf_apply_sale_item_stock` decrements the named lot by
`base_units_total`, refuses to over-commit a lot that cannot cover the line, and
the movement ledger records the base-unit outflow.

**Known gap (pre-existing, R4).** In the *local* store `applyStockDelta` moves
`totalQuantity` and never decrements an existing batch, so a local sale is not
yet attributed to a lot. FEFO lot selection remains Phase 1 work. The canonical
database trigger does allocate. `verify-units-domain.ts` asserts the local gap
explicitly rather than papering over it.

---

## 9. Authorization

No parallel system. Packaging is a financial control — redefining a box from 100
pieces to 1 restates every price, margin, stock value and reorder quantity in the
branch — so it is gated exactly like cost:

- `pf_guard_unit_write` raises `insufficient_privilege` when a **signed-in**
  non-owner changes `medicines.units`.
- It uses the existing per-branch role model via `pf_is_owner()`. There is no new
  permission, no new role and no new table.
- `auth.uid() IS NULL` is exempt — the trusted server context (SQL editor,
  migration, `service_role`) — for the same bootstrap reason as
  `pf_guard_cost_write` and `pf_guard_profile_privileges`.
- Client-side, `updateUnitPrice` is gated by `canApprovePricing`, and
  `receiveStock` still lets an attendant book stock in without pricing it.

---

## 10. Audit trail

Historical transactions must not be reinterpreted when packaging changes. Both
paths snapshot:

**Sales** (`sale_items`, already present in the initial schema):

```sql
unit_key, unit_name, unit_multiplier, quantity, base_units_total, unit_price
```

**Receipts** (added in `20261005120000_unit_hierarchy.sql`):

```sql
received_quantity, received_unit_key, received_unit_name, received_unit_multiplier
```

The snapshot is the point. After an owner redefines a box from 100 to 120 pieces:

- a past sale still reads `1 × Box (100) = 100 base units`
- a past receipt still reads `5 × Box (100) = 500 base units`

Neither silently restates itself. Verified in `verify-units-db.mjs`.

The audit line written on receipt reads in the entered unit, with the canonical
total alongside:

> `Received 5 × Box (100) of Paracetamol on GRN-2026-0119 (500 base units)`

A bare "500" does not say whether the supplier sent five boxes or five hundred
tablets.

---

## 11. Offline compatibility

Every conversion is a pure function of `(units, unitKey, quantity)`. No network,
no store, no clock. The same input always yields the same base quantity, which
`verify-units-domain.ts` asserts over 200 repeated calls. Base-unit quantities are
integers by construction, so an offline queue can replay a `quantity + unitKey`
pair and reach the same number an online write would.

---

## 12. Integer safety

- `multiplier` must be a positive integer.
- `quantity` must be a positive integer.
- The product must be a safe integer.
- Violations are **refused**, never rounded.

There is no path in the system that produces a fractional tablet. If a product
genuinely needs fractional stock (a 100ml bottle measured in ml), it is modelled
as its own base unit — the quantity stays an integer count of that unit.

---

## 13. What was deliberately not done

| Not done | Why |
|---|---|
| Chain-style `parentKey`/`perParent` factors | redundant with flat factors, adds cycle and ambiguity failure modes, and does not fit non-nested packaging |
| Repackaging existing `units` data | already flat and already validated; a rewrite would be destructive for no gain |
| A local FEFO lot picker | explicitly deferred (R4); the unit work does not depend on it |
| Unit configuration UI | out of scope for this step; the domain, database and validation are in place and owner-gated |
| Granting `batch_id` write from this migration | see below |

### Two defects found and fixed in `20261005120000_unit_hierarchy.sql`

1. **`sale_items.batch_id` was not grantable.** The initial migration's column
   grant predated the column and was never extended, so no client could ever set
   it. Since a sale without `batch_id` moves no stock by design, the entire FEFO
   write path was unreachable. Now granted for INSERT **and** SELECT —
   `RETURNING batch_id` needs SELECT on the returned column, and reading it back
   is how a client confirms which lot a line consumed.
2. **`units` was freely editable by any attendant.** It sat in the plain UPDATE
   grant with no owner check. Now gated by `pf_guard_unit_write`.

### One defect found and deliberately NOT fixed here

`pf_apply_sale_item_stock` is `SECURITY DEFINER` and, like every function created
without an explicit grant, is executable by `PUBLIC` — so any signed-in attendant
can call it directly. It cannot reach another branch (a batch's medicine is
branch-scoped and `pf_check_sale_item_batch` enforces same-medicine), but it does
allow stock to be deducted without a matching sale header.

Closing this belongs with the sale-write migration (R3), where the call site
becomes an internal statement of a `SECURITY DEFINER` RPC and `EXECUTE` can then
be revoked from `PUBLIC`. Revoking it now would be premature: the intended caller
does not exist yet.

---

## 14. The configuration UI

**Where it lives:** `/pricing`, on each product's row in the Price list — a
"layers" action beside the price pencil opens `UnitEditor`. No new route: the
pricing screen is already the owner-gated place where per-product commercial
decisions are made, and packaging is exactly that.

`src/components/app/unit-editor.tsx` renders one row per unit, smallest first via
`unitsBySize`:

```
Base unit: Capsule
┌────────────────────────────┬───────────────────┬───────────────┬────────┐
│ Unit                       │            Equals │ Selling price │        │
├────────────────────────────┼───────────────────┼───────────────┼────────┤
│ Capsule      [Base unit]   │     1 × Capsule   │        ₦180   │   🔒   │
│ Pack (21)                  │    21 × Capsule   │      ₦7,000   │  🗑     │
└────────────────────────────┴───────────────────┴───────────────┴────────┘
1 Pack (21) = 21 × Capsule
210 × Capsule on hand, shown as: 15 × Pack (21)
```

### What the owner can do

Add a unit, rename one, change a multiplier, change a price, remove a unit.
`+ Add Unit` appends an empty row; typing the name derives the key
(`"Carton (12)"` → `carton`) so the owner does not have to think about it.

### What is protected, and why

| Control | Locked when | Reason |
|---|---|---|
| Base unit **name** | always | it labels the unit everything is counted in |
| Base unit **multiplier** | always | it must be 1; there is nothing to configure |
| Remove (base unit) | always | removing it would leave stock uncountable |
| Multiplier of a unit **used in history** | `unitsUsedInHistory` | retyping `Card = 10` as `12` would make every old receipt say something it never was |
| Remove a unit **used in history** | same | the key is referenced by past `sale_items` and receipts |
| Name / price of a unit **used in history** | **not** locked | both are snapshotted per sale, so history keeps its own copy |

Refusing a multiplier change says so explicitly:

> *Card has historical transactions, so its conversion cannot change from 10 to
> 12. Create a new unit instead.*

Renaming and repricing a used unit stay available, because `sale_items` snapshots
`unit_name` and `unit_price` alongside `unit_key` and `unit_multiplier`.

### Validation

The dialog runs `validateUnitHierarchy` on every keystroke and renders the same
issues the save path enforces, so what the owner is warned about and what blocks
the save cannot drift apart. `Save units` is disabled while any issue stands.

A freshly added unit reports all three of its problems immediately — no name, no
multiplier set, and therefore two base units — which is the intended feedback
rather than a blank row.

### Authorization

`isOwner` comes from the store, so the same component is correct wherever it is
opened from:

- **Owner** — every input enabled, `Save units` active.
- **Assistant** — names and multipliers disabled, prices disabled, remove
  disabled, and an explanatory panel: *"Only an owner can change packaging. You
  can still sell this medicine in any of the units below."*

The dialog is still reachable for an assistant, deliberately: hiding it would
teach them nothing, and the POS and receiving screens need the configuration to
be visible. The actual refusal is `updateUnits`, which mirrors
`pf_guard_unit_write` — and the database refuses it independently.

### Responsiveness

Each unit is a `grid-cols-1` card that becomes four columns at `sm`; the column
headings and the per-field hints are `sm:hidden` / `sm:sr-only`; the footer is
`flex-col-reverse` on mobile. No fixed pixel widths, so nothing overflows a phone.
Verified: the widest descendant of the dialog never exceeds the dialog's own
width.

---

## 15. Verification

| Suite | Covers |
|---|---|
| `verify-units-domain.ts` | conversion, validation, display, per-unit pricing, cost safety, receiving, POS, batches, determinism |
| `verify-units-ui.ts` | the `updateUnits` write path: owner configuration, role gate, base-unit protection, validation rejections, independent pricing, cost fail-closed, historical snapshot protection, receiving/POS pickup |
| `verify-units-db.mjs` | M1+M2+M3 against real Postgres: columns, backfill, constraints, unit validation, owner-only writes, grants, cost isolation, branch isolation, FEFO, snapshot survival |

All three run with:

```
bun "%TEMP%\pfdb\verify-units-domain.ts"
bun "%TEMP%\pfdb\verify-units-ui.ts"
bun "%TEMP%\pfdb\verify-units-db.mjs"
```
