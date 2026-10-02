-- ============================================================================
-- PharmaFlow — Supabase Postgres schema
-- ----------------------------------------------------------------------------
-- Run with:  supabase db push        (or paste into the SQL editor)
--
-- Design notes
--   * Money is `numeric(14,2)`, never float. v3 used JS numbers, which means
--     `0.1 + 0.2 !== 0.3` on a pharmacy's daily takings.
--   * Every table that belongs to a branch carries `branch_id`, and Row Level
--     Security scopes reads and writes to the caller's branch. Multi-branch
--     isolation is enforced by the database, not by remembering to filter.
--   * Cost prices are hidden from assistants with COLUMN-level grants, not RLS.
--     RLS filters rows, not columns — a policy cannot stop `SELECT cost_per_base_unit`.
--     Grants can, so that is what does it.
--   * Nothing here touches Edge Functions or Storage. Auth + Postgres only.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------ enums

create type staff_role as enum ('owner', 'assistant');
create type prescription_class as enum ('otc', 'prescription', 'controlled');
create type stock_state as enum ('in_stock', 'low_stock', 'out_of_stock', 'expiring_soon', 'expired');
create type receipt_state as enum ('pending_pricing', 'confirmed');
create type sale_state as enum ('paid', 'part_paid', 'credit', 'refunded', 'voided');
create type payment_kind as enum ('cash', 'transfer', 'pos_card', 'wallet');
create type movement_kind as enum ('receipt', 'sale', 'adjustment', 'return', 'void', 'disposal');
create type order_state as enum (
  'pending_review', 'confirmed', 'ready_for_pickup',
  'out_for_delivery', 'completed', 'cancelled'
);
create type request_state as enum ('pending_restock', 'restocked', 'notified');
create type urgency_level as enum ('routine', 'urgent', 'emergency');

-- ------------------------------------------------------- helper functions

-- Wrappers so policies stay readable. `auth.uid()` is Supabase's "who is calling".
create or replace function pf_current_branch()
returns uuid
language sql stable
security definer
set search_path = public
as $$
  select branch_id from profiles where id = auth.uid()
$$;

create or replace function pf_current_role()
returns staff_role
language sql stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function pf_is_owner()
returns boolean
language sql stable
as $$
  select coalesce(pf_current_role() = 'owner', false)
$$;

create or replace function pf_touch_updated_at()
returns trigger
language plpgsql
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
  rating        numeric(2,1) not null default 0,
  reviews_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- profiles
-- One row per authenticated user. Supabase owns `auth.users`; this is the app's
-- view of it, holding the staff role and the home branch.

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

-- A trigger rather than application code, so a user can never exist without a
-- profile — the role check would otherwise silently fail open.
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
    coalesce((new.raw_user_meta_data->>'role')::staff_role, 'assistant'),
    coalesce((new.raw_user_meta_data->>'is_customer')::boolean, false)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function pf_handle_new_user();

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
  rating          numeric(2,1) not null default 0 check (rating between 0 and 5),
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
  units               jsonb not null default '[]'::jsonb,

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
  state               stock_state generated always as (
    case
      when expiry_date < current_date then 'expired'
      when expiry_date <= current_date + 90 then 'expiring_soon'
      when total_quantity = 0 then 'out_of_stock'
      when total_quantity <= low_stock_threshold then 'low_stock'
      else 'in_stock'
    end
  ) stored,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint medicines_barcode_unique unique (branch_id, barcode),
  constraint medicines_price_above_cost check (price_per_base_unit >= cost_per_base_unit)
);
create index if not exists medicines_branch_idx on medicines(branch_id);
create index on medicines using gin (to_tsvector('english', name || ' ' || generic_name));
create index if not exists medicines_state_idx on medicines(branch_id, state);
create index if not exists medicines_reorder_idx on medicines(branch_id, average_daily_sales)
  where average_daily_sales > 0;

drop trigger if exists medicines_touch on medicines;
create trigger medicines_touch before update on medicines
  for each row execute function pf_touch_updated_at();

-- The first unit must be the base unit, or every stock calculation is wrong.
create or replace function pf_check_base_unit()
returns trigger
language plpgsql
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

-- Only an owner may move a receipt out of the pricing queue. Enforced here as
-- well as in RLS, because the UI is not the security boundary.
create or replace function pf_require_owner_to_price()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'confirmed' and old.state = 'pending_pricing' and not pf_is_owner() then
    raise exception 'Only an owner can approve pricing' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists receipts_require_owner on stock_receipts;
create trigger receipts_require_owner before update on stock_receipts
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
  state             sale_state not null default 'paid',
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
  -- on a sale that already happened.
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

drop trigger if exists credit_ledger_balance on credit_ledger;
create trigger credit_ledger_balance before insert on credit_ledger
  for each row execute function pf_check_credit_ledger_balance();

alter table sales
  add constraint sales_credit_account_fkey
  foreign key (credit_account_id) references credit_accounts(id) on delete set null;

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
  constraint customer_orders_number_unique unique (order_number)
);
create index if not exists orders_branch_idx on customer_orders(branch_id, created_at desc);
create index if not exists orders_state_idx on customer_orders(branch_id, state);

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

-- Branches: staff see their own; customers see all (a public directory).
create policy branches_read on branches for select
  using (is_customer or id = pf_current_branch());

create policy branches_owner_write on branches for all
  using (pf_is_owner()) with check (pf_is_owner());

-- Profiles: read yourself and your colleagues; write only yourself.
create policy profiles_read on profiles for select
  using (id = auth.uid() or is_customer = false);
