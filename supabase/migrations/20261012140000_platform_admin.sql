-- ================================================== platform administration
--
-- ## What this is for
--
-- PharmaFlow is becoming a multi-tenant SaaS: the platform operator needs to
-- onboard pharmacies, invite their first owner, watch platform activity, and
-- suspend a pharmacy without deleting its records. Each pharmacy owner then runs
-- their own pharmacy exactly as they do today.
--
-- ## The smallest secure design
--
-- `staff_role` is `('owner','assistant')` and is used for branch-level authority
-- everywhere. Widening that enum would make a platform operator look like a
-- pharmacy owner to every policy that reads it, which is precisely the confusion
-- this avoids. Instead:
--
--   * `profiles.is_platform_admin` - one boolean, alongside the existing
--     `is_customer`. Same shape, same convention, one new concept rather than a
--     second role system.
--
-- ## Why a client cannot grant itself this flag
--
-- Three independent reasons, any one of which is sufficient:
--
--   1. `20261002160000_initial_schema.sql` runs `revoke update on profiles from
--      authenticated` and **nothing ever re-grants it**. Every profile column is
--      writable only by a trigger or a service_role connection.
--   2. `pf_guard_profile_privileges` below is redefined to treat a change to this
--      column the same as a change to `role`: trusted context only.
--   3. `pf_grant_platform_admin` is `service_role`-only. No browser, at any role,
--      can call it.
--
-- There is deliberately no email allow-list, no metadata lookup and no
-- environment flag. Those are all things a client can influence.

-- ---------------------------------------------------------------------------
-- 1. The flag, and the predicate that reads it
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists is_platform_admin boolean not null default false;

comment on column public.profiles.is_platform_admin is
  'Platform operator. Set only by pf_grant_platform_admin under service_role. '
  'Not part of staff_role: a platform operator is not a pharmacy owner, and '
  'must never satisfy a branch-level policy.';

-- `pf_guard_profile_privileges` is redefined in full below.

create or replace function public.pf_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

comment on function public.pf_is_platform_admin() is
  'True when the caller was granted platform administration by '
  'pf_grant_platform_admin under service_role. Reads only the caller''s own row, '
  'so a caller with no profile is false rather than an error.';

-- ---------------------------------------------------------------------------
-- 2. Pharmacy lifecycle status
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'pharmacy_status') then
    create type public.pharmacy_status as enum ('pending', 'active', 'suspended');
  end if;
end $$;

-- Defaulted to 'active' on purpose: every pharmacy that exists today is active,
-- including Endline Pharmacy. A pharmacy only becomes 'pending' when the
-- platform operator creates it, and only becomes 'suspended' deliberately.
alter table public.branches
  add column if not exists status public.pharmacy_status not null default 'active',
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text,
  add column if not exists activated_at timestamptz;

create index if not exists branches_status_idx
  on public.branches (status, created_at desc);

comment on column public.branches.status is
  'pending = created but the owner has not accepted their invitation yet; '
  'active = operating; suspended = access withdrawn, records retained.';

-- ---------------------------------------------------------------------------
-- 3. Suspension fails closed, in one place
--
-- `pf_current_branch()` is what every RLS policy in the schema reads. Returning
-- NULL for a suspended branch therefore withdraws access to medicines, sales,
-- customers, orders and audit at the same instant, without editing fifty
-- policies and without any of them disagreeing about what "suspended" means.
--
-- NULL rather than an exception: the existing policies already treat a NULL
-- branch as "matches nothing", so this composes with them instead of forcing
-- every policy to be taught a new error path.
create or replace function public.pf_current_branch()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.branch_id
  from public.profiles p
  where p.id = auth.uid()
    and exists (
      select 1 from public.branches b
      where b.id = p.branch_id
        and b.status <> 'suspended'
    );
$$;

comment on function public.pf_current_branch() is
  'The caller''s active branch, or NULL when they have none, are a customer, or '
  'their branch is suspended. Every RLS policy reads this, so a suspension '
  'withdraws access everywhere at once. A platform administrator has no branch '
  'and reads through the pf_platform_* views instead.';

-- ---------------------------------------------------------------------------
-- 4. Profile privilege guard, extended
-- ---------------------------------------------------------------------------

