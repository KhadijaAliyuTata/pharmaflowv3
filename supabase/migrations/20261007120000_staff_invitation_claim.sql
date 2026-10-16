-- Reservation for staff invitation acceptance.
--
-- Additive only. `staff_invitations` and all three of its functions already exist and
-- are exercised by `verify-staff-invitations.mjs`; this extends that one system rather
-- than introducing a second. No table is created, no policy is dropped or relaxed, and
-- no existing column changes meaning.
--
-- ## Why this is needed
--
-- `/api/accept-invite` validates an invitation and then calls `auth.admin.createUser`.
-- Those are two systems that cannot share a transaction — the row is in Postgres, the
-- account is in GoTrue. Between the read and the create, the invitation can be revoked
-- or expire, and a second concurrent request can start the same creation.
--
-- This adds a short-lived *reservation* so that window is one atomic statement instead
-- of two network calls. It is deliberately not a consumption: `accepted_at` still
-- belongs to `pf_redeem_invitation` and nothing here changes it.
--
-- ## What the reservation does and does not decide
--
-- It sequences account creation. It grants nothing:
--
--   * It cannot create a membership, a branch, or a role.
--   * `pf_redeem_invitation` remains the only authority for membership, and it reads
--     neither of these columns. A redeemed invitee is unaffected by an active claim.
--   * It never sets `accepted_at`, so an invitation is not consumed by being claimed.
--
-- ## The window that remains open
--
-- A claim is a Postgres write; `createUser` is an HTTPS call. An owner can revoke in
-- between, and revocation cannot cancel a request already in flight. What that can
-- produce is a confirmed account with no membership — an inert account, since
-- `pf_current_branch()` is NULL and every policy resolves to nothing. It cannot see the
-- pharmacy. Recovering from it needs no new mechanism: the owner re-issues an
-- invitation to that address and the person redeems it.
--
-- ## Lease length
--
-- Four minutes. Long enough to cover a slow GoTrue round trip, short enough that a
-- person who hit a transient error is not locked out of retrying while waiting for a
-- lease to expire. A longer lease would make concurrent-double-submit protection work
-- against the user, since a failed attempt and a genuine duplicate look identical from
-- the server's side.
--
-- ## Release
--
-- There is none, by design. A claim is released by the passage of time, never by a
-- compensating write, so there is no second operation that can fail and strand someone
-- mid-recovery.

alter table public.staff_invitations
  add column if not exists claimed_at timestamptz;

alter table public.staff_invitations
  add column if not exists claim_expires_at timestamptz;

-- The claim RPC probes by token, which already resolves through
-- `staff_invitations_token_idx`. This index serves the owner's invitation list and
-- the sweep for stale claims, which filters on the lease column.
create index if not exists staff_invitations_claim_idx
  on public.staff_invitations (claim_expires_at)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------- pf_claim_invitation
--
-- Reserve a live invitation for one acceptance attempt, or refuse.
--
-- Returns the row's address on success, and NULL on any refusal. The caller cannot
-- act on the reason from SQL, so the endpoint's `evaluateInvitation` stays the single
-- source of user-facing wording; this function's job is only to make the check and
-- the write one statement.
--
-- SECURITY DEFINER because the caller is `service_role` acting through PostgREST with
-- no session and therefore no `auth.uid()`. `service_role` holds BYPASSRLS, so the
-- RLS on this table would otherwise filter the UPDATE to zero rows and every claim
-- would fail.
--
-- The single `UPDATE ... WHERE` is what makes concurrent claims safe: two callers
-- racing produce one row updated and one zero-row update, and the loser sees NULL. A
-- read-then-write pair could not make that guarantee.

create or replace function public.pf_claim_invitation(p_token text)
returns table (email text, claim_expires_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email text;
  v_until timestamptz;
begin
  if p_token is null or btrim(p_token) = '' then
    return;
  end if;

  -- Bounded to the same four minutes as the column default, so a lease taken here
  -- and a lease taken by any other caller cannot disagree about how long a claim
  -- lasts.
  v_until := now() + interval '4 minutes';

  -- Qualified throughout: this function's OUT parameter is named `email`, which is
  -- also a column of the target table, so a bare reference would be ambiguous in
  -- plpgsql.
  return query
  update public.staff_invitations as inv
     set claimed_at      = now(),
         claim_expires_at = v_until
   where inv.token = btrim(p_token)
     and inv.accepted_at is null
     and inv.revoked_at is null
     and (inv.expires_at is null or inv.expires_at > now())
     and (
       inv.claimed_at is null
       or inv.claim_expires_at is null
       or inv.claim_expires_at < now()
     )
  returning inv.email, inv.claim_expires_at;
end;
$$;

comment on function public.pf_claim_invitation(text) is
  'Reserves a live invitation for one acceptance attempt and returns its address, or '
  'returns no row when the invitation is withdrawn, accepted, expired, or already '
  'claimed by a live lease. Grants nothing: only pf_redeem_invitation creates a '
  'membership. Reachable only by service_role.';

-- ---------------------------------------------------------------- grants
--
-- Reachable only by `service_role`.
--
-- PostgreSQL grants EXECUTE to PUBLIC on every new function, and `anon` reaching a
-- SECURITY DEFINER function is the exact defect that
-- 20261005190000_function_execute_hardening swept from this schema. A claim RPC that
-- `anon` could call would be a database-write oracle for unauthenticated callers, so
-- the revoke is the point of this section rather than a formality.
--
-- Deliberately no grant to `authenticated` either. The browser never claims anything;
-- it calls the Worker route, which claims as service_role.
revoke all on function public.pf_claim_invitation(text) from public;
revoke all on function public.pf_claim_invitation(text) from anon;
revoke all on function public.pf_claim_invitation(text) from authenticated;

grant execute on function public.pf_claim_invitation(text) to service_role;

-- The table itself stays SELECT-only for `authenticated`, exactly as
-- 20261006090000_staff_invitations granted it. The two new columns are display-free
-- bookkeeping: nothing in the browser reads or writes them, and adding columns does
-- not widen any grant.
revoke all on public.staff_invitations from anon, authenticated;
grant select on public.staff_invitations to authenticated;
