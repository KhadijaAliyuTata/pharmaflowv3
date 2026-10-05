# Database verification suites

Executable security and correctness checks against the real migration chain.

```bash
bun run verify:db          # every suite, combined result
bun run supabase/verify/verify-chain.mjs   # one suite
```

These apply the migrations to an in-process PostgreSQL
([PGlite](https://pglite.dev), a devDependency) and then act as real Supabase
roles. They are the evidence behind the Phase 0 security work, and they run
against the schema rather than against mocks.

| Suite | Asserts |
|---|---|
| `verify-chain.mjs` | The chain applies to a fresh database one exec per file; every file is re-runnable; the first migration stands alone; RLS is on everywhere; no policy trusts a row column as an authorization claim |
| `verify-function-surface.mjs` | `anon` can execute nothing; no data-changing function is callable as an RPC; `authenticated` can execute only what it needs, and only for a stated reason |
| `verify-tenant-isolation.mjs` | Cross-branch reads and writes are refused; stock cannot move between branches; cost columns are unreadable by assistants; owner-only cost views return nothing to assistants; role escalation and audit forgery are refused; sale lines stay immutable |
| `verify-stock-authority.mjs` | **Both directions for stock**: an unauthorized caller cannot mutate stock, *and* a genuine authenticated sale still deducts the right quantity from the right lot with an auditable movement |

## Why `harness.mjs` looks the way it does

Four rules in the harness exist because breaking any one produces a **false
result rather than an error**, which is the dangerous kind of test failure. Each
was learned the hard way during the Phase 0 audit:

1. **`grant usage on schema auth`** — real Supabase grants this to `anon` and
   `authenticated`. Without it, `SECURITY INVOKER` triggers that call `auth.uid()`
   directly fail with "permission denied", and the suite reports a working write
   path as broken. This produced three false findings before it was fixed.

2. **Reset the role in a `finally`** — a statement that raises aborts the
   transaction, so every later assertion in that block fails too. One failure
   silently invalidates everything after it.

3. **A fresh database per scenario group**, so a poisoned transaction cannot
   reach across groups.

4. **Assert on stored state, not on whether an error was raised.** RLS filters a
   forbidden write down to zero matching rows and still *reports success*. "Did it
   throw?" is the wrong question; "is the value unchanged?" is the right one. The
   first version of the branch-registration test passed for entirely the wrong
   reason.

`verify-stock-authority.mjs` is deliberately two-sided. Closing a vulnerability by
breaking the legitimate path would leave the pharmacy unable to sell, which is
worse than the vulnerability it replaced, so the positive assertions matter as
much as the negative ones.