create or replace function public.pf_guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The platform flag is in the same list as `role`. Not because an owner could
  -- otherwise set it - the table UPDATE is revoked from authenticated, so
  -- nobody can - but so that a future re-grant of that grant cannot silently
  -- turn this column into a privilege-escalation path.
  if new.is_platform_admin is distinct from old.is_platform_admin then
    if auth.uid() is null then
      return new;  -- trusted server context: a migration or service_role
    end if;

    raise exception 'Platform administration is granted only by the platform operator'
      using errcode = 'insufficient_privilege';
  end if;

  if new.role is distinct from old.role
     or new.branch_id is distinct from old.branch_id
     or new.is_customer is distinct from old.is_customer then

    if auth.uid() is null then
      return new;  -- trusted server context
    end if;

    -- Switching to a branch you belong to, keeping the role that branch grants.
    if exists (
      select 1 from public.branch_memberships m
      where m.user_id = auth.uid()
        and m.branch_id = new.branch_id
        and m.role = new.role
    ) then
      return new;
    end if;

    if not public.pf_is_owner() then
      raise exception 'Only an owner can change a role, branch or customer flag'
        using errcode = 'insufficient_privilege';
    end if;

    if new.branch_id is distinct from public.pf_current_branch() then
      raise exception 'An owner can only assign staff inside their own branch'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Provisioning - service_role only
-- ---------------------------------------------------------------------------
--
-- The operator runs this once, from a machine with the service_role key. It is
-- the only path that can set the flag.
--
-- It matches on `email`, but the EMAIL IS NOT THE AUTHORITY - it is only how
-- the operator identifies which account to promote. The authorisation is the
-- service_role connection executing this function; an `authenticated` caller
-- cannot reach it at all, because the EXECUTE grant is withheld below.

create or replace function public.pf_grant_platform_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Belt and braces. `auth.uid()` is NULL for a service_role connection and set
  -- for every gateway request, so this refuses anything that arrives through
  -- PostgREST even if the grants below are later widened by mistake.
  if auth.uid() is not null then
    raise exception 'Platform administration is granted only by the platform operator'
      using errcode = 'insufficient_privilege';
  end if;

  if p_email is null or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address' using errcode = 'invalid_parameter_value';
  end if;

  update public.profiles
     set is_platform_admin = true
   where id = (
     select u.id from auth.users u where lower(u.email) = lower(p_email)
   )
  returning id into v_id;

  if v_id is null then
    raise exception 'No account exists for that email address' using errcode = 'no_data_found';
  end if;

  return v_id;
end;
$$;

comment on function public.pf_grant_platform_admin(text) is
  'service_role ONLY - no EXECUTE is granted to anon or authenticated, and the '
  'function refuses any request carrying a JWT. Promotes the account with this '
  'email to platform administrator. Run once by the platform operator.';

revoke execute on function public.pf_grant_platform_admin(text) from public;
revoke execute on function public.pf_grant_platform_admin(text) from anon;
revoke execute on function public.pf_grant_platform_admin(text) from authenticated;

-- ---------------------------------------------------------------------------
-- 6. Onboarding a pharmacy
-- ---------------------------------------------------------------------------

