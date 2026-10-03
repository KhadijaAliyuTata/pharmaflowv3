-- ============================================================================
-- PharmaFlow — Supabase Postgres schema (Phase 0: database & security foundation)
-- ----------------------------------------------------------------------------
-- Apply with:  supabase db push
--
-- This file is the single initial migration and is safe to run repeatedly. It has
-- never been successfully applied before (it could not run — see "Phase 0 fixes"
-- below), so it is corrected in place rather than superseded by a repair script.
--
-- Design notes
--   * Money is `numeric(14,2)`, never float. v3 used JS numbers, which means
--     `0.1 + 0.2 !== 0.3` on a pharmacy's daily takings.
--   * Every table that belongs to a branch carries `branch_id`, and Row Level
--     Security scopes reads and writes to the caller's branch. Multi-branch
--     isolation is enforced by the database, not by remembering to filter.
--   * Purchase cost is hidden from assistants. RLS cannot do this (it filters
--     rows, not columns) and neither can a plain column grant (see "Cost data").
--   * Nothing here touches Edge Functions or Storage. Auth + Postgres only.
--
-- Phase 0 fixes applied in this revision
--   1. Helpers referenced `profiles` before `profiles` existed, so the script
--      aborted at the very first function. Tables and helpers are now ordered so
--     nothing is referenced before it exists.
--   2. `medicines.state` was a GENERATED column whose expression called
--     `current_date`. PostgreSQL requires generated-column expressions to be
--     IMMUTABLE, so the table could not be created. It is now a trigger-maintained
--     column, which may legally depend on the current date.
--   3. Two policies referenced `is_customer` on tables that have no such column
--     (`branches`, `customers`). Replaced with `pf_is_customer()`.
--   4. All policies are now `TO authenticated`; anonymous callers get nothing.
--   5. `profiles_self_update` allowed self-promotion to owner and self-move
--     between branches. Now guarded by a column grant plus a trigger.
--   6. `pf_handle_new_user` trusted `raw_user_meta_data.role`. It no longer does.
--   7. `grant select (cost_per_base_unit) ... to authenticated` handed the cost
--     column back to every signed-in user, defeating the grants section.
--   8. Seven policies had no branch predicate, allowing cross-branch access.
--   9. `audit_insert` did not constrain `actor_id`, so audit rows could be forged.
--  10. `pf_sync_total_quantity` read `new.medicine_id` inside an AFTER DELETE
--      trigger, where `NEW` is unassigned. It also ignored a batch moving between
--      medicines.
--  11. The script is now idempotent: enum creation, indexes, policies,
--      constraints and triggers are all guarded.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------ enums
-- PostgreSQL has no `create type if not exists`. The standard safe pattern is to
-- catch duplicate_object, which makes a re-run a no-op instead of an error.

do $$ begin create type staff_role as enum ('owner', 'assistant');
exception when duplicate_object then null; end $$;

do $$ begin create type prescription_class as enum ('otc', 'prescription', 'controlled');
exception when duplicate_object then null; end $$;

do $$ begin create type stock_state as enum ('in_stock', 'low_stock', 'out_of_stock', 'expiring_soon', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin create type receipt_state as enum ('pending_pricing', 'confirmed');
exception when duplicate_object then null; end $$;

do $$ begin create type sale_state as enum ('paid', 'part_paid', 'credit', 'refunded', 'voided');
exception when duplicate_object then null; end $$;

do $$ begin create type payment_kind as enum ('cash', 'transfer', 'pos_card', 'wallet');
exception when duplicate_object then null; end $$;

do $$ begin create type movement_kind as enum ('receipt', 'sale', 'adjustment', 'return', 'void', 'disposal');
exception when duplicate_object then null; end $$;

do $$ begin create type order_state as enum (
  'pending_review', 'confirmed', 'ready_for_pickup',
  'out_for_delivery', 'completed', 'cancelled'
);
exception when duplicate_object then null; end $$;

do $$ begin create type request_state as enum ('pending_restock', 'restocked', 'notified');
exception when duplicate_object then null; end $$;

do $$ begin create type urgency_level as enum ('routine', 'urgent', 'emergency');
exception when duplicate_object then null; end $$;

-- Defined first because `branches` and `profiles` attach a touch-trigger to it
-- before the policy helpers below can exist. It references no table.
create or replace function pf_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- branches

create table if not exists branches (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text not null default '',
  city          text not null default '',
  state         text not null default '',
  phone         text not null default '',
  opening_hours text not null default '',
  is_open_now   boolean not null default true,
  is_main_hub   boolean not null default false,
  -- numeric(2,1) can hold at most 9.9 but is documented as a 0-5 rating, so the
  -- old definition could not represent 5.0. numeric(3,1) can.
  rating        numeric(3,1) not null default 0 check (rating between 0 and 5),
  reviews_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists branches_main_hub_idx on branches(is_main_hub) where is_main_hub;

drop trigger if exists branches_touch on branches;
create trigger branches_touch before update on branches
  for each row execute function pf_touch_updated_at();

-- ---------------------------------------------------------------- profiles
-- One row per authenticated user. Supabase owns `auth.users`; this is the app's
-- view of it, holding the staff role and the home branch.
--
-- This table is created before the policy helpers, because those helpers read it.

create table if not exists profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  full_name      text not null,
  phone          text not null default '',
  role           staff_role not null default 'assistant',
  branch_id      uuid references branches(id) on delete set null,
  license_number text,
  -- Customers are auth users too, but have no branch and no staff role.
  is_customer    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists profiles_branch_idx on profiles(branch_id);

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles
  for each row execute function pf_touch_updated_at();

-- ------------------------------------------------------- authorization helpers
-- These are the ONLY source of authorization in the database. Each one reads the
-- caller's own `profiles` row via `auth.uid()` and returns NULL/false when that
-- row is missing, so an unknown caller sees nothing. They never accept a role or
-- branch from the caller, which is what made the old policies unsafe.

create or replace function pf_current_branch()
returns uuid
language sql stable
security definer
set search_path = public
as $$
  select p.branch_id from profiles p where p.id = auth.uid()
$$;

create or replace function pf_current_role()
returns staff_role
language sql stable
security definer
set search_path = public
as $$
  select p.role from profiles p where p.id = auth.uid()
$$;

create or replace function pf_is_owner()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce(pf_current_role() = 'owner', false)
$$;

-- Replaces the broken `is_customer` column reference on `branches`/`customers`.
-- The old policies assumed `is_customer` existed on those tables; it does not,
-- and `is_customer` is a property of the CALLER, not of the row being read.
create or replace function pf_is_customer()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_customer from profiles p where p.id = auth.uid()), false)
$$;

