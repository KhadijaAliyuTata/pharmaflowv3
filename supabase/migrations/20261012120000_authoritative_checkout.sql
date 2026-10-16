-- ============================================================ authoritative checkout
--
-- ## What this replaces, and why it had to happen
--
-- `createSale` in `src/lib/supabase/sales.ts` was never called by the POS. The
-- live checkout path ran `ops.checkout(store.getState(), …)`, which resolves the
-- medicine in `state.medicines` - the seeded prototype copy persisted to
-- `pharmaflow:state:v3` - while the POS priced from `useMedicines()`, which reads
-- Postgres. Seed ids are slugs (`med-paracetamol`); the catalogue's are uuid.
-- The lookup could not match, so a real sale failed with "Unknown product".
--
-- `src/lib/catalogue-writes.ts` already documented this mismatch and disabled the
-- catalogue edit controls for exactly that reason. This migration supplies the
-- write path they were waiting for.
--
-- ## Why one transaction
--
-- The old path was two PostgREST round trips (header, then lines) with no
-- transaction between them, and the deduction trigger it relied on no-ops when
-- `sale_items.batch_id is null` - which it always was, because nothing populated
-- it. So the header could be written, the lines could fail, and no stock would
-- move. One function fixes all three: header, lines, allocations and movements
-- are one statement, so any failure rolls the whole sale back.
--
-- ## What the server refuses to take from the client
--
-- The client sends `{medicine_id, unit_key, quantity}` per line and nothing else
-- numeric. The unit's `multiplier` and `sellingPrice` are read from the server's
-- own `medicines.units`; `base_units_total` is derived here; subtotal, discount,
-- total and outstanding are all recomputed. A tampered client cannot choose what
-- leaves the shelf or what it is charged.
--
-- ## Locking
--
-- Two levels, and the order matters:
--
--   1. `select … from medicines … for update` per line. This serialises every
--      concurrent sale of the *same product*, so the batch scan below cannot race.
--   2. `for update` on the eligible batches, ordered by expiry ascending.
--
-- Both are taken medicine-first, consistently, so two overlapping sales acquire
-- locks in the same order and cannot deadlock. The advisory lock on the branch is
-- taken last and only guards receipt-number allocation.
--
-- ## FEFO, and the trigger
--
-- `pf_apply_sale_item_stock()` handles exactly one lot per sale line. A line can
-- legitimately need several (buy 3 boxes, one lot holds 2). So:
--
--   * single lot covers the whole line -> `batch_id` is set and the existing
--     trigger performs the deduction, with its own guard and tenant check;
--   * line spans several lots -> `batch_id` is left null, so the trigger returns
--     early, and this function applies every allocation itself.
--
-- The two branches are mutually exclusive by construction, so stock is never
-- deducted twice. The trigger is left exactly as it is.
--
-- `pf_record_stock_movement()` is redefined below only to label these
-- movements `sale` rather than `adjustment`, which is what an UPDATE of
-- `medicine_batches` would otherwise produce for every sale.

alter table public.sales
  add column if not exists idempotency_key text;