create or replace function public.pf_create_pharmacy(
  p_actor         uuid,
  p_pharmacy_name text,
  p_owner_name    text,
  p_owner_email   text,
  p_phone         text default '',
  p_address       text default '',
  p_city          text default '',
  p_state         text default ''
)
returns table (
  branch_id        uuid,
  pharmacy_name    text,
  owner_invitation uuid,
  invitation_token text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid;
  v_inv    uuid;
  v_token  text;
begin
  -- ------------------------------------------------- authority
  --
  -- The actor is an ARGUMENT, not `auth.uid()`, and that is deliberate. This
  -- function is reachable only with the service-role key, and a service-role
  -- connection carries no JWT - so requiring `auth.uid()` would make the two
  -- conditions contradictory and onboarding impossible.
  --
  -- Verifying an argument instead of a claim does not weaken anything, because:
  --
  --   * no browser can call this at all (no EXECUTE for anon or authenticated);
  --   * the id is not taken on trust - it is resolved against `profiles`, so a
  --     Worker that passed the wrong id, or an owner who passed their own, is
  --     refused by the database rather than by convention.
  if p_actor is null then
    raise exception 'No acting administrator' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.profiles p
     where p.id = p_actor and p.is_platform_admin
  ) then
    raise exception 'Only a platform administrator can onboard a pharmacy'
      using errcode = 'insufficient_privilege';
  end if;

  -- ------------------------------------------------- input
  if p_pharmacy_name is null or btrim(p_pharmacy_name) = '' then
    raise exception 'Enter the pharmacy name' using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(p_pharmacy_name)) > 120 then
    raise exception 'The pharmacy name is too long' using errcode = 'invalid_parameter_value';
  end if;
  if p_owner_name is null or btrim(p_owner_name) = '' then
    raise exception 'Enter the owner''s name' using errcode = 'invalid_parameter_value';
  end if;
  if p_owner_email is null
     or p_owner_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid owner email address' using errcode = 'invalid_parameter_value';
  end if;

  -- ------------------------------------------------- duplicates
  --
  -- Two guards, both about not creating a second pharmacy by accident:
  --
  --   * a name already in use, so "Endline Pharmacy" cannot be created twice
  --     and accidentally orphaned from its real owner;
  --   * a live owner invitation already out to that address, so a double click
  --     cannot produce two invitations that both work.
  if exists (
    select 1 from public.branches b
     where lower(btrim(b.name)) = lower(btrim(p_pharmacy_name))
  ) then
    raise exception 'A pharmacy with that name already exists' using errcode = 'unique_violation';
  end if;

  if exists (
    select 1 from public.staff_invitations i
     where lower(i.email) = lower(btrim(p_owner_email))
       and i.accepted_at is null
       and i.revoked_at is null
  ) then
    raise exception 'There is already a live invitation for that email address'
      using errcode = 'unique_violation';
  end if;

  -- ------------------------------------------------- the pharmacy
  --
  -- 'pending', not 'active': the pharmacy does not exist operationally until its
  -- owner has accepted and set their own password. `pf_redeem_invitation` then
  -- activates it, at the bottom of this file.
  insert into public.branches (name, address, city, state, phone, status, is_main_hub)
  values (
    btrim(p_pharmacy_name),
    coalesce(btrim(p_address), ''),
    coalesce(btrim(p_city), ''),
    coalesce(btrim(p_state), ''),
    coalesce(btrim(p_phone), ''),
    'pending'::public.pharmacy_status,
    true
  )
  returning id into v_branch;

  -- ------------------------------------------------- the owner invitation
  --
  -- Written directly rather than through `pf_create_invitation`, because that
  -- function takes its branch from `pf_current_branch()` and a platform operator
  -- has no branch - it is a function for an owner inviting into their own
  -- pharmacy, which is a different operation and stays that way.
  --
  -- The token uses the column default: two `gen_random_uuid()` calls, 256 bits,
  -- generated in the database so a client cannot choose a predictable value.
  insert into public.staff_invitations (branch_id, email, role, invited_by)
  values (v_branch, lower(btrim(p_owner_email)), 'owner'::public.staff_role, p_actor)
  returning id, token into v_inv, v_token;

  -- ------------------------------------------------- record it
  --
  -- `audit_events.branch_id` is NOT NULL, so a platform action is recorded
  -- against the pharmacy it affected. That is more useful than a platform-level
  -- log: the onboarding appears in that pharmacy's own history, and the
  -- pf_platform_activity view collects them all.
  insert into public.audit_events (branch_id, actor_id, action, description, metadata)
  values (
    v_branch, p_actor, 'pharmacy_created',
    format('Onboarded %s and invited %s as owner', btrim(p_pharmacy_name), btrim(p_owner_email)),
    jsonb_build_object(
      'pharmacy_name', btrim(p_pharmacy_name),
      'owner_email',   lower(btrim(p_owner_email)),
      'owner_name',    btrim(p_owner_name),
      'invitation_id', v_inv
    )
  );

  branch_id        := v_branch;
  pharmacy_name    := btrim(p_pharmacy_name);
  owner_invitation := v_inv;
  -- Returned to the SERVER so it can send the email. `pf_create_pharmacy` is not
  -- exposed to a browser (no EXECUTE grant below): the only caller is a Worker
  -- route holding the service-role key, which emails the token and does not put
  -- it in the response body.
  invitation_token := v_token;
  return next;
end;
$$;

comment on function public.pf_create_pharmacy(uuid, text, text, text, text, text, text, text) is
  'Platform administrator only. Creates a pharmacy as ''pending'' and issues its '
  'first owner invitation in one transaction, so a failure leaves neither a '
  'half-made pharmacy nor an orphan invitation. Refuses a duplicate pharmacy '
  'name and a second live invitation for the same address.';

