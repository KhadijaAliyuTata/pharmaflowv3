-- Staff invitations.
--
-- An owner adds a member of staff by issuing an invite, not by creating a
-- credential for them. The invitee follows the link, sets their own password,
-- and the membership is created for them. Two properties make this the shape
-- we want:
--
--   1. No `service_role` key is involved at any point. Creating an auth user
--      normally needs Supabase's admin API, which needs the service key, and
--      that key must never reach a browser or a Worker bundle. Going through
--      sign-up means the browser only ever uses the publishable key it already
--      has, and the staff member's password is set by them and is never seen,
--      stored or transmitted through this codebase.
--
--   2. Nothing outside the issuing owner can redirect it. `pf_create_invitation`
--      takes the branch from `pf_current_branch()` and the inviter from
--      `auth.uid()`, so an owner can only ever invite into their own branch and
--      only ever as themselves.
--
-- The table itself is never written by the client. Grants are column-safe and
-- all three mutations go through SECURITY DEFINER functions, so a crafted
-- PostgREST call cannot forge `accepted_at`/`accepted_by`, mint a token, or
-- point an invite at another branch.

create table if not exists public.staff_invitations (
  id          uuid primary key default gen_random_uuid(),

  -- The branch the invite grants access to. Issued by the function, never the
  -- client: `pf_create_invitation` copies `pf_current_branch()` here.
  branch_id   uuid not null references public.branches(id) on delete cascade,

  -- Bound deliberately. `pf_redeem_invitation` refuses an invite whose address
  -- is not the signed-in identity, so a link forwarded to the wrong person is
  -- inert rather than a working credential for whoever opens it.
  email       text not null,

  role        public.staff_role not null default 'assistant',

  -- 256 bits of entropy, generated in the database so a predictable token can
  -- never be produced by a client choosing its own value.
  --
  -- Built from two `gen_random_uuid()` calls rather than pgcrypto's
  -- `gen_random_bytes`, and that is deliberate. On Supabase pgcrypto lives in
  -- `extensions`, which the SECURITY DEFINER functions below cannot see because
  -- they set `search_path to 'public'`. More importantly the test harness runs
  -- PGlite, which has no pgcrypto at all, so a pgcrypto default would fail the
  -- entire verification suite rather than just this column. `gen_random_uuid()`
  -- is in `pg_catalog` on PostgreSQL 13+, so it behaves identically in both.
  token       text not null unique
              default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),

  invited_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),

  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  revoked_at  timestamptz
);

comment on table public.staff_invitations is
  'Pending and settled staff invites. Written only through pf_create_invitation, '
  'pf_revoke_invitation and pf_redeem_invitation.';

-- The owner-facing list filters on the live rows for a branch.
create index if not exists staff_invitations_branch_live_idx
  on public.staff_invitations (branch_id, created_at desc)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Scoped by branch and by role, in the same shape as `memberships_owner_write`.
-- Deliberately not `for all`: read, insert and update are separate policies so
-- that granting one never silently grants the others.

alter table public.staff_invitations enable row level security;

drop policy if exists staff_invitations_owner_read on public.staff_invitations;
drop policy if exists staff_invitations_owner_insert on public.staff_invitations;
drop policy if exists staff_invitations_owner_update on public.staff_invitations;

create policy staff_invitations_owner_read
  on public.staff_invitations
  for select
  to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch());

create policy staff_invitations_owner_insert
  on public.staff_invitations
  for insert
  to authenticated
  with check (pf_is_owner() and branch_id = pf_current_branch());

create policy staff_invitations_owner_update
  on public.staff_invitations
  for update
  to authenticated
  using (pf_is_owner() and branch_id = pf_current_branch())
  with check (pf_is_owner() and branch_id = pf_current_branch());

-- No delete policy. An invite is revoked, never erased: a settled invite is the
-- record that a person was once issued access to this branch.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Read is allowed and governed by the policy above. Write is not granted at all;
-- it only happens inside the SECURITY DEFINER functions, which run as the
-- function owner and so are not filtered by these policies.
--
-- Note the column-level INSERT grant is deliberately absent. With a table-level
-- INSERT grant a client could set `accepted_by`, `invited_by` or `branch_id`
-- itself, which is precisely the forgery this design exists to prevent.

revoke all on public.staff_invitations from anon, authenticated;
grant select on public.staff_invitations to authenticated;

-- ---------------------------------------------------------------------------
-- pf_create_invitation — owner issues an invite
-- ---------------------------------------------------------------------------