-- A retried submit (double-click, flaky network, refresh mid-sale) must not ring
-- up twice. Partial, so the many rows with no key are unaffected.
create unique index if not exists sales_idempotency_idx
  on public.sales (branch_id, idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------- movement labelling
--
-- Same body as 20261004090000_function_execute_hefo_foundation.sql, with one
-- added branch. An UPDATE of a batch is normally an adjustment; during a
-- checkout this function sets a transaction-local flag, so the movement is
-- recorded as the sale it actually is. `set_config(…, true)` scopes the flag to
-- the transaction, so it cannot leak into an unrelated request.
create or replace function public.pf_record_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  medicine uuid;
  changed integer;
  lot uuid;
  lot_ref uuid;
begin
  if tg_op = 'DELETE' then
    medicine := old.medicine_id;
    changed  := -old.quantity;
    lot      := old.id;
    -- The lot row is already gone inside an AFTER DELETE, so `batch_id` cannot
    -- point at it: the insert would fail its own foreign key. The id is kept in
    -- the note instead, so the movement still records which lot left the shelf.
    lot_ref  := null;
  else
    medicine := new.medicine_id;
    changed  := new.quantity - coalesce(old.quantity, 0);
    lot      := new.id;
    lot_ref  := new.id;
  end if;

  -- A no-op edit (say, correcting a recall reason) is not a stock change and
  -- must not create a movement row.
  if changed = 0 then
    return null;
  end if;

  insert into stock_movements (
    branch_id, medicine_id, batch_id, kind,
    quantity_changed, resulting_quantity, performed_by, note, reference_id
  )
  values (
    coalesce(new.branch_id, old.branch_id),
    medicine,
    lot_ref,
    case
      when tg_op = 'INSERT' then 'receipt'::movement_kind
      when tg_op = 'DELETE' then 'disposal'::movement_kind
      when coalesce(current_setting('pharmaflow.sale_stock', true), '') = 'sale'
        then 'sale'::movement_kind
      else 'adjustment'::movement_kind
    end,
    changed,
    coalesce(new.quantity, 0),
    auth.uid(),
    case
      when tg_op = 'INSERT' then 'Batch received'
      when tg_op = 'DELETE' then 'Batch ' || lot || ' deleted'
      when coalesce(current_setting('pharmaflow.sale_stock', true), '') = 'sale'
        then 'Dispensed by a sale'
      else 'Batch quantity adjusted'
    end,
    null
  );

  return null;
end;
$$;

-- ------------------------------------------------ credit ledger write order
--
-- `pf_check_credit_ledger_balance` (BEFORE INSERT on credit_ledger) and
-- `pf_check_credit_account_ledger` (BEFORE UPDATE on credit_accounts) together
-- cannot both be satisfied while a balance changes:
--
--   * the ledger insert requires `balance_after` to equal the account balance
--     AS IT IS AT THAT MOMENT;
--   * the account update requires the new balance to equal the LATEST ledger
--     entry.
--
-- Raise a balance from 90 to 115 and there is no order that passes both:
-- UPDATE-then-INSERT trips the second (new balance 115 vs latest ledger 90), and
-- INSERT-then-UPDATE trips the first (balance_after 115 vs account still 90).
-- This was not theoretical - the second credit sale to an account failed with
-- "balance (115.00) does not match its latest ledger entry (90.00)".
--
-- So `pf_complete_sale` writes the ledger row first and the balance second, and
-- only the first check is excused, and only while the transaction runs. The
-- second trigger still does its real job: by the time the account is updated the
-- ledger already holds the new balance, so it verifies a genuinely consistent
-- state rather than being silenced. The end state both triggers describe - the
-- account balance equals the latest `balance_after` - holds exactly as it would
-- without this change.
create or replace function public.pf_check_credit_ledger_balance()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  current numeric;
begin
  -- Transaction-local. Set only by pf_complete_sale, and reset automatically
  -- when the transaction ends, so no other writer can reach this branch.
  if coalesce(current_setting('pharmaflow.credit_write', true), '') = '1' then
    return new;
  end if;

  select outstanding_balance into current
  from credit_accounts where id = new.account_id for update;

  if abs(current - new.balance_after) > 0.01 then
    raise exception
      'Ledger balance_after (%) does not match the account balance (%)', new.balance_after, current
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------- checkout
create or replace function public.pf_complete_sale(
  p_lines                   jsonb,
  p_payment_method          public.payment_kind,
  p_amount_paid             numeric,
  p_discount                numeric  default 0,
  p_discount_reason         text     default null,
  p_customer_id             uuid     default null,
  p_credit_account_id       uuid     default null,
  p_dispensed_against_prescription boolean default false,
  p_idempotency_key         text     default null
)
returns table (
  sale_id           uuid,
  receipt_number    text,
  total             numeric,
  line_count        integer,
  already_completed boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid;
  v_branch   uuid;
  v_line     record;
  v_b        record;
  v_it       record;
  v_al       record;
  v_med      public.medicines%rowtype;
  v_acct     public.credit_accounts%rowtype;
  v_cust     public.customers%rowtype;
  v_unit     jsonb;
  v_med_id   uuid;
  v_unit_key text;
  v_qty_text text;
  v_qty      bigint;
  v_mult     bigint;
  v_base     bigint;
  v_price    numeric;
  v_line_t   numeric;
  v_subtotal numeric := 0;
  v_discount numeric;
  v_paid     numeric;
  v_total    numeric;
  v_outstand numeric;
  v_need     bigint;
  v_take     bigint;
  v_seq      bigint;
  v_single   uuid;
  v_items    jsonb := '[]'::jsonb;
  v_allocs   jsonb := '[]'::jsonb;
  v_alloc    jsonb;
  v_state    public.sale_state;
  v_sale     uuid;
  v_rcpt     text;
  v_lines    integer;
  v_reference text;
begin
  -- ------------------------------------------------- 1. who is calling
  --
  -- SECURITY DEFINER bypasses RLS, so every branch and role decision is made
  -- here. Nothing below trusts a branch id the caller supplied, because the
  -- function accepts none.
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;

  if not public.pf_is_staff() then
    raise exception 'Only pharmacy staff can ring up sales' using errcode = 'insufficient_privilege';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Cart is empty' using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 2. idempotency
  --
  -- Reads into locals, not into the OUT names. `returns table (sale_id, …)`
  -- declares variables of those names, so a bare `sale_id` inside this function
  -- is ambiguous against `sale_items.sale_id` — plpgsql reports
  -- "column reference is ambiguous" rather than guessing. The OUT names are
  -- written once, at the end.
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select s.id, s.receipt_number, s.total
      into v_sale, v_rcpt, v_total
      from public.sales s
     where s.branch_id = v_branch
       and s.idempotency_key = p_idempotency_key;

    if found then
      select count(*)::int into v_lines
        from public.sale_items si
       where si.sale_id = v_sale;
      sale_id := v_sale;
      receipt_number := v_rcpt;
      line_count := v_lines;
      already_completed := true;
      return next;
      return;
    end if;
  end if;

  v_discount := round(coalesce(p_discount, 0), 2);
  v_paid     := round(coalesce(p_amount_paid, 0), 2);

  if v_discount < 0 then
    raise exception 'Discount cannot be negative' using errcode = 'check_violation';
  end if;
  if v_paid < 0 then
    raise exception 'Amount received cannot be negative' using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 3. every line, validated
  --
  -- Nothing is written in this loop. A failure anywhere raises before the sale
  -- row exists, so a rejected cart leaves nothing behind to reconcile.
  for v_line in select value as j from jsonb_array_elements(p_lines)
  loop
    v_med_id := nullif(v_line.j ->> 'medicine_id', '')::uuid;
    v_unit_key := v_line.j ->> 'unit_key';
    v_qty_text := v_line.j ->> 'quantity';

    if v_med_id is null then
      raise exception 'A sale line is missing its product' using errcode = 'check_violation';
    end if;
    if v_unit_key is null or btrim(v_unit_key) = '' then
      raise exception 'A sale line is missing its unit' using errcode = 'check_violation';
    end if;
    -- Regex before cast: a cast failure would abort with an opaque error, and
    -- 0.5 tablets must be refused for what it is rather than how it failed.
    if v_qty_text is null or v_qty_text !~ '^[0-9]+$' then
      raise exception 'Quantity must be a whole number greater than zero (received %)',
        coalesce(v_qty_text, 'nothing') using errcode = 'check_violation';
    end if;

    v_qty := v_qty_text::bigint;
    if v_qty <= 0 then
      raise exception 'Quantity must be greater than zero' using errcode = 'check_violation';
    end if;

    -- Serialise concurrent sales of this product. Taken before any batch is
    -- read, so the FEFO scan below sees a settled picture.
    select m.* into v_med
      from public.medicines m
     where m.id = v_med_id
       for update;

    if not found then
      raise exception 'Product % does not exist', v_med_id using errcode = 'no_data_found';
    end if;
    if v_med.branch_id <> v_branch then
      raise exception 'Product % belongs to another pharmacy', v_med_id
        using errcode = 'insufficient_privilege';
    end if;
    if v_med.do_not_sell then
      raise exception '% is locked and cannot be sold', v_med.name
        using errcode = 'check_violation';
    end if;

    -- The third rule in `saleBlock` (src/domain/selectors.ts). The POS enforces
    -- it, but a POS is not a security boundary: a crafted or stale request would
    -- otherwise be able to sell a product the shelf has already flagged as past
    -- expiry. The FEFO scan below separately refuses any lot past its own date,
    -- so this is the product-level rule, not a second copy of that one.
    if v_med.expiry_date <= current_date then
      raise exception '% is past its expiry date and cannot be sold', v_med.name
        using errcode = 'check_violation';
    end if;

    -- The unit is resolved against the server's own packaging definition. A
    -- client asking to sell "1 box" of a product that has no box is refused,
    -- and a client cannot invent a multiplier.
    select u into v_unit
      from jsonb_array_elements(v_med.units) u
     where u ->> 'key' = v_unit_key;

    if not found then
      raise exception '"%" is not a unit of %', v_unit_key, v_med.name
        using errcode = 'check_violation';
    end if;

    if v_unit ->> 'multiplier' is null
       or v_unit ->> 'multiplier' !~ '^[0-9]+$'
       or (v_unit ->> 'multiplier')::bigint <= 0 then
      raise exception '% has an invalid conversion factor', coalesce(v_unit ->> 'name', v_unit_key)
        using errcode = 'check_violation';
    end if;
    v_mult := (v_unit ->> 'multiplier')::bigint;

    v_base := v_mult * v_qty;
    if v_base > 2147483647 then
      raise exception 'That quantity is too large to track in base units'
        using errcode = 'check_violation';
    end if;

    if v_unit ->> 'sellingPrice' is null
       or v_unit ->> 'sellingPrice' !~ '^[0-9]+(\.[0-9]+)?$' then
      raise exception '% has no usable selling price for %',
        v_med.name, coalesce(v_unit ->> 'name', v_unit_key) using errcode = 'check_violation';
    end if;
    v_price  := round((v_unit ->> 'sellingPrice')::numeric, 2);
    v_line_t := round(v_price * v_qty, 2);
    v_subtotal := v_subtotal + v_line_t;

    -- FEFO. Earliest expiry first; recalled lots and anything already past its
    -- date are not sellable stock and are never allocated. `received_date` and
    -- `id` break ties so the ordering is total and every session locks in the
    -- same order.
    v_need  := v_base;
    v_alloc := '[]'::jsonb;

    for v_b in
      select b.id, b.quantity
        from public.medicine_batches b
       where b.medicine_id = v_med_id
         and b.branch_id = v_branch
         and not b.is_recalled
         and b.expiry_date > current_date
         and b.quantity > 0
       order by b.expiry_date asc, b.received_date asc, b.id asc
         for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_b.quantity);
      v_alloc := v_alloc || jsonb_build_array(
        jsonb_build_object('batch_id', v_b.id, 'units', v_take)
      );
      v_need := v_need - v_take;
    end loop;

    if v_need > 0 then
      raise exception 'Only % of % left in sellable stock',
        v_base - v_need, v_med.name using errcode = 'check_violation';
    end if;

    -- One lot covers the line: name it and let the existing trigger deduct.
    -- Several lots: leave it null so the trigger returns early and this
    -- function applies every allocation below. Never both.
    v_single := null;
    if jsonb_array_length(v_alloc) = 1
       and (v_alloc -> 0 ->> 'units')::bigint = v_base then
      v_single := (v_alloc -> 0 ->> 'batch_id')::uuid;
    end if;

    for v_al in select value as j from jsonb_array_elements(v_alloc)
    loop
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object(
        'batch_id',    v_al.j ->> 'batch_id',
        'units',       v_al.j ->> 'units',
        'via_trigger', (v_single is not null)
      ));
    end loop;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'medicine_id',      v_med.id,
      'medicine_name',    v_med.name,
      'generic_name',     coalesce(v_med.generic_name, ''),
      'unit_key',         v_unit_key,
      'unit_name',        coalesce(nullif(v_unit ->> 'name', ''), v_unit_key),
      'unit_multiplier',  v_mult,
      'quantity',         v_qty,
      'base_units_total', v_base,
      'unit_price',       v_price,
      'line_total',       v_line_t,
      'batch_id',         v_single
    ));
  end loop;

  -- ------------------------------------------------- 4. money, recomputed
  v_subtotal := round(v_subtotal, 2);

  if v_discount > v_subtotal then
    raise exception 'Discount cannot exceed the subtotal' using errcode = 'check_violation';
  end if;

  v_total := round(v_subtotal - v_discount, 2);

  if v_paid > v_total then
    raise exception 'Amount received is more than the total' using errcode = 'check_violation';
  end if;

  v_outstand := round(v_total - v_paid, 2);

  if v_outstand > 0 and p_customer_id is null and p_credit_account_id is null then
    raise exception 'Record a customer before leaving a balance' using errcode = 'check_violation';
  end if;

  if p_credit_account_id is not null then
    select * into v_acct
      from public.credit_accounts c
     where c.id = p_credit_account_id
       for update;

    if not found then
      raise exception 'Credit account not found' using errcode = 'no_data_found';
    end if;
    if v_acct.branch_id <> v_branch then
      raise exception 'Credit account belongs to another pharmacy' using errcode = 'insufficient_privilege';
    end if;
    if v_acct.is_suspended then
      raise exception '% is suspended', v_acct.name using errcode = 'check_violation';
    end if;
    if v_outstand > 0
       and (v_acct.outstanding_balance + v_outstand) > v_acct.credit_limit then
      raise exception 'Credit limit exceeded — %', v_acct.name using errcode = 'check_violation';
    end if;
  end if;

  if p_customer_id is not null then
    select * into v_cust
      from public.customers cu
     where cu.id = p_customer_id
       for update;

    if not found then
      raise exception 'Customer not found' using errcode = 'no_data_found';
    end if;
    if v_cust.branch_id <> v_branch then
      raise exception 'Customer belongs to another pharmacy' using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- ------------------------------------------------- 5. receipt number
  --
  -- All medicine locks are already held, so this advisory lock cannot deadlock:
  -- every concurrent sale for the same products is still blocked at step 3.
  perform pg_advisory_xact_lock(hashtextextended(v_branch::text, 0));

  select coalesce(max(nullif(regexp_replace(s.receipt_number, '^PF-[0-9]{4}-', ''), '')::bigint), 0)
    into v_seq
    from public.sales s
   where s.branch_id = v_branch
     and s.receipt_number ~ '^PF-[0-9]{4}-[0-9]+$';

  -- `repeat` rather than `lpad`. `lpad(text, 4, '0')` TRUNCATES on the right when
  -- the string is already longer than the requested length, so `lpad('10000', 4,
  -- '0')` is '1000' - and every sale from the 10,000th of a year onwards would
  -- collide with `sales_receipt_unique`. The TypeScript twin of this line uses
  -- `String.padStart`, which does not truncate, so the two paths disagreed. This
  -- form pads to at least four characters and never shortens.
  receipt_number := 'PF-' || to_char(current_date, 'YYYY') || '-' ||
                    repeat('0', greatest(0, 4 - length((v_seq + 1)::text))) ||
                    (v_seq + 1)::text;

  -- ------------------------------------------------- 6. write the sale
  v_state := case
               when v_outstand <= 0 then 'paid'::public.sale_state
               when v_paid > 0      then 'part_paid'::public.sale_state
               else 'credit'::public.sale_state
             end;

  insert into public.sales (
    branch_id, receipt_number, attendant_id, customer_id, credit_account_id,
    subtotal, discount, discount_reason, total, payment_method, state,
    amount_paid, outstanding, dispensed_against_prescription, idempotency_key
  )
  values (
    v_branch, receipt_number, v_actor, p_customer_id, p_credit_account_id,
    v_subtotal, v_discount, nullif(btrim(coalesce(p_discount_reason, '')), ''),
    v_total, p_payment_method, v_state,
    v_paid, v_outstand, coalesce(p_dispensed_against_prescription, false),
    nullif(btrim(coalesce(p_idempotency_key, '')), '')
  )
  returning id into v_sale;

  -- Set before the lines go in: the deduction trigger runs during this insert
  -- and writes the movement, so the flag has to already be visible to it.
  perform set_config('pharmaflow.sale_stock', 'sale', true);

  for v_it in select value as j from jsonb_array_elements(v_items)
  loop
    insert into public.sale_items (
      sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
      unit_multiplier, quantity, base_units_total, unit_price, line_total, batch_id
    )
    values (
      v_sale,
      (v_it.j ->> 'medicine_id')::uuid,
      v_it.j ->> 'medicine_name',
      v_it.j ->> 'generic_name',
      v_it.j ->> 'unit_key',
      v_it.j ->> 'unit_name',
      (v_it.j ->> 'unit_multiplier')::integer,
      (v_it.j ->> 'quantity')::integer,
      (v_it.j ->> 'base_units_total')::integer,
      (v_it.j ->> 'unit_price')::numeric,
      (v_it.j ->> 'line_total')::numeric,
      nullif(v_it.j ->> 'batch_id', '')::uuid
    );
  end loop;

  -- ------------------------------------------------- 7. split allocations
  --
  -- Only the lines the trigger did not already handle. By construction no
  -- allocation appears in both sets, so nothing is deducted twice.
  for v_al in select value as j from jsonb_array_elements(v_allocs)
  loop
    if not (v_al.j ->> 'via_trigger')::boolean then
      update public.medicine_batches
         set quantity = quantity - (v_al.j ->> 'units')::integer
       where id = (v_al.j ->> 'batch_id')::uuid;

      if not found then
        raise exception 'Lot % disappeared during the sale', v_al.j ->> 'batch_id'
          using errcode = 'check_violation';
      end if;
    end if;
  end loop;

  -- `medicines.total_quantity` is deliberately absent: `pf_sync_total_quantity`
  -- recomputes it from the batches on every write, so any value set here would
  -- be overwritten.

  -- ------------------------------------------------- 8. customer and credit
  if v_cust.id is not null then
    update public.customers
       set total_spent      = total_spent + v_total,
           purchase_count   = purchase_count + 1,
           outstanding_debt = outstanding_debt + v_outstand,
           last_purchase_date = now()
     where id = v_cust.id;
  end if;

  if v_acct.id is not null and v_outstand > 0 then
    -- Ledger first, balance second - see the note on
    -- `pf_check_credit_ledger_balance` above for why that order is forced.
    -- Transaction-local, so the exemption cannot outlive this statement.
    perform set_config('pharmaflow.credit_write', '1', true);

    insert into public.credit_ledger (
      account_id, branch_id, kind, amount, balance_after, note, reference_id, recorded_by
    )
    values (
      v_acct.id, v_branch, 'charge', v_outstand,
      v_acct.outstanding_balance + v_outstand,
      'Sale ' || receipt_number, v_sale, v_actor
    );

    -- `pf_check_credit_account_ledger` runs here and is NOT excused: the ledger
    -- already carries the new balance, so the comparison it makes is real.
    update public.credit_accounts
       set outstanding_balance = v_acct.outstanding_balance + v_outstand,
           updated_at = now()
     where id = v_acct.id;
  end if;

  sale_id    := v_sale;
  total      := v_total;
  line_count := jsonb_array_length(v_items);
  already_completed := false;
  return next;
end;
$$;

-- ------------------------------------------------------------------- grants
--
-- PostgreSQL grants EXECUTE to PUBLIC by default, which would make this
-- callable by `anon` - an unauthenticated client with no session. Same treatment
-- as every other pf_* function in 20261005190000_function_execute_hardening.
revoke execute on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text
) from public;

revoke execute on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text
) from anon;

grant execute on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text
) to authenticated;

comment on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text
) is
  'Authoritative checkout. Takes {medicine_id, unit_key, quantity} lines and nothing else numeric: multiplier, unit price, base units, subtotal and total are all derived here. Allocates stock FEFO across eligible lots under row locks, writes the sale, its lines and the stock movements in one transaction, and returns the existing sale instead of ringing up twice when the idempotency key repeats. Cost data is never returned - sale line costs stay behind the owner-gated views.';