-- ---------------------------------------------------------------------------
-- 7. Suspending and reactivating a pharmacy
-- ---------------------------------------------------------------------------

create or replace function public.pf_set_pharmacy_status(
  p_actor     uuid,
  p_branch_id uuid,
  p_status    public.pharmacy_status,
  p_reason    text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_was  public.pharmacy_status;
begin
  -- Same reasoning as pf_create_pharmacy: service-role only, so the actor is
  -- resolved from the database rather than from a JWT claim.
  if p_actor is null then
    raise exception 'No acting administrator' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.profiles p
     where p.id = p_actor and p.is_platform_admin
  ) then
    raise exception 'Only a platform administrator can change a pharmacy''s status'
      using errcode = 'insufficient_privilege';
  end if;

  select b.name, b.status into v_name, v_was
    from public.branches b
   where b.id = p_branch_id;

  if not found then
    raise exception 'Pharmacy not found' using errcode = 'no_data_found';
  end if;

  if v_was = p_status then
    return false;  -- nothing to do, and not an error
  end if;

  if p_status = 'suspended' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Give a reason for suspending a pharmacy'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.branches
     set status = p_status,
         suspended_at = case when p_status = 'suspended' then now() else null end,
         suspended_reason = case when p_status = 'suspended' then btrim(p_reason) else null end,
         activated_at = case when p_status = 'active' then now() else activated_at end
   where id = p_branch_id;

  insert into public.audit_events (branch_id, actor_id, action, description, metadata)
  values (
    p_branch_id, p_actor, 'pharmacy_status_changed',
    format('%s changed from %s to %s', v_name, v_was, p_status),
    jsonb_build_object('from', v_was, 'to', p_status, 'reason', p_reason)
  );

  return true;
end;
$$;

comment on function public.pf_set_pharmacy_status(uuid, uuid, public.pharmacy_status, text) is
  'Platform administrator only. Suspending withdraws access everywhere because '
  'pf_current_branch() returns NULL for a suspended branch; it deletes nothing. '
  'Returns false when the status is already what was asked for.';

-- ---------------------------------------------------------------------------
-- 8. Redeeming the first owner's invitation activates the pharmacy
-- ---------------------------------------------------------------------------

create or replace function public.pf_redeem_invitation(p_token text)
returns table (branch uuid, granted_role public.staff_role)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_inv    public.staff_invitations;
  v_email  text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception 'Enter your invite code' using errcode = 'invalid_parameter_value';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  -- `for update` so two people racing on the same token cannot both pass the
  -- `accepted_at is null` test below.
  select * into v_inv
  from public.staff_invitations i
  where i.token = btrim(p_token)
    and i.accepted_at is null
    and i.revoked_at is null
    and (i.expires_at is null or i.expires_at > now())
  for update;

  if not found then
    -- Distinguished from a used or withdrawn code so the caller can say "expired"
    -- rather than "invalid", which is a materially different instruction for
    -- whoever is holding the email. Carried over verbatim from
    -- 20261006150000_staff_invitation_expiry.sql: this function is redefined here
    -- only to add the pharmacy activation below, and dropping this clause while
    -- doing so would silently make expired invitations work again.
    if exists (
      select 1 from public.staff_invitations i
      where i.token = btrim(p_token)
        and (i.expires_at is not null and i.expires_at <= now())
    ) then
      raise exception 'That invitation has expired. Ask your owner to send a new one.'
        using errcode = 'invalid_parameter_value';
    end if;

    raise exception 'That invite code is not valid, or has already been used'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The binding that makes a forwarded link inert. The token proves you were
  -- sent the link; this proves the link was sent to *you*.
  if v_inv.email is distinct from v_email then
    raise exception 'This invite was issued to a different email address'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.branch_memberships m
    where m.user_id = auth.uid()
      and m.branch_id = v_inv.branch_id
  ) then
    raise exception 'You already work at this pharmacy'
      using errcode = 'unique_violation';
  end if;

  -- Role and branch come from the invitation row only. There is no argument
  -- through which a caller could ask for a different branch or a higher role.
  insert into public.branch_memberships (user_id, branch_id, role, is_default)
  values (auth.uid(), v_inv.branch_id, v_inv.role, true);

  update public.staff_invitations
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_inv.id;

  -- The one line this differs from 20261006090000: a pharmacy created by the
  -- platform operator becomes operational the moment its owner arrives.
  update public.branches
     set status = 'active'::public.pharmacy_status,
         activated_at = now()
   where id = v_inv.branch_id
     and status = 'pending'::public.pharmacy_status;

  insert into public.audit_events (branch_id, actor_id, action, description, metadata)
  values (
    v_inv.branch_id, auth.uid(), 'pharmacy_activated',
    format('%s accepted their owner invitation', v_email),
    jsonb_build_object('invitation_id', v_inv.id, 'role', v_inv.role)
  );

  return query select v_inv.branch_id, v_inv.role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Platform views