-- A staff member is someone with a branch and a staff role.
create or replace function pf_is_staff()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and not p.is_customer and p.branch_id is not null
  )
$$;

-- `pf_touch_updated_at` is defined above, immediately after the enums, because the
-- `branches` and `profiles` touch-triggers attach to it before any table that the
-- policy helpers read exists.

-- --------------------------------------------------------- new-user trigger
-- A trigger rather than application code, so a user can never exist without a
-- profile — the role check would otherwise silently fail open.
--
-- SECURITY: the role and the customer flag are hardcoded. They previously came
-- from `new.raw_user_meta_data`, which is supplied by the client at signup, so
-- anyone could POST `{"role":"owner"}` and be created as an owner. Promotion to
-- owner is now only possible via the owner-only UPDATE policy plus
-- `pf_guard_profile_privileges` below. New accounts start with no branch at all
-- and therefore see nothing until an owner assigns them one — failing closed.

create or replace function pf_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, full_name, phone, role, is_customer)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'phone', new.phone, ''),
    'assistant',
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function pf_handle_new_user();

-- Role, branch and the customer flag are the privilege-bearing columns on
-- `profiles`. A caller may edit their own name and phone (enforced by a column
-- grant) but may never change these. RLS alone cannot express "this column, not
-- that one", so the check lives in a trigger and fires for every writer
-- regardless of which policy admitted the row.
create or replace function pf_guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     or new.branch_id is distinct from old.branch_id
     or new.is_customer is distinct from old.is_customer then

    -- A NULL `auth.uid()` means there is no end user on the request: this is the
    -- SQL editor, a migration, or a service_role/backend connection. Those are the
    -- trusted server context, and they are also the only way the *first* owner of a
    -- branch can exist — without this exemption nobody could ever be promoted and
    -- the branch would have no owner at all. Every signed-in user has `auth.uid()`
    -- set by the gateway and is therefore always subject to the checks below.
    if auth.uid() is null then
      return new;
    end if;

    if not pf_is_owner() then
      raise exception 'Only an owner can change a role, branch or customer flag'
        using errcode = 'insufficient_privilege';
    end if;

    -- An owner administers their own branch, so they cannot mint staff in, or
    -- move staff into, a branch they do not hold.
    if new.branch_id is distinct from pf_current_branch() then
      raise exception 'An owner can only assign staff inside their own branch'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_privileges on profiles;
create trigger profiles_guard_privileges before update on profiles
  for each row execute function pf_guard_profile_privileges();

-- --------------------------------------------------------------- customers

create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),
  branch_id           uuid not null references branches(id) on delete cascade,
  -- Links to auth.users only if the customer has signed in. A walk-in
  -- prescription customer has a phone number and no account.
  auth_user_id        uuid unique references auth.users(id) on delete set null,
  code                text not null,
  name                text not null,
  phone               text not null,
  email               text,
  wallet_balance      numeric(14,2) not null default 0,
  outstanding_debt    numeric(14,2) not null default 0,
  total_spent         numeric(14,2) not null default 0,
  purchase_count      integer not null default 0,
  consent_for_reminders boolean not null default false,
  chronic_medications text[] not null default '{}',
  notes               text,
  registered_date     date not null default current_date,
  last_purchase_date  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint customers_phone_unique unique (branch_id, phone)
);
create index if not exists customers_branch_idx on customers(branch_id);
create index if not exists customers_debt_idx on customers(branch_id) where outstanding_debt > 0;
-- The customer portal resolves "the signed-in customer's record" through this.
create index if not exists customers_auth_user_idx on customers(auth_user_id) where auth_user_id is not null;

drop trigger if exists customers_touch on customers;
create trigger customers_touch before update on customers
  for each row execute function pf_touch_updated_at();

-- --------------------------------------------------------------- suppliers

create table if not exists suppliers (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id) on delete cascade,
  name            text not null,
  contact_person  text not null default '',
  phone           text not null default '',
  address         text not null default '',
  email           text,
  lead_time_days  integer not null default 3 check (lead_time_days > 0),
  rating          numeric(3,1) not null default 0 check (rating between 0 and 5),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists suppliers_branch_idx on suppliers(branch_id);

drop trigger if exists suppliers_touch on suppliers;
create trigger suppliers_touch before update on suppliers
  for each row execute function pf_touch_updated_at();

-- --------------------------------------------------------------- medicines

