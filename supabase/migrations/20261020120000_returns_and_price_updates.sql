-- ====================================================== returns & price updates
--
-- Two linked gaps are closed here:
--
--   1. A completed sale can be reversed only by voiding the whole thing. There
--      is no partial return, no reason record, no batch-level restoration and no
--      quarantine path.
--   2. `medicines.units[].sellingPrice` is authoritative for the POS, but every
--      live write path is disabled (`src/lib/catalogue-writes.ts`). Pricing is
--      therefore only editable in the demo store.
--
-- The return model is deliberately separate from `sales`. The completed sale,
-- its lines, receipt number, tendered money and sale payments are immutable.
-- A return is its own linked transaction with its own number, reason, review,
-- allocations, credit note and refund record. A partial return never edits the
-- sale or marks the whole sale returned.
--
-- Stock restoration reuses the recorded `stock_movements` allocation for the
-- sale. It never re-runs FEFO: today's lots are not the lots the sale drew from.
-- If the original allocation cannot be identified, or the lot is expired,
-- recalled, damaged or locked, the returned units are recorded as quarantined
-- and are not added back to sellable batch quantity.
--
-- Limit, stated plainly: `sale_items.batch_id` identifies a lot only when one
-- lot covered the whole line. For a line split across lots the allocation is
-- recoverable from `stock_movements`, keyed by sale and medicine. If a single
-- sale has more than one line for the same medicine, the movement ledger cannot
-- say which line consumed which lot. That case is quarantined rather than
-- guessed. It is not silently assigned to an arbitrary batch.

-- --------------------------------------------------------------- sales credit
--
-- `returned_credit` is the portion of accepted returns applied against this
-- sale's outstanding balance. It is a separate number, not a rewrite of
-- `amount_paid`, `outstanding` or `total`; `sales_paid_plus_outstanding` stays
-- true for the original transaction. Effective outstanding is:
--
--     sales.outstanding - sales.returned_credit
--
-- `pf_record_customer_payment` below uses that net figure.
alter table public.sales
  add column if not exists returned_credit numeric(14,2) not null default 0;