-- ---------------------------------------------------------------------------
--
-- `security_invoker = false`, so the view runs as its owner and RLS is bypassed -
-- which is the only way one row per pharmacy from every tenant can be returned.
-- That makes the `pf_is_platform_admin()` predicate inside each view the ONLY
-- thing standing between this data and every signed-in user, so it is not
-- optional and is never to be removed.
--
-- `grant select ... to authenticated` is deliberate: a non-administrator gets an
-- empty result rather than a permission error, exactly like `pf_medicine_costs`.

create or replace view public.pf_platform_pharmacies with (security_invoker = false) as
  select
    b.id,
    b.name,
    b.status,
    b.address,
    b.city,
    b.state,
    b.phone,
    b.created_at,
    b.activated_at,
    b.suspended_at,
    b.suspended_reason,
    (select count(*)::int from public.branch_memberships m where m.branch_id = b.id) as member_count,
    (select p.full_name from public.branch_memberships m
       join public.profiles p on p.id = m.user_id
      where m.branch_id = b.id and m.role = 'owner'::public.staff_role
      order by m.is_default desc, m.created_at asc limit 1) as owner_name,
    (select p.id from public.branch_memberships m
       join public.profiles p on p.id = m.user_id
      where m.branch_id = b.id and m.role = 'owner'::public.staff_role
      order by m.is_default desc, m.created_at asc limit 1) as owner_id,
    (select i.email from public.staff_invitations i
      where i.branch_id = b.id and i.role = 'owner'::public.staff_role
      order by i.created_at desc limit 1) as owner_invitation_email,
    (select i.created_at from public.staff_invitations i
      where i.branch_id = b.id and i.role = 'owner'::public.staff_role
      order by i.created_at desc limit 1) as owner_invited_at,
    (select i.accepted_at from public.staff_invitations i
      where i.branch_id = b.id and i.role = 'owner'::public.staff_role
      order by i.created_at desc limit 1) as owner_accepted_at,
    -- Administration activity only: role changes, onboarding, status changes.
    -- NOT product use. The column name has always read as "last activity", which
    -- invites exactly the wrong conclusion. It is kept as-is for backward
    -- compatibility and must not be used as an adoption metric - see the column
    -- below for that.
    (select max(a.created_at) from public.audit_events a where a.branch_id = b.id) as last_activity_at,

    -- Business activity: the last time this pharmacy actually did work.
    --
    -- `greatest()` over the two tables that carry real operational timestamps.
    -- Both are needed, for opposite reasons:
    --
    --   * A sale line with no `batch_id` moves no stock, so it produces NO
    --     movement row. Sales alone catch it.
    --   * Receiving, adjusting and disposing of stock produce movement rows but
    --     no sale. Movements alone catch them.
    --
    -- Using either table on its own would under-count, and a pharmacy that
    -- receives stock but has not sold yet would look inactive.
    --
    -- Deliberately NOT included:
    --
    --   * `audit_events` - administration, not adoption. That is what the
    --     column above measures, and conflating the two is the bug this fixes.
    --   * `customer_orders` - never written by the application. Including it
    --     would imply a capability that does not exist.
    --   * `stock_receipts` - receiving already emits a movement row with
    --     kind='receipt', so it would be redundant.
    --
    -- A void is genuine activity and creates its own movement row, so voided
    -- sales are not filtered out: doing so would hide real work.
    --
    -- NULL means the pharmacy has never transacted, which is the honest answer.
    -- `greatest()` ignores NULL rather than propagating it, so a pharmacy with
    -- sales but no movements still reports its most recent sale.
    greatest(
      (select max(s.sold_at)    from public.sales           s where s.branch_id = b.id),
      (select max(m.created_at) from public.stock_movements m where m.branch_id = b.id)
    ) as last_business_activity_at
  from public.branches b
  where public.pf_is_platform_admin();