create or replace function public.pf_create_invitation(
  p_email text,
  p_role  public.staff_role default 'assistant'
)
returns table (token text, email text, role public.staff_role, created_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_branch uuid;
  v_role  public.staff_role;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  if not pf_is_owner() then
    raise exception 'Only an owner can invite staff' using errcode = 'insufficient_privilege';
  end if;

  v_branch := pf_current_branch();
  if v_branch is null then
    raise exception 'No active branch for this account' using errcode = 'insufficient_privilege';
  end if;

  if p_email is null or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address' using errcode = 'invalid_parameter_value';
  end if;

  -- Staff is `assistant` unless an owner deliberately says otherwise. An
  -- accidental second owner is far harder to undo than a promotion.
  v_role := case when p_role = 'owner' then 'owner'::public.staff_role
                  else 'assistant'::public.staff_role end;

  -- Re-issuing to the same address supersedes the previous live invite rather
  -- than leaving two that both work.
  --
  -- Aliased because this function's OUT parameters are named `email`, `token`,
  -- `role` and `created_at`, which are also columns of this table. In plpgsql a
  -- bare name matching both a variable and a column of the statement's table is
  -- an error ("column reference is ambiguous") rather than a silent preference
  -- for one of them, so every reference here is qualified.
  update public.staff_invitations as live
     set revoked_at = now()
   where live.branch_id = v_branch
     and lower(live.email) = lower(p_email)
     and live.accepted_at is null
     and live.revoked_at is null;

  return query
  insert into public.staff_invitations as inv (branch_id, email, role, invited_by)
  values (v_branch, lower(p_email), v_role, auth.uid())
  returning inv.token, inv.email, inv.role, inv.created_at;
end;
$$;

comment on function public.pf_create_invitation(text, public.staff_role) is
  'Owner-only. Issues an invite into the caller''s own branch and returns the '
  'token to share. The branch and the inviter are taken from the session, never '
  'from the arguments.';

-- ---------------------------------------------------------------------------
-- pf_revoke_invitation — owner withdraws an unused invite
-- ---------------------------------------------------------------------------

create or replace function public.pf_revoke_invitation(p_token text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  if not pf_is_owner() then
    raise exception 'Only an owner can revoke an invite' using errcode = 'insufficient_privilege';
  end if;

  -- Scoped by branch as well as by owner, so a token from another pharmacy is
  -- simply not found rather than silently revoked here.
  update public.staff_invitations
     set revoked_at = now()
   where token = p_token
     and branch_id = pf_current_branch()
     and accepted_at is null
     and revoked_at is null
  returning id into v_id;

  return v_id is not null;
end;
$$;

comment on function public.pf_revoke_invitation(text) is
  'Owner-only. Marks an unused invite revoked. Returns false if the invite is '
  'already used, already revoked, or belongs to another branch.';

-- ---------------------------------------------------------------------------
-- pf_redeem_invitation — the invitee claims their place
-- ---------------------------------------------------------------------------

create or replace function public.pf_redeem_invitation(p_token text)
returns table (branch uuid, granted_role public.staff_role)
language plpgsql
security definer
set search_path to 'public'
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
  for update;

  if not found then
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

  -- `memberships_audit_role_change` already records this insert, so the new
  -- member appears in the audit log exactly like any other join.
  update public.staff_invitations
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_inv.id;

  return query select v_inv.branch_id, v_inv.role;
end;
$$;

comment on function public.pf_redeem_invitation(text) is
  'Any signed-in user. Exchanges a valid invite code for a membership in the '
  'invited branch, at the invited role, bound to the caller''s own email. The '
  'caller then claims their branch by updating their own profile: '
  'pf_guard_profile_privileges already permits that once the membership exists.';

-- ---------------------------------------------------------------------------
-- Execute grants
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default, which would let an anonymous
-- caller reach these. `pf_redeem_invitation` genuinely needs to be reachable by
-- any signed-in user and that is all; the two owner functions refuse non-owners
-- internally as well, so this grant is the outer bound and not the only one.

revoke all on function public.pf_create_invitation(text, public.staff_role) from public;
revoke all on function public.pf_revoke_invitation(text) from public;
revoke all on function public.pf_redeem_invitation(text) from public;

grant execute on function public.pf_create_invitation(text, public.staff_role) to authenticated;
grant execute on function public.pf_revoke_invitation(text) to authenticated;
grant execute on function public.pf_redeem_invitation(text) to authenticated;