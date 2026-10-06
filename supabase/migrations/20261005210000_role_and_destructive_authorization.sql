-- ============================================================================
-- Phase 0d: role integrity, attribution integrity, destructive authorization
-- ============================================================================
--
-- Additive and self-contained. No file above this one is edited, the chain still
-- applies to a fresh database, and every statement here is re-runnable.
--
-- ## Why the FOR ALL policies are replaced rather than supplemented
--
-- RLS policies are permissive and are OR-ed together. Adding an owner-only
-- DELETE policy to a table that already has a `FOR ALL ... TO authenticated`
-- policy changes nothing: the FOR ALL policy already permits the delete, so the
-- pair reduces to "anyone may delete". Restriction therefore requires DROPPING
-- the FOR ALL policy and restating the commands individually.
--
-- That is what this file does for the tables where an attendant could destroy
-- tenant data. Confirmed before the fix: DELETE was accepted on medicines,
-- medicine_batches, stock_receipts, customers, customer_orders, order_items,
-- medicine_requests and notifications.
--
-- ## What stays staff-writable, and why
--
-- DELETE is owner-gated on records a pharmacy would be damaged by losing:
-- catalogue, stock lots, receipts, customers and orders. A receipt carries the
-- cost of what was bought, so deleting one is deleting a financial record, not a
-- queue entry.
--
-- Two exceptions keep DELETE available to staff, because there it is a normal
-- part of the job rather than data destruction:
--
--   - `medicine_requests`: a request entered in error should be withdrawable by
--     whoever entered it, without an owner round trip. This is the Demand Radar
--     source, so it stays editable.
--   - `notifications`: scoped to the caller's own rows. A user clearing their own
--     notification list is not tampering with anyone else's data.
--
-- INSERT and UPDATE are unchanged in spirit: a counter still records receipts,
-- adjusts stock and takes orders. Only the destructive command is restricted.
--
-- ## Attribution: sales.attendant_id (B4)
--
-- `sales_staff_write` checked only `branch_id = pf_current_branch()`, so
-- `attendant_id` was whatever the client sent. Reproduced before this fix: an
-- assistant recorded a sale attributed to the owner, which falsifies the per-staff
-- sales totals the owner dashboard reads.
--
-- The INSERT policy now requires `attendant_id = auth.uid()`, matching the rule
-- `audit_events` already follows via `actor_id = auth.uid()`. The audit log got
-- this right and `sales` did not; they are now consistent.
--
-- `audit_events` is deliberately NOT changed. It is already append-only in
-- practice and already binds its actor to the caller.
--
-- ## Cost on INSERT (B3)
--
-- `pf_guard_cost_write` was attached as `BEFORE UPDATE` only, so nothing checked
-- who supplied a purchase cost when a row was first written. Reproduced before
-- this fix: an assistant inserted a medicine with cost 777 / price 900 and it was
-- stored. `medicines_price_above_cost` is a data-integrity constraint, not an
-- authorization control, and it did not object.
--
-- The guard becomes `BEFORE INSERT OR UPDATE`. Zero is accepted from a non-owner,
-- because that is the legitimate state of a product or lot nobody has priced yet
-- (both columns are `not null default 0`, and `pf_require_owner_to_price` owns the
-- later pricing step). A non-zero cost from a non-owner is refused.
--
-- ============================================================================

-- ====================================== 1. cost guard also covers first write

create or replace function public.pf_guard_cost_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A NULL auth.uid() is the trusted server context (SQL editor, migration,
  -- service_role). Matches pf_guard_profile_privileges.
  if auth.uid() is null then
    return new;
  end if;

  -- On INSERT there is no OLD row, so this cannot be written as a single
  -- comparison. The two cases are handled separately rather than relying on
  -- OLD being NULL, which would raise rather than evaluate.
  if tg_op = 'INSERT' then
    -- 0 is a legitimate unpriced state; anything above it is a purchase price
    -- and belongs to an owner.
    if new.cost_per_base_unit is not null
       and new.cost_per_base_unit <> 0
       and not pf_is_owner() then
      raise exception 'Only an owner can set a purchase cost'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.cost_per_base_unit is distinct from old.cost_per_base_unit
     and not pf_is_owner() then
    raise exception 'Only an owner can set or change a purchase cost'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- SECURITY DEFINER so the guard can read the cost column it is protecting; a