comment on view public.pf_platform_pharmacies is
  'Every pharmacy with its owner and onboarding state. Empty for anyone who is '
  'not a platform administrator - the WHERE clause is the security boundary. '
  'TWO ACTIVITY COLUMNS, and they do not mean the same thing: '
  '`last_activity_at` is ADMINISTRATION activity (role changes, onboarding, '
  'status changes) and is not an adoption signal; '
  '`last_business_activity_at` is PRODUCT activity (a sale recorded, or stock '
  'received, moved, adjusted or disposed of) and is the one to use for '
  'adoption. NULL on the latter means the pharmacy has never transacted.';

-- Orders and activity, joined to the pharmacy name so the dashboard does not
-- have to make a second query per row.
create or replace view public.pf_platform_orders with (security_invoker = false) as
  select
    o.id,
    o.branch_id,
    b.name as pharmacy_name,
    o.order_number,
    o.state,
    o.payment_state,
    o.delivery_type,
    o.created_at,
    o.updated_at,
    -- Count only, never the customer's identity: a platform operator supervising
    -- fulfilment does not need to know who the customer is.
    (select count(*)::int from public.order_items oi where oi.order_id = o.id) as item_count
  from public.customer_orders o
  join public.branches b on b.id = o.branch_id
  where public.pf_is_platform_admin();

comment on view public.pf_platform_orders is
  'Cross-pharmacy customer orders. Excludes customer identity and prescription '
  'content by design: supervising fulfilment does not require either.';

create or replace view public.pf_platform_activity with (security_invoker = false) as
  select
    a.id,
    a.branch_id,
    b.name as pharmacy_name,
    a.actor_id,
    p.full_name as actor_name,
    a.action,
    a.description,
    a.created_at
  from public.audit_events a
  join public.branches b on b.id = a.branch_id
  left join public.profiles p on p.id = a.actor_id
  where public.pf_is_platform_admin();

comment on view public.pf_platform_activity is
  'Platform-wide audit trail. `metadata` is deliberately NOT exposed here: it is '
  'free-form jsonb and could carry anything a future writer puts in it.';

grant select on public.pf_platform_pharmacies to authenticated;
grant select on public.pf_platform_orders     to authenticated;
grant select on public.pf_platform_activity   to authenticated;

-- ---------------------------------------------------------------------------
-- 9b. The switcher must agree with what pf_current_branch() accepts
-- ---------------------------------------------------------------------------
--
-- `pf_my_branches` predates the status column and matched on membership alone, so
-- a suspended pharmacy kept appearing in the branch switcher: an option the user
-- could select that `pf_set_active_branch()` would then refuse. That exact class
-- of bug is called out in 20261004090000_stock_ledger_and_fefo_foundation.sql, and
-- it is why both are defined here rather than one at a time.
create or replace view pf_my_branches with (security_invoker = false) as
  select b.*
  from public.branches b
  where b.status <> 'suspended'
    and exists (
      select 1 from public.branch_memberships m
      where m.user_id = auth.uid() and m.branch_id = b.id
    );

comment on view pf_my_branches is
  'Branches the caller may switch to. Excludes suspended pharmacies, so the '
  'switcher never offers a branch pf_set_active_branch() would refuse.';

grant select on pf_my_branches to authenticated;

-- ---------------------------------------------------------------------------
-- 9c. Telling a suspended user what happened
-- ---------------------------------------------------------------------------
--
-- Suspension makes `pf_current_branch()` return NULL, which means every
-- branch-scoped read comes back empty. That is the correct fail-closed
-- behaviour, but from the inside it is indistinguishable from "this pharmacy has
-- no data", which is a confusing thing to show somebody whose business was
-- switched off by an operator.
--
-- So this answers exactly one question - is my own branch suspended - and
-- nothing else. It returns a single word for the caller's own branch. It cannot
-- be pointed at another pharmacy, cannot enumerate anything, and grants no
-- access that `pf_current_branch() = NULL` has not already withdrawn.
create or replace function public.pf_my_branch_status()
returns public.pharmacy_status
language sql
stable
security definer
set search_path = public
as $$
  select b.status
  from public.profiles p
  join public.branches b on b.id = p.branch_id
  where p.id = auth.uid();
$$;

comment on function public.pf_my_branch_status() is
  'Status of the caller''s own branch, including when it is suspended. Read-only '
  'and self-scoped: it exposes one word about the caller''s own pharmacy and '
  'nothing about any other.';

