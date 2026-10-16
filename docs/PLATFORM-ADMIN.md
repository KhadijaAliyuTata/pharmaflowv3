# Platform Administration — Provisioning and Operations

How to become a platform administrator, and what the platform dashboard can and
cannot do today. Written for the operator.

---

## 1. Becoming the first platform administrator

There is deliberately **no self-service route**. An administrator is granted once,
by you, from a machine that holds the service-role key.

### Why it is not a configuration flag

These were all rejected, and why:

| Rejected | Because |
|---|---|
| An email allow-list in code | Any code change could add a row; the authority would be "whoever edited the list" |
| `user_metadata.platform_admin` | Client-writable. Anyone can `updateUser` their own metadata |
| An environment variable | Same problem — it is configuration someone can edit, not a grant the database records |
| A hardcoded password | A shared secret in the repository |
| A hidden UI link | Not a security boundary at all |

What is used instead: a **column the database owns**, which no client can write,
set by a **function only `service_role` can execute**.

### The procedure

**Step 1 — make sure the account exists.** Sign in to PharmaFlow normally with
the account you want to be the administrator. It must have a `profiles` row.

**Step 2 — apply the migration to your database.** `20261012140000_platform_admin.sql`
is **not yet applied anywhere**. It has only ever been verified against PGlite.

```
supabase db push          # or apply the single file to a STAGING project first
```

> Recommended: apply to a staging project and run `bun run verify:db` there first.
> Adds one column, three views and six functions. It does not touch existing
> rows: `branches.status` defaults to `active`, so a pre-existing pharmacy such as
> Endline is unaffected. Verified in §14 of `verify-platform-admin.mjs`.

**Step 3 — run the grant once.** The function takes **one named parameter,
`p_email`**. PostgREST matches the body's key to the parameter name, so
`{"email": …}` is wrong and will not bind.

```bash
curl -sS -X POST "$PUBLIC_SUPABASE_URL/rest/v1/rpc/pf_grant_platform_admin" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_email":"your-email@example.com"}'
```

Both `apikey` and `Authorization: Bearer` are sent. `apikey` alone is enough for
some PostgREST configurations and not others; sending both is unambiguous.

It returns the user UUID. Two refusals are expected and both are meaningful:

| Response | Meaning |
|---|---|
| a UUID | granted |
| `No account exists for that email address` | sign in through the app first, so a `profiles` row exists |
| `Platform administration is granted only by the platform operator` | **see Step 3a** |

#### Step 3a — if `auth.uid()` is not null under the service-role key

The function refuses when `auth.uid() IS NOT NULL`, on the reasoning that a
service-role connection carries no JWT. **That assumption is untested against
this project's configuration.**

This project uses Supabase's **new API key format** — the anon key in `.env` is
an `sb_publishable_…` key, so the Worker secret is almost certainly an
`sb_secret_…` key rather than a legacy service-role JWT. The two formats are
handled differently by PostgREST with respect to `request.jwt.claims`, so
whether `auth.uid()` is NULL under a service-role connection **cannot be
determined from this repository and must be measured on staging**.

It is not a cosmetic risk. If `auth.uid()` comes back non-null, the grant is
impossible through the function, and the function is the only sanctioned route —
so without a fallback the platform operator would be permanently locked out of
creating any administrator.

**Diagnose it before relying on it.** Run this on staging first; it grants
nothing:

```sql
-- as the database owner. Probes the one assumption the bootstrap rests on.
select public.pf_grant_platform_admin('definitely-not-a-real-address@example.test');
```

| Outcome | Reading |
|---|---|
| `ERROR: No account exists for that email address` | **good** — `auth.uid()` was NULL, and the function body is reachable. Proceed with Step 3. |
| `ERROR: Platform administration is granted only by the platform operator` | `auth.uid()` was non-null. Use the fallback below. |

#### Step 3b — fallback: grant directly as the database owner

