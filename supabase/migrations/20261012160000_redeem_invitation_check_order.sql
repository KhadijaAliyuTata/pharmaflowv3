-- ============================================================================
-- Revocation and the address binding now precede the idempotent path
-- ----------------------------------------------------------------------------
-- Apply with:  supabase db push
--
-- ## Why this exists
--
-- `20261012150000_redeem_invitation_idempotent.sql` made redemption idempotent by
-- checking the caller's membership *first* — ahead of the withdrawn test and
-- ahead of the address binding. That was too eager in two ways, and this
-- migration puts both tests back in front of it:
--
--   * a **withdrawn** invitation could still be "redeemed" by anyone who already
--     held a membership at the branch. Withdrawing a code is an explicit act, and
--     an accepted invitation cannot be revoked (`pf_revoke_invitation` refuses
--     once `accepted_at` is set) — so no legitimate replay can ever reach this
--     check with a revoked token. That makes "revoked" the stronger signal, and
--     it belongs first;
--
--   * the **address binding** stopped applying to members, so a member of a
--     branch could present a code issued to somebody else and be told it
--     succeeded. The code proved nothing to them, and the binding is precisely
--     what makes a forwarded link inert. It applies to everyone again.
--
-- The idempotent path itself is unchanged: a caller who already holds a
-- membership at the invitation's branch gets that membership back and nothing is
-- written. Only its position in the sequence moved.
--
-- ## The resulting order
--
--   1. signed in, and a token was supplied;
--   2. the token is found, whether or not it has been used;
--   3. withdrawn        -> refused, for everyone;
--   4. address binding  -> refused, for everyone;
--   5. already a member -> success, writing nothing (the idempotent path);
--   6. expired          -> refused;
--   7. already accepted -> refused ("has already been used");
--   8. otherwise: create the membership, stamp `accepted_at`, activate the
--      pharmacy, write the audit row.
--
-- Step 5 sits above steps 6 and 7 on purpose. An invitation that was accepted
-- and has since passed its deadline must still be a success for the person who
-- redeemed it — they hold the membership, and the invitation did its job. It sits
-- below step 3 because a withdrawn invitation is never one that was accepted.
--
-- The signature — `(text) returns table(branch uuid, granted_role staff_role)` —
-- `security definer`, `search_path` and the grants are all unchanged.
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
  -- its owner arrives.
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

comment on function public.pf_redeem_invitation(text) is
  'Redeems an invitation for the signed-in caller. Idempotent: if the caller '
  'already holds a membership at the invitation''s branch, returns that place and '
  'writes nothing, so re-opening a used link is a success rather than an error. A '
  'withdrawn or expired code and a code addressed to another email are still '
  'refused, for members as well as for everyone else. The only writer of '
  'branch_memberships.';

revoke all on function public.pf_redeem_invitation(text) from public;
grant execute on function public.pf_redeem_invitation(text) to authenticated;