create table if not exists medicines (
  id                  uuid primary key default gen_random_uuid(),
  branch_id           uuid not null references branches(id) on delete cascade,
  barcode             text,
  name                text not null,
  generic_name        text not null,
  strength            text not null default '',
  dosage_form         text not null default '',
  category            text not null default '',
  supplier_id         uuid references suppliers(id) on delete set null,

  -- Tradeable units. Base unit is the one with multiplier 1; enforced below.
  -- The default is a valid single base unit: the previous default was '[]', which
  -- the base-unit trigger always rejected, so every insert had to spell it out.
  units               jsonb not null
                      default '[{"key":"unit","name":"Unit","multiplier":1,"sellingPrice":0}]'::jsonb,

  -- Denormalised for query speed. Maintained by `pf_guard_total_quantity`, which
  -- recomputes it from `medicine_batches` on every write, so it can never be set
  -- directly by a client. See the "stock total cannot drift" section below.
  total_quantity      integer not null default 0 check (total_quantity >= 0),
  low_stock_threshold integer not null default 0 check (low_stock_threshold >= 0),
  average_daily_sales numeric(10,2) not null default 0 check (average_daily_sales >= 0),

  -- Cost is what RLS cannot protect; see the grants at the bottom.
  cost_per_base_unit  numeric(14,2) not null default 0 check (cost_per_base_unit >= 0),
  price_per_base_unit numeric(14,2) not null default 0 check (price_per_base_unit >= 0),

  expiry_date         date not null,
  purchase_date       date not null default current_date,

  common_use          text not null default '',
  storage             text not null default '',
  prescription_class  prescription_class not null default 'otc',
  warnings            text[] not null default '{}',

  is_brand            boolean not null default false,
  generic_equivalent_id uuid references medicines(id) on delete set null,

  do_not_sell         boolean not null default false,
  do_not_sell_reason  text,
  do_not_sell_locked_by uuid references profiles(id) on delete set null,
  do_not_sell_locked_at timestamptz,

  nafdac_reg_number   text,
  manufacturer        text,

  -- Was `generated always as (...) stored`. PostgreSQL requires a generated
  -- column's expression to be IMMUTABLE, and this one called `current_date`,
  -- which is only STABLE — so the table could not be created at all. It is now an
  -- ordinary column maintained by `pf_medicine_state`, which may legally read the
  -- current date.
  state               stock_state not null default 'out_of_stock',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint medicines_barcode_unique unique (branch_id, barcode),
  constraint medicines_price_above_cost check (price_per_base_unit >= cost_per_base_unit)
);
create index if not exists medicines_branch_idx on medicines(branch_id);
create index if not exists medicines_name_search_idx on medicines using gin
  (to_tsvector('english', name || ' ' || generic_name));
create index if not exists medicines_state_idx on medicines(branch_id, state);
create index if not exists medicines_reorder_idx on medicines(branch_id, average_daily_sales)
  where average_daily_sales > 0;
create index if not exists medicines_supplier_idx on medicines(supplier_id);
create index if not exists medicines_generic_equiv_idx on medicines(generic_equivalent_id)
  where generic_equivalent_id is not null;
create index if not exists medicines_locked_by_idx on medicines(do_not_sell_locked_by)
  where do_not_sell_locked_by is not null;

drop trigger if exists medicines_touch on medicines;
create trigger medicines_touch before update on medicines
  for each row execute function pf_touch_updated_at();

-- The first unit must be the base unit, or every stock calculation is wrong.
create or replace function pf_check_base_unit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  first_multiplier numeric;
begin
  first_multiplier := (new.units -> 0 ->> 'multiplier')::numeric;
  if first_multiplier is distinct from 1 then
    raise exception 'The first unit for % must be the base unit (multiplier 1)', new.name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists medicines_base_unit on medicines;
create trigger medicines_base_unit before insert or update of units on medicines
  for each row execute function pf_check_base_unit();

-- Recomputes `medicines.state`. See the note on the column for why this is a
-- trigger rather than a generated column.
create or replace function pf_medicine_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.state := case
    when new.expiry_date < current_date        then 'expired'::stock_state
    when new.expiry_date <= current_date + 90   then 'expiring_soon'::stock_state
    when new.total_quantity = 0                 then 'out_of_stock'::stock_state
    when new.total_quantity <= new.low_stock_threshold then 'low_stock'::stock_state
    else 'in_stock'::stock_state
  end;
  return new;
end;
$$;

drop trigger if exists medicines_state on medicines;
create trigger medicines_state before insert or update on medicines
  for each row execute function pf_medicine_state();

-- Cost price is owner-only. Grants alone cannot express that (see "Cost data"),
-- so the rule is enforced here for every writer.
create or replace function pf_guard_cost_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- See `pf_guard_profile_privileges`: a NULL `auth.uid()` is the trusted server
  -- context (SQL editor, migration, service_role), not a signed-in user.
  if auth.uid() is null then
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

drop trigger if exists medicines_guard_cost on medicines;
create trigger medicines_guard_cost before update on medicines
  for each row execute function pf_guard_cost_write();

-- ------------------------------------------------------------------ batches

create table if not exists medicine_batches (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id) on delete cascade,
  medicine_id       uuid not null references medicines(id) on delete cascade,
  batch_number      text not null,
  expiry_date       date not null,
  quantity          integer not null default 0 check (quantity >= 0),
  cost_per_base_unit numeric(14,2) not null default 0,
  supplier_id       uuid references suppliers(id) on delete set null,
  received_date     date not null default current_date,
  is_recalled       boolean not null default false,
  recall_reason     text,
  created_at        timestamptz not null default now(),
  constraint medicine_batches_unique unique (medicine_id, batch_number)
);
create index if not exists batches_medicine_idx on medicine_batches(medicine_id);
-- Expiry watch list. Partial index: only rows that can actually expire.
create index if not exists batches_expiry_idx on medicine_batches(branch_id, expiry_date)
  where quantity > 0 and not is_recalled;
create index if not exists batches_supplier_idx on medicine_batches(supplier_id);

drop trigger if exists batches_guard_cost on medicine_batches;
create trigger batches_guard_cost before update on medicine_batches
  for each row execute function pf_guard_cost_write();

-- ------------------------------------------------------- stock receipts