do $$ begin
  alter table public.sales
    add constraint sales_returned_credit_nonnegative check (returned_credit >= 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.sales
    add constraint sales_returned_credit_within_total
    check (returned_credit <= total + 0.01);
exception when duplicate_object then null;
end $$;

-- --------------------------------------------------------------- return tables

create sequence if not exists public.medicine_return_number_seq;

create table if not exists public.medicine_returns (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references public.branches(id) on delete restrict,
  sale_id         uuid not null references public.sales(id) on delete restrict,
  return_number   text not null,
  status          text not null default 'pending_review'
                  check (status in ('pending_review', 'completed', 'rejected')),
  reason          text not null
                  check (reason in (
                    'wrong_medicine', 'damaged', 'customer_changed_mind',
                    'expired', 'recalled', 'other'
                  )),
  note            text not null default '',
  idempotency_key text,
  requested_by    uuid not null references public.profiles(id) on delete restrict,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text,
  completed_at    timestamptz,
  refund_value    numeric(14,2) not null default 0 check (refund_value >= 0),
  credit_applied  numeric(14,2) not null default 0 check (credit_applied >= 0),
  refund_amount   numeric(14,2) not null default 0 check (refund_amount >= 0),
  refund_method   text check (refund_method in (
                    'cash', 'transfer', 'pos_card', 'wallet',
                    'store_credit', 'not_refunded'
                  )),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint medicine_returns_number_unique unique (branch_id, return_number),
  -- The value is known when the request is created; the credit/refund split is
  -- only known when it is completed. Pending and rejected rows therefore may
  -- carry a value with a zero split.
  constraint medicine_returns_value_split
    check (
      status <> 'completed'
      or abs((credit_applied + refund_amount) - refund_value) < 0.01
    )
);

create unique index if not exists medicine_returns_idempotency_idx
  on public.medicine_returns(branch_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists medicine_returns_sale_idx
  on public.medicine_returns(sale_id, created_at desc);

create index if not exists medicine_returns_pending_idx
  on public.medicine_returns(branch_id, created_at desc)
  where status = 'pending_review';

create table if not exists public.medicine_return_items (
  id               uuid primary key default gen_random_uuid(),
  return_id        uuid not null references public.medicine_returns(id) on delete cascade,
  sale_item_id     uuid not null references public.sale_items(id) on delete restrict,
  medicine_id      uuid not null references public.medicines(id) on delete restrict,
  quantity         integer not null check (quantity > 0),
  base_units_total integer not null check (base_units_total > 0),
  unit_price       numeric(14,2) not null check (unit_price >= 0),
  line_total       numeric(14,2) not null check (line_total >= 0),
  return_value     numeric(14,2) not null default 0 check (return_value >= 0),
  restocked_units  integer not null default 0 check (restocked_units >= 0),
  quarantined_units integer not null default 0 check (quarantined_units >= 0),
  created_at       timestamptz not null default now(),
  constraint medicine_return_items_sale_item_unique unique (return_id, sale_item_id),
  constraint medicine_return_items_units_balance
    check (restocked_units + quarantined_units <= base_units_total)
);

create index if not exists medicine_return_items_return_idx
  on public.medicine_return_items(return_id);

create index if not exists medicine_return_items_sale_item_idx
  on public.medicine_return_items(sale_item_id);

create table if not exists public.medicine_return_allocations (
  id             uuid primary key default gen_random_uuid(),
  return_item_id uuid not null references public.medicine_return_items(id) on delete cascade,
  batch_id       uuid references public.medicine_batches(id) on delete set null,
  base_units     integer not null check (base_units > 0),
  disposition    text not null check (disposition in ('restocked', 'quarantined')),
  note           text not null default '',
  created_at     timestamptz not null default now()
);

create index if not exists medicine_return_allocations_item_idx
  on public.medicine_return_allocations(return_item_id);

create index if not exists medicine_return_allocations_batch_idx
  on public.medicine_return_allocations(batch_id)
  where batch_id is not null;

-- ---------------------------------------------------------- price audit ledger
--
-- Append-only. There is no UPDATE or DELETE policy and no write grant. Rows are
-- written only by `pf_update_medicine_price`.
create table if not exists public.medicine_price_changes (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references public.branches(id) on delete restrict,
  medicine_id     uuid not null references public.medicines(id) on delete restrict,
  unit_key        text not null,
  unit_name       text not null,
  unit_multiplier integer not null check (unit_multiplier > 0),
  old_price       numeric(14,2) not null check (old_price >= 0),
  new_price       numeric(14,2) not null check (new_price >= 0),
  reason          text not null default '',
  changed_by      uuid not null references public.profiles(id) on delete restrict,
  changed_at      timestamptz not null default now()
);

create index if not exists medicine_price_changes_branch_idx
  on public.medicine_price_changes(branch_id, changed_at desc);

create index if not exists medicine_price_changes_medicine_idx
  on public.medicine_price_changes(medicine_id, changed_at desc);

-- --------------------------------------------------- stock movement kind: return
--
-- Extends the existing movement writer rather than introducing a second ledger.
-- `pharmaflow.sale_stock = 'return'` and `pharmaflow.sale_ref = <return id>` are
-- set only inside `pf_apply_return`.
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
    lot_ref  := null;
  else
    medicine := new.medicine_id;
    changed  := new.quantity - coalesce(old.quantity, 0);
    lot      := new.id;
    lot_ref  := new.id;
  end if;

  if changed = 0 then
    return null;
  end if;

  if coalesce(current_setting('pharmaflow.sale_stock', true), '') = 'sale' then
    kind_text := 'sale'::movement_kind;
    note_text := 'Dispensed by a sale';
  elsif coalesce(current_setting('pharmaflow.sale_stock', true), '') = 'void' then
    kind_text := 'void'::movement_kind;
    note_text := 'Restored by voiding a sale';
  elsif coalesce(current_setting('pharmaflow.sale_stock', true), '') = 'return' then
    kind_text := 'return'::movement_kind;
    note_text := 'Restored by an accepted customer return';
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

  ref := nullif(current_setting('pharmaflow.sale_ref', true), '')::uuid;

  insert into public.stock_movements (
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

-- --------------------------------------------------- void cannot double-restore
--
-- A sale with any accepted or pending return must not be voided. Void restores
-- every sale movement, which would put returned stock back a second time. The
-- owner can reject the pending return first; an accepted return is final and the
-- sale remains a sale, with the return recorded separately.
create or replace function public.pf_guard_void_with_returns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state = 'voided' and old.state is distinct from 'voided' then
    if exists (
      select 1
        from public.medicine_returns r
       where r.sale_id = new.id
         and r.status in ('pending_review', 'completed')
    ) then
      raise exception
        'Sale % has a return recorded against it and cannot be voided',
        new.receipt_number using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sales_guard_void_with_returns on public.sales;
create trigger sales_guard_void_with_returns
  before update of state on public.sales
  for each row execute function public.pf_guard_void_with_returns();

-- ------------------------------------------------------- what can be returned
--
-- Server-authoritative view of one sale's lines. `quantity_remaining` excludes
-- both accepted returns and returns still awaiting review, so an attendant
-- cannot reserve the same unit twice while an owner is deciding.
create or replace function public.pf_sale_returnable(p_sale_id uuid)
returns table (
  sale_item_id       uuid,
  medicine_id        uuid,
  medicine_name      text,
  unit_key           text,
  unit_name          text,
  unit_multiplier    integer,
  quantity_sold      integer,
  quantity_returned  integer,
  quantity_pending   integer,
  quantity_remaining integer,
  unit_price         numeric,
  line_total         numeric,
  return_value_per_unit numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid;
  v_branch uuid;
  v_sale   public.sales%rowtype;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;
  if not public.pf_is_staff() then
    raise exception 'Only pharmacy staff can inspect a sale for return'
      using errcode = 'insufficient_privilege';
  end if;

  select s.* into v_sale
    from public.sales s
   where s.id = p_sale_id;

  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.branch_id <> v_branch then
    raise exception 'That sale belongs to another pharmacy' using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    si.id,
    si.medicine_id,
    si.medicine_name,
    si.unit_key,
    si.unit_name,
    si.unit_multiplier,
    si.quantity,
    coalesce(sum(case when r.status = 'completed' then ri.quantity else 0 end), 0)::integer,
    coalesce(sum(case when r.status = 'pending_review' then ri.quantity else 0 end), 0)::integer,
    (si.quantity
      - coalesce(sum(case when r.status in ('completed', 'pending_review') then ri.quantity else 0 end), 0)
    )::integer,
    si.unit_price,
    si.line_total,
    case
      when si.quantity > 0 and v_sale.subtotal > 0
        then round((si.line_total * (v_sale.total / v_sale.subtotal)) / si.quantity, 2)
      else 0
    end
  from public.sale_items si
  left join public.medicine_return_items ri on ri.sale_item_id = si.id
  left join public.medicine_returns r
    on r.id = ri.return_id
   and r.status in ('completed', 'pending_review')
  where si.sale_id = p_sale_id
  group by si.id
  order by si.id;
end;
$$;

-- ------------------------------------------------------------ finalise a return
--
-- Internal. Never granted to a client. `pf_create_return` calls it when an owner
-- creates the return; `pf_review_return` calls it when an owner approves one.
create or replace function public.pf_apply_return(
  p_return_id     uuid,
  p_actor         uuid,
  p_approve       boolean,
  p_note          text,
  p_refund_method text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret       public.medicine_returns%rowtype;
  v_sale      public.sales%rowtype;
  v_item      record;
  v_si        public.sale_items%rowtype;
  v_batch     public.medicine_batches%rowtype;
  v_account   public.credit_accounts%rowtype;
  v_alloc     record;
  v_need      integer;
  v_already   integer;
  v_remaining integer;
  v_take      integer;
  v_line_count integer;
  v_disposition text;
  v_effective numeric;
  v_credit    numeric;
  v_refund    numeric;
  v_restocked integer;
  v_quarantined integer;
  v_note      text;
begin
  select r.* into v_ret
    from public.medicine_returns r
   where r.id = p_return_id
     for update;

  if not found then
    raise exception 'Return not found' using errcode = 'no_data_found';
  end if;
  if v_ret.branch_id <> public.pf_current_branch() then
    raise exception 'That return belongs to another pharmacy' using errcode = 'insufficient_privilege';
  end if;
  if v_ret.status <> 'pending_review' then
    raise exception 'Return % has already been reviewed', v_ret.return_number
      using errcode = 'check_violation';
  end if;

  if not p_approve then
    update public.medicine_returns
       set status = 'rejected',
           reviewed_by = p_actor,
           reviewed_at = now(),
           review_note = nullif(btrim(coalesce(p_note, '')), ''),
           updated_at = now()
     where id = p_return_id;

    insert into public.audit_events (branch_id, actor_id, action, description, metadata)
    values (
      v_ret.branch_id, p_actor, 'return',
      'Return ' || v_ret.return_number || ' rejected',
      jsonb_build_object('return_id', v_ret.id, 'sale_id', v_ret.sale_id, 'status', 'rejected')
    );
    return;
  end if;

  select s.* into v_sale
    from public.sales s
   where s.id = v_ret.sale_id
     for update;

  if not found then
    raise exception 'The sale for this return no longer exists' using errcode = 'no_data_found';
  end if;
  if v_sale.branch_id <> v_ret.branch_id then
    raise exception 'The sale and return belong to different pharmacies' using errcode = 'insufficient_privilege';
  end if;
  if v_sale.state in ('voided', 'refunded') then
    raise exception 'A voided or refunded sale cannot be returned' using errcode = 'check_violation';
  end if;

  for v_item in
    select ri.*
      from public.medicine_return_items ri
     where ri.return_id = p_return_id
     order by ri.id
  loop
    select si.* into v_si
      from public.sale_items si
     where si.id = v_item.sale_item_id
       and si.sale_id = v_sale.id;

    if not found then
      raise exception 'A return line no longer belongs to this sale' using errcode = 'check_violation';
    end if;

    -- Revalidate against completed returns only. Pending returns were already
    -- counted during creation, so the total cannot exceed the sold quantity.
    select coalesce(sum(ri.quantity), 0)::integer into v_already
      from public.medicine_return_items ri
      join public.medicine_returns r on r.id = ri.return_id
     where ri.sale_item_id = v_item.sale_item_id
       and r.status = 'completed'
       and r.id <> p_return_id;

    if v_item.quantity > (v_si.quantity - v_already) then
      raise exception 'Only % of % may still be returned',
        greatest(v_si.quantity - v_already, 0), v_si.medicine_name
        using errcode = 'check_violation';
    end if;

    v_need := v_item.base_units_total;

    -- Damaged stock never goes back on the shelf. It still records the original
    -- line and value; only the disposition differs.
    if v_ret.reason = 'damaged' then
      insert into public.medicine_return_allocations
        (return_item_id, batch_id, base_units, disposition, note)
      values (v_item.id, null, v_need, 'quarantined', 'Damaged return');

      update public.medicine_return_items
         set restocked_units = 0,
             quarantined_units = v_need
       where id = v_item.id;
      continue;
    end if;

    -- A sale with two lines of the same medicine has no line-level allocation in
    -- the movement ledger. Quarantine rather than guessing a lot.
    select count(*)::integer into v_line_count
      from public.sale_items si
     where si.sale_id = v_sale.id
       and si.medicine_id = v_item.medicine_id;

    if v_line_count > 1 then
      insert into public.medicine_return_allocations
        (return_item_id, batch_id, base_units, disposition, note)
      values (
        v_item.id, null, v_need, 'quarantined',
        'Sale line has ambiguous batch provenance'
      );

      update public.medicine_return_items
         set restocked_units = 0,
             quarantined_units = v_need
       where id = v_item.id;
      continue;
    end if;

    -- Replay the sale's own recorded allocation, in the order it happened. The
    -- `already` subtraction is the sum of every prior accepted allocation for
    -- this sale/medicine/lot, whether it was restocked or quarantined, so a
    -- partial return cannot reuse the same consumed units twice.
    for v_alloc in
      select sm.batch_id,
             sum(-sm.quantity_changed)::integer as units
        from public.stock_movements sm
        left join public.medicine_batches b on b.id = sm.batch_id
       where sm.reference_id = v_sale.id
         and sm.kind = 'sale'::public.movement_kind
         and sm.medicine_id = v_item.medicine_id
         and sm.quantity_changed < 0
         and sm.batch_id is not null
       group by sm.batch_id
       -- The sale's movements may share one `now()` timestamp, so ordering by
       -- created_at alone is not stable. Expiry and receipt order are the lot
       -- order FEFO used to consume them in the first place.
       order by min(b.expiry_date) nulls last,
                min(b.received_date) nulls last,
                min(sm.id::text)
    loop
      exit when v_need <= 0;

      select coalesce(sum(a.base_units), 0)::integer into v_already
        from public.medicine_return_allocations a
        join public.medicine_return_items ri on ri.id = a.return_item_id
        join public.medicine_returns r on r.id = ri.return_id
       where r.sale_id = v_sale.id
         and ri.medicine_id = v_item.medicine_id
         and a.batch_id = v_alloc.batch_id
         and r.status = 'completed';

      v_remaining := v_alloc.units - v_already;
      if v_remaining <= 0 then
        continue;
      end if;

      v_take := least(v_need, v_remaining);

      select b.* into v_batch
        from public.medicine_batches b
       where b.id = v_alloc.batch_id
         and b.branch_id = v_sale.branch_id
         for update;

      if not found then
        insert into public.medicine_return_allocations
          (return_item_id, batch_id, base_units, disposition, note)
        values (
          v_item.id, null, v_take, 'quarantined',
          'Original lot is no longer available in this pharmacy'
        );
        v_need := v_need - v_take;
        continue;
      end if;

      v_disposition := case
        when v_batch.expiry_date <= current_date then 'quarantined'
        when v_batch.is_recalled then 'quarantined'
        else 'restocked'
      end;

      v_note := case
        when v_disposition = 'quarantined' and v_batch.expiry_date <= current_date
          then 'Original lot is expired'
        when v_disposition = 'quarantined' and v_batch.is_recalled
          then 'Original lot is recalled'
        else 'Restored to the original lot'
      end;

      if v_disposition = 'restocked' then
        perform set_config('pharmaflow.sale_stock', 'return', true);
        perform set_config('pharmaflow.sale_ref', v_ret.id::text, true);

        update public.medicine_batches
           set quantity = quantity + v_take
         where id = v_batch.id;
      end if;

      insert into public.medicine_return_allocations
        (return_item_id, batch_id, base_units, disposition, note)
      values (
        v_item.id,
        case when v_disposition = 'restocked' then v_batch.id else null end,
        v_take,
        v_disposition,
        v_note
      );

      v_need := v_need - v_take;
    end loop;

    if v_need > 0 then
      insert into public.medicine_return_allocations
        (return_item_id, batch_id, base_units, disposition, note)
      values (
        v_item.id, null, v_need, 'quarantined',
        'No recoverable original batch allocation'
      );
    end if;

    select
      coalesce(sum(case when a.disposition = 'restocked' then a.base_units else 0 end), 0)::integer,
      coalesce(sum(case when a.disposition = 'quarantined' then a.base_units else 0 end), 0)::integer
      into v_restocked, v_quarantined
      from public.medicine_return_allocations a
     where a.return_item_id = v_item.id;

    update public.medicine_return_items
       set restocked_units = v_restocked,
           quarantined_units = v_quarantined
     where id = v_item.id;
  end loop;

  -- Financial side. The original sale money fields are untouched. A credit note
  -- first offsets what is still owed (or, for a paid sale, is all refundable).
  v_effective := round(v_sale.outstanding - v_sale.returned_credit, 2);
  if v_effective < 0 then
    v_effective := 0;
  end if;

  v_credit := least(v_ret.refund_value, v_effective);
  v_refund := round(v_ret.refund_value - v_credit, 2);

  if v_credit > 0 and v_sale.customer_id is null and v_sale.credit_account_id is null then
    raise exception 'This sale has a balance but no customer or credit account to credit'
      using errcode = 'check_violation';
  end if;

  if v_refund > 0
     and p_refund_method is not null
     and p_refund_method not in ('cash', 'transfer', 'pos_card', 'wallet', 'store_credit') then
    raise exception 'Choose a valid refund method' using errcode = 'check_violation';
  end if;

  if v_credit > 0 then
    if v_sale.customer_id is not null then
      update public.customers
         set outstanding_debt = greatest(outstanding_debt - v_credit, 0)
       where id = v_sale.customer_id;
    end if;

    if v_sale.credit_account_id is not null then
      select * into v_account
        from public.credit_accounts c
       where c.id = v_sale.credit_account_id
         and c.branch_id = v_sale.branch_id
         for update;

      if not found then
        raise exception 'The credit account for this sale is not available'
          using errcode = 'check_violation';
      end if;
      if v_account.outstanding_balance + 0.001 < v_credit then
        raise exception 'The credit account balance is lower than the return credit'
          using errcode = 'check_violation';
      end if;

      perform set_config('pharmaflow.credit_write', '1', true);

      insert into public.credit_ledger (
        account_id, branch_id, kind, amount, balance_after, note, reference_id, recorded_by
      )
      values (
        v_account.id,
        v_sale.branch_id,
        'payment',
        v_credit,
        v_account.outstanding_balance - v_credit,
        'Return ' || v_ret.return_number || ' on ' || v_sale.receipt_number,
        v_ret.id,
        p_actor
      );

      update public.credit_accounts
         set outstanding_balance = v_account.outstanding_balance - v_credit,
             updated_at = now()
       where id = v_account.id;
    end if;

    update public.sales
       set returned_credit = returned_credit + v_credit
     where id = v_sale.id;
  end if;

  update public.medicine_returns
     set status = 'completed',
         reviewed_by = p_actor,
         reviewed_at = now(),
         completed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''),
         credit_applied = v_credit,
         refund_amount = v_refund,
         refund_method = case
           when v_refund <= 0 then 'not_refunded'
           else p_refund_method
         end,
         updated_at = now()
   where id = v_ret.id;

  insert into public.audit_events (branch_id, actor_id, action, description, metadata)
  values (
    v_ret.branch_id,
    p_actor,
    'return',
    'Return ' || v_ret.return_number || ' completed on ' || v_sale.receipt_number,
    jsonb_build_object(
      'return_id', v_ret.id,
      'sale_id', v_sale.id,
      'refund_value', v_ret.refund_value,
      'credit_applied', v_credit,
      'refund_amount', v_refund,
      'status', 'completed'
    )
  );
end;
$$;

-- --------------------------------------------------------------- create return
create or replace function public.pf_create_return(
  p_sale_id         uuid,
  p_items           jsonb,
  p_reason          text,
  p_note            text default null,
  p_refund_method   text default null,
  p_idempotency_key text default null
)
returns table (
  return_id      uuid,
  return_number  text,
  status         text,
  refund_value   numeric,
  credit_applied numeric,
  refund_amount  numeric,
  already_exists boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor     uuid;
  v_branch    uuid;
  v_sale      public.sales%rowtype;
  v_si        public.sale_items%rowtype;
  v_item      record;
  v_line      record;
  v_seen      uuid[] := array[]::uuid[];
  v_sale_item uuid;
  v_qty_text  text;
  v_qty       integer;
  v_reserved  integer;
  v_value     numeric := 0;
  v_factor    numeric;
  v_line_net  numeric;
  v_reserved_value numeric;
  v_return    uuid;
  v_number    text;
  v_seq       bigint;
  v_ret       public.medicine_returns%rowtype;
  v_existing  public.medicine_returns%rowtype;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;
  if not public.pf_is_staff() then
    raise exception 'Only pharmacy staff can record a return' using errcode = 'insufficient_privilege';
  end if;

  if p_reason is null or p_reason not in (
    'wrong_medicine', 'damaged', 'customer_changed_mind',
    'expired', 'recalled', 'other'
  ) then
    raise exception 'Choose a valid return reason' using errcode = 'check_violation';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one medicine to return' using errcode = 'check_violation';
  end if;

  -- Lock the sale before reading any line or previous return. Concurrent returns
  -- for the same sale serialise here rather than racing on the remaining units.
  select s.* into v_sale
    from public.sales s
   where s.id = p_sale_id
     for update;

  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.branch_id <> v_branch then
    raise exception 'That sale belongs to another pharmacy' using errcode = 'insufficient_privilege';
  end if;
  if v_sale.state in ('voided', 'refunded') then
    raise exception 'A voided or refunded sale cannot be returned' using errcode = 'check_violation';
  end if;

  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select r.* into v_existing
      from public.medicine_returns r
     where r.branch_id = v_branch
       and r.idempotency_key = btrim(p_idempotency_key);

    if found then
      if v_existing.sale_id <> p_sale_id then
        raise exception 'That return key is already in use' using errcode = 'check_violation';
      end if;

      return_id      := v_existing.id;
      return_number  := v_existing.return_number;
      status         := v_existing.status;
      refund_value   := v_existing.refund_value;
      credit_applied := v_existing.credit_applied;
      refund_amount  := v_existing.refund_amount;
      already_exists := true;
      return next;
      return;
    end if;
  end if;

  -- First pass: validate every line and compute its proportional value before
  -- writing the header. Nothing is written if any line is invalid.
  for v_item in select value as j from jsonb_array_elements(p_items)
  loop
    v_sale_item := nullif(v_item.j ->> 'sale_item_id', '')::uuid;
    if v_sale_item is null then
      raise exception 'A return line is missing its sale line' using errcode = 'check_violation';
    end if;
    if v_sale_item = any(v_seen) then
      raise exception 'The same sale line appears twice in this return' using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_sale_item;

    v_qty_text := v_item.j ->> 'quantity';
    if v_qty_text is null or v_qty_text !~ '^[0-9]+$' then
      raise exception 'Return quantity must be a whole number greater than zero'
        using errcode = 'check_violation';
    end if;
    v_qty := v_qty_text::integer;
    if v_qty <= 0 then
      raise exception 'Return quantity must be greater than zero' using errcode = 'check_violation';
    end if;

    select si.* into v_si
      from public.sale_items si
     where si.id = v_sale_item
       and si.sale_id = v_sale.id;

    if not found then
      raise exception 'A return line does not belong to this sale' using errcode = 'check_violation';
    end if;

    select coalesce(sum(ri.quantity), 0)::integer into v_reserved
      from public.medicine_return_items ri
      join public.medicine_returns r on r.id = ri.return_id
     where ri.sale_item_id = v_si.id
       and r.status in ('pending_review', 'completed');

    if v_qty > (v_si.quantity - v_reserved) then
      raise exception 'Only % of % may still be returned',
        greatest(v_si.quantity - v_reserved, 0), v_si.medicine_name
        using errcode = 'check_violation';
    end if;

    -- The line's share of the actual sale total, so a discount is not refunded
    -- as if it had never been given. Rounding is per line and checked against
    -- the remaining sale value below.
    v_factor := case when v_sale.subtotal > 0 then v_sale.total / v_sale.subtotal else 0 end;
    v_line_net := round(v_si.line_total * v_factor, 2);
    v_value := v_value + round(v_line_net * v_qty / v_si.quantity, 2);
  end loop;

  select coalesce(sum(r.refund_value), 0)
    into v_reserved_value
    from public.medicine_returns r
   where r.sale_id = v_sale.id
     and r.status in ('pending_review', 'completed');

  if v_reserved_value + v_value > v_sale.total + 0.01 then
    raise exception 'The return value would exceed the sale total'
      using errcode = 'check_violation';
  end if;

  -- Number generation is serialised on the branch, so two returns created at the
  -- same moment cannot mint the same return number.
  perform pg_advisory_xact_lock(hashtextextended(v_branch::text || ':returns', 0));
  v_seq := nextval('public.medicine_return_number_seq');
  v_number := 'RT-' || to_char(current_date, 'YYYY') || '-' ||
              repeat('0', greatest(0, 6 - length(v_seq::text))) || v_seq::text;

  insert into public.medicine_returns (
    branch_id, sale_id, return_number, status, reason, note, idempotency_key, requested_by
  )
  values (
    v_branch, v_sale.id, v_number, 'pending_review', p_reason,
    btrim(coalesce(p_note, '')), nullif(btrim(coalesce(p_idempotency_key, '')), ''), v_actor
  )
  returning id into v_return;

  for v_item in select value as j from jsonb_array_elements(p_items)
  loop
    v_sale_item := (v_item.j ->> 'sale_item_id')::uuid;
    v_qty := (v_item.j ->> 'quantity')::integer;

    select si.* into v_si
      from public.sale_items si
     where si.id = v_sale_item;

    v_factor := case when v_sale.subtotal > 0 then v_sale.total / v_sale.subtotal else 0 end;
    v_line_net := round(v_si.line_total * v_factor, 2);

    insert into public.medicine_return_items (
      return_id, sale_item_id, medicine_id, quantity, base_units_total,
      unit_price, line_total, return_value
    )
    values (
      v_return, v_si.id, v_si.medicine_id, v_qty,
      v_qty * v_si.unit_multiplier,
      v_si.unit_price,
      round(v_si.unit_price * v_qty, 2),
      round(v_line_net * v_qty / v_si.quantity, 2)
    );
  end loop;

  update public.medicine_returns
     set refund_value = v_value,
         updated_at = now()
   where id = v_return;

  if public.pf_is_owner() then
    perform public.pf_apply_return(v_return, v_actor, true, null, p_refund_method);
  else
    insert into public.audit_events (branch_id, actor_id, action, description, metadata)
    values (
      v_branch, v_actor, 'return',
      'Return ' || v_number || ' requested on ' || v_sale.receipt_number,
      jsonb_build_object('return_id', v_return, 'sale_id', v_sale.id, 'status', 'pending_review')
    );
  end if;

  select r.* into v_ret
    from public.medicine_returns r
   where r.id = v_return;

  return_id      := v_ret.id;
  return_number  := v_ret.return_number;
  status         := v_ret.status;
  refund_value   := v_ret.refund_value;
  credit_applied := v_ret.credit_applied;
  refund_amount  := v_ret.refund_amount;
  already_exists := false;
  return next;
end;
$$;

-- --------------------------------------------------------------- review return
create or replace function public.pf_review_return(
  p_return_id     uuid,
  p_approve       boolean,
  p_note          text default null,
  p_refund_method text default null
)
returns table (
  return_id      uuid,
  return_number  text,
  status         text,
  refund_value   numeric,
  credit_applied numeric,
  refund_amount  numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_ret   public.medicine_returns%rowtype;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  if public.pf_current_branch() is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;
  if not public.pf_is_owner() then
    raise exception 'Only an owner can approve or reject a return'
      using errcode = 'insufficient_privilege';
  end if;

  if p_approve is null then
    raise exception 'Choose whether to approve or reject the return'
      using errcode = 'check_violation';
  end if;

  perform public.pf_apply_return(
    p_return_id, v_actor, p_approve, p_note, p_refund_method
  );

  select r.* into v_ret
    from public.medicine_returns r
   where r.id = p_return_id;

  return_id      := v_ret.id;
  return_number  := v_ret.return_number;
  status         := v_ret.status;
  refund_value   := v_ret.refund_value;
  credit_applied := v_ret.credit_applied;
  refund_amount  := v_ret.refund_amount;
  return next;
end;
$$;

-- ----------------------------------------------------------- update sale price
create or replace function public.pf_update_medicine_price(
  p_medicine_id  uuid,
  p_unit_key     text,
  p_new_price    numeric,
  p_expected_price numeric,
  p_reason       text default null
)
returns table (
  medicine_id uuid,
  unit_key    text,
  old_price   numeric,
  new_price   numeric,
  changed_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid;
  v_branch   uuid;
  v_med      public.medicines%rowtype;
  v_unit     jsonb;
  v_mult     integer;
  v_old      numeric;
  v_new      numeric;
  v_name     text;
  v_changed  timestamptz;
  v_cost     numeric;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;

  -- Pricing is an owner decision, matching `medicines_guard_units` and the
  -- pricing-approval rules already in the schema.
  if not public.pf_is_owner() then
    raise exception 'Only an owner can change a selling price'
      using errcode = 'insufficient_privilege';
  end if;

  if p_unit_key is null or btrim(p_unit_key) = '' then
    raise exception 'Choose a unit to reprice' using errcode = 'check_violation';
  end if;
  if p_new_price is null
     or p_new_price::text in ('NaN', 'Infinity', '-Infinity')
     or p_new_price < 0 then
    raise exception 'Selling price must be a finite number of zero or more'
      using errcode = 'check_violation';
  end if;
  if p_new_price <> round(p_new_price, 2) then
    raise exception 'Selling price supports at most two decimal places'
      using errcode = 'check_violation';
  end if;
  if p_new_price <= 0 then
    raise exception 'Selling price must be greater than zero' using errcode = 'check_violation';
  end if;
  if p_expected_price is null then
    raise exception 'The current price is required to check for a stale edit'
      using errcode = 'check_violation';
  end if;

  select m.* into v_med
    from public.medicines m
   where m.id = p_medicine_id
     for update;

  if not found then
    raise exception 'Product not found' using errcode = 'no_data_found';
  end if;
  if v_med.branch_id <> v_branch then
    raise exception 'That product belongs to another pharmacy' using errcode = 'insufficient_privilege';
  end if;

  select u into v_unit
    from jsonb_array_elements(v_med.units) u
   where u ->> 'key' = p_unit_key;

  if not found then
    raise exception '"%" is not a unit of %', p_unit_key, v_med.name
      using errcode = 'check_violation';
  end if;
  if v_unit ->> 'multiplier' is null
     or (v_unit ->> 'multiplier') !~ '^[0-9]+$'
     or (v_unit ->> 'multiplier')::integer <= 0 then
    raise exception 'That unit has an invalid conversion factor'
      using errcode = 'check_violation';
  end if;

  v_mult := (v_unit ->> 'multiplier')::integer;
  v_old  := round(coalesce((v_unit ->> 'sellingPrice')::numeric, 0), 2);
  v_new  := round(p_new_price, 2);
  v_name := coalesce(nullif(v_unit ->> 'name', ''), p_unit_key);

  if abs(v_old - round(p_expected_price, 2)) > 0.01 then
    raise exception
      'The price of % · % changed from ₦% to ₦% while this form was open. Reload before saving.',
      v_med.name, v_name, round(p_expected_price, 2), v_old
      using errcode = 'check_violation';
  end if;
  if v_new = v_old then
    raise exception 'The price is unchanged' using errcode = 'check_violation';
  end if;

  -- Cost is read inside the definer function, never returned. The rule matches
  -- the demo domain: a unit may not be sold at or below its purchase cost. A
  -- zero cost is treated as "not recorded", not as free stock.
  v_cost := round(v_med.cost_per_base_unit * v_mult, 2);
  if v_med.cost_per_base_unit > 0 and v_new <= v_cost then
    raise exception 'Price must be above the cost of one % (₦%)', v_name, v_cost
      using errcode = 'check_violation';
  end if;

  update public.medicines
     set units = (
           select jsonb_agg(
             case
               when u ->> 'key' = p_unit_key
                 then jsonb_set(u, '{sellingPrice}', to_jsonb(v_new), true)
               else u
             end
             order by ord
           )
           from jsonb_array_elements(v_med.units) with ordinality as t(u, ord)
         ),
         price_per_base_unit = case when v_mult = 1 then v_new else price_per_base_unit end,
         updated_at = now()
   where id = v_med.id;

  insert into public.medicine_price_changes (
    branch_id, medicine_id, unit_key, unit_name, unit_multiplier,
    old_price, new_price, reason, changed_by
  )
  values (
    v_branch, v_med.id, p_unit_key, v_name, v_mult,
    v_old, v_new, btrim(coalesce(p_reason, '')), v_actor
  );

  insert into public.audit_events (branch_id, actor_id, action, description, metadata)
  values (
    v_branch, v_actor, 'price_change',
    v_med.name || ' · ' || v_name || ': ₦' || v_old || ' → ₦' || v_new,
    jsonb_build_object(
      'medicine_id', v_med.id,
      'unit_key', p_unit_key,
      'old', v_old,
      'next', v_new
    )
  );

  select now() into v_changed;

  medicine_id := v_med.id;
  unit_key    := p_unit_key;
  old_price   := v_old;
  new_price   := v_new;
  changed_at  := v_changed;
  return next;
end;
$$;

-- --------------------------------------------------------- repayment netting
--
-- Same contract as 20261018120000, with one change: the amount a customer still
-- owes is `outstanding - returned_credit`. The sale's original total and
-- outstanding remain on the record; the accepted return credit is a separate
-- linked adjustment. A repayment moves `outstanding` down by the amount paid,
-- and the effective figure (returned to the caller) is net of the credit note.
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
  v_effective numeric;
  v_new_paid numeric;
  v_new_out  numeric;
  v_new_eff  numeric;
  v_state    public.sale_state;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy' using errcode = 'insufficient_privilege';
  end if;

  if not public.pf_is_staff() then
    raise exception 'Only pharmacy staff can record a repayment' using errcode = 'insufficient_privilege';
  end if;

  if p_sale_id is null then
    raise exception 'No sale was given' using errcode = 'check_violation';
  end if;
  if p_method is null then
    raise exception 'Choose a repayment method' using errcode = 'check_violation';
  end if;
  if p_method = 'split' then
    raise exception 'Record each split part as its own repayment — one method per repayment'
      using errcode = 'check_violation';
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount <= 0 then
    raise exception 'A repayment must be greater than zero' using errcode = 'check_violation';
  end if;

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
  if v_sale.customer_id is null then
    raise exception 'This sale has no customer on it — repayments are recorded against a named customer'
      using errcode = 'check_violation';
  end if;

  v_effective := round(v_sale.outstanding - v_sale.returned_credit, 2);
  if v_effective <= 0 then
    raise exception 'Nothing is outstanding on this sale' using errcode = 'check_violation';
  end if;
  if v_amount > v_effective then
    raise exception 'A repayment cannot exceed the outstanding balance of %', v_effective
      using errcode = 'check_violation';
  end if;

  v_new_paid := round(v_sale.amount_paid + v_amount, 2);
  -- Move the original outstanding down, not the net figure: `returned_credit`
  -- remains the permanent record of the accepted return.
  v_new_out  := round(v_sale.outstanding - v_amount, 2);
  v_new_eff  := round(v_effective - v_amount, 2);
  v_state    := case when v_new_eff <= 0.005 then 'paid'::public.sale_state
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
  outstanding    := v_new_eff;
  state          := v_state;
  return next;
end;
$$;

-- ------------------------------------------------------------------- RLS
alter table public.medicine_returns            enable row level security;
alter table public.medicine_return_items       enable row level security;
alter table public.medicine_return_allocations enable row level security;
alter table public.medicine_price_changes      enable row level security;

drop policy if exists medicine_returns_read on public.medicine_returns;
create policy medicine_returns_read on public.medicine_returns
  for select to authenticated
  using (branch_id = public.pf_current_branch());

drop policy if exists medicine_return_items_read on public.medicine_return_items;
create policy medicine_return_items_read on public.medicine_return_items
  for select to authenticated
  using (
    exists (
      select 1 from public.medicine_returns r
       where r.id = return_id
         and r.branch_id = public.pf_current_branch()
    )
  );

drop policy if exists medicine_return_allocations_read on public.medicine_return_allocations;
create policy medicine_return_allocations_read on public.medicine_return_allocations
  for select to authenticated
  using (
    exists (
      select 1
        from public.medicine_return_items ri
        join public.medicine_returns r on r.id = ri.return_id
       where ri.id = return_item_id
         and r.branch_id = public.pf_current_branch()
    )
  );

drop policy if exists medicine_price_changes_read on public.medicine_price_changes;
create policy medicine_price_changes_read on public.medicine_price_changes
  for select to authenticated
  using (branch_id = public.pf_current_branch());

-- --------------------------------------------------------------- privileges
--
-- Return and price rows are written only through the RPCs. Read access is
-- branch-scoped by RLS. There is no INSERT/UPDATE/DELETE policy on the return or
-- price ledger, so even a caller with a table privilege cannot forge a return.
revoke all on public.medicine_returns, public.medicine_return_items,
  public.medicine_return_allocations, public.medicine_price_changes
  from anon;

grant select on public.medicine_returns, public.medicine_return_items,
  public.medicine_return_allocations, public.medicine_price_changes
  to authenticated;

-- Protect the aggregate return credit from a direct owner UPDATE while leaving
-- the existing void path (state/status fields) writable, as it was before.
revoke update on public.sales from authenticated;
grant update (
  state, status_reason, status_changed_by, status_changed_at
) on public.sales to authenticated;

revoke execute on function public.pf_guard_void_with_returns() from public;
revoke execute on function public.pf_guard_void_with_returns() from anon;
revoke execute on function public.pf_guard_void_with_returns() from authenticated;

revoke execute on function public.pf_sale_returnable(uuid) from public;
revoke execute on function public.pf_sale_returnable(uuid) from anon;
grant execute on function public.pf_sale_returnable(uuid) to authenticated;

revoke execute on function public.pf_create_return(
  uuid, jsonb, text, text, text, text
) from public;
revoke execute on function public.pf_create_return(
  uuid, jsonb, text, text, text, text
) from anon;
grant execute on function public.pf_create_return(
  uuid, jsonb, text, text, text, text
) to authenticated;

revoke execute on function public.pf_review_return(
  uuid, boolean, text, text
) from public;
revoke execute on function public.pf_review_return(
  uuid, boolean, text, text
) from anon;
grant execute on function public.pf_review_return(
  uuid, boolean, text, text
) to authenticated;

revoke execute on function public.pf_update_medicine_price(
  uuid, text, numeric, numeric, text
) from public;
revoke execute on function public.pf_update_medicine_price(
  uuid, text, numeric, numeric, text
) from anon;
grant execute on function public.pf_update_medicine_price(
  uuid, text, numeric, numeric, text
) to authenticated;

-- Internal: callable only by the two owner-facing RPCs (the owner of the
-- function retains EXECUTE; PUBLIC does not).
revoke execute on function public.pf_apply_return(
  uuid, uuid, boolean, text, text
) from public;
revoke execute on function public.pf_apply_return(
  uuid, uuid, boolean, text, text
) from anon;
revoke execute on function public.pf_apply_return(
  uuid, uuid, boolean, text, text
) from authenticated;

comment on table public.medicine_returns is
  'A customer return is a separate linked transaction. The original sale, its lines, receipt number and payments are not edited. A partial return never changes the sale state.';

comment on table public.medicine_return_allocations is
  'Per-lot restoration or quarantine record for one return line. Restocked units are added back to the original batch; quarantined units are not sellable stock and remain here for review.';

comment on function public.pf_create_return(
  uuid, jsonb, text, text, text, text
) is
  'Create a customer return against a completed sale in the caller''s branch. Validates every sale line and remaining quantity under a sale row lock. Owners complete the return immediately; attendants create a pending_review record. Idempotent when p_idempotency_key repeats. Never edits the sale or its lines.';

comment on function public.pf_review_return(
  uuid, boolean, text, text
) is
  'Owner-only approval or rejection of a pending return. Approval restores accepted units to their original batches, quarantines damaged/expired/recalled/unprovenanced units, applies a credit against outstanding first, records any refund due, and audits the decision. Rejection changes no stock and no money.';

comment on function public.pf_update_medicine_price(
  uuid, text, numeric, numeric, text
) is
  'Owner-only authoritative selling-price update for one medicine unit in the caller''s branch. Requires the expected current price to reject stale concurrent updates, refuses non-positive/invalid prices and prices at or below cost, updates only units[].sellingPrice (and price_per_base_unit for the base unit), writes an append-only price-change row and an audit event. Never changes cost, batches, expiry or stock.';
