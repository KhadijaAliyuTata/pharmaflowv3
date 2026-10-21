# Offline sync engine — outbox processing rules

Status: Phase 3 (POS only). The engine exists and is tested, and the POS screen
is the **only** module that records or drains operations. Receiving, credit,
payments, stock and catalogue writes remain online-only. Nothing here is a claim
that those workflows are offline-capable.

Engine source: `src/offline/sync-engine.ts` (+ `src/offline/probe.ts`).
Data layer: the Phase 1 `outbox`/`conflicts`/`meta` stores in
`src/offline/local-db.ts` — there is deliberately no second storage system.

## Lifecycle of one operation

1. A caller `repo.enqueueOp({ opId, type, payload, deps })`. The op id must be
   generated client-side; the POS uses its durable checkout/idempotency key.
2. The engine stamps `attempts++` and `inFlightSince` BEFORE dispatching, so a
   crash mid-send leaves the row saying "sent, outcome unknown" — and the next
   run re-sends the same op id. **Every operation therefore REQUIRES server-side
   idempotency keyed by `opId`** — the same guarantees `pf_complete_sale`
   (checkout key) and `pf_receive_stock` (receipt number) already provide.
3. On the handler reporting the SERVER durably accepted, the outcome record
   (`meta: outbox:outcome:<opId>`) and the outbox row removal commit in ONE
   transaction. Sent/queued/retrying is never "confirmed".

## Dependency graph (`deps[]`)

- A dependent runs only after its deps are durably completed (outcome exists).
- Explicit terminal `needs-attention` reasons — never silent, never forever:
  - `dependency-missing:<id>` — dep is queued nowhere and has no outcome.
  - `dependency-rejected:<id>` — dep was terminal-rejected (see `conflicts`).
  - `dependency-blocking-dep:<id>` — dep already needs attention; the waiter
    cascades immediately instead of waiting (or it would pend forever).
  - `dependency-cycle` — pinned over any pending op whose dependency graph
    (among currently pending ops) can never resolve: both cycle members and
    everything strictly downstream of a cycle.
- Unrelated operations are never dragged down by a bad or exhausted op.

## Retry policy (persisted)

`attempts`, `nextAttemptAt`, `inFlightSince`, `lastError` live in the outbox
row itself: reload, tab crash and browser restart do NOT reset history (pinned
by verify suite). Defaults: 5 attempts, 2s base, doubling, 10 min cap. On the
last allowed failure the row becomes `needs-attention` (`attempts-exhausted`,
kind preserved) and automatic retries stop. The POS panel does not claim a
manual retry or void it cannot perform: its button only asks the engine to
re-check genuinely pending sales.

## Error classification

| Kind          | Example                    | Action                          |
| ------------- | -------------------------- | ------------------------------- |
| `network`     | fetch/timeout, AbortError  | retry with backoff              |
| `server`      | HTTP 5xx                   | retry with backoff              |
| `auth`        | 401                        | needs-attention (re-auth)       |
| `permission`  | 403                        | needs-attention (role changed)  |
| `conflict`    | 409                        | needs-attention (human review)  |
| `validation`  | 400/422 server-declined    | terminal: moved to `conflicts`  |

Handlers that throw are classified conservatively (retry) and bounded by the
attempt cap. A cached offline role is never treated as server authority: every
send goes through the real RPC under real RLS; permission changes surface as
403 → needs-attention, not as local success.

## Only the server completes

No client path marks a sale, stock adjustment, receiving transaction, credit
entry or payment confirmed for merely being queued or sent. Completion is
exactly "the handler returned ok AND its outcome row committed".

## Locking (single-flight)

- Preferred: Web Locks (`navigator.locks`, exclusive). A tab failing to
  acquire skips the whole run (`stopped: 'busy'`) — the leader processes.
- Fallback (no Web Locks): a localStorage lease with ~30s expiry. STRICTLY
  weaker: a crashed holder stalls other tabs until expiry, then heals. On
  storage-less environments the adapter degrades to "no cross-tab protection",
  which is safer for correctness (idempotent ops) than being wedged forever.
- The POS probe loop invokes runs on a confirmed-reachable probe and on the
  browser's `online` event. The engine never self-schedules.

## `probeServer()` — two independent axes