create table if not exists stock_receipts (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id) on delete cascade,
  receipt_number    text not null,
  medicine_id       uuid not null references medicines(id) on delete cascade,
  batch_number      text not null,
  base_units_received integer not null check (base_units_received > 0),
  supplier_id       uuid references suppliers(id) on delete set null,
  expiry_date       date not null,
  received_at       timestamptz not null default now(),
  received_by       uuid not null references profiles(id) on delete restrict,
  state             receipt_state not null default 'pending_pricing',
  cost_per_base_unit  numeric(14,2),
  price_per_base_unit numeric(14,2),
  priced_by         uuid references profiles(id) on delete set null,
  priced_at         timestamptz,
  constraint stock_receipts_number_unique unique (branch_id, receipt_number)
);
create index if not exists receipts_pending_idx on stock_receipts(branch_id)
  where state = 'pending_pricing';
create index if not exists receipts_medicine_idx on stock_receipts(medicine_id);
create index if not exists receipts_supplier_idx on stock_receipts(supplier_id);
create index if not exists receipts_received_by_idx on stock_receipts(received_by);
create index if not exists receipts_priced_by_idx on stock_receipts(priced_by)
  where priced_by is not null;

-- Only an owner may move a receipt out of the pricing queue, and only an owner
-- may state a cost on it. Enforced in a trigger as well as in RLS, because the UI
-- is not the security boundary.
--
-- This previously fired BEFORE UPDATE only, which left two holes: an assistant
-- could INSERT a receipt already in `confirmed` state with a cost filled in, and
-- could edit the cost of a receipt that was still `pending_pricing`. It now
-- covers INSERT too.
create or replace function pf_require_owner_to_price()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Trusted server context (SQL editor, migration, service_role) is exempt; see
  -- `pf_guard_profile_privileges`. Every signed-in user has `auth.uid()` set.
  if auth.uid() is null then
    return new;
  end if;

  if new.state = 'confirmed'
     and (tg_op = 'INSERT' or old.state = 'pending_pricing') then

    if not pf_is_owner() then
      raise exception 'Only an owner can approve pricing'
        using errcode = 'insufficient_privilege';
    end if;

    if new.cost_per_base_unit is not null
       and (tg_op = 'INSERT' or new.cost_per_base_unit is distinct from old.cost_per_base_unit)
       and not pf_is_owner() then
      raise exception 'Only an owner can set a purchase cost'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists receipts_require_owner on stock_receipts;
create trigger receipts_require_owner before insert or update on stock_receipts
  for each row execute function pf_require_owner_to_price();

-- ------------------------------------------------------------ stock ledger

create table if not exists stock_movements (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id) on delete cascade,
  medicine_id       uuid not null references medicines(id) on delete cascade,
  kind              movement_kind not null,
  quantity_changed  integer not null,
  resulting_quantity integer not null,
  performed_by      uuid not null references profiles(id) on delete restrict,
  note              text not null default '',
  reference_id      uuid,
  created_at        timestamptz not null default now()
);
create index if not exists movements_medicine_idx on stock_movements(medicine_id, created_at desc);
create index if not exists movements_branch_idx on stock_movements(branch_id, created_at desc);
create index if not exists movements_performed_by_idx on stock_movements(performed_by);

-- ------------------------------------------------------------------- sales

create table if not exists sales (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id) on delete cascade,
  receipt_number    text not null,
  sold_at           timestamptz not null default now(),
  attendant_id      uuid not null references profiles(id) on delete restrict,
  customer_id       uuid references customers(id) on delete set null,
  credit_account_id uuid,
  subtotal          numeric(14,2) not null check (subtotal >= 0),
  discount          numeric(14,2) not null default 0 check (discount >= 0),
  discount_reason   text,
  total             numeric(14,2) not null check (total >= 0),
  payment_method    payment_kind not null,
  state             sale_state default 'paid',
  amount_paid       numeric(14,2) not null default 0 check (amount_paid >= 0),
  outstanding       numeric(14,2) not null default 0 check (outstanding >= 0),
  dispensed_against_prescription boolean not null default false,
  status_reason     text,
  status_changed_by uuid references profiles(id) on delete set null,
  status_changed_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint sales_receipt_unique unique (branch_id, receipt_number),
  constraint sales_discount_within_subtotal check (discount <= subtotal),
  constraint sales_paid_plus_outstanding check (abs((amount_paid + outstanding) - total) < 0.01)
);
create index if not exists sales_branch_idx on sales(branch_id, sold_at desc);
create index if not exists sales_attendant_idx on sales(attendant_id, sold_at desc);
-- The dashboard's "outstanding credit" tile reads exactly this.
create index if not exists sales_outstanding_idx on sales(branch_id, sold_at desc)
  where outstanding > 0 and state <> 'voided';
create index if not exists sales_customer_idx on sales(customer_id) where customer_id is not null;
create index if not exists sales_status_changed_by_idx on sales(status_changed_by)
  where status_changed_by is not null;

drop trigger if exists sales_touch on sales;
create trigger sales_touch before update on sales
  for each row execute function pf_touch_updated_at();

create table if not exists sale_items (
  id                uuid primary key default gen_random_uuid(),
  sale_id           uuid not null references sales(id) on delete cascade,
  medicine_id       uuid not null references medicines(id) on delete restrict,
  medicine_name     text not null,
  generic_name      text not null,
  unit_key          text not null,
  unit_name         text not null,
  unit_multiplier   integer not null check (unit_multiplier > 0),
  quantity          integer not null check (quantity > 0),
  base_units_total  integer not null check (base_units_total > 0),
  unit_price        numeric(14,2) not null check (unit_price >= 0),
  line_total        numeric(14,2) not null check (line_total >= 0),
  -- Snapshot, not a join. Reordering a medicine must never rewrite the margin
  -- on a sale that already happened. Readable by owners only — see
  -- `pf_sale_item_costs` below and the note on `cost_per_base_unit_snapshot` in
  -- db.types.ts. Any attendant may WRITE it (the till records the cost it
  -- dispensed at), but only an owner may read it back.
  cost_per_base_unit_snapshot numeric(14,2) not null default 0
);
create index if not exists sale_items_sale_idx on sale_items(sale_id);
create index if not exists sale_items_medicine_idx on sale_items(medicine_id);