-- non-owner holds no SELECT on it, and an INVOKER trigger would fail on its own
-- privilege rather than on the rule it exists to enforce.

drop trigger if exists medicines_guard_cost on medicines;
create trigger medicines_guard_cost
  before insert or update on medicines
  for each row execute function public.pf_guard_cost_write();

drop trigger if exists batches_guard_cost on medicine_batches;
create trigger batches_guard_cost
  before insert or update on medicine_batches
  for each row execute function public.pf_guard_cost_write();

-- ============================================ 2. sales attribution is the caller's

drop policy if exists sales_staff_write on sales;

drop policy if exists sales_staff_insert on sales;
create policy sales_staff_insert on sales
  for insert to authenticated
  with check (
    branch_id = pf_current_branch()
    -- B4: an attendant cannot record a sale against somebody else's name.
    and attendant_id = auth.uid()
  );

-- Void/refund stays owner-only and branch-scoped, unchanged in substance.
drop policy if exists sales_owner_void on sales;
create policy sales_owner_void on sales
  for update to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists sales_read on sales;
create policy sales_read on sales
  for select to authenticated
  using (
    branch_id = pf_current_branch()
    or customer_id in (
      select c.id from customers c where c.auth_user_id = auth.uid()
    )
  );

-- ================================= 3. destructive commands become owner-only

-- Catalogue. A counter still creates and edits products; deleting one is the
-- owner's call.
drop policy if exists medicines_staff_write on medicines;

drop policy if exists medicines_staff_insert on medicines;
create policy medicines_staff_insert on medicines
  for insert to authenticated
  with check (branch_id = pf_current_branch());

drop policy if exists medicines_staff_update on medicines;
create policy medicines_staff_update on medicines
  for update to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists medicines_owner_delete on medicines;
create policy medicines_owner_delete on medicines
  for delete to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

-- Stock lots. Deleting a lot disposes of real stock; the movement ledger records
-- it, but the decision belongs to the owner.
drop policy if exists batches_staff_write on medicine_batches;

drop policy if exists batches_staff_insert on medicine_batches;
create policy batches_staff_insert on medicine_batches
  for insert to authenticated
  with check (branch_id = pf_current_branch());

drop policy if exists batches_staff_update on medicine_batches;
create policy batches_staff_update on medicine_batches
  for update to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists batches_owner_delete on medicine_batches;
create policy batches_owner_delete on medicine_batches
  for delete to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

-- Receipts carry what was paid, so they are a financial record rather than a
-- queue entry. Staff still record receiving; only deletion is restricted.
drop policy if exists receipts_staff_write on stock_receipts;

drop policy if exists receipts_staff_insert on stock_receipts;
create policy receipts_staff_insert on stock_receipts
  for insert to authenticated
  with check (branch_id = pf_current_branch());

drop policy if exists receipts_staff_update on stock_receipts;
create policy receipts_staff_update on stock_receipts
  for update to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists receipts_owner_delete on stock_receipts;
create policy receipts_owner_delete on stock_receipts
  for delete to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists receipts_read on stock_receipts;
create policy receipts_read on stock_receipts
  for select to authenticated
  using (branch_id = pf_current_branch());

-- Customers have sales, credit and chronic-medication history attached. An
-- attendant records them; an owner removes them.
drop policy if exists customers_staff_write on customers;

drop policy if exists customers_staff_insert on customers;
create policy customers_staff_insert on customers
  for insert to authenticated
  with check (branch_id = pf_current_branch() or auth_user_id = auth.uid());

drop policy if exists customers_staff_update on customers;
create policy customers_staff_update on customers
  for update to authenticated
  using (branch_id = pf_current_branch() or auth_user_id = auth.uid())
  with check (branch_id = pf_current_branch() or auth_user_id = auth.uid());

drop policy if exists customers_owner_delete on customers;
create policy customers_owner_delete on customers
  for delete to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists customers_read on customers;
