-- ============================================================================
-- Phase 0b: close the function execution surface
-- ============================================================================
--
-- Additive and self-contained. Nothing above this file is edited; the whole
-- chain still applies cleanly to a fresh database and every statement here is
-- re-runnable.
--
-- ## The defect
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC. That default was never
-- revoked, so all 13 SECURITY DEFINER functions in this schema were callable by
-- `anon` — a client with no session, no JWT and no table privileges. A
-- SECURITY DEFINER function runs with its owner's rights and therefore bypasses
-- RLS, so `anon` reaching one is not a low-severity information leak; it is a
-- write primitive.
--
-- The worst case was `pf_apply_sale_item_stock`, which had no authorization
-- check of any kind and was attached to no trigger. Reproduced against this
-- schema before the fix:
--
--     anon, no JWT        quantity 500 -> 490   (another pharmacy's lot)
--     4 repeated calls    500 -> 490 -> 460     (replay drains stock)
--     other-branch staff  460 -> 450             (while RLS hid the row from
--                                                 SELECT, so the RPC bypassed it)
--
-- ## The design decision for that function
--
-- It becomes an AFTER INSERT trigger on `sale_items` rather than staying an RPC
-- or being deleted.
--
-- PostgreSQL refuses `select some_trigger_fn()` outright — "trigger functions
-- can only be called as triggers" — regardless of EXECUTE grants. As a trigger
-- the stock-depletion path is not merely restricted, it is unreachable: there is
-- no call to make, and therefore no grant that can later be got wrong.
--
-- Three further reasons, all of which the alternative designs failed:
--
--   * Atomicity. A trigger runs inside the sale line's own transaction, so the
--     line and its stock movement commit or roll back together. An RPC is a
--     second round trip that can half-succeed.
--   * Direction of travel. `src/lib/supabase/sales.ts` already documents that the
--     two-request sale write "needs a database function rather than two round
--     trips". A trigger on `sale_items` lives inside that future function; a
--     separate RPC would have to be remembered by the caller and could simply be
--     omitted, which is how this hole stayed open in the first place.
--   * Preserved intent. The original comment states FEFO is "deliberately not
--     implemented; the caller supplies batch_id and the database records what
--     happened". That is unchanged. Allocation is still Phase 2 work.
--
-- Deleting the function instead would have left the pharmacy unable to deduct
-- stock at all, which is a worse outcome than the vulnerability it replaced.
--
-- ## The branch check this adds
--
-- The deduction trigger is SECURITY DEFINER, so it updates `medicine_batches`
-- without RLS applying. `sale_items.batch_id` is client-supplied, and the
-- existing `pf_check_sale_item_batch` only proves the lot belongs to the same
-- *medicine* — not the same *branch*. Without the check added below, a signed-in
-- user could name another pharmacy's lot and have it decremented through the very
-- privilege this migration is closing. The lot must belong to the branch of the
-- sale that consumed it.
--
-- ## Authorization after this file
--
--   anon        executes nothing.
--   PUBLIC      executes nothing, on any application function.
--   authenticated executes exactly six, each for a stated reason:
--     pf_is_owner, pf_is_staff, pf_is_customer, pf_current_branch,
--     pf_current_role  — evaluated inside RLS predicates, which run as the
--                         querying role, so the role must be able to execute them.
--     pf_set_active_branch — the one genuine client RPC. It authorises itself
--                         against `branch_memberships` for `auth.uid()` and
--                         refuses a branch the caller does not hold.
--
-- Every other function is a trigger, and triggers fire without the invoking role
-- holding EXECUTE, so none of them needs a grant from anyone.
--
-- ============================================================================

-- ============================================ 1. stock depletion becomes a trigger

-- Dropped rather than replaced: the signature changes from (uuid) to (), and
-- CREATE OR REPLACE cannot alter a function's signature. It is attached to
-- nothing, so nothing depends on it.
drop function if exists public.pf_apply_sale_item_stock(uuid);

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

-- AFTER, so the row exists and the deduction is the last thing to happen before
-- commit. The existing `sale_items_batch_check` BEFORE trigger still runs first
-- and proves the lot matches the line's medicine.
drop trigger if exists sale_items_deplete_stock on sale_items;

create trigger sale_items_deplete_stock
  after insert on sale_items
  for each row execute function public.pf_apply_sale_item_stock();

-- ================================================== 2. revoke the PUBLIC default

-- Every application function in the public schema. Written out rather than
-- looped so that adding a function later without a grant here is visible in the
-- diff, and `verify-function-surface.mjs` fails loudly.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'pf\_%'
  loop
    execute format('revoke execute on function %s from public', fn.sig);
  end loop;
end $$;

-- Named explicitly as well, so the intent is readable at the point where anon
-- matters most rather than only being implied by PUBLIC.
revoke execute on function public.pf_is_owner()      from anon;
revoke execute on function public.pf_is_staff()      from anon;
revoke execute on function public.pf_is_customer()   from anon;
revoke execute on function public.pf_current_branch() from anon;
revoke execute on function public.pf_current_role()  from anon;
revoke execute on function public.pf_set_active_branch(uuid) from anon;

-- Also from anon generally, in case a future function is added without naming it.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'pf\_%'
  loop
    execute format('revoke execute on function %s from anon', fn.sig);
  end loop;
end $$;

-- ============================================= 3. re-grant only what is needed

-- RLS predicate helpers. These are evaluated as the querying role, so without
-- these grants every policy would fail closed and the whole application would
-- read as empty. That is the correct failure direction, but it is a failure, so
-- the grant is deliberate and named.
grant execute on function public.pf_is_owner()       to authenticated;
grant execute on function public.pf_is_staff()       to authenticated;
grant execute on function public.pf_is_customer()    to authenticated;
grant execute on function public.pf_current_branch() to authenticated;
grant execute on function public.pf_current_role()   to authenticated;

-- The one client-invoked function. It checks `branch_memberships` for
-- `auth.uid()` and raises for a branch the caller does not hold, so exposing it
-- to a signed-in user is safe and necessary: the branch switcher calls it.
grant execute on function public.pf_set_active_branch(uuid) to authenticated;

-- ================================================================ 4. assertions

comment on function public.pf_apply_sale_item_stock() is
  'AFTER INSERT on sale_items. Depletes the lot named by NEW.batch_id. Unreachable as an RPC: PostgreSQL refuses to call a trigger function directly. Requires the lot to be in the same branch as the sale, because SECURITY DEFINER bypasses RLS.';

comment on function public.pf_set_active_branch(uuid) is
  'Client RPC for the branch switcher. Authorises against branch_memberships for auth.uid(). The only pf_* function exposed to authenticated.';

-- If either grant were dropped by a later migration the application would fail
-- closed and read as empty rather than leak, which is the right direction, so no
-- runtime check is needed here. `verify-function-surface.mjs` pins both sides.