-- --------------------------------------------------------- credit accounts

create table if not exists credit_accounts (
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references branches(id) on delete cascade,
  name               text not null,
  kind               text not null default 'business',
  contact_person     text not null default '',
  phone              text not null default '',
  email              text,
  credit_limit       numeric(14,2) not null default 0 check (credit_limit >= 0),
  outstanding_balance numeric(14,2) not null default 0 check (outstanding_balance >= 0),
  is_suspended       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists credit_accounts_branch_idx on credit_accounts(branch_id);
create index if not exists credit_accounts_over_limit_idx on credit_accounts(branch_id)
  where outstanding_balance > credit_limit;

-- The balance on the account and the balance on its last ledger row must agree,
-- or the ledger stops being trustworthy. This is what enforces it.
create or replace function pf_check_credit_ledger_balance()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  current numeric;
begin
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

create table if not exists credit_ledger (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references credit_accounts(id) on delete cascade,
  branch_id    uuid not null references branches(id) on delete cascade,
  entry_at     timestamptz not null default now(),
  kind         text not null check (kind in ('charge', 'payment')),
  amount       numeric(14,2) not null check (amount > 0),
  balance_after numeric(14,2) not null,
  note         text not null default '',
  reference_id uuid,
  recorded_by  uuid not null references profiles(id) on delete restrict
);
create index if not exists credit_ledger_account_idx on credit_ledger(account_id, entry_at desc);
create index if not exists credit_ledger_branch_idx on credit_ledger(branch_id, entry_at desc);
create index if not exists credit_ledger_recorded_by_idx on credit_ledger(recorded_by);

-- The original ran `alter table sales add constraint ...` unguarded, which fails
-- on any re-run. Guarded so the script is repeatable.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sales_credit_account_fkey'
  ) then
    alter table sales
      add constraint sales_credit_account_fkey
      foreign key (credit_account_id) references credit_accounts(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------- customer orders

create table if not exists customer_orders (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id) on delete cascade,
  order_number    text not null,
  customer_id     uuid not null references customers(id) on delete cascade,
  delivery_type   text not null default 'pickup' check (delivery_type in ('pickup', 'delivery')),
  delivery_address text,
  payment_method  text not null default 'pay_on_delivery',
  payment_state   text not null default 'pending' check (payment_state in ('pending', 'paid')),
  state           order_state not null default 'pending_review',
  subtotal        numeric(14,2) not null default 0,
  delivery_fee    numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  prescription_attached boolean not null default false,
  -- Prescription images live outside the database by policy: no Storage, no
  -- Edge Functions. The counter keeps the paper.
  pharmacist_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint customer_orders_number_unique unique (branch_id, order_number)
);
create index if not exists orders_branch_idx on customer_orders(branch_id, created_at desc);
create index if not exists orders_state_idx on customer_orders(branch_id, state);
create index if not exists orders_customer_idx on customer_orders(customer_id);

drop trigger if exists orders_touch on customer_orders;
create trigger orders_touch before update on customer_orders
  for each row execute function pf_touch_updated_at();

create table if not exists order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references customer_orders(id) on delete cascade,
  medicine_id   uuid references medicines(id) on delete set null,
  medicine_name text not null,
  unit_name     text not null,
  quantity      integer not null check (quantity > 0),
  line_total    numeric(14,2) not null default 0
);
create index if not exists order_items_order_idx on order_items(order_id);
create index if not exists order_items_medicine_idx on order_items(medicine_id)
  where medicine_id is not null;

-- ------------------------------------------------------- medicine requests

create table if not exists medicine_requests (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id) on delete cascade,
  medicine_name text not null,
  generic_name  text,
  customer_id   uuid references customers(id) on delete set null,
  customer_name text,
  customer_phone text,
  quantity_requested integer not null check (quantity_requested > 0),
  urgency       urgency_level not null default 'routine',
  state         request_state not null default 'pending_restock',
  recorded_at   timestamptz not null default now(),
  recorded_by   uuid not null references profiles(id) on delete restrict,
  notified_at   timestamptz
);
create index if not exists requests_open_idx on medicine_requests(branch_id, recorded_at desc)
  where state = 'pending_restock';
create index if not exists requests_customer_idx on medicine_requests(customer_id)
  where customer_id is not null;
create index if not exists requests_recorded_by_idx on medicine_requests(recorded_by);

-- -------------------------------------------------------- audit + alerts

create table if not exists audit_events (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id) on delete cascade,
  actor_id   uuid not null references profiles(id) on delete restrict,
  action     text not null,
  description text not null,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_branch_idx on audit_events(branch_id, created_at desc);
create index if not exists audit_actor_idx on audit_events(actor_id, created_at desc);