If Step 3a shows the guard is in the way, do **not** relax the guard. It is
there for a reason, and §3 below explains what it stops. Grant the flag with
database-owner access instead, which is a strictly higher privilege than holding
a long-lived API key:

```sql
-- Supabase Studio -> SQL Editor, as the `postgres` role.
-- `auth.uid()` is NULL in this context, so pf_guard_profile_privileges allows it.
update public.profiles
   set is_platform_admin = true
 where id = (
   select u.id from auth.users u where lower(u.email) = lower('your-email@example.com')
 )
returning id, full_name, is_platform_admin;
```

**Zero rows returned means the account does not exist** — sign in through the app
first. `returning` rather than trusting a row count, so you can see which account
was actually promoted.

This needs no key, no Worker, and no HTTP request. It is arguably the safer
bootstrap and there is no reason to prefer the API path except that it can be run
from a machine that holds the service-role key rather than a browser.

#### What the bootstrap must never do

- **Never** grant by email pattern, role, or any bulk `update`. One account, one
  statement, and `returning` so the operator can see which account it was.
- **Never** run it from a client. It has no `EXECUTE` grant for `anon` or
  `authenticated`; see §1.
- **Never** put the service-role or `sb_secret_…` key in a browser, a
  `PUBLIC_*` variable, or a committed file. It belongs only in a Worker secret or
  a shell variable you do not persist.

### How it is enforced

Three independent barriers, any one of which is sufficient:

1. **`revoke update on profiles from authenticated`** — already in
   `20261002160000_initial_schema.sql` and never re-granted. No browser can write
   any profile column, so `is_platform_admin` is unreachable from a client.
2. **`pf_guard_profile_privileges`** was redefined to treat a change to
   `is_platform_admin` exactly like a change to `role`: trusted context only, and
   any request carrying a JWT is refused with *"Platform administration is
   granted only by the platform operator"*.
3. **`pf_grant_platform_admin` has no EXECUTE grant for `anon` or `authenticated`**,
   and refuses internally if `auth.uid()` is not null — so even a future widening
   of the grants would still be stopped by the function body.

> The `auth.uid()` guard has one **unresolved dependency**: whether it evaluates
> to NULL under this project's `sb_secret_…` service-role key is not determinable
> from this repository, because the key lives only as a Worker secret. Step 3a
> measures it on staging and Step 3b is the fallback. The guard itself is
> **unchanged** — it was not relaxed to make the procedure convenient.

---

## 2. Onboarding a pharmacy

From the platform dashboard: **Add Pharmacy** → fill in the name, owner name,
owner email, phone and location → submit.

What happens, in one database transaction:

1. The browser posts to `POST /api/platform/onboard-pharmacy` with its own JWT.
2. The Worker verifies the caller with the **anon** key and asks the database
   `pf_is_platform_admin()`. A non-admin gets **403** before anything else runs.
3. The Worker calls `pf_create_pharmacy` with the **service-role** key, passing
   the caller's user id.
4. The database re-checks that id against `profiles`. A Worker that passed the
   wrong id — or an owner passing their own — is refused by the database, not by
   convention.
5. A `branches` row is created with status **`pending`**.
6. A 256-bit `staff_invitations` row is created for the owner email at role `owner`.
7. An `audit_events` row records `pharmacy_created` against that pharmacy.
8. The Worker emails the invitation link and **does not return the token**.

### Rules the database enforces

- **Duplicate pharmacy name** → refused. This is what protects Endline Pharmacy
  from being created a second time and orphaned.
- **A second live invitation for the same email** → refused. A double-click
  cannot produce two invitations that both work.
- **Neither half survives a failure.** The RPC is one transaction; there is no
  orphan pharmacy with no invitation, or invitation with no pharmacy.

### Email delivery

| Situation | What you see |
|---|---|
| Delivered | `emailSent: true` |
| `RESEND_API_KEY` / `RESEND_FROM` not set on the Worker | `emailSent: false`, `emailError` names the missing setting |
| Resend rejected the message | `emailSent: false`, `emailError` with the HTTP status |

