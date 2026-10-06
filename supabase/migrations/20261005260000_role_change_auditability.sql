-- ============================================================================
-- Audit every membership and role change, and reserve that namespace
-- ============================================================================
--
-- Closes an auditability gap: nothing recorded a role change, so promoting or
-- demoting a member left no trace. Given `branch_memberships.role` is now the
-- authoritative authorization source (see
-- 20261005250000_branch_membership_role_authority.sql), an unlogged change to it
-- is an unlogged change to what somebody is permitted to do.
--
-- ## What is recorded
--
--   membership created   INSERT on branch_memberships
--   role changed         UPDATE where the role actually differs
--   membership removed   DELETE on branch_memberships
--
-- Each event carries the caller as `actor_id`, the affected member and branch in
-- `metadata`, and both the previous and the new role where the schema allows it.
-- `created_at` is the column default, so the timestamp is the database's, not a
-- supplied one.
--
-- `audit_events` has no `old_role`/`new_role` columns, and adding them would mean a
-- second migration against an append-only table for no security benefit. `metadata`
-- is a jsonb column that already exists for exactly this, so previous and new role
-- are recorded there and remain queryable.
--
-- ## Actor binding
--
-- `actor_id` is `auth.uid()` and nothing else. It is never taken from a parameter,
-- from `new`/`old`, or from the client. This function is SECURITY DEFINER, which
-- changes the privileges its body runs with but not the identity `auth.uid()`
-- reports: `auth.uid()` reads the session JWT claim set by the gateway, so the
-- recorded actor is the caller even though the insert executes as the definer.
-- This is the same binding `audit_insert` already enforces, and this trigger does
-- not weaken it — it writes through SECURITY DEFINER, so RLS on `audit_events` does
-- not apply to the insert at all, which is why the reserved-namespace guard below
-- is what stops forgery.
--
-- ## Reserved namespace
--
-- Without a guard, `audit_insert` lets any staff member insert an audit row naming
-- themselves as actor. That is correct for ordinary events — an attendant recording
-- their own action is legitimate, and Phase 0 relies on it — but it would also let
-- them write a role-change event that never happened, into a log an owner reads to
-- find out who has been given what authority. A forged `role.promoted` is worse than
-- no event at all.
--
-- So the `role.` action prefix is reserved. A BEFORE INSERT trigger on
-- `audit_events` rejects that namespace unless the insert came from inside another
-- trigger, which it distinguishes with `pg_trigger_depth()`: a write made by this
-- trigger has depth 2, and a write made directly by a client has depth 1. There is
-- no flag a client could set, because a client cannot reach depth 2 without
-- modifying a table this project controls.
--
-- Other action names are untouched. An attendant can still record their own sale or
-- stock action exactly as before, and no existing behaviour changes.
--
-- ## Trusted server context
--
-- A NULL `auth.uid()` is the SQL editor, a migration, or a service_role connection.
-- Those are the bootstrap paths that create the first owner and the initial
-- memberships, and `actor_id` is `NOT NULL references profiles(id)`, so there is no
-- actor to record. The audit write is skipped, matching the exemption in
-- `pf_guard_profile_privileges` and `pf_handle_new_user`. The role change still
-- happens; only its log entry is absent, and only for operations no end user can
-- perform.
--
-- ## What this migration does NOT do
--
-- It does not grant, revoke, or alter any privilege; create, drop or broaden any
-- policy; touch a cost column; make `profiles.role` authoritative again; or
-- introduce any membership -> profile authorization dependency. `profiles.role`
-- remains a display cache and the authorization chain remains
-- `pf_current_branch() -> branch_memberships -> role`.
--
-- ============================================================================

-- ================================================== 1. record role changes

create or replace function public.pf_audit_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user   uuid;
  target_branch uuid;
  previous_role staff_role;
  next_role     staff_role;
  event_action  text;
  event_text    text;