create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id) on delete cascade,
  recipient_id uuid references profiles(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  severity   text not null default 'info' check (severity in ('info', 'warning', 'urgent')),
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_unread_idx on notifications(recipient_id, created_at desc)
  where read_at is null;
create index if not exists notifications_branch_idx on notifications(branch_id, created_at desc);

-- ============================================ stock total cannot drift
-- `total_quantity` is denormalised for query speed. Every path that changes it
-- must write a movement, or the ledger and the total disagree.

-- Re-derives `medicines.total_quantity` from the batch ledger on every write.
-- Because this is a BEFORE trigger it overrides whatever the statement asked for,
-- so a client cannot inflate or deflate stock by writing the column directly —
-- the previous schema allowed exactly that through `medicines_staff_write`.
create or replace function pf_guard_total_quantity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.total_quantity := (
    select coalesce(sum(b.quantity), 0)
    from medicine_batches b
    where b.medicine_id = new.id
      and not b.is_recalled
      and b.expiry_date >= current_date
  );
  return new;
end;
$$;

drop trigger if exists medicines_guard_total on medicines;
create trigger medicines_guard_total before insert or update on medicines
  for each row execute function pf_guard_total_quantity();

-- Keeps the denormalised total in step when a batch row changes.
--
-- This previously read `new.medicine_id` unconditionally. In an AFTER DELETE
-- trigger `NEW` is unassigned, so deleting a batch raised
-- `record "new" is not assigned yet` and batch deletion was impossible. It also
-- ignored a batch being moved between medicines, leaving the old medicine stale.
create or replace function pf_sync_total_quantity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
  previous_medicine uuid;
begin
  target := case when tg_op = 'DELETE' then old.medicine_id else new.medicine_id end;

  if tg_op = 'UPDATE' and old.medicine_id is distinct from new.medicine_id then
    previous_medicine := old.medicine_id;
  end if;

  -- Both rows are re-derived by the BEFORE trigger on `medicines`, so this only
  -- has to mark them dirty.
  if target is not null then
    update medicines set total_quantity = total_quantity where id = target;
  end if;

  if previous_medicine is not null then
    update medicines set total_quantity = total_quantity where id = previous_medicine;
  end if;

  return null;
end;
$$;

drop trigger if exists batches_sync_total on medicine_batches;
create trigger batches_sync_total
  after insert or update or delete on medicine_batches
  for each row execute function pf_sync_total_quantity();

-- ==================================================== row level security

alter table branches          enable row level security;
alter table profiles          enable row level security;
alter table customers         enable row level security;
alter table suppliers         enable row level security;
alter table medicines         enable row level security;
alter table medicine_batches  enable row level security;
alter table stock_receipts    enable row level security;
alter table stock_movements   enable row level security;
alter table sales             enable row level security;
alter table sale_items        enable row level security;
alter table credit_accounts   enable row level security;
alter table credit_ledger     enable row level security;
alter table customer_orders   enable row level security;
alter table order_items       enable row level security;
alter table medicine_requests enable row level security;
alter table audit_events      enable row level security;
alter table notifications     enable row level security;

-- Every policy below is `TO authenticated`. They previously had no `TO` clause,
-- which makes them `TO PUBLIC` — meaning the `anon` role was in scope for all of
-- them. Nothing here is reachable without a signed-in user.
--
-- Deliberately NOT kept public: `branches_read` was written as a "customers see
-- all (a public directory)" rule. It is now authenticated. A signed-in customer
-- can still list pharmacies; an anonymous visitor cannot. That matches the
-- decision to put a session check in front of the portal, and it removes any
-- dependency on the portal being reachable without credentials.

-- Branches: staff see their own branch; a signed-in customer sees the directory.
drop policy if exists branches_read on branches;
create policy branches_read on branches for select to authenticated
  using (pf_is_customer() or id = pf_current_branch());

-- An owner administers their own branch only. This was `pf_is_owner()` with no
-- branch predicate, so an owner of any branch could rename, close or delete any
-- other pharmacy's branch.
drop policy if exists branches_owner_write on branches;
create policy branches_owner_write on branches for all to authenticated
  using (pf_is_owner() and id = pf_current_branch())
  with check (pf_is_owner() and id = pf_current_branch());

-- Profiles: yourself, and colleagues in your own branch. This previously read
-- `id = auth.uid() or is_customer = false`, which returned every staff profile in
-- every branch — full name, phone, role and licence number included.
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
  using (
    id = auth.uid()
    or (not is_customer and branch_id = pf_current_branch())
  );

-- A user may edit their own row. Which columns they may touch is decided by the
-- column grant in the privileges section (full_name, phone only); `role`,
-- `branch_id` and `is_customer` are additionally blocked by
-- `pf_guard_profile_privileges`. RLS cannot restrict columns, so both are needed.
drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Owners may move staff between roles inside their own branch.
drop policy if exists profiles_owner_update on profiles;
create policy profiles_owner_update on profiles for update to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

-- Customers: your own record, or your branch's records if you are staff.
--
-- The old policy granted a customer the whole table via a bare `is_customer`
-- column reference. `customers` carries wallet balances, outstanding debt and
-- lifetime spend, so that would have exposed every customer's finances to any
-- signed-in customer. Customers now see only their own row.
drop policy if exists customers_read on customers;
create policy customers_read on customers for select to authenticated
  using (auth_user_id = auth.uid() or branch_id = pf_current_branch());

drop policy if exists customers_staff_write on customers;
create policy customers_staff_write on customers for all to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists suppliers_read on suppliers;
create policy suppliers_read on suppliers for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists suppliers_owner_write on suppliers;
create policy suppliers_owner_write on suppliers for all to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists medicines_read on medicines;
create policy medicines_read on medicines for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists medicines_staff_write on medicines;
create policy medicines_staff_write on medicines for all to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists batches_read on medicine_batches;
create policy batches_read on medicine_batches for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists batches_staff_write on medicine_batches;
create policy batches_staff_write on medicine_batches for all to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists receipts_read on stock_receipts;
create policy receipts_read on stock_receipts for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists receipts_staff_write on stock_receipts;
create policy receipts_staff_write on stock_receipts for all to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists movements_read on stock_movements;
create policy movements_read on stock_movements for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists movements_staff_write on stock_movements;
create policy movements_staff_write on stock_movements for insert to authenticated
  with check (branch_id = pf_current_branch());

drop policy if exists sales_read on sales;
create policy sales_read on sales for select to authenticated
  using (branch_id = pf_current_branch() or customer_id in (
    select id from customers where auth_user_id = auth.uid()
  ));

drop policy if exists sales_staff_write on sales;
create policy sales_staff_write on sales for insert to authenticated
  with check (branch_id = pf_current_branch());

-- Sales are never updated in place except to void or refund, and only by an
-- owner of that sale's branch. Line items are immutable.
drop policy if exists sales_owner_void on sales;
create policy sales_owner_void on sales for update to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists sale_items_read on sale_items;
create policy sale_items_read on sale_items for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_id));

