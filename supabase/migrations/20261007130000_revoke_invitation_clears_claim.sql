-- Revoking an invitation also ends any active claim on it.
--
-- Separate from 20261007120000_staff_invitation_claim so that the change to a
-- pre-existing, already-audited function is independently reviewable.
--
-- ## Why
--
-- Without this, an owner who revokes during an in-flight acceptance leaves a claim
-- alive for up to four minutes, and a later attempt is refused as `claimed` rather
-- than as `revoked`. That is not a security problem — `pf_redeem_invitation` refuses
-- the revoked row regardless — but it is a confusing message for a code that is
-- permanently dead, and it makes revocation feel like it did not take effect.
--
-- Setting `claim_expires_at = now()` collapses the lease to already-expired, using the
-- same column the natural expiry uses. The claim is released by the passage of time as
-- designed; this simply brings that time forward.
--
-- `claimed_at` is left alone deliberately: it is the record of when acceptance
-- started, which is worth keeping for an owner asking why an account exists for a
-- withdrawn invitation.

drop function if exists public.pf_revoke_invitation(text);

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
  --
  -- `claim_expires_at = now()` ends any active claim. The `is distinct from` guard
  -- keeps the UPDATE from firing for rows that were never claimed, so this does not
  -- dirty every revoked invitation with a value nobody reads.
  update public.staff_invitations as inv
     set revoked_at      = now(),
         claim_expires_at = now()
   where inv.token = p_token
     and inv.branch_id = pf_current_branch()
     and inv.accepted_at is null
     and inv.revoked_at is null
     and inv.claim_expires_at is distinct from now()
  returning inv.id into v_id;

  return v_id is not null;
end;
$$;

comment on function public.pf_revoke_invitation(text) is
  'Owner-only, scoped to their own branch. Withdraws an unused invitation and ends any '
  'active claim on it, so a withdrawn code reports as withdrawn rather than as claimed.';

-- ---------------------------------------------------------------- grants
--
-- Unchanged from 20261006090000_staff_invitations: owner actions are `authenticated`
-- only. Recreating the function drops the old grant, so it is restated here rather
-- than assumed to have survived.
revoke all on function public.pf_revoke_invitation(text) from public;
revoke all on function public.pf_revoke_invitation(text) from anon;
grant execute on function public.pf_revoke_invitation(text) to authenticated;