**A failed email is never reported as delivered.** The pharmacy and its
invitation both exist and are usable, so a resend is possible.

### Owner acceptance

The owner follows the link, sets their own password, and accepts. `pf_redeem_invitation`
creates their `branch_memberships` row and flips the pharmacy to **`active`** in
the same transaction. No password is ever created or transmitted by this codebase.

The invitation is bound to the invited email address, single-use, and 256-bit.

---

## 3. Suspending a pharmacy

**PATCH /api/platform/pharmacy-status** with `{ branchId, status, reason }`.

Suspending **deletes nothing.** It makes `pf_current_branch()` return `NULL` for
that branch, and because every RLS policy in the schema reads that function,
access to medicines, sales, customers, orders and audit is withdrawn at once —
without editing fifty policies or letting any two of them disagree about what
"suspended" means.

`pf_my_branches` is redefined in the same migration to exclude suspended
branches, so the branch switcher never offers an option that
`pf_set_active_branch()` would refuse.

Reactivating restores access immediately. Every record is exactly where it was.

### What the suspended pharmacy sees

Suspension is **fail-closed**: it removes access rather than raising an error.
From inside the app that is indistinguishable from "this pharmacy has no data",
which would leave a user whose business was switched off looking at empty lists
and reasonably concluding their records were gone.

So the migration adds one read-only function, `pf_my_branch_status()`, returning a
single word about the caller's *own* branch. It takes no arguments, so it cannot
be aimed at another pharmacy, and it grants nothing that
`pf_current_branch() = NULL` has not already withdrawn.

The interface uses it in two places (`src/components/app/suspended-banner.tsx`):

- **No branch at all** → a full-page notice explaining the suspension and that
  nothing was deleted, instead of "No branch assigned — ask an owner to add you
  to a counter", which would be actively misleading: an owner cannot add someone
  to a counter that is withdrawn.
- **A branch that resolves but reads empty** → a persistent banner above the
  counter.

The banner is an explanation, not a control. If it failed to render, the pharmacy
would still be locked; it would just be confusingly empty.

### A bug this work found: the switcher accepted suspended branches

`pf_set_active_branch()` (from `20261004090000`) authorised against
`branch_memberships` and nothing else. It had **no status check**, so it would
select a suspended pharmacy, write that id onto `profiles.branch_id`, and report
success.

Nothing leaked — `pf_current_branch()` still returned NULL and every read and
write was still refused, so the access decision was never in doubt. What was
wrong was the *lie*: the client was told it had switched to a pharmacy it cannot
read. The migration now redefines the function to refuse a suspended branch with
`insufficient_privilege`. `pending` is still allowed through, because an invited
owner who has not accepted yet has a membership to select and refusing them would
strand the acceptance flow.

This was found by `verify-platform-admin.mjs` §11b, not by review. The claim in
the original version of this document — that `pf_my_branches` and
`pf_set_active_branch()` already agreed — was false until it was fixed.

### Writes are refused too, not just reads

§11b exercises every write path while a pharmacy is suspended, and each one is
asserted to refuse:

| Path | Result |
|---|---|
| `pf_complete_sale` (SECURITY DEFINER) | refused — "This account has no active pharmacy" |
| …leaving a sale header behind | 0 rows |
| …and stock deducted | no — still 500 |
| `pf_create_invitation` | refused |
| `pf_set_active_branch` | refused |
| Direct `INSERT` on a scoped table | refused by RLS |
| An attendant attempting the same sale | refused |
| The identical sale after reactivation | **succeeds**, and stock moves |

The last row is the load-bearing one. Without it, every refusal above would be
equally consistent with "the fixture is broken".

---

## 4. The dashboard

Route: **`/platform`** — its own layout, outside `_app`.

```
/platform               Overview: counts + recent platform activity
/platform/pharmacies    Searchable list, Add Pharmacy, suspend/reactivate
/platform/orders        Persisted orders (see the caveat below)
/platform/activity      Read-only audit feed
```

