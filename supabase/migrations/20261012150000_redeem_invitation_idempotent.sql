-- ============================================================================
-- Redeeming an invitation a second time is now a success, not an error
-- ----------------------------------------------------------------------------
-- Apply with:  supabase db push
--
-- ## The defect
--
-- `pf_redeem_invitation` is the only writer of `branch_memberships`. It read the
-- invitation with `accepted_at is null`, and it raised `unique_violation` when
-- the caller already belonged to the branch. Both facts are correct for a *first*
-- redemption and wrong for a second one:
--
--   * the first call stamps `accepted_at`, so a second call no longer matches the
--     lookup and the person is told "That invite code is not valid, or has
--     already been used";
--   * if the lookup had matched, the `branch_memberships` insert would instead
--     have raised `unique_violation`.
--
-- Either way the same thing happens: someone who is already on the team opens the
-- emailed link again — a reload, a second device, a retried flow — and is told
-- they have no place at the pharmacy. The membership is fine; the message is not.
--
-- ## The fix
--
-- Redemption is idempotent for the person the invitation belongs to, and only for
-- them. Two changes, no more:
--
--   1. the token is looked up without requiring it to be unused, so the
--      invitation row is still found on a second visit;
--   2. before any validation or write, the caller's **existing membership of the
--      invitation's branch** is checked. If it is there, the function returns the
--      place they already hold and writes nothing at all — no second membership,
--      no re-stamped `accepted_at`, no second activation of the pharmacy, no
--      second audit row.
--
-- Otherwise the original path runs exactly as before: the expiry test, the
-- used/revoked test, the address binding, then the membership insert,
-- `accepted_at`, the pharmacy activation and the audit row.
--
-- ## What is deliberately NOT relaxed
--
--   * a caller who is **not** already a member still cannot redeem a used,
--     revoked or expired code, and still cannot redeem a code issued to a
--     different address. Every original `raise` is preserved with the same
--     errcode and the same message, and in the same precedence, so callers that
--     match on the text keep working;
--   * the idempotent path returns the branch and role **from the caller's
--     existing membership row**, never from anything the request can influence;
--   * no path other than this function creates a membership, and a redeemed code
--     still grants only the branch and role stored on the invitation row.
--
-- ## Why `create or replace` and not `drop` + `create`
--
-- The signature — `(text) returns table(branch uuid, granted_role staff_role)` —
-- is left exactly as it was. A return-shape change would need a `drop`, and it
-- would ripple into the client (`src/lib/supabase/staff.ts` reads `branch` and
-- `granted_role`) and into the invitation verification suites. The whole point of
-- this fix is that the function alone, replaced in place, stops the defect.
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

  -- Looked up WITHOUT `accepted_at is null`, and without the revoked/expiry
  -- filters that used to live here. A code that has already been accepted has to
  -- stay findable, or the second visit cannot be recognised as the same person
  -- coming back — which is the whole defect. The revoked / expired / address
  -- tests now run below, where they can still refuse a *non-member*. `for update`
  -- is kept: two callers racing on one token are still serialised.
  select * into v_inv
  from public.staff_invitations i
  where i.token = btrim(p_token)
  for update;

  if not found then
    raise exception 'That invite code is not valid, or has already been used'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Idempotent path. If this person already holds a membership at the
  -- invitation's branch then the invitation has done its job: hand back the place
  -- they already have, and write nothing.
  --
  -- Deliberately before the expiry, used/revoked and address tests. A returning
  -- member must not be turned away by any of them, and none of them grants
  -- anything they do not already hold: the branch and role returned are the ones
  -- on their existing membership row.
  select m.role into v_role
  from public.branch_memberships m
  where m.user_id = auth.uid()
    and m.branch_id = v_inv.branch_id;

  if found then
    return query select v_inv.branch_id, v_role;
    return;
  end if;

  -- ---------------------------------------------------------------- original
  -- Below this line the behaviour is the one defined in
  -- 20261012140000_platform_admin.sql, with the checks in the same precedence:
  -- an expired code reports "expired" even if it was also used or revoked, then
  -- used/revoked report "already used", then the address binding. `expires_at is
  -- null` means "no expiry" by design.

  if v_inv.expires_at is not null and v_inv.expires_at <= now() then
    raise exception 'That invitation has expired. Ask your owner to send a new one.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'That invite code is not valid, or has already been used'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The binding that makes a forwarded link inert. The token proves you were
  -- sent the link; this proves the link was sent to *you*.
  if v_inv.email is distinct from v_email then
    raise exception 'This invite was issued to a different email address'
      using errcode = 'insufficient_privilege';
  end if;

  -- Role and branch come from the invitation row only. There is no argument
  -- through which a caller could ask for a different branch or a higher role.
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
  'writes nothing, so re-opening a used link is a success rather than an error. '
  'All other refusals — expired, revoked, used by someone else, addressed to '
  'another email — are unchanged. The only writer of branch_memberships.';

revoke all on function public.pf_redeem_invitation(text) from public;
grant execute on function public.pf_redeem_invitation(text) to authenticated;
