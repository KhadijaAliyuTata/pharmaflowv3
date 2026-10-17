-- ============================================================================
-- Tier 7 — the receiving write path: pf_receive_stock
-- ----------------------------------------------------------------------------
-- Apply with:  supabase db push
--
-- Additive and self-contained. Nothing above this file is edited, the chain still
-- applies to a fresh database, and every statement is re-runnable.
--
-- ## The defect
--
-- `stock_receipts` and `medicine_batches` are both writable by `authenticated`,
-- and `pf_record_stock_movement` derives a movement from each batch change — but
-- nothing wrote all three together. So the only receiving path in the product was
-- `/stock-receiving` calling `ops.receiveStock`, which mutates
-- `pharmaflow:state:v3` in localStorage. In a live build the store is empty and
-- nothing it does reaches Postgres: the screen reports a receipt that does not
-- exist, and stock never enters the database. That is the question Q3 left open —
-- "how does stock enter the database".
--
-- ## Idempotency (T7.6)
--
-- `stock_receipts_number_unique` — `unique (branch_id, receipt_number)` — already
-- exists (initial schema), so the receipt number IS the idempotency key and no
-- constraint is added here. A resubmitted delivery (double-click, retry after a
-- dropped connection) carries the same number and returns the receipt that
-- already exists rather than booking the goods twice. The caller is responsible
-- for keeping the number stable across retries and fresh for the next delivery;
-- `src/lib/supabase/stock.ts` documents how it is generated.
--
-- ## What this function deliberately does NOT decide
--
-- Cost and pricing stay with `pf_require_owner_to_price` (BEFORE INSERT OR UPDATE
-- on `stock_receipts`) and `pf_guard_cost_write` (BEFORE INSERT OR UPDATE on
-- `medicine_batches`). Both are security definer and both read `auth.uid()`, so
-- they still see the caller through this definer function and remain the
-- enforcement; this file does not restate the owner rule as its own authority.
--
-- ## The movement is not written here
--
-- `stock_movements` has exactly one writer — the `pf_record_stock_movement`
-- trigger on `medicine_batches`. This function inserts or tops up the batch and
-- lets that trigger record the movement, in the same transaction. Inserting one
-- here as well would produce a second, duplicate row for the same change.
--
-- ## Known cosmetic limit
--
-- Topping up an existing lot writes its movement as `adjustment`, where a first
-- delivery is `receipt`: the trigger labels a lot change by the statement that
-- made it, and a batch row has no "received more of this lot" statement. The
-- stock figure is identical either way; only the ledger label differs, and
-- `movement_kind` has no separate value to use. Recorded here rather than worked
-- around by editing the shared trigger.
-- ============================================================================