### Why it is not inside `_app`

`_app` is the pharmacy: it resolves an active branch and its sidebar is declared
in `nav.ts` for owners and attendants. A platform administrator usually has **no
branch at all**, so every branch-scoped screen in that shell would be empty and
the switcher would have nothing to show.

It is a real path segment rather than a pathless `_platform` layout because a
pathless one claims `/` and `/orders`, which `_app` already owns, and the router
refuses to build with two routes at the same path. That was tried and the build
failed with `Conflicting configuration paths`.

Navigation is a separate list in `src/routes/platform.tsx`, not `nav.ts`. An
owner must not see platform destinations, and an operator must not see one
pharmacy's counter.

### The UI is not the boundary

Hiding the links and refusing to render for a non-administrator is a courtesy. An
owner who types `/platform` is turned away at the route; an owner who calls
`POST /api/platform/onboard-pharmacy` directly is refused by the Worker, which
asks the database. Only the second one is load-bearing, and both are tested.

---

## 5. What the metrics mean

| Metric | Source | Honest caveat |
|---|---|---|
| Registered pharmacies | `branches` rows | Real |
| Active / pending / suspended | `branches.status` | Real. Defaults to `active`, so pre-existing pharmacies are active |
| Owners and staff per pharmacy | `branch_memberships` | Real |
| Owner invitation state | `staff_invitations` (latest owner invite) | Real |
| Total orders | `customer_orders` | ⚠️ **See below** |
| Platform activity | `audit_events` across all branches | Real |

### ⚠️ Orders are not yet persisted

`customer_orders` exists in Postgres with `order_number`, `state`,
`payment_state` and `delivery_type`, and the platform view reads it. **But the
application still writes orders to `localStorage`.** The table is very likely
empty in production.

The platform order view is therefore built and correct, and will read empty until
orders are migrated. **It will not show local data and call it a platform-wide
view.**

The `/platform/orders` screen states this in words, permanently and above the
table — not only when the table is empty, because an operator reading a populated
table later still needs to know what is and is not covered. It renders
`"No orders are recorded in the database. This is the unavailability described
above - not a count of zero orders taken."`

There is deliberately **no order count tile** on the Overview screen. A `0` there
would be a false claim about real pharmacies.

Migrating order writes is a separate, sizeable piece of work. It has not been done
and is not claimed to be done. **Tracked as a follow-up, out of scope here.**

### Revenue is deliberately absent

There is no platform-wide revenue figure, and there should not be one yet: sales
are persisted per branch through `pf_complete_sale`, but aggregating a pharmacy's
money as a platform operator is a product decision, not a technical one. Order
counts are shown; order counts are not confused with completed sales.

### What the platform views never expose

- **Purchase costs.** `cost_per_base_unit` is withheld from `authenticated` at the
  column level, and no `pf_platform_*` view selects it.
- **Customer identity.** The orders view returns an item **count**, not the
  customer's name or phone.
- **Prescription content.** Never read into any platform view.
- **Audit `metadata`.** Free-form jsonb; excluded because a future writer could
  put anything in it.
- **Invitation tokens.** Never in any API response.

---

## 6. Owner-managed staff — unchanged and verified

The owner staff flow was **not rebuilt**. It is the existing one, and the
verification suite asserts it holds for every pharmacy rather than just one:

- An owner invites by email into **their own branch** — `pf_create_invitation`
  takes the branch from `pf_current_branch()`.
- An owner cannot invite into another pharmacy. **Tested:** a foreign pharmacy's
  token handed to a different owner returns `false` and leaves the invitation
  untouched.
- An owner cannot promote themselves to platform administrator. **Tested** both
  the column grant and the trigger guard.
- An invitation cannot be used twice. **Tested.**
- Expired, revoked, malformed and wrong-address invitations are all rejected.
  **Tested**, including that an expired code grants no membership.

---

## 7. Not load-tested

