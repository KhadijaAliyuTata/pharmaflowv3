-- ============================================================================
-- Phase 0 follow-up — stock ledger integrity, FEFO foundation, multi-branch
-- ----------------------------------------------------------------------------
-- Apply with:  supabase db push
--
-- Additive only. `20261002160000_initial_schema.sql` is left exactly as
-- committed; nothing here edits or replaces it. Every object is created with a
-- guard, so this file is safe to re-run.
--
-- Four defects are addressed:
--
--   1. `pf_check_credit_ledger_balance` was defined but no trigger invoked it,
--      so the ledger invariant was unenforced. (This trigger existed in the
--      pre-Phase-0 schema and was lost in that revision; restored here.)
--
--   2. `sale_items` had no link to `medicine_batches`, so a sale could not
--      record which lot it consumed. That blocks FEFO, expiry attribution,
--      recall tracing and batch-accurate depletion. `batch_id` is added as
--      NULLABLE so historical sales survive.
--
--   3. `stock_movements` was never written, while `medicines.total_quantity`
--      moved. The header claim that "every path that changes it must write a
--      movement" was not implemented. Movements are now derived from the batch
--      ledger by trigger, and the client is no longer permitted to insert them,
--      so the ledger has exactly one writer and cannot contain duplicates.
--
--   4. The schema had no way to express one user across many branches:
--      `profiles.branch_id` is a single nullable home branch and RLS reads it
--      directly. `branch_memberships` plus `pf_set_active_branch()` make the
--      active branch switchable without ever letting the client assert its own
--      tenant.
-- ============================================================================

-- ============================================ 1. credit ledger invariant
-- The function and its comment both exist at this point; only the trigger was
-- missing. Re-created here defensively so this migration is the fix on its own,
-- whether or not the earlier file has been applied.

drop trigger if exists credit_ledger_balance on credit_ledger;
create trigger credit_ledger_balance before insert on credit_ledger
  for each row execute function pf_check_credit_ledger_balance();

-- The original check compares the incoming `balance_after` against the account's
-- current balance, which catches a miscomputed row. It does not catch the other
-- half of the invariant: an owner can change `credit_accounts.outstanding_balance`
-- directly and leave the ledger describing a different figure. This trigger
-- closes that direction, so the account and its last ledger row can never drift.

create or replace function pf_check_credit_account_ledger()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  latest numeric;
begin
  select balance_after into latest
  from credit_ledger
  where account_id = new.id
  order by entry_at desc, id desc
  limit 1;

  -- No ledger row yet, so there is nothing to disagree with.
  if latest is null then
    return new;
  end if;

  if abs(latest - new.outstanding_balance) > 0.01 then
    raise exception
      'Account % balance (%) does not match its latest ledger entry (%)',
      new.id, new.outstanding_balance, latest
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists credit_accounts_ledger on credit_accounts;
create trigger credit_accounts_ledger before update on credit_accounts
  for each row execute function pf_check_credit_account_ledger();

-- ==================================================== 2. sale -> batch link
-- Nullable and ON DELETE SET NULL on purpose:
--   * historical sales predate this column and must remain valid;
--   * deleting or merging a lot must not delete the record that it was sold.
-- A traceable sale keeps its `batch_id`; a sale predating the column, or one
-- whose lot was removed, reads NULL and is reported as untraced rather than
-- wrong.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sale_items_batch_id_fkey'
  ) then
    alter table sale_items
      add column batch_id uuid references medicine_batches(id) on delete set null;
  end if;
end $$;

-- Tracing questions ("which lot was this?") filter and join on this.
create index if not exists sale_items_batch_idx on sale_items(batch_id)
  where batch_id is not null;

