# PharmaFlow V3 — investor demo walkthrough

A five-minute, local-only walkthrough of the existing demo. Nothing here adds a
product feature; it only describes what already ships and how to start it
safely.

Everything the audience sees runs on **fictional sample data**. The owner and
attendant experiences are the real application running against a seeded local
store; the supplier and customer pages are clearly-labelled prototypes.

---

## Safe local startup (loopback only)

Start from the `pharmaflowv3/` directory. These set the demo variables for **this
process only** — they do not edit `.env`, and the server binds to loopback so it
is not exposed on the network.

### Windows PowerShell

```powershell
$env:PUBLIC_SUPABASE_URL=' '; $env:PUBLIC_SUPABASE_ANON_KEY=' '; $env:PUBLIC_DEMO_MODE='true'; bun run dev -- --host 127.0.0.1
```

Use a single **space** (`' '`), not empty quotes: in PowerShell an empty
assignment deletes the variable, while a space is trimmed and treated as absent.

### Bash / macOS

```bash
PUBLIC_SUPABASE_URL= PUBLIC_SUPABASE_ANON_KEY= PUBLIC_DEMO_MODE=true bun run dev -- --host 127.0.0.1
```

Then open:

```
http://127.0.0.1:5173/demo
```

No username or password is required.

### If the hub cards are disabled

The repo's committed `.env` has Supabase credentials and `PUBLIC_DEMO_MODE=false`,
so a dev server started from it resolves to **live** and `/demo` deliberately
disables the four cards with a truthful explanation. That is the intended
fail-closed behaviour — use the commands above for the demo instead of editing
`.env`.

---

## The five-minute script

### Before they arrive

Start the server (above) and open `/demo`. Confirm the four cards are enabled
("Explore as … →") and the fixed **DEMO MODE — sample data only** badge is on
screen.

### 1. The problem (~40s)

> Most community pharmacies here are owner-run. The owner is often at a second
> shop, at the wholesaler, or at home — and the moment they step out, they lose
> sight of three things: what's selling, what's running low or about to expire,
> and what staff are doing at the counter. PharmaFlow V3 gives the owner that
> visibility from a phone.

### 2. Pharmacy Owner (~70s) — click **Pharmacy Owner**

> This is the owner's dashboard. **Today's Sales**, **Gross Profit Today**,
> **Stock Value** — what came in, what was kept, what the shelves are worth.
> **Demand Radar** and **Expiring Stock** flag what to reorder and what to move.
> And **Recent Pharmacy Activities**: every action is attributed to a staff
> member and a time, so the owner knows who did what, and when. This is the real
> application running on a seeded demo pharmacy — every figure is fictional
> sample data.

### 3. Pharmacy Attendant (~70s) — back to the hub → **Pharmacy Attendant**

> Same pharmacy, the counter view. Search stock, add items, take payment — cash,
> transfer, part payment. Now notice what is not here: no purchase cost, no
> margin, no profit. An attendant never sees owner-only financial information.

### 4. Supplier (~70s) — back to the hub → **Supplier**

> Now the other side of the counter. This is a labelled prototype. The catalogue
> shows each medicine with its pack, an indicative trade price and sample stock —
> for example the cough syrup, one 100 ml bottle. I can build a quotation: pick
> quantities, the total updates, and send quotation — which is simulated; it
> appears in Order status but nothing leaves this page. Finally, compare prices:
> two fictional suppliers quoting the same pack side by side, so the owner can
> buy the cheaper pack without waiting for callbacks. The heading says it plainly
> — sample quotations only, not live market prices.

### 5. Customer (~70s) — back to the hub → **Customer**

> Finally the customer. Search for a medicine and see indicative prices and
> availability — and prescription-only items cannot be ordered. Choose a
> pharmacy: three demo pharmacies are open for sample orders, the rest are
> onboarding. Add items and place the order — and this is a simulated
> confirmation: no payment, no real order, no message to the pharmacy. In the
> real product, that order would land in the pharmacy's order queue.

### 6. Closing (~30s)

> So it's one ecosystem. The same Endline Pharmacy the owner runs is the buyer in
> those supplier enquiries and the pharmacy the customer can order from —
> pharmacy operations, suppliers and customers connected in one place. To be
> clear about what you've seen: the owner dashboard and the POS are working
> software on fictional data; the supplier and customer pages are
> clearly-labelled prototypes. Nothing here is a live integration, and we're not
> claiming production readiness.

---

## Working functionality vs simulated interactions

| Experience | Working (real code, fictional data) | Simulated / fictional |
| --- | --- | --- |
| `/demo` hub | Navigation into each experience; no credentials needed | — |
| Pharmacy Owner | The real dashboard on the seeded local store | All figures; costs/margins shown to the owner |
| Pharmacy Attendant | The real POS: stock search, sale recording, payment modes | All figures; owner-only financials are not shown |
| Supplier | Tab switching, quotation maths, price comparison | Catalogue, prices, "send quotation" (notifies nobody), order states |
| Customer | Medicine search, pharmacy chooser, cart, totals, prescription restriction | Stock, prices, order placement and confirmation |

**Honesty guardrails**

- No live supplier integrations, verified market prices, payments, fulfilled
  orders or real emails exist behind these screens.
- The customer "order" creates nothing and contacts no pharmacy; the name and
  phone typed there stay in the browser tab.
- The owner and attendant demos are the real application, but on a seeded local
  store — not the production database.
- Every onboarding pharmacy shown in the customer finder is a fictional
  `(demo)` entry. Real onboarding records are never hard-coded into a public
  prototype.