begin
  -- Trusted server context: no end user, so no actor to record, and the audit
  -- table's actor column is NOT NULL. See the note above.
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    target_user   := new.user_id;
    target_branch := new.branch_id;
    previous_role := null;
    next_role     := new.role;
    event_action  := 'role.membership_created';
    event_text    := 'Added to the branch as ' || new.role::text;

  elsif tg_op = 'DELETE' then
    target_user   := old.user_id;
    target_branch := old.branch_id;
    previous_role := old.role;
    next_role     := null;
    event_action  := 'role.membership_removed';
    event_text    := 'Removed from the branch, held ' || old.role::text;

  else
    -- An UPDATE that leaves the role alone is not a role change. `is_default` can
    -- move without this firing, which is correct: nothing about anybody's
    -- authorization changed.
    if new.role is not distinct from old.role then
      return new;
    end if;

    target_user   := new.user_id;
    target_branch := new.branch_id;
    previous_role := old.role;
    next_role     := new.role;
    event_action  := 'role.changed';
    event_text    := case
      when next_role = 'owner' and previous_role is distinct from 'owner'
        then 'Promoted from ' || previous_role::text || ' to owner'
      when previous_role = 'owner' and next_role is distinct from 'owner'
        then 'Demoted from owner to ' || next_role::text
      else 'Role changed from ' || previous_role::text || ' to ' || next_role::text
    end;
  end if;

  insert into audit_events (branch_id, actor_id, action, description, metadata)
  values (
    target_branch,
    auth.uid(),
    event_action,
    target_user::text || ' ' || event_text,
    jsonb_build_object(
      'affected_user',   target_user,
      'branch_id',       target_branch,
      'previous_role',   previous_role,
      'new_role',        next_role,
      'source',          'pf_audit_role_change'
    )
  );

  return coalesce(new, old);
end;
$$;

-- AFTER, not BEFORE: the audit row records what actually happened, so a statement
-- that later fails its own constraint cannot leave a log entry claiming otherwise.
--
-- `for each row`, and one trigger rather than one per action, so a membership
-- cannot be created without passing through exactly one code path.
drop trigger if exists memberships_audit_role_change on branch_memberships;

create trigger memberships_audit_role_change
  after insert or update of role or delete on branch_memberships
  for each row execute function public.pf_audit_role_change();

-- ================================ 2. reserve the role. namespace from forgery

-- Ordinary audit rows are still writable by staff, for their own actions. The
-- `role.` prefix is not, because a forged role change is the one event an owner
-- would rely on and must not be able to come from the person it describes.
--
-- `pg_trigger_depth()` is 1 for a statement executed by the caller and 2 for a
-- statement executed from inside another trigger, which is how the legitimate write
-- is told apart from a forged one. A client cannot arrange depth 2 without writing
-- to a table whose triggers are ours.
create or replace function public.pf_reserve_role_audit_namespace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.action like 'role.%' and pg_trigger_depth() < 2 then
    raise exception 'Role-change audit events are written by the database only'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists audit_events_reserve_role_namespace on audit_events;

create trigger audit_events_reserve_role_namespace
  before insert on audit_events
  for each row execute function public.pf_reserve_role_audit_namespace();

-- ============================================================== 3. assertions

comment on function public.pf_audit_role_change() is
  'AFTER INSERT OR UPDATE OF role OR DELETE on branch_memberships. Records the caller as actor_id (auth.uid(), never a parameter), the affected member and branch in metadata, and previous_role and new_role in metadata. Skipped for a NULL auth.uid(), which is the trusted server context that has no end-user actor to record.';

comment on function public.pf_reserve_role_audit_namespace() is
  'Rejects an audit_events row whose action begins with ''role.'' unless pg_trigger_depth() >= 2, which only pf_audit_role_change can produce. Staff may still record their own ordinary events; they may not write the record of somebody''s authority change.';

comment on trigger memberships_audit_role_change on branch_memberships is
  'Makes the authoritative role auditable. membership created, role changed, membership removed. Branch membership is what authorization reads, so a change to it is a change to what a person may do.';

-- ================================================ 4. revoke the PUBLIC default

-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default. Phase 0b
-- revoked that default for every `pf_*` function then in the schema, and added a
-- check to `verify-function-surface.mjs` so a function added later without a grant
-- here is visible rather than silent.
--
-- Both functions above are trigger functions, so PostgreSQL refuses to call them
-- any other way: `select pf_audit_role_change()` fails with "trigger functions can
-- only be called as triggers" regardless of EXECUTE. The default is revoked anyway,
-- for the same reason 0b did it for the other thirteen — an unused grant is one
-- that can later be got wrong, and the suite that catches that is the point.
--
-- Anonymous callers get nothing here; these are not on the six-function grant list
-- and must never join it.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('pf_audit_role_change', 'pf_reserve_role_audit_namespace')
  loop
    execute format('revoke execute on function %s from public', fn.sig);
    execute format('revoke execute on function %s from anon', fn.sig);
  end loop;
end $$;