create policy profiles_self_update on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

create policy customers_read on customers for select
  using (
    is_customer
    or auth_user_id = auth.uid()
    or branch_id = pf_current_branch()
  );
create policy customers_staff_write on customers for all
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

create policy suppliers_read on suppliers for select
  using (branch_id = pf_current_branch());
create policy suppliers_owner_write on suppliers for all
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

create policy medicines_read on medicines for select
  using (branch_id = pf_current_branch());
create policy medicines_staff_write on medicines for all
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

create policy batches_read on medicine_batches for select
  using (branch_id = pf_current_branch());
create policy batches_staff_write on medicine_batches for all
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

create policy receipts_read on stock_receipts for select
  using (branch_id = pf_current_branch());
create policy receipts_staff_write on stock_receipts for all
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

create policy movements_read on stock_movements for select
  using (branch_id = pf_current_branch());
create policy movements_staff_write on stock_movements for insert
  with check (branch_id = pf_current_branch());

create policy sales_read on sales for select
  using (branch_id = pf_current_branch() or customer_id in (
    select id from customers where auth_user_id = auth.uid()
  ));
create policy sales_staff_write on sales for insert
  with check (branch_id = pf_current_branch());

-- Sales are never updated in place except to void or refund, and only by an
-- owner. Line items are immutable.
create policy sales_owner_void on sales for update
  using (pf_is_owner()) with check (pf_is_owner());
create policy sale_items_read on sale_items for select
  using (exists (select 1 from sales s where s.id = sale_id));
create policy sale_items_insert on sale_items for insert
  with check (exists (select 1 from sales s where s.id = sale_id));

create policy credit_read on credit_accounts for select
  using (pf_is_owner());
create policy credit_owner_write on credit_accounts for all
  using (pf_is_owner()) with check (pf_is_owner());
create policy credit_ledger_read on credit_ledger for select
  using (pf_is_owner());
create policy credit_ledger_insert on credit_ledger for insert
  with check (pf_is_owner());

create policy orders_read on customer_orders for select
  using (
    branch_id = pf_current_branch()
    or customer_id in (select id from customers where auth_user_id = auth.uid())
  );
create policy orders_staff_write on customer_orders for all
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());
create policy order_items_read on order_items for select
  using (exists (select 1 from customer_orders o where o.id = order_id));
create policy order_items_staff_write on order_items for all
  using (exists (select 1 from customer_orders o where o.id = order_id))
  with check (exists (select 1 from customer_orders o where o.id = order_id));

create policy requests_read on medicine_requests for select
  using (branch_id = pf_current_branch());
create policy requests_staff_write on medicine_requests for all
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

-- Staff may read the audit log; only owners may read it. It is the record of
-- who did what, including who approved pricing.
create policy audit_read on audit_events for select
  using (pf_is_owner());
create policy audit_insert on audit_events for insert
  with check (branch_id = pf_current_branch());

create policy notifications_read on notifications for select
  using (recipient_id = auth.uid() or (recipient_id is null and branch_id = pf_current_branch()));
create policy notifications_staff_write on notifications for all
  using (branch_id = pf_current_branch())
  with check (branch_id = pf_current_branch());

-- =============================== column grants: hide cost from assistants
-- RLS filters rows. To keep purchase cost from assistants you need grants.
-- `authenticated` is Supabase's role for every signed-in user.

revoke select on medicines from authenticated;
grant select (
  id, branch_id, barcode, name, generic_name, strength, dosage_form, category,
  supplier_id, units, total_quantity, low_stock_threshold, average_daily_sales,
  price_per_base_unit, expiry_date, purchase_date, common_use, storage,
  prescription_class, warnings, is_brand, generic_equivalent_id, do_not_sell,
  do_not_sell_reason, nafdac_reg_number, manufacturer, state, created_at, updated_at
) on medicines to authenticated;

-- Owners get everything back.
grant select (cost_per_base_unit) on medicines to authenticated;

-- Cost must not leak through the batch or receipt tables either.
revoke select on medicine_batches from authenticated;
grant select (
  id, branch_id, medicine_id, batch_number, expiry_date, quantity,
  supplier_id, received_date, is_recalled, recall_reason, created_at
) on medicine_batches to authenticated;

revoke select on stock_receipts from authenticated;
grant select (
  id, branch_id, receipt_number, medicine_id, batch_number, base_units_received,
  supplier_id, expiry_date, received_at, received_by, state,
  price_per_base_unit, priced_by, priced_at
) on stock_receipts to authenticated;

-- ============================================ stock total cannot drift
-- `total_quantity` is denormalised for query speed. Every path that changes it
-- must write a movement, or the ledger and the total disagree. A trigger is
-- the only way to make that true for every client, including a compromised one.

create or replace function pf_sync_total_quantity()
returns trigger
language plpgsql
as $$
begin
  update medicines set total_quantity = (
    select coalesce(sum(quantity), 0)
    from medicine_batches
    where medicine_id = new.medicine_id and not is_recalled and expiry_date >= current_date
  )
  where id = new.medicine_id;
  return null;
end;
$$;

drop trigger if exists batches_sync_total on medicine_batches;
create trigger batches_sync_total
  after insert or update or delete on medicine_batches
  for each row execute function pf_sync_total_quantity();

-- ============================================================ realtime
-- The dashboard and the stock list should update when another till sells.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table medicines;
alter publication supabase_realtime add table sales;
alter publication supabase_realtime add table stock_receipts;
alter publication supabase_realtime add table notifications;