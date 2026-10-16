-- Staff invitations: expiry and the invited person's name.
--
-- Additive only. `staff_invitations` and all three of its functions already exist
-- and are exercised by `verify-staff-invitations.mjs`; this migration extends that
-- one system rather than introducing a second one. No table is created, no policy
-- is dropped or relaxed, and no existing column changes meaning.
--
-- ## Why this is needed
--
-- Two things the existing invitation could not do, both of which matter now that
-- the invitation is delivered by email rather than read aloud across a counter:
--
--   * `expires_at`. An emailed code that never expires is a permanent credential
--     sitting in someone's inbox. Redemption now refuses an expired invitation,
--     which is the difference between "a link" and "an open door".
--   * `full_name`. The owner already knows who they are inviting, and an
--     invitation addressed to a person is not the same artifact as one addressed
--     to an address. The name is carried on the invitation and shown in the email.
--     It is display data only: nothing in redemption reads it, and copying it onto
--     the profile is deliberately left for a separate change so this migration
--     cannot alter what a redeemed member can see.
--
-- ## Token strength is unchanged
--
-- Nothing here touches `token`. It is already two chained `gen_random_uuid()`
-- values — 256 bits from a CSPRNG — and it remains the only credential. The
-- `full_name` column is display data and is never used to authorise anything.

create table if not exists public.staff_invitations (
  -- Kept only so this file stands alone; the table is created by
  -- 20261006090000_staff_invitations.sql and this migration never re-creates it.
  id uuid primary key default gen_random_uuid()
);

alter table public.staff_invitations
  add column if not exists full_name text;

alter table public.staff_invitations
  add column if not exists expires_at timestamptz;

-- Existing rows predate expiry. Backfilling to 7 days from creation gives them the
-- same window a new invitation gets rather than leaving them valid forever.
update public.staff_invitations
   set expires_at = created_at + interval '7 days'
 where expires_at is null;

-- New invitations expire 7 days out. A week is long enough for someone to receive
-- the mail and set a password, and short enough that a leaked inbox does not hold
-- a working credential indefinitely.
alter table public.staff_invitations
  alter column expires_at set default (now() + interval '7 days');

-- The owner lists invitations and the redemption path filters on them, so an index
-- on the live window keeps both cheap as the table grows.
create index if not exists staff_invitations_expires_idx
  on public.staff_invitations (expires_at)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------- pf_create_invitation
-- Gains two optional parameters. Both default, so every existing two-argument call
-- — including all 46 assertions in verify-staff-invitations.mjs — keeps working
-- unchanged. Postgres requires that once a parameter has a default, every later one
-- does too, so p_role is given a default here as well.
--
-- Returned set gains `expires_at` so the caller can state the deadline in the email
-- rather than guessing at it.

drop function if exists public.pf_create_invitation(text, public.staff_role);

create or replace function public.pf_create_invitation(
  p_email text,
  p_role  public.staff_role default 'assistant',
  p_full_name text default null,
  p_expires_in interval default interval '7 days'
)
returns table (
  token text,
  email text,
  role public.staff_role,
  created_at timestamptz,
  expires_at timestamptz,
  full_name text
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_branch uuid;
  v_role  public.staff_role;
  v_name   text;
  v_expiry interval;
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

  -- Trimmed, and length-capped: this is displayed in an email and on the
  -- acceptance screen, so it must not be able to carry markup or unbounded text.
  v_name := nullif(btrim(coalesce(p_full_name, '')), '');
  if v_name is not null and length(v_name) > 120 then
    raise exception 'That name is too long' using errcode = 'invalid_parameter_value';
  end if;

  -- Bounded so a caller cannot mint an invitation valid for a decade.
  v_expiry := case
    when p_expires_in is null or p_expires_in <= interval '0' then interval '7 days'
    when p_expires_in > interval '30 days' then interval '30 days'
    else p_expires_in
  end;

  -- Re-issuing to the same address supersedes the previous live invite rather
  -- than leaving two that both work.
  --
  -- Aliased because this function's OUT parameters are named `email`, `token`,
  -- `role` and `created_at`, which are also columns of this table. In plpgsql a
  -- bare name matching both a variable and a column of the statement's table is an
  -- error ("column reference is ambiguous"), so every reference here is qualified.
  update public.staff_invitations as live
     set revoked_at = now()
   where live.branch_id = v_branch
     and lower(live.email) = lower(p_email)
     and live.accepted_at is null
     and live.revoked_at is null;

  -- `token` is deliberately OMITTED from this column list so the column DEFAULT
  -- applies: two chained gen_random_uuid() values, 256 bits from a CSPRNG.
  -- Naming the column with a literal would write that literal to every row —
  -- a single shared credential for the whole installation. That mistake is
  -- exactly what this omission avoids.
  return query
  insert into public.staff_invitations as inv (branch_id, email, role, invited_by, full_name, expires_at)
  values (v_branch, lower(p_email), v_role, auth.uid(), v_name, now() + v_expiry)
  returning inv.token, inv.email, inv.role, inv.created_at, inv.expires_at, inv.full_name;
end;
$$;

comment on function public.pf_create_invitation(text, public.staff_role, text, interval) is
  'Owner-only. Issues an invitation into the caller''s own branch and returns the '
  'token to share, with the expiry and the invited name so the email can state both. '
  'The branch and the inviter are taken from the session, never from the arguments.';

-- ---------------------------------------------------------------- pf_redeem_invitation
-- Unchanged in every respect except one: an expired invitation is no longer
-- found, so it cannot be redeemed. Same signature, same SECURITY DEFINER, same
-- email binding, same "only once" behaviour.

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
    and (i.expires_at is null or i.expires_at > now())
  for update;

  if not found then
    -- Distinguished from a used or withdrawn code so the caller can say
    -- "expired" rather than "invalid", which is a materially different
    -- instruction for whoever is holding the email.
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

  -- `memberships_audit_role_change` already records this insert, so the new
  -- member appears in the audit log exactly like any other join.
  update public.staff_invitations
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_inv.id;

  return query select v_inv.branch_id, v_inv.role;
end;
$$;

-- ---------------------------------------------------------------- grants
-- Unchanged from 20261006090000: SELECT only. The extra columns are display data
-- on a table nobody may write except through the functions above.
revoke all on public.staff_invitations from anon, authenticated;
grant select on public.staff_invitations to authenticated;

revoke all on function public.pf_create_invitation(text, public.staff_role, text, interval) from public;
grant execute on function public.pf_create_invitation(text, public.staff_role, text, interval) to authenticated;

revoke all on function public.pf_revoke_invitation(text) from public;
grant execute on function public.pf_revoke_invitation(text) to authenticated;

revoke all on function public.pf_redeem_invitation(text) from public;
grant execute on function public.pf_redeem_invitation(text) to authenticated;