revoke execute on function public.pf_my_branch_status() from public;
revoke execute on function public.pf_my_branch_status() from anon;
grant execute on function public.pf_my_branch_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 9d. The branch switcher must refuse a suspended pharmacy
-- ---------------------------------------------------------------------------
--
-- `pf_set_active_branch()` (20261004090000) authorises against
-- `branch_memberships` and nothing else. It has no status check, so before this
-- definition it would happily select a suspended pharmacy, write that id onto
-- `profiles.branch_id`, and report success.
--
-- Nothing leaks. `pf_current_branch()` still returns NULL for a suspended
-- branch, so every read and every write is still refused - the access decision
-- was never in doubt. What was wrong is the *lie*: the client is told it switched
-- to a pharmacy it cannot read, so the interface shows an empty counter and the
-- user has no way to learn why. That is exactly the confusion this migration
-- exists to remove, and it contradicts the claim on `pf_my_branches` below.
--
-- Everything else is the original function, unchanged. In particular the NULL
-- `auth.uid()` bootstrap path still skips the profile update, because that is
-- how the first membership is created by a migration or the SQL editor.
create or replace function public.pf_set_active_branch(p_branch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role staff_role;
  target_status pharmacy_status;
begin
  if p_branch_id is null then
    raise exception 'Pick a branch' using errcode = 'invalid_parameter_value';
  end if;

  select bm.role, b.status
  into target_role, target_status
  from branch_memberships bm
  join branches b on b.id = bm.branch_id
  where bm.user_id = auth.uid() and bm.branch_id = p_branch_id;

  if target_role is null then
    raise exception 'You are not assigned to that branch'
      using errcode = 'insufficient_privilege';
  end if;

  -- Refuse a withdrawn pharmacy. `pending` is allowed through on purpose: an
  -- owner who has been invited but has not accepted yet has a membership to
  -- select, and refusing them would strand the acceptance flow.
  if target_status = 'suspended' then
    raise exception 'This pharmacy is suspended. Contact the platform operator.'
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

comment on function public.pf_set_active_branch(uuid) is
  'Client RPC for the branch switcher. Authorises against branch_memberships for '
  'auth.uid(), and since 20261012140000 also refuses a suspended branch. Without '
  'the status check it reported success for a pharmacy it then refused to read.';

revoke execute on function public.pf_set_active_branch(uuid) from public;
revoke execute on function public.pf_set_active_branch(uuid) from anon;
grant execute on function public.pf_set_active_branch(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Execute grants
-- ---------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC by default. Onboarding and suspension are
-- reached through Worker routes holding the service-role key, so no `pf_*`
-- platform function is granted to `authenticated` at all - which is the same
-- posture `pf_claim_invitation` already takes.

revoke execute on function public.pf_create_pharmacy(uuid, text, text, text, text, text, text, text) from public;
revoke execute on function public.pf_create_pharmacy(uuid, text, text, text, text, text, text, text) from anon;
revoke execute on function public.pf_create_pharmacy(uuid, text, text, text, text, text, text, text) from authenticated;

revoke execute on function public.pf_set_pharmacy_status(uuid, uuid, public.pharmacy_status, text) from public;
revoke execute on function public.pf_set_pharmacy_status(uuid, uuid, public.pharmacy_status, text) from anon;
revoke execute on function public.pf_set_pharmacy_status(uuid, uuid, public.pharmacy_status, text) from authenticated;

grant execute on function public.pf_is_platform_admin() to authenticated;

-- The predicate is the exception to the posture below: RLS policies and the
-- `pf_platform_*` views evaluate it as the querying role, so without this grant
-- they would fail closed with a permission error rather than an empty set.
-- `verify-function-surface.mjs` is what caught the missing revokes.
revoke execute on function public.pf_is_platform_admin() from public;
revoke execute on function public.pf_is_platform_admin() from anon;

-- service_role, explicitly.
--
-- Revoking from PUBLIC also strips service_role, because it inherits nothing but
-- PUBLIC on Supabase. Without these grants the Worker routes holding the
-- service-role key could not call any of it, and onboarding would fail at
-- runtime with a permission error rather than at review.
--
-- This is the only grant that makes these functions reachable at all. No browser
-- role can execute any of them.
grant execute on function public.pf_grant_platform_admin(text) to service_role;
grant execute on function public.pf_create_pharmacy(uuid, text, text, text, text, text, text, text) to service_role;
grant execute on function public.pf_set_pharmacy_status(uuid, uuid, public.pharmacy_status, text) to service_role;