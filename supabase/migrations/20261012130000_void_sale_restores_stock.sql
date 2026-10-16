-- ======================================================== void restores stock
--
-- ## The problem this closes
--
-- `sales_owner_void` allows an owner to set `sales.state = 'voided'`, and
-- nothing else happened. The stock the sale consumed stayed consumed. That was
-- survivable while the POS wrote to localStorage and no sale ever reached the
-- database. Since `pf_complete_sale` (20261012120000) writes real sales, voiding
-- one now destroys stock permanently with no record of why.
--
-- ## Why this needs a new migration rather than a line in the last one
--
-- The blocker was not "add a function". It was that **nothing recorded which lot
-- a sale consumed**:
--
--   * `pf_record_stock_movement()` wrote `reference_id` as a hardcoded `null`;
--   * `sale_items.batch_id` names a lot only when ONE lot covered the whole
--     line. A line split across two lots - the ordinary case once a pharmacy
--     holds several batches of the same drug - is stored with `batch_id = null`,
--     because `sale_items` has exactly one line per cart line and cannot express
--     a split.
--
-- So for a split line the allocation existed only as a side effect of the batch
-- UPDATE, with nothing tying it to the sale. Re-deriving it at void time would
-- mean re-running FEFO against today's lots, which is not the same set - it
-- would guess. This migration records the reference instead.
--
-- Both trigger functions are redefined below. Neither is deleted, and neither
-- weakens anything: the change is that a movement now carries the sale that
-- caused it, and that the reference is set from a transaction-local setting
-- rather than guessed.
--
-- ## No accounting is invented here
--
-- `sale_state` distinguishes `voided` from `refunded`, and this function only
-- ever produces `voided`. A void undoes the transaction - stock back, customer
-- and credit-account side effects unwound, a `void` movement written. It is not
-- a refund and does not pretend to be one; no money is moved anywhere, because
-- a void records a mistake rather than a repayment.

-- ---------------------------------------------------------------------------
-- 1. Movements carry the reference that caused them
-- ---------------------------------------------------------------------------
--
-- `reference_id` becomes the sale id when one is in scope. For every other
-- writer the value is unchanged (`null`), so this cannot be used to forge a link
-- from an unrelated movement to a sale.
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
  kind_text public.movement_kind;
  note_text text;
  ref uuid;
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

  -- 'sale' while a checkout is running, 'void' while one is being undone,
  -- otherwise the historical behaviour.
  if coalesce(current_setting('pharmaflow.sale_stock', true), '') = 'sale' then
    kind_text := 'sale'::movement_kind;
    note_text := 'Dispensed by a sale';
  elsif coalesce(current_setting('pharmaflow.sale_stock', true), '') = 'void' then
    kind_text := 'void'::movement_kind;
    note_text := 'Restored by voiding a sale';
  else
    kind_text := case
                   when tg_op = 'INSERT' then 'receipt'::movement_kind
                   when tg_op = 'DELETE' then 'disposal'::movement_kind
                   else 'adjustment'::movement_kind
                 end;
    note_text := case
                   when tg_op = 'INSERT' then 'Batch received'
                   when tg_op = 'DELETE' then 'Batch ' || lot || ' deleted'
                   else 'Batch quantity adjusted'
                 end;
  end if;

  -- Only set by the two functions below, and only inside their own transaction.
  ref := nullif(current_setting('pharmaflow.sale_ref', true), '')::uuid;

  insert into stock_movements (
    branch_id, medicine_id, batch_id, kind,
    quantity_changed, resulting_quantity, performed_by, note, reference_id
  )
  values (
    coalesce(new.branch_id, old.branch_id),
    medicine,
    lot_ref,
    kind_text,
    changed,
    coalesce(new.quantity, 0),
    auth.uid(),
    note_text,
    ref
  );

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The stock trigger announces which sale it is serving
-- ---------------------------------------------------------------------------
--
-- This is the only place a sale's identity is available to the movement writer
-- without changing `pf_complete_sale`. It runs once per sale line, so the
-- reference is in scope by the time that function applies any split allocation
-- (which happens after every line has been inserted).
--
-- Set before the `batch_id is null` early return, so a fully split line still
-- establishes the reference for the lines around it.
create or replace function public.pf_apply_sale_item_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lot_branch uuid;
  sale_branch uuid;