-- A line must not claim a lot belonging to a different product. Referential
-- integrity alone does not catch that: `batch_id` and `medicine_id` are two
-- independent foreign keys, so nothing stops a paracetamol line pointing at an
-- amoxicillin lot. Both columns are attacker-controlled, and a wrong pairing
-- would silently corrupt every expiry and recall report built on the link.
create or replace function pf_check_sale_item_batch()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  batch_medicine uuid;
begin
  if new.batch_id is null then
    return new;
  end if;

  select medicine_id into batch_medicine
  from medicine_batches where id = new.batch_id;

  -- The FK guarantees the row exists, but a null here would mean it was deleted
  -- between the check and the insert. Fail rather than store a broken link.
  if batch_medicine is null then
    raise exception 'Batch % no longer exists', new.batch_id
      using errcode = 'foreign_key_violation';
  end if;

  if batch_medicine <> new.medicine_id then
    raise exception
      'Batch % belongs to a different product than line item %', new.batch_id, new.medicine_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists sale_items_batch_check on sale_items;
create trigger sale_items_batch_check before insert or update on sale_items
  for each row execute function pf_check_sale_item_batch();

-- ===================================================== 3. stock movement ledger
-- Accounting model
-- ----------------
-- `medicine_batches` is the only stock ledger that exists, and it is the right
-- one: a lot carries quantity, expiry, cost and recall, all of which a movement
-- log cannot reconstruct. So movements are DERIVED from batch changes rather than
-- written alongside them. That gives one source of truth, and it means a sale, a
-- receipt, an adjustment, a disposal or a transfer all produce a movement for
-- free — as long as they change a batch.
--
-- `medicines.total_quantity` is already derived from batches by
-- `pf_guard_total_quantity`, so the two stay in step by construction.
--
-- Actor. `performed_by` was NOT NULL, but a trigger cannot know who caused a
-- batch edit that ran outside a request (a migration, a seed, a service-role
-- job). Forcing a value would attribute those to an arbitrary profile, which is
-- worse than admitting there is no actor. It is made nullable and NULL is
-- defined as "written by the database, no authenticated actor". `auth.uid()` is
-- used whenever a request is behind the write.

alter table stock_movements
  alter column performed_by drop not null;

alter table stock_movements
  add column if not exists batch_id uuid references medicine_batches(id) on delete set null;

create index if not exists movements_batch_idx on stock_movements(batch_id)
  where batch_id is not null;

-- One movement per batch change, whatever the caller is.
create or replace function pf_record_stock_movement()
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
      else 'adjustment'::movement_kind
    end,
    changed,
    coalesce(new.quantity, 0),
    auth.uid(),
    case
      when tg_op = 'INSERT' then 'Batch received'
      when tg_op = 'DELETE' then 'Batch ' || lot || ' deleted'
      else 'Batch quantity adjusted'
    end,
    null
  );

  return null;
end;
$$;

drop trigger if exists batches_record_movement on medicine_batches;
create trigger batches_record_movement
  after insert or update of quantity or delete on medicine_batches
  for each row execute function pf_record_stock_movement();