`browserOnline` (`navigator.onLine`, advisory) is separate from
`serverReachable` (real, time-boxed, credential-free `GET /auth/v1/health`).
Timeout, transport error, and ANY non-2xx response are all "not confirmed
reachable" — the Phase 0 spike showed an outage can surface as a *resolved*
proxy 502. A successful probe is a gate for "worth trying", NEVER evidence
that an authenticated write will succeed.

## Sensitive data

Events and persisted errors carry op id, type, attempt counters and failure
kinds only. Handler messages are sanitized: forbidden financial tokens are
redacted (longest-first, to avoid `[redacted]_per_base_unit` residue from a
short key matching first) and text is truncated before storage. Tokens and
session material never reach events, errors or conflicts.

A terminal conflict may copy the original operation payload so a human can
reconcile it. That copy passes the same Phase 1 financial guard as the queue
(attendant caches cannot hold cost/COGS/margin), and the recovery view exposes
only the sale totals and refusal reason — never the raw payload or cost data.

## Supported operation types

The engine is a registry: an op type is processable only when a handler is
registered for it at wiring time.

- **`pf_complete_sale` (offline POS sales — Phase 3, wired on the POS screen
  only).** Recorded by `src/offline/pos-offline.ts` (`recordSaleIntent`), drained
  by `createPosSaleHandler`, whose ONLY server call is the existing
  `completeSale` → `pf_complete_sale` RPC (`src/lib/supabase/sales.ts`) — the
  authoritative checkout path. There is no second sales-write path.
  - **Server idempotency contract:** `opId === idempotency_key`. The RPC's
    replay short-circuit (step 2) keys the ORIGINAL sale on
    `(branch_id, idempotency_key)`: a re-sent op returns `already_completed`,
    never a second deduction. The key is generated once per intended sale on
    the device, survives reloads/retries/lost responses (it lives in the outbox
    row), and repeated clicks dedupe against the stored payload (occurrence
    stamp excluded — the FIRST `sold_at` wins). The outbox check-and-put is
    transactional, so two concurrent clicks of one sale resolve as a duplicate,
    never as a spurious conflict and never as an overwrite.
  - **Immutable quote:** every recorded intent carries the subtotal, discount,
    total, amount paid, line unit prices, quantities and line totals the
    attendant saw. It is evidence for reconciliation, never an instruction: the
    server still derives and stores the authoritative price. A missing or
    internally inconsistent quote is refused before anything enters the outbox.
    After the server commits, a differing total or line count creates a durable
    `server-mismatch` conflict, whether the sale completed online or from the
    queue. The record keeps the receipt/sale identifiers and both totals. The
    sale is not retried, the payment is not adjusted and the idempotency key does
    not change; the operator is told not to collect or refund a difference. This detects and
    exposes drift but is **not** a pre-commit price guard — preventing the
    server from creating debt at a changed price needs a server contract change
    (expected total checked inside `pf_complete_sale`) and is not implemented.
  - **Occurrence time (M1):** the intent stamps `sold_at` at record time; the
    migration `20261017120000_offline_sale_sold_at.sql` validates it server-side
    (≤ 5 min future, ≤ 30 days past) and stores it via
    `coalesce(p_sold_at, now())` — an omitted timestamp keeps the exact previous
    column-default behaviour. Sync time never overwrites sale time. Status:
    prepared + PGlite-verified (13/13), NOT applied to any real database.
  - **Failure mapping:** stock exhaustion (check violation, "Only N …") →
    `conflict` (needs-attention; a restock/person can resolve it); other money/
    shape rejections and unknown-product/refusal codes → `validation` (terminal,
    moved to `conflicts` with full details, never silently discarded);
    `insufficient_privilege` → `permission` (needs-attention); missing session
    or unconfigured Supabase → `auth`; transport failures/timeouts and any
    code-less error → `network` (bounded retry with the SAME key — an ambiguous
    outcome is settled by the server's replay short-circuit, not by guessing).
    A no-answer timeout (30 s) is treated exactly like a lost response.
  - **Truthful states on the POS panel:** Saved on this device / Pending sync /
    Needs attention / Confirmed by server, plus terminal conflicts (server
    refusal, server-confirmed mismatch, and a local duplicate-key attempt that
    was never sent). Outcomes (sale id, receipt, sold_at, expected/server total)
    persist in `meta` (`outbox:outcome:*`, now carrying `type` + small `result`)
    so "confirmed" survives the op row's removal. Conflicts live in `conflicts`
    and stay visible even when the outbox is empty. Browser-online and
    server-reachable are shown separately; both come from `probeServer()`.
  - **Offline reopen is narrow:** a server-confirmed branch/role snapshot lets
    the app shell and POS reopen on one already-signed-in device. It is bound
    to the local auth user, expires after seven days, only restores after a
    transport failure, downgrades any saved owner role to assistant, and is
    revalidated when the browser reports a connection. A non-transport refusal,
    missing/expired snapshot, or mismatched identity fails closed. While running
    from that snapshot, only `/pos` renders; inventory, reports, returns and
    pricing are blocked rather than shown from stale data.
  - **The POS has a narrow read cache:** on a server-confirmed branch it saves
    a branch/user-scoped catalogue snapshot and a minimal customer list
    (id/name/phone only). On an offline reopen it composes from that snapshot
    only when the catalogue is present and no older than 24 hours; an absent,
    unreadable, or older snapshot blocks sale composition with an explicit
    message. Age is re-evaluated at sale time, so a till left open offline
    cannot cross the 24-hour line with a loaded cart. Offline settlement is
    cash-only and paid in full: the payment UI disables Debt, Part, Wallet,
    Split, transfer and card, and the submission path refuses them again before
    anything enters the outbox. If a reachable probe is followed by a network failure, a blocked
    settlement is not queued; the cart is kept and the attendant is told to check
    the ledger because the server may have seen the attempt. The failed attempt
    is then held as explicit reconciliation evidence (original method, amounts
    and key): all further submissions for that cart are blocked, including a
    switch to Full + Cash, until a person confirms the ledger outcome. Reusing
    the key would replay the original non-cash sale; a new key is minted only by
    an explicit "not in the ledger" resolution. The in-memory block survives a
    branch/role identity-key change while the cart and key remain, so that change
    cannot enable a retry. The note lives in the identity's local `meta` store,
    so the block and its evidence survive a reload; it is never read as a queued
    sale. The checkout pins the repository and its actual storage identity before
    awaiting the server; a missing, closed or mismatched handle fails closed
    rather than writing or clearing another identity's note. Explicit resolution
    therefore clears the note only in the identity database that produced it.
    A valid note also makes sign-out retain the identity database with an
    "unresolved settlement evidence" warning; a malformed note is ignored.
    Sign-out inspection and deletion are separate IndexedDB operations, so a
    write landing between them (another tab or an in-flight checkout) can still
    be purged; no atomicity is claimed and this is a documented residual risk.
    An `already_completed` replay of the unresolved
    key is never shown as a fresh cash receipt. A missing customer
    cache therefore still allows a walk-in cash sale, but no offline sale can
    leave a balance or use a wallet. The cache is
    replaced as a whole snapshot, never merged, and it never becomes a second
    write path.
  - **Offline stock is an estimate:** stock shown offline is cached, not
    reserved. The panel says so and warns that another device may sell the same
    units. No local reservation, decrement or multi-device oversell protection is
    claimed. Server-side stock checks and FEFO remain the authority when the
    sale syncs.
- **Intentionally unsupported today:** receiving (`pf_receive_stock`), stock
  adjustments, credit/payments, catalogue writes, customer orders. They arrive
  in their own phases WITH their verified handler + server idempotency
  contract. An unregistered type is refused to `needs-attention`
  ('unsupported-operation-type') and is never sent. Nothing outside the POS
  screen records or drains intents: until a screen has this same wiring, it
  stays online-dependent.

## Phase 2 explicitly does not include

- POS or any screen wiring; scheduling/timers; user-facing needs-attention UI;
  manual retry affordances; M1 (`sold_at`).

## Phase 3 note (POS wiring)

The POS screen now owns BOTH halves of this contract, on one screen only:
it probes (`probeServer`) before a sale, records the intent durably when the
server is unreachable or silent (`recordSaleIntent`, same key as the online
attempt), and runs `engine.runOnce()` on the probe loop only when the probe has
confirmed reachability. `runOnce()` is still never self-scheduled — nothing in
the engine schedules itself; the screen's interval does. The same screen writes
the read-only catalogue/customer cache described above, but only on a
server-confirmed branch. Screens without this wiring remain online-dependent,
and nothing claims the whole application is offline-ready.