begin
  -- Transaction-local: it cannot outlive this sale.
  perform set_config('pharmaflow.sale_ref', new.sale_id::text, true);

  -- An untraced sale consumes nothing. FEFO allocation lands in Phase 2 and will
  -- populate `batch_id`; until then a line without a lot is recorded but not
  -- decremented, which is the pre-existing behaviour and is preferable to
  -- guessing which lot to take.
  if new.batch_id is null then
    return new;
  end if;

  -- SECURITY DEFINER bypasses RLS, so this trigger is responsible for not being
  -- the thing that lets a caller reach another tenant's stock. Resolve the lot's
  -- branch and the sale's branch and require them to agree.
  select b.branch_id into lot_branch
  from medicine_batches b where b.id = new.batch_id;

  select s.branch_id into sale_branch
  from sales s where s.id = new.sale_id;

  if lot_branch is null then
    raise exception 'Lot % does not exist', new.batch_id
      using errcode = 'foreign_key_violation';
  end if;

  if lot_branch is distinct from sale_branch then
    raise exception 'Lot % belongs to a different branch than the sale', new.batch_id
      using errcode = 'insufficient_privilege';
  end if;

  update medicine_batches
  set quantity = quantity - new.base_units_total
  where id = new.batch_id
    and quantity >= new.base_units_total;

  -- Zero rows means the lot cannot cover the line. Raising here aborts the whole
  -- sale line insert, so an over-commit is impossible rather than clamped: the
  -- alternative is a sale recorded against stock that does not exist.
  if not found then
    raise exception 'Lot % does not hold % units for this sale line',
      new.batch_id, new.base_units_total
      using errcode = 'check_violation';
  end if;

  -- `pf_sync_total_quantity` fires on this update and recomputes
  -- `medicines.total_quantity`, and `pf_record_stock_movement` writes the audit
  -- row. Neither needs doing here.
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. pf_void_sale
-- ---------------------------------------------------------------------------
create or replace function public.pf_void_sale(
  p_sale_id uuid,
  p_reason  text
)
returns table (
  sale_id        uuid,
  receipt_number text,
  restored_units integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid;
  v_branch   uuid;
  v_sale     public.sales%rowtype;
  v_acct     public.credit_accounts%rowtype;
  v_alloc    record;
  v_units    integer := 0;
  v_reason   text;
begin
  -- ------------------------------------------------- 1. authority
  --
  -- SECURITY DEFINER bypasses RLS, so the owner-and-branch check that
  -- `sales_owner_void` would otherwise perform has to be made here.
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;

  -- Owners only. Mirrors `sales_owner_void` in 20261002160000_initial_schema.sql
  -- so the RPC and the RLS policy cannot disagree about who may void.
  if not public.pf_is_owner() then
    raise exception 'Only an owner can void a sale' using errcode = 'insufficient_privilege';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'Give a reason for the void' using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 2. the sale
  select s.* into v_sale
    from public.sales s
   where s.id = p_sale_id;

  if not found then
    raise exception 'Sale does not exist' using errcode = 'no_data_found';
  end if;

  if v_sale.branch_id <> v_branch then
    raise exception 'That sale belongs to another pharmacy' using errcode = 'insufficient_privilege';
  end if;

  -- Two separate refusals rather than one "already finalised": the client shows
  -- the message, and an owner who has already refunded needs to know that is the
  -- reason rather than being told the sale is voided.
  if v_sale.state = 'voided' then
    raise exception 'Sale % is already voided', v_sale.receipt_number
      using errcode = 'check_violation';
  end if;
  if v_sale.state = 'refunded' then
    raise exception 'Refunded sales cannot be voided' using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 3. what it consumed
  --
  -- The allocation, exactly as it happened. Deliberately NOT re-derived by
  -- re-running FEFO: today's lots are not the lots the sale drew from, and
  -- guessing would put stock back on the wrong batch.
  --
  -- A sale written before this migration has movements with a null
  -- `reference_id`, and therefore no recoverable allocation. That is refused
  -- rather than approximated.
  for v_alloc in
    select sm.batch_id, -sm.quantity_changed as units
      from public.stock_movements sm
     where sm.reference_id = v_sale.id
       and sm.kind = 'sale'::public.movement_kind
       and sm.quantity_changed < 0
     order by sm.created_at asc, sm.id asc
     for update
  loop
    if v_alloc.batch_id is null then
      raise exception
        'The lot consumed by % no longer exists, so its stock cannot be restored safely',
        v_sale.receipt_number using errcode = 'check_violation';
    end if;

    if v_alloc.units <= 0 then
      raise exception 'The recorded allocation for % is not usable', v_sale.receipt_number
        using errcode = 'check_violation';
    end if;

    -- Lock the lot and confirm it still belongs to this branch before adding to
    -- it. `FOR UPDATE` is taken here rather than in the loop above so the row is
    -- held for the rest of the transaction.
    perform 1
       from public.medicine_batches b
      where b.id = v_alloc.batch_id
        and b.branch_id = v_branch
        for update;

    if not found then
      raise exception 'The lot consumed by % is not available in this pharmacy',
        v_sale.receipt_number using errcode = 'insufficient_privilege';
    end if;

    perform set_config('pharmaflow.sale_stock', 'void', true);
    perform set_config('pharmaflow.sale_ref', v_sale.id::text, true);

    update public.medicine_batches
       set quantity = quantity + v_alloc.units
     where id = v_alloc.batch_id;

    v_units := v_units + v_alloc.units;
  end loop;

  -- No movements means either the sale predates the reference, or it consumed
  -- nothing. Either way the stock cannot be put back correctly, and marking it
  -- voided anyway would hide that. `pf_sync_total_quantity` recomputes
  -- `medicines.total_quantity` from the lots on the update above.
  if v_units = 0 then
    raise exception
      'The stock consumed by % cannot be identified, so it has not been voided',
      v_sale.receipt_number using errcode = 'check_violation';
  end if;

  -- ------------------------------------------------- 4. customer and credit
  --
  -- Unwound exactly as `pf_complete_sale` applied them. Floored at zero so a
  -- double unwind cannot manufacture negative debt.
  if v_sale.customer_id is not null then
    update public.customers
       set total_spent      = greatest(total_spent - v_sale.total, 0),
           purchase_count   = greatest(purchase_count - 1, 0),
           outstanding_debt = greatest(outstanding_debt - v_sale.outstanding, 0)
     where id = v_sale.customer_id
       and branch_id = v_branch;
  end if;

  if v_sale.credit_account_id is not null and v_sale.outstanding > 0 then
    select * into v_acct
      from public.credit_accounts c
     where c.id = v_sale.credit_account_id
       and c.branch_id = v_branch
     for update;

    if found then
      -- Ledger first, balance second, with the same transaction-local exemption
      -- `pf_complete_sale` uses. The reason is in
      -- 20261012120000_authoritative_checkout.sql: the two credit triggers
      -- cannot both be satisfied in the other order.
      perform set_config('pharmaflow.credit_write', '1', true);

      insert into public.credit_ledger (
        account_id, branch_id, kind, amount, balance_after, note, reference_id, recorded_by
      )
      values (
        v_acct.id, v_branch, 'payment', v_sale.outstanding,
        greatest(v_acct.outstanding_balance - v_sale.outstanding, 0),
        'Voided ' || v_sale.receipt_number, v_sale.id, v_actor
      );

      -- `pf_check_credit_account_ledger` runs here and is not excused: the ledger
      -- already carries the new balance, so its comparison is a real one.
      update public.credit_accounts
         set outstanding_balance = greatest(outstanding_balance - v_sale.outstanding, 0),
             updated_at = now()
       where id = v_acct.id;
    end if;
  end if;

  -- ------------------------------------------------- 5. mark it voided
  --
  -- After the stock, so the state change is the last thing to happen before
  -- commit. Any failure above rolls the whole thing back, leaving the sale
  -- exactly as it was.
  update public.sales
     set state             = 'voided'::public.sale_state,
         status_reason     = v_reason,
         status_changed_by = v_actor,
         status_changed_at = now()
   where id = v_sale.id;

  sale_id := v_sale.id;
  receipt_number := v_sale.receipt_number;
  restored_units := v_units;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
--
-- Same treatment as every other client-callable function: PostgreSQL grants
-- EXECUTE to PUBLIC by default, which would make this reachable by `anon`.
revoke execute on function public.pf_void_sale(uuid, text) from public;
revoke execute on function public.pf_void_sale(uuid, text) from anon;
grant execute on function public.pf_void_sale(uuid, text) to authenticated;

comment on function public.pf_void_sale(uuid, text) is
  'Voids a sale and returns its stock to the lots it was taken from. Owner-only, branch-scoped, single transaction. Restores the recorded allocation rather than re-deriving FEFO, and refuses outright when that allocation cannot be recovered. Writes a ''void'' movement per lot. Never returns cost or margin data, and never produces a ''refunded'' state - a void is a correction, not a repayment.';