-- Revoking an invitation ends a claim only when one is actually active.
--
-- Corrects the guard introduced by 20261007130000. That migration is applied and
-- is not edited; this supersedes its definition of the same function.
--
-- ## The defect
--
-- 20261007130000 guarded the claim-clearing with:
--
--     and inv.claim_expires_at is distinct from now()
--
-- and documented it as "keeps the UPDATE from firing for rows that were never
-- claimed". It does not. `IS DISTINCT FROM` is the NULL-safe comparison, so
--
--     null is distinct from now()    -> true
--
-- A never-claimed invitation has `claim_expires_at IS NULL`, which satisfies the
-- guard, so the UPDATE fired on it and stamped `claim_expires_at = now()` onto a
-- row that had never been claimed. A live lease and an absent claim are
-- indistinguishable to that expression.
--
-- The guard excluded nothing at all. It returned false only for a row whose
-- timestamp equalled `now()` to the microsecond, which does not occur.
--
-- ## Why this is not a security hole
--
-- The function still set `revoked_at`, so the row was dead either way:
-- `pf_claim_invitation` refuses `revoked_at is not null` and so does
-- `pf_redeem_invitation`. What was wrong was the data written and the claim made
-- about it — a revoked invitation carried a claim timestamp it never had.
--
-- ## Why the fix moves the condition into SET
--
-- The tempting repair is to add the active-claim test to the WHERE clause. That
-- would be a regression: a never-claimed invitation would then match zero rows,
-- `v_id` would be null, and `pf_revoke_invitation` would return false — the owner
-- could no longer withdraw a code nobody had claimed. Withdrawal must not depend
-- on claim state.
--
-- So the WHERE clause keeps exactly the checks it had, and the claim timestamp is
-- assigned conditionally:
--
--     claim_expires_at = case
--       when <a claim exists and its lease is still running> then now()
--       else inv.claim_expires_at        -- NULL stays NULL
--     end
--
-- ## What "active" means here
--
-- All three parts are required, and each excludes a different state:
--
--   claimed_at is not null          a claim actually happened; without this a
--                                   never-claimed row is indistinguishable
--   claim_expires_at is not null    the lease deadline was written
--   claim_expires_at > now()        the lease has not yet lapsed; strictly
--                                   greater, so at the expiry instant the claim
--                                   is already over and needs no clearing
--
-- An invitation whose lease has already lapsed keeps its old timestamp. It is
-- already in the past, so nothing reads it as a live claim, and rewriting it would
-- be the same noise this migration exists to remove.
--
-- ## Preserved exactly
--
-- Authorization (`auth.uid()`, `pf_is_owner()`), branch scoping, the
-- `accepted_at is null` and `revoked_at is null` predicates, the boolean return,
-- `SECURITY DEFINER`, `set search_path to 'public'`, and every grant.
--
-- `pf_redeem_invitation` is not touched: it remains the only path in this flow
-- that creates a membership.

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
  -- The WHERE clause is unchanged from 20261006090000 and deliberately says
  -- nothing about claims: whether anybody has claimed this code must not decide
  -- whether the owner can withdraw it.
  update public.staff_invitations as inv
     set revoked_at = now(),
         -- Collapse the lease only when one is genuinely running. `else` passes the
         -- current value through untouched, so NULL stays NULL and an already-lapsed
         -- timestamp keeps its history rather than being rewritten to the moment of
         -- the revocation.
         claim_expires_at = case
           when inv.claimed_at is not null
            and inv.claim_expires_at is not null
            and inv.claim_expires_at > now()
           then now()
           else inv.claim_expires_at
         end
   where inv.token = p_token
     and inv.branch_id = pf_current_branch()
     and inv.accepted_at is null
     and inv.revoked_at is null
  returning inv.id into v_id;

  return v_id is not null;
end;
$$;

comment on function public.pf_revoke_invitation(text) is
  'Owner-only, scoped to their own branch. Withdraws an unused invitation and ends its '
  'claim, but only when a claim exists and its lease is still running. Corrects the '
  'guard in 20261007130000, which treated a NULL claim_expires_at as distinct from '
  'now() and so stamped a claim onto never-claimed invitations.';

-- ---------------------------------------------------------------- grants
--
-- Unchanged from 20261006090000 and restated from 20261007130000: owner actions are
-- `authenticated` only. Recreating the function drops the old ACL, so the revoke is
-- repeated rather than assumed to have survived.
revoke all on function public.pf_revoke_invitation(text) from public;
revoke all on function public.pf_revoke_invitation(text) from anon;
grant execute on function public.pf_revoke_invitation(text) to authenticated;
