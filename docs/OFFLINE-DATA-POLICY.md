# Offline data policy — per-record truth, freshness and lifecycle

Status: Phase 3 (POS only). The local database has a POS-only read cache
(catalogue and minimal customer identity) and a durable sale-intent outbox.
Receiving, stock, credit, returns, pricing and catalogue writes are online-only.
Nothing in this document should be read as a claim that PharmaFlow is broadly
offline-capable; the app-wide statement happens only after every supported
workflow is implemented and verified.

## 1. Cold routes are still offline-hostile — by design, until designed otherwise

The Phase 0 service worker precaches all hashed app chunks, so **warm routes**
(realise you visited before this session) render and work offline. **Cold
routes** — a URL never visited, or a server-rendered document that is not in
the `pf-offline-v1-docs` cache — have no document offline. The browser literally
has nothing to render, and the SW surfaces the transport failure truthfully
instead of fabricating content.

This is a **known, documented limitation**, not an oversight:

- Precaching *documents* for unvisited URLs is impossible (they are per-URL).
- Faking a shell with a generic HTML page and hydrating onto an unrelated URL
  was deferred as its own work item ("offline cold-route shell"), because
  half-working pages that pretend to be the page you asked for are exactly the
  failure mode this project refuses (see §3).

Practical rule: after first use, the user's *own* routinely-visited screens are
available offline. A cold link from a fresh device or a deep link into an
unvisited route requires exactly one online visit — after which the document
cache warm-jars the route for the next visit.

## 2. Cached data is never server-confirmed data

Every row cached by the local data layer is written with
`serverConfirmed: false`, and every read from it returns `fromCache: true`
plus a snapshot timestamp and a per-record `cachedAt`. The POS cache reader
(`src/offline/pos-cache.ts`) labels the snapshot with its age and only uses it
when the branch itself came from the saved-branch snapshot. A silent
pass-through of cached rows as if they were live server data is a bug, and
verify suites test the property at the data-layer level so wiring cannot
quietly erase it.

### Freshness thresholds

One numeric source (`src/offline/local-db.ts`), cited here:

| Bucket        | Age since `cachedAt` | Meaning for stock / prices |
| ------------- | -------------------- | -------------------------- |
| `fresh`       | ≤ 2 minutes          | Reasonable for display; still *not* a promise |
| `stale`       | 2 min – 24 h         | Advisory only; show a "cached, X ago" label near any quantity or price |
| `very-stale`  | > 24 h               | Quantities and prices must not be displayed as *the* answer; refresh is required before a sale uses them |

### Stock

The local stock figure is a **hint**, never a confirmed quantity. `stockIsHintOnly`
is unconditionally `true` in `staleInfo()` — the field exists so code cannot
accidentally read it as authoritative. Any POS mutation made offline goes
through the later sync engine (server-side revalidation, its own pending state),
never by trusting the cached number as available inventory.

### Prices

Prices follow the same buckets as stock. The price corresponding to
`very-stale` rows must not be rendered as *the* price to charge without saying
when it was fetched. Price *changes offline* are an owner operation and are
covered by the later catalogue-write phase; until then there is no offline
price-mutation path at all.

### Expiry

Batch expiry dates are dated facts (immutable once fetched). A cached batch's
expiry *may be shown* even when the snapshot is stale, but the snapshot age is
always attached. The cached expiry is never "extended" or recomputed against a
new device date to look fresher than it is.

### Recalls — fail-closed

Recall information is **sticky-safe**:

- A batch cached as `is_recalled` **stays blocked** however stale the snapshot
  is. Staleness never un-suppresses a recall.
- *Clearing* a recall (returning a batch to sellable) requires a fresh server
  read — the cache can present stale `is_recalled: false` as advisory at best
  (`recallStateRequiresRevalidation` is true for any non-fresh row).

## 3. Owner-only financial fields never reach attendant caches

The database withholds cost, COGS and margin from `authenticated` by grant,
exposing them only through owner-gated views to the owner. The local cache
writer (`src/offline/financial-guard.ts`) is the second boundary: every record
written by a non-`owner` repository is deep-stripped of every forbidden
financial key (`cost`, `cost_per_base_unit`, `cogs`, `margin`, `profit`,
`purchase_price`, `stockvalue`, …) before it is stored, and every read re-strips
and asserts no residual keys. If stripping ever leaves a forbidden key behind,
the write is refused rather than persisted.

Databases are per `(pharmacy, user)`, so an owner's rich cache is a different
database from their attendants' — the attendant never opens a file that could
carry owner rows.

## 4. Identity, namespacing and lifecycle

- **Database name**: `pf-offline:<pharmacyId>:<userId>`. Identity components
  are validated (`[A-Za-z0-9_-]{8,64}`, fail-closed, no fallback aliases).
- **Row stamping**: every data row also stores its `pharmacyId`; every read
  filters on its mismatch. Two layers must both be defeated to leak a foreign
  pharmacy's rows into a screen.
- **Account switching**: the new identity opens a different database. The old
  identity's data is not read, shown, or mixed into caches — purely by naming.
- **Saved branch (offline reopen)**: `pharmaflow:branch-snapshot:v1` holds one
  server-confirmed branch, its display fields and the role the server reported.
  It is bound to the local auth user id, expires after seven days, and is only
  restored after a transport-shaped failure. A saved owner role is downgraded to
  assistant offline, and a different user, expired snapshot, malformed data or
  non-transport refusal fails closed. Sign-out clears it. While it is in use,
  only `/pos` renders; other screens are blocked rather than shown from stale
  cached data.

### Logout, suspension, staff removal