The views are ordered and support `LIMIT` / `OFFSET`, and `branches.status` is
indexed. That is **not** a load test. There is no evidence in this work that the
platform queries perform acceptably with thousands of pharmacies, and none is
claimed. Before onboarding more than the pilot ten, that should be measured
against a staging dataset at realistic size.

---

## 8. Environment requirements

| Binding | Where | If missing |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **Worker secret** | Onboarding returns `503` and says so. Never a `PUBLIC_` var, never in a client bundle |
| `RESEND_API_KEY` | **Worker secret** | The pharmacy and invitation are created; `emailSent: false` with the reason. Never reported as delivered |
| `RESEND_FROM` | **Worker secret** | As above |
| `PUBLIC_APP_URL` | Worker secret / build env | Invitation links point at the wrong host. **Still unverified** — see below |
| `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` | `PUBLIC_*`, in the bundle | Intended. The anon key is public by design; the service-role key is what must never be |

`wrangler secret list` returns **names only**, so `PUBLIC_APP_URL` cannot be
compared against the Worker's value without printing a production secret. It was
left unresolved deliberately. The `.env` host is
`pharmaflow.aliyutatak.workers.dev` and the Worker secret is set, but whether the
two agree has not been proven.

---

## 9. What was verified, and what was not

**Actually run, and passing:**

| Gate | Result |
|---|---|
| `bun run verify:db` | **19 suites, all passed** |
| `bun supabase/verify/verify-platform-admin.mjs` | **88 passed, 0 failed** (was 72) |
| `bun run typecheck` | exit 0 |
| `bun x vite build` | exit 0 |
| UTF-8 validity across `src/`, `supabase/`, `docs/` | 0 invalid files |

The platform-admin suite gained §11b and §11c — 16 new assertions covering
suspension on write paths and the `pf_my_branch_status` explanation function.

**Not verified, and not claimed:**

- **Concurrency.** PGlite is single-connection, so the `FOR UPDATE` locks in
  `pf_create_pharmacy`, `pf_void_sale` and `pf_complete_sale` have never run
  under contention.
- **Real PostgreSQL behaviour.** Every suite runs on PGlite. Column grants,
  `security_invoker` view semantics and `SECURITY DEFINER` search-path handling
  are asserted there but have not been exercised on a real server.
- **Email delivery.** No invitation email has been sent. `emailSent` reflects what
  Resend's HTTP response said, nothing more.
- **Cross-pharmacy order monitoring.** Cannot work; orders are not persisted.
- **Load.**

A **disposable staging Supabase project** is what is needed to close the first
three: apply the migration, run `bun run verify:db` against real Postgres, and
add a two-connection concurrency test.

---

## 10. Outstanding before this reaches production

1. **Apply the migration to a staging database** and re-run all 19 suites there.
2. **Run the two-connection concurrency test** against real PostgreSQL. PGlite is
   single-connection, so the row locks in `pf_create_pharmacy` are untested under
   contention.
3. **Confirm `RESEND_API_KEY` and `RESEND_FROM`** are set on the Worker — without
   them onboarding creates the pharmacy and invitation but sends no email.
4. **Confirm `PUBLIC_APP_URL`** is correct. A mismatch makes emailed invitation
   links point at the wrong host. (Still unverified — see §8.)
5. **Migrate order writes** if the platform order view is to show anything.
6. **Exercise the dashboard as an administrator.** The routes were smoke-tested
   in a browser: `/platform`, `/platform/pharmacies`, `/platform/orders` and
   `/platform/activity` all render, with no load error and no console error, and
   all four correctly refuse an anonymous visitor. **That only proves the shell
   and the refusal path.** The screens behind the gate — Overview, the pharmacy
   table, the Add Pharmacy form, the suspend confirmation — have never been
   rendered, because no authenticated administrator session was available in the
   environment where this was built. Treat them as untested.
7. **Exercise a real invitation end-to-end** against staging: onboard, receive
   the email, redeem, confirm the pharmacy activates.