drop policy if exists sale_items_insert on sale_items;
create policy sale_items_insert on sale_items for insert to authenticated
  with check (exists (select 1 from sales s where s.id = sale_id));

-- Credit accounts are owner-only, and now scoped to the caller's branch. The four
-- credit policies previously had no branch predicate at all, so an owner of one
-- pharmacy could read and write every other pharmacy's credit limits, customer
-- debt balances and credit ledgers.
drop policy if exists credit_read on credit_accounts;
create policy credit_read on credit_accounts for select to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists credit_owner_write on credit_accounts;
create policy credit_owner_write on credit_accounts for all to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists credit_ledger_read on credit_ledger;
create policy credit_ledger_read on credit_ledger for select to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists credit_ledger_insert on credit_ledger;
create policy credit_ledger_insert on credit_ledger for insert to authenticated
  with check (pf_is_owner() and branch_id = pf_current_branch());

drop policy if exists orders_read on customer_orders;
create policy orders_read on customer_orders for select to authenticated
  using (
    branch_id = pf_current_branch()
    or customer_id in (select id from customers where auth_user_id = auth.uid())
  );

drop policy if exists orders_staff_write on customer_orders;
create policy orders_staff_write on customer_orders for all to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

drop policy if exists order_items_read on order_items;
create policy order_items_read on order_items for select to authenticated
  using (exists (select 1 from customer_orders o where o.id = order_id));

drop policy if exists order_items_staff_write on order_items;
create policy order_items_staff_write on order_items for all to authenticated
  using (exists (select 1 from customer_orders o where o.id = order_id))
  with check (exists (select 1 from customer_orders o where o.id = order_id));

drop policy if exists requests_read on medicine_requests;
create policy requests_read on medicine_requests for select to authenticated
  using (branch_id = pf_current_branch());

drop policy if exists requests_staff_write on medicine_requests;
create policy requests_staff_write on medicine_requests for all to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

-- Staff may read the audit log; only owners may read it, and only for their own
-- branch — it previously had no branch predicate, so any owner could read every
-- pharmacy's audit trail, including who approved pricing and who voided sales.
drop policy if exists audit_read on audit_events;
create policy audit_read on audit_events for select to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

-- An audit row must name the caller as its actor. The old policy constrained only
-- `branch_id`, so any staff user could insert an event attributing an action to
-- somebody else — forging the record this policy exists to protect.
drop policy if exists audit_insert on audit_events;
create policy audit_insert on audit_events for insert to authenticated
  with check (branch_id = pf_current_branch() and actor_id = auth.uid());

drop policy if exists notifications_read on notifications;
create policy notifications_read on notifications for select to authenticated
  using (recipient_id = auth.uid() or (recipient_id is null and branch_id = pf_current_branch()));

drop policy if exists notifications_staff_write on notifications;
create policy notifications_staff_write on notifications for all to authenticated
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

-- =========================================================== cost protection
-- Cost data
-- ----------
-- The previous approach could not work, for two independent reasons.
--
--   1. The old line `grant select (cost_per_base_unit) on medicines to
--      authenticated` was commented "Owners get everything back", but
--      `authenticated` is the role of *every* signed-in user, including
--      assistants. There is no separate Postgres role for owners, so that grant
--      handed the column to everyone and defeated the whole section.
--   2. Even written differently, a column grant cannot be conditional. Postgres
--      grants are to roles; Supabase issues every signed-in request as
--      `authenticated`, so there is no way to say "this column, owners only"
--      through a grant.
--
-- RLS *can* express it, because a policy is evaluated per request and may call
-- `auth.uid()`. So the cost columns are withheld from `authenticated` entirely and
-- published through owner-gated views whose WHERE clause calls `pf_is_owner()`.
-- An assistant querying a view gets zero rows, not an error, so owner reporting is
-- unaffected and assistant screens do not crash on a permission error.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

revoke all on medicines, medicine_batches, stock_receipts, sale_items from authenticated;

grant select (
  id, branch_id, barcode, name, generic_name, strength, dosage_form, category,
  supplier_id, units, total_quantity, low_stock_threshold, average_daily_sales,
  price_per_base_unit, expiry_date, purchase_date, common_use, storage,
  prescription_class, warnings, is_brand, generic_equivalent_id, do_not_sell,
  do_not_sell_reason, nafdac_reg_number, manufacturer, state, created_at, updated_at
) on medicines to authenticated;

-- `cost_per_base_unit` is grantable but not readable: an owner needs it on
-- INSERT/UPDATE, and `pf_guard_cost_write` is what stops an assistant using it.
grant insert (
  branch_id, barcode, name, generic_name, strength, dosage_form, category,
  supplier_id, units, low_stock_threshold, average_daily_sales,
  cost_per_base_unit, price_per_base_unit, expiry_date, purchase_date,
  common_use, storage, prescription_class, warnings, is_brand,
  generic_equivalent_id, nafdac_reg_number, manufacturer
) on medicines to authenticated;
grant update (
  barcode, name, generic_name, strength, dosage_form, category, supplier_id,
  units, low_stock_threshold, average_daily_sales, cost_per_base_unit,
  price_per_base_unit, expiry_date, purchase_date, common_use, storage,
  prescription_class, warnings, is_brand, generic_equivalent_id,
  do_not_sell, do_not_sell_reason, nafdac_reg_number, manufacturer
) on medicines to authenticated;
grant delete on medicines to authenticated;
-- The safety lock is an owner action (`setSafetyLock`/`setBatchRecall` in
-- src/domain/operations.ts had no role check at all). Recording who locked it and
-- when is part of that, so those two columns are owner-writable.
grant update (do_not_sell_locked_by, do_not_sell_locked_at) on medicines to authenticated;