- **Logout** goes through `src/lib/sign-out.ts`. It first inspects the active
  identity's outbox, conflicts, foreign-stamped strays and a valid unresolved
  settlement note. Only when all four are empty does it call
  `purgeIdentity(pharmacyId, userId)` and remove the database. If anything is
  unsynchronised or unresolved, or inspection itself fails, the data is
  **retained**, the session clears, and the user is warned with the count.
  Sign-out never silently deletes a sale the server has not settled. A
  malformed/tampered note is ignored by the defensive parser, so it cannot keep
  an otherwise clean identity un-purgeable forever. Inspection and deletion are
  separate IndexedDB operations, so a write that lands after inspection (from
  another tab or an in-flight checkout) can still be purged; no atomicity is
  claimed and this remains a documented follow-up risk.
- `purgeIdentity()` closes this tab's matching open repo handles before
  deleting, so the POS's own IndexedDB connection cannot block the purge.
- **Suspension** and **staff removal** are administrator directives that map to
  `purgeAllOffline()` (device-side) called by the auth/session wiring when that
  phase ships. `purgeAllOffline()` enumerates `indexedDB.databases()` and falls
  back to a names-only localStorage registry — that registry holds *database
  names only*, never user data, so losing or leaking it is harmless.
- Wiring for suspension/staff-removal purge is **not** done yet; the API exists
  and is tested. Logout is wired, but only through the safe retain-or-purge
  policy above.

### Schema upgrades

`SCHEMA_VERSION` is 2. v1 created `meta`, `catalogue`, `outbox`, `conflicts`,
`sales` and `audit`; v2 adds the POS-only `customers` identity store. Upgrades
are strictly additive branches keyed on `oldVersion` inside the `upgrade`
callback; a shipped store is never rewritten in place, and a missing legacy
store is filled in rather than assumed. The verify suite pins this: an
incomplete v1 database upgraded with the real schema function keeps its data
and gains the missing stores; a fresh install and a converged one differ only
in upgrade history.

## 5. Storage failure semantics

`classifyStorageError` maps IndexedDB error names onto kinds that upstream code
(NOT this module) turns into retry/attention policy:

| Kind            | Meaning                                        | Retriable |
| --------------- | ---------------------------------------------- | --------- |
| `quota`         | Browser storage refused more bytes             | after freeing space |
| `clone`         | Value un-serialisable for structured-clone     | no (caller bug) |
| `constraint`    | Key/index conflict we did not pre-guard        | no (caller bug) |
| `version`       | Concurrent downgrade                          | no — fatal |
| `blocked`       | Another tab holds an upgrade-hostile connection| until tab closed |
| `abort`         | Transaction aborted                            | yes |
| `unknown`       | anything else                                  | escalate |

Failures from local cache writes and reads are *surfaced*, never swallowed. On
the POS, a failed repo open, a failed device-sales read, a failed catalogue
cache write and a sync summary with errors all appear in the device panel; a
failed device-sales read preserves the last known rows instead of rendering an
empty queue. A sale that could not be recorded locally remains a visible
failure, never a silent data loss. Other workflows have no local write path yet.

## 6. What is wired, and what is not

- **Wired:** the POS screen writes a branch/user-scoped catalogue and minimal
  customer snapshot on a server-confirmed branch. On a branch restored from the
  saved-branch snapshot it reads that cache only if the snapshot is present and
  no older than 24 hours. The age is re-evaluated at sale time, so a till left
  open offline stops composing when the snapshot crosses 24 hours. Cached stock
  is a hint, never a reservation. Offline settlement is cash-only and paid in
  full: Debt, Part, Wallet, Split, transfer and card are disabled in the payment
  UI and refused again in the sale-submission path. If a reachable probe is followed by a
  network failure, a blocked settlement is not queued; the cart is kept and the
  attendant is told to check the ledger because the server may have seen the
  attempt. That attempt is held as explicit reconciliation state (original
  method, amounts and idempotency key), and every further submission for the
  cart is blocked — including a switch to Full + Cash. Reusing the key would
  replay the original non-cash sale, while minting a new key would hide the
  uncertainty. The cashier must confirm in the ledger whether the original was
  recorded before closing it or explicitly starting a new transaction. The
  in-memory block survives a branch/role identity-key change while the cart and
  key remain; a new identity's saved note may fill an empty slot but never
  replaces it. The note is stored in the identity's local `meta` store and
  restored after a reload, so the evidence outlives the in-memory cart; it is
  never read back as a queued sale. The checkout pins the originating repository
  and its actual branch/user before awaiting the server; a missing, closed or
  mismatched handle fails closed instead of writing or clearing another
  identity's note. Explicit resolution clears the durable note only in the
  identity database that produced it, never another identity's.
  A server `already_completed` replay of that key is never
  presented as a fresh cash receipt. A cached customer identity may be attached
  to a cash sale, but debt
  and wallet values are never cached. The POS also
  records sale intents in the local outbox and drains them through the sync
  engine when its probe confirms the server is reachable. The panel exposes
  pending, needs-attention, confirmed and terminal-conflict states, including
  server-price mismatches. See `docs/OFFLINE-SYNC.md`.
- **Not wired:** receiving, stock adjustments, credit/payments, returns, price
  changes, catalogue writes and customer orders remain online-only. A screen
  without this wiring must not record an intent.
- **Still not claimed:** "PharmaFlow works offline" in any product surface,
  docs or README. The POS read cache and sale safety net are deliberately
  narrower than that.
- **Known limit:** cold, unvisited routes still have no offline document (see
  §1). A warm `/pos` route is required for an offline browser reload; this is
  not changed by the saved-branch snapshot or the POS cache.