-- Sale depletion. `sale_items.batch_id` names the lot consumed; the quantity is
-- decremented there and the trigger above turns that into the movement. FEFO —
-- choosing WHICH lot when several qualify — is deliberately not implemented; the
-- caller supplies `batch_id` and the database records what happened.
create or replace function pf_apply_sale_item_stock(p_sale_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item sale_items%rowtype;
begin
  select * into item from sale_items where id = p_sale_item_id;

  if not found then
    raise exception 'Sale item % does not exist', p_sale_item_id
      using errcode = 'no_data_found';
  end if;

  if item.batch_id is null then
    return;  -- untraced sale; nothing to decrement
  end if;

  update medicine_batches
  set quantity = quantity - item.base_units_total
  where id = item.batch_id
    and quantity >= item.base_units_total;

  -- Zero rows means the lot could not cover the line. `pf_sync_total_quantity`
  -- has already recomputed the aggregate by this point, so raising here leaves
  -- the sale in place but refuses to over-commit stock.
  if not found then
    raise exception 'Batch % does not hold % units for this sale line',
      item.batch_id, item.base_units_total
      using errcode = 'check_violation';
  end if;
end;
$$;

-- One writer only. `movements_staff_write` let any authenticated user insert an
-- arbitrary movement, which is how duplicate and invented rows got in. The
-- ledger is now derived, so the client loses INSERT but keeps SELECT — reports
-- and the stock list still read it directly.
drop policy if exists movements_staff_write on stock_movements;

revoke insert on stock_movements from authenticated;

-- ====================================================== 4. multi-branch model
-- `profiles.branch_id` is the tenant RLS reads through `pf_current_branch()`,
-- and it holds exactly one branch. That is a fine "home branch" and it cannot
-- express "this owner runs three counters". This table is the missing piece:
-- membership is many-to-many, and `branch_id` becomes the *active* selection.
--
-- It deliberately carries no pharmacy/owner id. `branches` is the tenant root and
-- `is_main_hub` already marks the primary site, so introducing a second tenancy
-- level now would mean migrating 14 `branch_id` columns later.

create table if not exists branch_memberships (
  user_id     uuid not null references profiles(id) on delete cascade,
  branch_id   uuid not null references branches(id) on delete cascade,
  role        staff_role not null default 'assistant',
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (user_id, branch_id)
);

-- The switcher's only lookup: "which counters can this person open?"
create index if not exists branch_memberships_branch_idx on branch_memberships(branch_id);

create index if not exists branch_memberships_default_idx on branch_memberships(user_id)
  where is_default;

alter table branch_memberships enable row level security;

-- A user reads their own memberships, and staff read their branch's roster so a
-- manager can see who works the counter. No branch predicate is applied to the
-- membership list itself, because resolving "what may I switch to" has to happen
-- before a branch is active.
drop policy if exists memberships_self_read on branch_memberships;
create policy memberships_self_read on branch_memberships for select to authenticated
  using (user_id = auth.uid());

drop policy if exists memberships_branch_read on branch_memberships;
create policy memberships_branch_read on branch_memberships for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists memberships_owner_write on branch_memberships;
create policy memberships_owner_write on branch_memberships for all to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

grant select on branch_memberships to authenticated;
grant insert, update, delete on branch_memberships to authenticated;

-- Seed each existing profile's current branch into a membership, so switching
-- does not lock anyone out of the branch they already work in. Idempotent.
insert into branch_memberships (user_id, branch_id, role, is_default)
select p.id, p.branch_id, p.role, true
from profiles p
where p.branch_id is not null and not p.is_customer
on conflict (user_id, branch_id) do nothing;

-- Switch the active branch.
--
-- The client cannot simply `update profiles set branch_id = ...`: that would be
-- asserting its own tenant, and `pf_guard_profile_privileges` blocks it. This
-- function is the only sanctioned path and it refuses any branch the caller has
-- no membership of, so the reachable set is exactly the membership table.
create or replace function pf_set_active_branch(p_branch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role staff_role;
begin
  if p_branch_id is null then
    raise exception 'Pick a branch' using errcode = 'invalid_parameter_value';
  end if;

  select role into target_role
  from branch_memberships
  where user_id = auth.uid() and branch_id = p_branch_id;

  if target_role is null then
    raise exception 'You are not assigned to that branch'
      using errcode = 'insufficient_privilege';
  end if;

  -- A NULL `auth.uid()` is the SQL editor or a migration, which is the trusted
  -- bootstrap path that creates the first membership. Matches the exemption in
  -- `pf_guard_profile_privileges`.
  if auth.uid() is not null then
    update profiles
    set branch_id = p_branch_id,
        -- The role a person holds can differ per counter: an owner at head
        -- office may be an assistant at a branch. Whichever branch is active
        -- decides what `pf_is_owner()` sees.
        role = target_role
    where id = auth.uid();
  end if;

  return p_branch_id;
end;
$$;

grant execute on function pf_set_active_branch(uuid) to authenticated;

-- The privilege guard must let a deliberate switch through while still refusing
-- self-promotion. Without membership the two are indistinguishable, because both
-- look like "this row changed branch_id" — so the guard asks the membership table.
create or replace function pf_guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_member boolean := false;
begin
  if new.role is distinct from old.role
     or new.branch_id is distinct from old.branch_id
     or new.is_customer is distinct from old.is_customer then

    if auth.uid() is null then
      return new;  -- trusted server context
    end if;

    -- Switching to a branch you belong to, keeping the role that branch grants.
    if exists (
      select 1 from branch_memberships m
      where m.user_id = auth.uid()
        and m.branch_id = new.branch_id
        and m.role = new.role
    ) then
      return new;
    end if;

    if not pf_is_owner() then
      raise exception 'Only an owner can change a role, branch or customer flag'
        using errcode = 'insufficient_privilege';
    end if;

    if new.branch_id is distinct from pf_current_branch() then
      raise exception 'An owner can only assign staff inside their own branch'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

-- Mirror `profiles.branch_id` into a membership.
--
-- The backfill above only reaches profiles that existed when this migration ran.
-- Without this, a staff member added afterwards would be assigned a branch by an
-- owner but have no membership for it — so `pf_my_branches` would not list the
-- counter they actually work at, and `pf_set_active_branch` would refuse to
-- return them to it after they switched away.
--
-- Safe because it only mirrors a branch assignment that has already been
-- authorised: `pf_guard_profile_privileges` has already decided that this change
-- was permitted by the time this trigger runs.
create or replace function pf_sync_profile_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.branch_id is null then
    return new;
  end if;

  insert into branch_memberships (user_id, branch_id, role, is_default)
  values (new.id, new.branch_id, new.role, not exists (
    select 1 from branch_memberships m
    where m.user_id = new.id and m.is_default
  ))
  on conflict (user_id, branch_id) do update
    set role = excluded.role;

  return new;
end;
$$;

drop trigger if exists profiles_sync_membership on profiles;
create trigger profiles_sync_membership after insert or update of branch_id, role on profiles
  for each row execute function pf_sync_profile_membership();

-- Branch directory for the switcher.
--
-- Membership is the ONLY test. An earlier version also accepted
-- `profiles.branch_id = b.id`, reasoning that a profile predating this migration
-- would have no membership row. That was wrong, and testing caught it: revoking a
-- membership left the branch still listed, because revoking one does not clear
-- `profiles.branch_id`. The switcher would then offer a branch that
-- `pf_set_active_branch()` refuses — an option that cannot be taken.
--
-- Nothing legitimate is lost by requiring membership: the backfill above creates
-- one for every existing profile, and `pf_sync_profile_membership` creates one for
-- every future branch assignment.
create or replace view pf_my_branches with (security_invoker = false) as
  select b.*
  from branches b
  where exists (
    select 1 from branch_memberships m
    where m.user_id = auth.uid() and m.branch_id = b.id
  );

grant select on pf_my_branches to authenticated;

-- ============================================================ 5. realtime
-- `medicines` and `stock_receipts` were dropped from the publication because
-- Realtime `postgres_changes` filters rows by RLS but NOT by column grants. Both
-- tables hold `cost_per_base_unit`, so publishing them would hand an assistant
-- the purchase price that the grants section exists to withhold.
--
-- The resolution is not to publish them anyway, and not to leave live stock
-- broken. `stock_movements` carries no cost column and no branch secret — it
-- holds medicine, batch, quantity and time. Subscribing to it gives a second
-- till the signal to re-fetch the affected products, which is the live stock
-- behaviour the dashboard wanted, with nothing sensitive in the payload.
--
-- `medicine_batches` also stays out: it has a cost column too.
--
-- So: sales, notifications and stock_movements are published; medicines,
-- medicine_batches and stock_receipts are not. Removing a table from a
-- publication is idempotent only if it is a member, hence the guard.

do $$
declare t text;
begin
  foreach t in array array['medicines', 'medicine_batches', 'stock_receipts'] loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['sales', 'notifications', 'stock_movements'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;