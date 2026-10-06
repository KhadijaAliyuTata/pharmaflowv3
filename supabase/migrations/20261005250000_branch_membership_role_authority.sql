-- ============================================================================
-- Make branch_memberships.role the single authoritative source for role
-- ============================================================================
--
-- Closes a confirmed fail-open privilege-retention defect.
--
-- ## The defect
--
-- Two role columns existed, and they were not symmetric:
--
--     profiles.role            one per user
--     branch_memberships.role  one per (user, branch)
--
-- RLS never read either directly. It read `pf_is_owner()`, and `pf_current_role()`
-- was:
--
--     select p.role from profiles p where p.id = auth.uid()
--
-- so `profiles.role` authorized. `branch_memberships.role` reached authorization
-- only through `pf_set_active_branch()`, which copies it onto `profiles.role` when
-- the user switches branch. `branch_memberships` had no triggers at all, so
-- nothing ever synced the other way.
--
-- A one-way copy makes the two directions fail in opposite ways:
--
--   PROMOTION  owner writes branch_memberships.role = 'owner'
--              profiles.role unchanged, pf_is_owner() stays false
--              takes effect only on a branch switch.        fails CLOSED
--
--   DEMOTION   owner writes branch_memberships.role = 'assistant'
--              profiles.role unchanged, pf_is_owner() stays TRUE
--              never takes effect at all.                    fails OPEN
--
-- Reproduced end to end: a pharmacist was promoted, switched branch, became
-- owner, and was demoted. They still read owner-only cost data and still ran
-- owner-only destructive statements -- `DELETE FROM medicines` emptied the
-- catalogue while `branch_memberships.role` read 'assistant'. The realistic
-- trigger is ordinary offboarding: revoke a pharmacist's privileges and they stay
-- a full branch owner until they happen to click "switch branch".
--
-- The second path is the membership escape hatch in `pf_guard_profile_privileges`,
-- which lets a change through when the caller holds a membership matching the
-- requested role. It cannot distinguish "switch to a branch where I already hold
-- this role" from "write this role for the first time", so once an owner had
-- promoted someone, that person could write `profiles.role = 'owner'` themselves
-- and take owner rights without switching.
--
-- ## The fix
--
-- `branch_memberships.role`, scoped to `pf_current_branch()`, is authoritative.
-- `pf_current_role()` resolves through it, so every one of the 16 policies and 4
-- cost views that call `pf_is_owner()` follows automatically and unchanged.
--
--     auth.uid() -> pf_current_branch() -> branch_memberships -> role
--                 -> pf_current_role() -> pf_is_owner() -> owner-only authorization
--
-- Promotion and demotion both take effect immediately. No branch switch is needed
-- for authorization to become correct, because authorization no longer depends on a
-- switch having happened.
--
-- SECURITY DEFINER is retained, and it is load-bearing here rather than incidental:
-- `branch_memberships` has RLS enabled, and `memberships_owner_write` calls
-- `pf_is_owner()`. A SECURITY INVOKER `pf_current_role()` would re-enter its own
-- table's policies. As definer it reads the membership row directly and bypasses
-- that recursion.
--
-- No role argument and no user id is accepted. The caller is bound to `auth.uid()`
-- and nothing else, exactly as before, so there is still no client-supplied value
-- on the authorization path.
--
-- ## What happens to profiles.role
--
-- It stays, as a cache of the role the person holds in the *active* branch, for
-- display and for the session's UI gating. It is no longer authoritative and a
-- stale value can neither grant nor withhold anything.
--
-- The column is deliberately NOT dropped. `pf_set_active_branch` still refreshes it
-- so the branch switcher can label each branch correctly, and the existing
-- `verify-*` suites assert against it. Removing it is a separate cleanup that
-- should follow a frontend migration off the field, not ride along with a security
-- fix.
--
-- ## Bidirectional synchronisation removed
--
-- `pf_sync_profile_membership` previously mirrored `profiles.role` back into
-- `branch_memberships` with `on conflict do update set role = excluded.role`. That
-- made the cache a writer of the source: editing `profiles.role` would silently
-- rewrite the authoritative row. It now inserts a membership only when one is
-- missing, and never overwrites an existing role. An owner still assigns a new
-- branch and the first membership is created for them, but from then on the role
-- at that branch is changed through `branch_memberships` alone, which is what
-- `setBranchMembership` in the application already does.
--
-- The consequence is deliberate and intended: writing `profiles.role` no longer
-- changes anybody's authorization. That is the point.
--
-- A membership -> profile back-sync was considered and rejected. It fires an UPDATE
-- on `profiles`, which re-enters `pf_guard_profile_privileges`, which requires
-- `new.branch_id = pf_current_branch()`. An owner administering a branch other than
-- the one they are standing in would therefore be blocked from demoting somebody,
-- turning a security fix into an outage. The cache is refreshed on branch switch
-- instead, and the UI role may lag a demotion until then. That lag is display-only;
-- authorization is already correct.
--
-- ## Backfill
--
-- Idempotent, and additive only. A profile with a branch but no membership would
-- otherwise lose all authorization the moment `pf_current_role()` stopped reading
-- `profiles`, so one is created with the role the profile already carried -- the
-- only evidence available at that point. No row is deleted or overwritten.
--
-- The cache is then reconciled so `profiles.role` agrees with the authoritative
-- membership for the active branch. That corrects the display value and does not
-- affect authorization, which no longer reads it.
--
-- Both statements are `on conflict do nothing` / `where distinct from`, so a second
-- run is a no-op and re-applying this migration changes nothing.
--
-- ============================================================================

