-- ============================================================ POS payments: split breakdown & customer repayments
--
-- ## Scope
--
-- The checkout already records `amount_paid` / `outstanding` on the sale row,
-- with the state machine (paid / part_paid / credit) enforced by
-- `pf_complete_sale`. What the database cannot yet answer is "HOW was the
-- collected money paid?" — an owner reconciling a till (or collecting a later
-- repayment) needs the per-method record, not just the total. Two additions:
--
--   1. `public.sale_payments` — one row per payment, per sale: the split-method
--      breakdown at checkout AND every repayment afterwards. Each row carries
--      its method, amount and the staff member who recorded it, so repayment
--      history has its own audit record by construction.
--   2. `pf_record_customer_payment` — the repayment path for a customer's
--      outstanding balance: atomically moves the sale's `amount_paid` /
--      `outstanding` / state, decrements `customers.outstanding_debt`, and
--      writes the `sale_payments` audit row in one transaction.
--
-- `pf_complete_sale` gains ONE optional argument, `p_payment_breakdown` (jsonb
-- array of {method, amount}). It is re-declared here IN FULL (including the
-- `p_sold_at` argument from M1, 20261017120000) rather than overloaded, for the
-- same reason M1 dropped-and-recreated: two coexisting signatures would make
-- the PostgREST call ambiguous. Callers that omit the breakdown behave exactly
-- as before: a single `sale_payments` row records the collected amount.
--
-- ## What this does NOT change
--
-- The source of truth for money remains `sales.amount_paid` / `sales.outstanding`
-- with their existing consistency constraint; `sale_payments` is derived
-- supporting detail. No migration-time statement USES the new 'split' enum
-- label (this file only runs `ALTER TYPE ... ADD VALUE` and table/function
-- DDL) — PostgreSQL forbids using a newly added enum value inside the same
-- transaction, and all uses below are run-time.
--
-- Status: NOT APPLIED to any real database. PGlite-verified via
-- supabase/verify/verify-authoritative-checkout.mjs.

-- ---------------------------------------------------------- one new method label
alter type public.payment_kind add value if not exists 'split' after 'wallet';

-- ---------------------------------------------------------- payment records
create table if not exists public.sale_payments (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references public.sales(id) on delete cascade,
  branch_id   uuid not null references public.branches(id) on delete cascade,
  method      public.payment_kind not null,
  amount      numeric(14,2) not null check (amount > 0),
  recorded_by uuid not null references auth.users(id) on delete set null,
  recorded_at timestamptz not null default now(),
  note        text
);

create index if not exists sale_payments_sale_idx
  on public.sale_payments (sale_id);

create index if not exists sale_payments_branch_idx
  on public.sale_payments (branch_id, recorded_at desc);

alter table public.sale_payments enable row level security;

-- Staff of the branch can read the payment history (amounts, not costs).
drop policy if exists sale_payments_read on public.sale_payments;
create policy sale_payments_read on public.sale_payments for select to authenticated
  using (branch_id = public.pf_current_branch());

-- Direct inserts stay limited to the recorder's own branch/identity; the RPCs
-- below are the real writers and bypass RLS deliberately.
drop policy if exists sale_payments_staff_insert on public.sale_payments;
create policy sale_payments_staff_insert on public.sale_payments for insert to authenticated
  with check (branch_id = public.pf_current_branch() and recorded_by = auth.uid());

-- No update or delete policy exists: a payment record is append-only audit.

revoke all on public.sale_payments from anon;

-- ---------------------------------------------------------- checkout redefined
drop function if exists public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text
);

drop function if exists public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text, timestamptz
);

drop function if exists public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text, timestamptz, jsonb
);