create policy customers_read on customers
  for select to authenticated
  using (
    auth_user_id = auth.uid()
    or branch_id = pf_current_branch()
  );

-- Customer orders and their lines.
drop policy if exists orders_staff_write on customer_orders;

drop policy if exists orders_staff_insert on customer_orders;
create policy orders_staff_insert on customer_orders
  for insert to authenticated
  with check (branch_id = pf_current_branch());

drop policy if exists orders_staff_update on customer_orders;
create policy orders_staff_update on customer_orders
  for update to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists orders_owner_delete on customer_orders;
create policy orders_owner_delete on customer_orders
  for delete to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists orders_read on customer_orders;
create policy orders_read on customer_orders
  for select to authenticated
  using (
    branch_id = pf_current_branch()
    or customer_id in (
      select c.id from customers c where c.auth_user_id = auth.uid()
    )
  );

drop policy if exists order_items_staff_write on order_items;

drop policy if exists order_items_staff_insert on order_items;
create policy order_items_staff_insert on order_items
  for insert to authenticated
  with check (
    exists (select 1 from customer_orders o where o.id = order_items.order_id)
  );

drop policy if exists order_items_staff_update on order_items;
create policy order_items_staff_update on order_items
  for update to authenticated
  using (
    exists (select 1 from customer_orders o where o.id = order_items.order_id)
  )
  with check (
    exists (select 1 from customer_orders o where o.id = order_items.order_id)
  );

drop policy if exists order_items_owner_delete on order_items;
create policy order_items_owner_delete on order_items
  for delete to authenticated
  using (pf_is_owner() and exists (
    select 1 from customer_orders o where o.id = order_items.order_id
  ));

drop policy if exists order_items_read on order_items;
create policy order_items_read on order_items
  for select to authenticated
  using (
    exists (select 1 from customer_orders o where o.id = order_items.order_id)
  );

-- Medicine requests: staff DELETE stays, because withdrawing a request entered in
-- error is the counter's own job and this is the Demand Radar source.
drop policy if exists requests_staff_write on medicine_requests;

drop policy if exists requests_staff_insert on medicine_requests;
create policy requests_staff_insert on medicine_requests
  for insert to authenticated
  with check (branch_id = pf_current_branch());

drop policy if exists requests_staff_update on medicine_requests;
create policy requests_staff_update on medicine_requests
  for update to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists requests_staff_delete on medicine_requests;
create policy requests_staff_delete on medicine_requests
  for delete to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists requests_read on medicine_requests;
create policy requests_read on medicine_requests
  for select to authenticated
  using (branch_id = pf_current_branch());

-- Notifications: a user may clear their own list, nobody else's.
drop policy if exists notifications_staff_write on notifications;

drop policy if exists notifications_staff_insert on notifications;
create policy notifications_staff_insert on notifications
  for insert to authenticated
  with check (branch_id = pf_current_branch());

drop policy if exists notifications_staff_update on notifications;
create policy notifications_staff_update on notifications
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

drop policy if exists notifications_staff_delete on notifications;
create policy notifications_staff_delete on notifications
  for delete to authenticated
  using (recipient_id = auth.uid());

drop policy if exists notifications_read on notifications;
create policy notifications_read on notifications
  for select to authenticated
  using (
    recipient_id = auth.uid()
    or (recipient_id is null and branch_id = pf_current_branch())
  );

-- ================================================================ 4. assertions

comment on function public.pf_guard_cost_write() is
  'BEFORE INSERT OR UPDATE on medicines and medicine_batches. Refuses a non-zero purchase cost from a non-owner on first write, and any cost change by a non-owner. Zero is the legitimate unpriced state.';

comment on policy sales_staff_insert on sales is
  'INSERT requires attendant_id = auth.uid(). An attendant cannot record a sale against another person''s name. Same rule audit_events already applies via actor_id.';

comment on policy medicines_owner_delete on medicines is
  'DELETE is owner-only. The previous FOR ALL policy permitted any branch member to delete catalogue, stock lots, receipts, customers and orders; permissive policies OR together, so the restriction required dropping it rather than adding a narrower policy beside it.';