-- ============================================ 1. backfill: no branch, no role

-- Staff with an active branch and no membership row would resolve to a NULL role
-- under the new chain and lose every privilege. `pf_sync_profile_membership` has
-- created one for every branch assignment since it was introduced, so in a database
-- that has always run this chain this affects nothing. It exists for databases
-- where a profile predates the backfill in the stock-ledger migration.
insert into branch_memberships (user_id, branch_id, role, is_default)
select p.id, p.branch_id, p.role, true
from profiles p
where p.branch_id is not null
  and not p.is_customer
  and not exists (
    select 1 from branch_memberships m
    where m.user_id = p.id and m.branch_id = p.branch_id
  )
on conflict (user_id, branch_id) do nothing;

-- ==================================== 2. reconcile the cache with the source

-- Make `profiles.role` tell the truth for the active branch, so the session and the
-- branch switcher stop showing a stale role. Display only; authorization already
-- reads the membership. `auth.uid()` is NULL during a migration, so
-- `pf_guard_profile_privileges` returns early and this does not need to be an owner.
update profiles p
set role = m.role
from branch_memberships m
where m.user_id = p.id
  and m.branch_id = p.branch_id
  and p.role is distinct from m.role;

-- ================================= 3. branch_memberships.role is authoritative

create or replace function public.pf_current_role()
returns staff_role
language sql
stable
security definer
set search_path = public
as $$
  -- The caller's role in the branch they are currently standing in, taken from the
  -- membership row rather than from `profiles.role`.
  --
  -- This is the only place role authorization is decided. Previously it read
  -- `profiles.role`, which no longer changes when a membership role changes, and so
  -- made demotion ineffective until the user happened to switch branch.
  --
  -- No parameter: the caller is `auth.uid()` and the branch is
  -- `pf_current_branch()`. Nothing here can be supplied by a client.
  --
  -- SECURITY DEFINER is required, not optional. `branch_memberships` has RLS
  -- enabled and its own write policy calls `pf_is_owner()`, which calls this
  -- function; as invoker it would re-enter its own table's policies.
  --
  -- A user with no membership for the active branch resolves to NULL, and
  -- `pf_is_owner()` therefore returns false. Absence of a membership denies, which
  -- is the direction that must be chosen when authorization is uncertain.
  select m.role
  from branch_memberships m
  where m.user_id = auth.uid()
    and m.branch_id = pf_current_branch()
$$;

-- ================================ 4. stop the cache writing back to the source

create or replace function public.pf_sync_profile_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.branch_id is null then
    return new;
  end if;

  -- Creates the membership for a newly assigned branch, using the role the profile
  -- carries at that moment as the initial value.
  --
  -- `on conflict do nothing`, where it used to be `do update set role = excluded.role`.
  -- That clause made `profiles.role` a writer of the authoritative row: any edit to
  -- the cache would silently rewrite the role a person actually holds at that
  -- branch. Membership is now written only through `branch_memberships`, which is
  -- what `setBranchMembership` already does and what `memberships_owner_write`
  -- already gates behind an owner.
  insert into branch_memberships (user_id, branch_id, role, is_default)
  values (new.id, new.branch_id, new.role, not exists (
    select 1 from branch_memberships m
    where m.user_id = new.id and m.is_default
  ))
  on conflict (user_id, branch_id) do nothing;

  return new;
end;
$$;

-- ============================================================ 5. assertions

comment on function public.pf_current_role() is
  'AUTHORITATIVE role resolution: the caller''s branch_memberships.role for pf_current_branch(). SECURITY DEFINER so it can read that table without re-entering its own RLS policies. profiles.role is a display-only cache of the same value and must never gate authorization.';

comment on function public.pf_sync_profile_membership() is
  'Creates a branch_memberships row when a profile is assigned a branch. Uses on conflict do nothing: an existing membership role is authoritative and is never overwritten from the profiles cache.';

comment on policy memberships_owner_write on branch_memberships is
  'Owner-only and branch-scoped, now governing the authoritative role itself. Because pf_is_owner() resolves from branch_memberships, this policy is part of the authorization chain; a change here changes what an owner can do, not merely who may administer memberships.';