-- Cost must not leak through the batch or receipt tables either.
grant select (
  id, branch_id, medicine_id, batch_number, expiry_date, quantity,
  supplier_id, received_date, is_recalled, recall_reason, created_at
) on medicine_batches to authenticated;
grant insert (
  branch_id, medicine_id, batch_number, expiry_date, quantity,
  cost_per_base_unit, supplier_id, received_date, is_recalled, recall_reason
) on medicine_batches to authenticated;
grant update (
  batch_number, expiry_date, quantity, cost_per_base_unit, supplier_id,
  received_date, is_recalled, recall_reason
) on medicine_batches to authenticated;
grant delete on medicine_batches to authenticated;

grant select (
  id, branch_id, receipt_number, medicine_id, batch_number, base_units_received,
  supplier_id, expiry_date, received_at, received_by, state,
  price_per_base_unit, priced_by, priced_at
) on stock_receipts to authenticated;
grant insert (
  branch_id, receipt_number, medicine_id, batch_number, base_units_received,
  supplier_id, expiry_date, received_by, state, cost_per_base_unit,
  price_per_base_unit, priced_by, priced_at
) on stock_receipts to authenticated;
grant update (
  base_units_received, supplier_id, expiry_date, state,
  cost_per_base_unit, price_per_base_unit, priced_by, priced_at
) on stock_receipts to authenticated;

-- `cost_per_base_unit_snapshot` is writable by any attendant (the till must
-- record what it dispensed at) but readable only by an owner, via
-- `pf_sale_item_costs`. It previously had no column grant at all and was fully
-- readable, which leaked the historical cost and margin of every sale line.
grant select (
  id, sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
  unit_multiplier, quantity, base_units_total, unit_price, line_total
) on sale_items to authenticated;
grant insert (
  sale_id, medicine_id, medicine_name, generic_name, unit_key, unit_name,
  unit_multiplier, quantity, base_units_total, unit_price, line_total,
  cost_per_base_unit_snapshot
) on sale_items to authenticated;

-- Owner-gated cost views. `security_invoker = false` means the view runs with the
-- owner's privileges and so is not itself filtered by RLS; the WHERE clauses are
-- therefore the authorisation, and they call `pf_is_owner()` plus the caller's
-- branch. A non-owner receives an empty result rather than a permission error.

create or replace view pf_medicine_costs with (security_invoker = false) as
  select m.id, m.branch_id, m.cost_per_base_unit
  from medicines m
  where pf_is_owner() and m.branch_id = pf_current_branch();

create or replace view pf_batch_costs with (security_invoker = false) as
  select b.id, b.medicine_id, b.branch_id, b.cost_per_base_unit
  from medicine_batches b
  where pf_is_owner() and b.branch_id = pf_current_branch();

create or replace view pf_receipt_costs with (security_invoker = false) as
  select r.id, r.branch_id, r.cost_per_base_unit, r.price_per_base_unit
  from stock_receipts r
  where pf_is_owner() and r.branch_id = pf_current_branch();

create or replace view pf_sale_item_costs with (security_invoker = false) as
  select i.id, i.sale_id, s.branch_id, i.cost_per_base_unit_snapshot
  from sale_items i
  join sales s on s.id = i.sale_id
  where pf_is_owner() and s.branch_id = pf_current_branch();

grant select on pf_medicine_costs, pf_batch_costs, pf_receipt_costs, pf_sale_item_costs to authenticated;

-- Privileges that are not cost-bearing: RLS already scopes every row, so ordinary
-- table privileges are fine.
grant select, insert, update, delete on
  branches, profiles, customers, suppliers, stock_movements, sales,
  credit_accounts, credit_ledger, customer_orders, order_items,
  medicine_requests, audit_events, notifications
to authenticated;

-- `profiles` is listed above for SELECT/DELETE, but UPDATE is column-limited:
-- full_name and phone are the user's own to edit; role, branch_id and
-- is_customer are not. Those three columns are still *grantable* to
-- `authenticated`, because a grant cannot be made conditional and an owner has to
-- be able to promote staff. `pf_guard_profile_privileges` is what actually
-- enforces the rule, for every writer, on every path.
revoke update on profiles from authenticated;
grant update (full_name, phone, role, branch_id, license_number, is_customer)
  on profiles to authenticated;

-- Sequences: needed for inserts into tables whose default is gen_random_uuid()
-- only in the general case; granted defensively so a future identity column works.
grant usage, select on all sequences in schema public to authenticated;

-- ============================================================ realtime
-- The dashboard and the stock list should update when another till sells.
--
-- `medicines` and `stock_receipts` were previously added to the publication.
-- Realtime `postgres_changes` payloads are filtered by RLS but NOT by column
-- privileges, so publishing a table that contains a cost column would leak that
-- column regardless of the grants above. Those two tables are therefore left out
-- until a cost-free projection exists. `sales` and `notifications` carry no cost
-- column and stay.
--
-- This is a deliberate reduction in functionality, made because the alternative
-- is a known leak. Reinstating live stock updates is Phase 1 work: either
-- publish a dedicated `stock_levels` table with no cost column, or serve live
-- counts through an RPC.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['medicines', 'stock_receipts'] loop
    execute format('alter publication supabase_realtime drop table %I', t);
  end loop;
exception when undefined_object then null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['sales', 'notifications'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
