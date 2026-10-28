-- ============================================================================
-- Only an owner invitation activates the pharmacy or writes the activation event
-- ----------------------------------------------------------------------------
-- Apply with:  supabase db push
--
-- ## Why this exists
--
-- `pf_redeem_invitation` was written for the owner-onboarding flow, and its last
-- two writes assumed every invitation belonged to an owner:
--
--   * it set `branches.status = 'active'` for any first redemption; and
--   * it wrote `pharmacy_activated` / "accepted their owner invitation".
--
-- Staff invitations reuse the same function. When an assistant accepted one, the
-- audit log said an owner had arrived and the event was labelled as a pharmacy
-- activation, even though the branch was already active and the person had been
-- granted the assistant role. The membership trigger already writes the accurate
-- `role.membership_created` event, so the owner-only writes are now gated on the
-- invitation role.
--
-- The signature, `security definer`, `search_path`, grants, and the redemption
-- order are unchanged.
-- ============================================================================

create or replace function public.pf_redeem_invitation(p_token text)
returns table (branch uuid, granted_role public.staff_role)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_inv    public.staff_invitations;
  v_email  text;
  v_role   public.staff_role;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception 'Enter your invite code' using errcode = 'invalid_parameter_value';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  -- Found whether or not it has been used, so a second visit can be recognised as
  -- the same person coming back rather than as a broken code. `for update` still
  -- serialises two callers racing on one token.
  select * into v_inv
  from public.staff_invitations i
  where i.token = btrim(p_token)
  for update;

  if not found then
    raise exception 'That invite code is not valid, or has already been used'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A withdrawn code is dead for everyone, member or not. An accepted invitation
  -- cannot be revoked, so this can never turn a genuine replay away.
  if v_inv.revoked_at is not null then
    raise exception 'That invite code is not valid, or has already been used'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The binding that makes a forwarded link inert. Strict for members too: the
  -- token proves the link was sent, this proves it was sent to *you*.
  if v_inv.email is distinct from v_email then
    raise exception 'This invite was issued to a different email address'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent path. This person already holds a membership at the invitation's
  -- branch, so the invitation has done its job: hand back the place they already
  -- have, and write nothing — no second membership, no re-stamped `accepted_at`,
  -- no second activation, no second audit row.
  select m.role into v_role
  from public.branch_memberships m
  where m.user_id = auth.uid()
    and m.branch_id = v_inv.branch_id;

  if found then
    return query select v_inv.branch_id, v_role;
    return;
  end if;

  -- ------------------------------------------------- first-redemption rules.
  -- `expires_at is null` means "no expiry" by design.
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then
    raise exception 'That invitation has expired. Ask your owner to send a new one.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_inv.accepted_at is not null then
    raise exception 'That invite code is not valid, or has already been used'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Role and branch come from the invitation row only; no argument can ask for a
  -- different branch or a higher role.
  insert into public.branch_memberships (user_id, branch_id, role, is_default)
  values (auth.uid(), v_inv.branch_id, v_inv.role, true);

  update public.staff_invitations
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_inv.id;

  -- A pharmacy created by the platform operator becomes operational the moment
  -- its owner arrives. An assistant cannot bring a pending pharmacy online, and
  -- must not produce an "owner invitation" audit entry; the membership trigger
  -- records the role grant instead.
  if v_inv.role = 'owner' then
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
  end if;

  return query select v_inv.branch_id, v_inv.role;
end;
$$;

comment on function public.pf_redeem_invitation(text) is
  'Redeems an invitation for the signed-in caller. Idempotent: if the caller '
  'already holds a membership at the invitation''s branch, returns that place and '
  'writes nothing, so re-opening a used link is a success rather than an error. A '
  'withdrawn or expired code and a code addressed to another email are still '
  'refused, for members as well as for everyone else. The only writer of '
  'branch_memberships. Only an owner invitation activates the branch.';

revoke all on function public.pf_redeem_invitation(text) from public;
grant execute on function public.pf_redeem_invitation(text) to authenticated;