create or replace function public.pf_complete_sale(
  p_lines                   jsonb,
  p_payment_method          public.payment_kind,
  p_amount_paid             numeric,
  p_discount                numeric  default 0,
  p_discount_reason         text     default null,
  p_customer_id             uuid     default null,
  p_credit_account_id       uuid     default null,
  p_dispensed_against_prescription boolean default false,
  p_idempotency_key         text     default null,
  p_sold_at                 timestamptz default null,
  p_payment_breakdown       jsonb    default null
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
  -- M1: the sale's occurrence time. `now()` when the caller omits it (the
  -- previous behaviour via the column default), the caller's own clock when it
  -- is supplied — after this function has validated it below.
  v_sold_at  timestamptz;
  -- POS payments: the split breakdown, validated into a plain list before
  -- anything is written.
  v_pay          record;
  v_pay_method   text;
  v_pay_text     text;
  v_pay_amount   numeric;
  v_breakdown    boolean := false;
  v_breaksum     numeric := 0;
  v_break_parts  integer := 0;
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

  -- ------------------------------------------------- 2b. when the sale happened
  --
  -- M1. An offline sale reports the moment it was recorded on the device. The
  -- server re-checks both edges rather than trusting what arrived, because a
  -- crafted or simply-broken device clock is the operator's problem too — a
  -- mis-stamped `sold_at` corrupts every ledger, stock-report and expiry rule
  -- that orders by it.
  v_sold_at := coalesce(p_sold_at, now());
  if p_sold_at is not null then
    if v_sold_at > now() + interval '5 minutes' then
      raise exception 'The sale time is more than 5 minutes in the future — set the device clock and try again'
        using errcode = 'check_violation';
    end if;
    if v_sold_at < now() - interval '30 days' then
      raise exception 'The sale time is more than 30 days old — it cannot be reconciled'
        using errcode = 'check_violation';
    end if;
  end if;

  if v_discount < 0 then
    raise exception 'Discount cannot be negative' using errcode = 'check_violation';
  end if;
  if v_paid < 0 then
    raise exception 'Amount received cannot be negative' using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 2c. payment breakdown
  --
  -- POS payments. A split sale sends the per-method parts it collected; the
  -- sum must equal the amount received to the kobo, and a sale labelled
  -- 'split' must actually carry (at least two) parts. Each entry names a real
  -- payment kind other than 'split' itself — a breakdown of breakdowns is a
  -- mistake, not money.
  if p_payment_breakdown is not null then
    v_breakdown := true;
    if jsonb_typeof(p_payment_breakdown) <> 'array' or jsonb_array_length(p_payment_breakdown) = 0 then
      raise exception 'The payment breakdown must be a non-empty list of payment parts'
        using errcode = 'check_violation';
    end if;

    for v_pay in select value as j from jsonb_array_elements(p_payment_breakdown)
    loop
      v_pay_method := v_pay.j ->> 'method';
      if v_pay_method is null
         or v_pay_method = 'split'
         or v_pay_method not in ('cash', 'transfer', 'pos_card', 'wallet') then
        raise exception 'A payment part names an unknown method (received %)',
          coalesce(v_pay_method, 'nothing') using errcode = 'check_violation';
      end if;

      v_pay_text := v_pay.j ->> 'amount';
      -- Regex before cast, as everywhere else money enters this function: a
      -- bad shape is refused for what it is, not for how the cast failed.
      if v_pay_text is null or v_pay_text !~ '^[0-9]+(\.[0-9]+)?$' then
        raise exception 'A payment part must carry a valid positive amount'
          using errcode = 'check_violation';
      end if;
      v_pay_amount := v_pay_text::numeric;
      if v_pay_amount <= 0 then
        raise exception 'A payment part must carry a positive amount' using errcode = 'check_violation';
      end if;

      v_breaksum := v_breaksum + v_pay_amount;
      v_break_parts := v_break_parts + 1;
    end loop;

    v_breaksum := round(v_breaksum, 2);
    if abs(v_breaksum - v_paid) > 0.01 then
      raise exception 'The payment parts add up to %, but the amount received is %',
        v_breaksum, v_paid using errcode = 'check_violation';
    end if;
  elsif p_payment_method = 'split' then
    raise exception 'A split payment must carry its payment breakdown' using errcode = 'check_violation';
  end if;

  if v_breakdown and jsonb_array_length(p_payment_breakdown) < 2 then
    raise exception 'A split payment needs at least two payment methods'
      using errcode = 'check_violation';
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
    amount_paid, outstanding, dispensed_against_prescription, idempotency_key,
    sold_at
  )
  values (
    v_branch, receipt_number, v_actor, p_customer_id, p_credit_account_id,
    v_subtotal, v_discount, nullif(btrim(coalesce(p_discount_reason, '')), ''),
    v_total, p_payment_method, v_state,
    v_paid, v_outstand, coalesce(p_dispensed_against_prescription, false),
    nullif(btrim(coalesce(p_idempotency_key, '')), ''),
    v_sold_at
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

  -- ------------------------------------------------- 7b. the payment records
  --
  -- POS payments. The breakdown (validated at step 2c) becomes one row per
  -- method; an ordinary payment becomes one row. A fully outstanding sale
  -- (debt) collects nothing and records no payment row. These rows are
  -- supporting detail: `sales.amount_paid` remains the money of record.
  if v_breakdown then
    for v_pay in select value as j from jsonb_array_elements(p_payment_breakdown)
    loop
      insert into public.sale_payments (sale_id, branch_id, method, amount, recorded_by)
      values (
        v_sale, v_branch,
        (v_pay.j ->> 'method')::public.payment_kind,
        round((v_pay.j ->> 'amount')::numeric, 2),
        v_actor
      );
    end loop;
  elsif v_paid > 0 then
    insert into public.sale_payments (sale_id, branch_id, method, amount, recorded_by)
    values (v_sale, v_branch, p_payment_method, v_paid, v_actor);
  end if;

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

-- ---------------------------------------------------------- repayments
create or replace function public.pf_record_customer_payment(
  p_sale_id uuid,
  p_amount  numeric,
  p_method  public.payment_kind,
  p_note    text default null
)
returns table (
  sale_id                    uuid,
  receipt_number             text,
  amount_paid                numeric,
  outstanding                numeric,
  state                      public.sale_state,
  customer_outstanding_debt  numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid;
  v_branch   uuid;
  v_sale     public.sales%rowtype;
  v_amount   numeric;
  v_new_paid numeric;
  v_new_out  numeric;
  v_state    public.sale_state;
begin
  -- ------------------------------------------------- 1. who is calling
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;

  -- Owner OR attendant: whoever is behind the counter can record the money a
  -- customer brought back. The audit row carries the recorder's identity.
  if not public.pf_is_staff() then
    raise exception 'Only pharmacy staff can record a repayment' using errcode = 'insufficient_privilege';
  end if;

  if p_sale_id is null then
    raise exception 'No sale was given' using errcode = 'check_violation';
  end if;
  if p_method is null then
    raise exception 'Choose a repayment method' using errcode = 'check_violation';
  end if;
  -- A split repayment is two repayments, not one: each part is recorded with
  -- its own method so the audit rows stay single-method.
  if p_method = 'split' then
    raise exception 'Record each split part as its own repayment — one method per repayment'
      using errcode = 'check_violation';
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then
    raise exception 'A repayment must be greater than zero' using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 2. the sale
  --
  -- Row lock: two staff members settling the same balance concurrently must
  -- serialise, not both "succeed" past the outstanding figure.
  select s.* into v_sale
    from public.sales s
   where s.id = p_sale_id
     for update;

  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.branch_id <> v_branch then
    raise exception 'Sale belongs to another pharmacy' using errcode = 'insufficient_privilege';
  end if;
  if v_sale.state in ('voided', 'refunded') then
    raise exception 'A voided or refunded sale cannot take a repayment' using errcode = 'check_violation';
  end if;
  -- Walk-in balances cannot exist (checkout refuses to leave one), so a null
  -- customer here is a data problem, not a workflow.
  if v_sale.customer_id is null then
    raise exception 'This sale has no customer on it — repayments are recorded against a named customer'
      using errcode = 'check_violation';
  end if;
  if v_sale.outstanding <= 0 then
    raise exception 'Nothing is outstanding on this sale' using errcode = 'check_violation';
  end if;
  if v_amount > v_sale.outstanding then
    raise exception 'A repayment cannot exceed the outstanding balance of %', v_sale.outstanding
      using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 3. write everything once
  v_new_paid := round(v_sale.amount_paid + v_amount, 2);
  v_new_out  := round(v_sale.outstanding - v_amount, 2);
  v_state    := case when v_new_out <= 0.005 then 'paid'::public.sale_state
                     else 'part_paid'::public.sale_state end;

  update public.sales
     set amount_paid = v_new_paid,
         outstanding = v_new_out,
         state       = v_state
   where id = v_sale.id;

  update public.customers
     set outstanding_debt = greatest(outstanding_debt - v_amount, 0)
   where id = v_sale.customer_id;

  insert into public.sale_payments (sale_id, branch_id, method, amount, recorded_by, note)
  values (
    v_sale.id, v_branch, p_method, v_amount, v_actor,
    nullif(btrim(coalesce(p_note, '')), '')
  );

  select c.outstanding_debt into customer_outstanding_debt
    from public.customers c
   where c.id = v_sale.customer_id;

  sale_id        := v_sale.id;
  receipt_number := v_sale.receipt_number;
  amount_paid    := v_new_paid;
  outstanding    := v_new_out;
  state          := v_state;
  return next;
end;
$$;

-- ------------------------------------------------------------------- grants
--
-- PostgreSQL grants EXECUTE to PUBLIC by default, which would make these
-- callable by `anon` - an unauthenticated client with no session. Same treatment
-- as every other pf_* function in 20261005190000_function_execute_hardening.
revoke execute on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text, timestamptz, jsonb
) from public;

revoke execute on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text, timestamptz, jsonb
) from anon;