create or replace function public.pf_receive_stock(p_receipt jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_branch   uuid;
  v_owner    boolean;
  v_number   text;
  v_med      uuid;
  v_batch    text;
  v_units    integer;
  v_supplier uuid;
  v_expiry   date;
  v_qty      integer;
  v_ukey     text;
  v_uname    text;
  v_umult    integer;
  v_cost     numeric;
  v_price    numeric;
  v_state    public.receipt_state;
  v_receipt  uuid;
  v_batch_id uuid;
  v_brand    uuid;
  -- The idempotent-replay lookup reads into these, NOT into v_receipt/v_state/
  -- v_units: a `select ... into` that matches nothing assigns NULL to its targets,
  -- so reusing them would wipe the payload for the insert below.
  v_have_id    uuid;
  v_have_state public.receipt_state;
  v_have_units integer;
begin
  -- ----------------------------------------------------------- who is calling
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy'
      using errcode = 'insufficient_privilege';
  end if;

  -- SECURITY DEFINER bypasses RLS, so membership is checked here rather than left
  -- to `receipts_staff_insert`. Nothing below trusts a branch the caller sent:
  -- the function accepts none.
  if not exists (
    select 1
    from public.branch_memberships m
    where m.user_id = v_actor
      and m.branch_id = v_branch
  ) then
    raise exception 'Only staff of this pharmacy can receive stock'
      using errcode = 'insufficient_privilege';
  end if;

  v_owner := public.pf_is_owner();

  -- ---------------------------------------------------------------- the payload
  if p_receipt is null or jsonb_typeof(p_receipt) <> 'object' then
    raise exception 'A receipt is required' using errcode = 'check_violation';
  end if;

  v_number   := nullif(btrim(coalesce(p_receipt ->> 'receipt_number', '')), '');
  v_batch    := nullif(btrim(coalesce(p_receipt ->> 'batch_number', '')), '');
  v_cost     := nullif(p_receipt ->> 'cost_per_base_unit', '')::numeric;
  v_price    := nullif(p_receipt ->> 'price_per_base_unit', '')::numeric;
  v_ukey     := nullif(btrim(coalesce(p_receipt ->> 'received_unit_key', '')), '');
  v_uname    := nullif(btrim(coalesce(p_receipt ->> 'received_unit_name', '')), '');
  v_umult    := nullif(p_receipt ->> 'received_unit_multiplier', '')::integer;
  v_qty      := nullif(p_receipt ->> 'received_quantity', '')::integer;
  v_med      := (p_receipt ->> 'medicine_id')::uuid;
  v_units    := (p_receipt ->> 'base_units_received')::integer;
  v_expiry   := (p_receipt ->> 'expiry_date')::date;
  v_supplier := nullif(p_receipt ->> 'supplier_id', '')::uuid;

  if v_number is null then
    raise exception 'A receipt number is required' using errcode = 'check_violation';
  end if;
  if v_med is null then
    raise exception 'Pick a product before receiving' using errcode = 'check_violation';
  end if;
  if v_batch is null then
    raise exception 'Batch number is required' using errcode = 'check_violation';
  end if;
  if v_units is null or v_units <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = 'check_violation';
  end if;
  if v_expiry is null then
    raise exception 'Expiry date is required' using errcode = 'check_violation';
  end if;
  if v_expiry <= current_date then
    raise exception 'Expiry date must be in the future' using errcode = 'check_violation';
  end if;

  -- `stock_receipts_received_unit_coherent` enforces num_nonnulls(...) in (0, 3).
  -- Checked here too so the message names the field a person actually filled in.
  if num_nonnulls(v_qty, v_ukey, v_umult) not in (0, 3) then
    raise exception 'A counted unit needs its key, name and multiplier together'
      using errcode = 'check_violation';
  end if;

  -- The product and the supplier must be this pharmacy's. `receipts_staff_insert`
  -- would have said so too; under definer it has to be said here.
  if not exists (
    select 1 from public.medicines m
    where m.id = v_med and m.branch_id = v_branch
  ) then
    raise exception 'Product not found in this pharmacy' using errcode = 'no_data_found';
  end if;

  if v_supplier is not null and not exists (
    select 1 from public.suppliers s
    where s.id = v_supplier and s.branch_id = v_branch
  ) then
    raise exception 'Supplier not found in this pharmacy' using errcode = 'no_data_found';
  end if;

  -- A cost is an owner's to state. A non-owner's is dropped rather than refused,
  -- so the receipt still books in and waits in the pricing queue — the same
  -- outcome as the screen, which does not offer the fields to an assistant. The
  -- two guards above are still what enforces this for every other writer.
  if not v_owner then
    v_cost  := null;
    v_price := null;
  end if;

  if v_cost is not null and v_cost <= 0 then
    raise exception 'Cost must be greater than zero' using errcode = 'check_violation';
  end if;
  if v_price is not null and v_price <= 0 then
    raise exception 'Selling price must be greater than zero' using errcode = 'check_violation';
  end if;
  if v_price is not null and v_cost is not null and v_price <= v_cost then
    raise exception 'Selling price must be above cost' using errcode = 'check_violation';
  end if;

  -- A price with no cost is not a priced receipt; it waits for the owner, exactly
  -- as `ops.receiveStock` decided it.
  v_state := case
               when v_cost is not null then 'confirmed'::public.receipt_state
               else 'pending_pricing'::public.receipt_state
             end;

  -- ------------------------------------------------------------- idempotency
  select r.id, r.state, r.base_units_received
    into v_have_id, v_have_state, v_have_units
    from public.stock_receipts r
   where r.branch_id = v_branch
     and r.receipt_number = v_number;

  if found then
    select b.id into v_batch_id
      from public.medicine_batches b
     where b.medicine_id = v_med
       and b.batch_number = v_batch;

    return jsonb_build_object(
      'receipt_id', v_have_id,
      'batch_id', v_batch_id,
      'receipt_number', v_number,
      'state', v_have_state,
      'base_units_received', coalesce(v_have_units, 0),
      'already_received', true
    );
  end if;

  -- ------------------------------------------------------------------- receipt
  -- Written first, so a failure below cannot leave a lot with no paperwork. The
  -- whole function is one transaction, so nothing here is visible until it ends.
  insert into public.stock_receipts (
    branch_id, receipt_number, medicine_id, batch_number, base_units_received,
    supplier_id, expiry_date, received_by, state, cost_per_base_unit,
    price_per_base_unit, priced_by, priced_at,
    received_quantity, received_unit_key, received_unit_name, received_unit_multiplier
  )
  values (
    v_branch, v_number, v_med, v_batch, v_units,
    v_supplier, v_expiry, v_actor, v_state, v_cost,
    v_price,
    case when v_state = 'confirmed' then v_actor end,
    case when v_state = 'confirmed' then now() end,
    v_qty, v_ukey, v_uname, v_umult
  )
  returning id into v_receipt;

  -- ----------------------------------------------------------------------- lot
  -- `medicine_batches_unique` is (medicine_id, batch_number) — a lot's identity,
  -- not a per-delivery row. A second delivery of the same lot tops up the one
  -- that exists, which is also what the trigger expects: it writes one movement
  -- per batch change. A lot number owned by another pharmacy is refused rather
  -- than merged into.
  select b.id, b.branch_id into v_batch_id, v_brand
    from public.medicine_batches b
   where b.medicine_id = v_med
     and b.batch_number = v_batch;

  if found then
    if v_brand <> v_branch then
      raise exception 'Batch % of this product belongs to another pharmacy', v_batch
        using errcode = 'insufficient_privilege';
    end if;

    update public.medicine_batches
       set quantity = quantity + v_units,
           received_date = current_date
     where id = v_batch_id;
  else
    insert into public.medicine_batches (
      branch_id, medicine_id, batch_number, expiry_date, quantity,
      cost_per_base_unit, supplier_id, received_date
    )
    values (
      v_branch, v_med, v_batch, v_expiry, v_units,
      coalesce(v_cost, 0), v_supplier, current_date
    )
    returning id into v_batch_id;
  end if;

  return jsonb_build_object(
    'receipt_id', v_receipt,
    'batch_id', v_batch_id,
    'receipt_number', v_number,
    'state', v_state,
    'base_units_received', v_units,
    'already_received', false
  );
end;
$$;

comment on function public.pf_receive_stock(jsonb) is
  'Tier 7 receiving write path. SECURITY DEFINER, so it checks membership itself. Writes the receipt and inserts or tops up the lot in one transaction and lets pf_record_stock_movement record the movement. Idempotent on (branch_id, receipt_number): a resubmitted delivery returns the receipt that already exists. A non-owner''s cost is dropped, not refused, so the delivery still books in and waits in the pricing queue; pf_require_owner_to_price and pf_guard_cost_write remain the enforcement for every other writer.';

-- PostgreSQL grants EXECUTE to PUBLIC by default, which would make this callable
-- by `anon`. Same treatment as every other pf_* function in
-- 20261005190000_function_execute_hardening.
revoke execute on function public.pf_receive_stock(jsonb) from public;
revoke execute on function public.pf_receive_stock(jsonb) from anon;
grant execute on function public.pf_receive_stock(jsonb) to authenticated;