grant execute on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text, timestamptz, jsonb
) to authenticated;

revoke execute on function public.pf_record_customer_payment(
  uuid, numeric, public.payment_kind, text
) from public;

revoke execute on function public.pf_record_customer_payment(
  uuid, numeric, public.payment_kind, text
) from anon;

grant execute on function public.pf_record_customer_payment(
  uuid, numeric, public.payment_kind, text
) to authenticated;

comment on function public.pf_complete_sale(
  jsonb, public.payment_kind, numeric, numeric, text, uuid, uuid, boolean, text, timestamptz, jsonb
) is
  'Authoritative checkout. Takes {medicine_id, unit_key} lines and nothing else numeric: multiplier, unit price, base units, subtotal and total are all derived here. Allocates stock FEFO across eligible lots under row locks, writes the sale, its lines and the stock movements in one transaction, and returns the existing sale instead of ringing up twice when the idempotency key repeats. An optional p_sold_at carries an offline sale''s occurrence time (validated: <= 5 minutes future, <= 30 days past). An optional p_payment_breakdown (jsonb array of {method, amount}) records the split-method parts of the collected amount; their sum must equal p_amount_paid and a sale labelled split must carry at least two parts. Every collected amount lands in sale_payments as one row per method. Cost data is never returned - sale line costs stay behind the owner-gated views.';

comment on function public.pf_record_customer_payment(
  uuid, numeric, public.payment_kind, text
) is
  'Record a repayment against a named customer''s outstanding balance on one sale. Locks the sale row, refuses voided/refunded sales, walk-in sales (no customer), already-settled sales and any amount above the outstanding balance, then atomically moves sales.amount_paid / outstanding / state, decrements customers.outstanding_debt and writes one sale_payments audit row with the paying method and the staff member who recorded it. One method per repayment: record each split part separately.';
