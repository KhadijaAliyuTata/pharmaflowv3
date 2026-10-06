-- ============================================================================
-- Phase 0e: make the owner receipt-pricing step work, and only for owners
-- ============================================================================
--
-- Additive and self-contained. No file above this one is edited, the chain still
-- applies to a fresh database, and every statement is re-runnable.
--
-- ## The defect
--
-- `pf_require_owner_to_price` is the guard on the intended receiving flow:
--
--     receive  ->  owner prices it  ->  owner approves  ->  stock exists
--
-- It was SECURITY INVOKER, and its rule was guarded by an outer `if new.state =
-- 'confirmed'`. So it only ever ran on the APPROVAL step, and only checked that
-- the approver was an owner. Pricing a receipt — writing `cost_per_base_unit` while
-- the receipt sat at `pending_pricing` — fell entirely outside it.
--
-- Reproduced against this schema before the fix:
--
--     ASSISTANT update stock_receipts set cost_per_base_unit = 1   -> ACCEPTED
--
-- An attendant wrote a purchase cost. That is exactly what the owner-only cost
-- boundary exists to prevent, and `pf_guard_cost_write` does not help here because
-- it is attached to `medicines` and `medicine_batches`, not to `stock_receipts`.
--
-- ## A correction to the original finding
--
-- B5 was reported as "nobody, including the owner, can write
-- `cost_per_base_unit`". That part was a false reading of a test, and it is
-- recorded here rather than quietly dropped.
--
-- The owner was never blocked. `authenticated` holds UPDATE on the cost column but
-- no SELECT on it, and the failing statement was:
--
--     update stock_receipts set cost_per_base_unit = 55 ... returning cost_per_base_unit
--
-- `RETURNING` requires SELECT on the returned column, so that statement fails with
-- "permission denied for table stock_receipts" even when the write is permitted.
-- The write succeeds; reading the value back in the same statement does not. Costs
-- are read through `pf_receipt_costs`, which is how the app reads them.
--
-- So the real defect is narrower and it is a privilege escalation in the unsafe
-- direction, not a broken owner path. The positive half of the pricing flow was
-- never broken and is asserted in `verify-receipt-pricing.mjs` so it stays that way.
--
-- ## The fix
--
-- SECURITY DEFINER, so the guard can read the column it exists to protect. An
-- INVOKER trigger would fail on its own privilege rather than on the rule.
--
-- With the privilege obstacle removed, the rule itself is stated explicitly and
-- enforced for every caller:
--
--   * a non-owner may not write a non-zero cost. Zero stays allowed, because that
--     is the legitimate state of a receipt nobody has priced yet, and refusing it
--     would block receiving altogether.
--   * a non-owner may not move a receipt to 'confirmed'. That is the pricing
--     approval, and it belongs to the owner.
--
-- `cost_per_base_unit` also stays un-selectable to `authenticated`. Nothing here
-- grants SELECT on it: the guard reads it as the definer, and the owner reads it
-- back through `pf_receipt_costs`. Confidentiality is unchanged — this fixes who
-- may WRITE a cost, not who may READ one.
--
-- ## No batch is created here
--
-- A confirmed receipt still does not create a `medicine_batches` row. There is no
-- database mechanism for it and that is not in scope for phase 0 — see the
-- Phase 2 note in `pf_apply_sale_item_stock`. What this migration fixes is that an
-- owner can now complete the step before that handoff exists.
--
-- ============================================================================

create or replace function public.pf_require_owner_to_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Whether this statement is writing a purchase cost for the first time or
  -- changing it. On INSERT there is no OLD, so the two cases are separate rather
  -- than relying on OLD being NULL.
  cost_written boolean;
begin
  -- Trusted server context (SQL editor, migration, service_role). Matches
  -- pf_guard_profile_privileges and pf_guard_cost_write.
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    cost_written := new.cost_per_base_unit is not null and new.cost_per_base_unit <> 0;
  else
    cost_written := new.cost_per_base_unit is distinct from old.cost_per_base_unit;
  end if;

  -- Only an owner may write a purchase cost. Zero is the legitimate unpriced
  -- state and stays available so receiving is never blocked.
  if cost_written and not pf_is_owner() then
    raise exception 'Only an owner can set a purchase cost'
      using errcode = 'insufficient_privilege';
  end if;

  -- Only an owner may approve pricing.
  if new.state = 'confirmed' and not pf_is_owner() then
    raise exception 'Only an owner can approve pricing'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- Reattached so the trigger uses the redefined SECURITY DEFINER function. An
-- existing trigger would keep calling the old definition otherwise, because
-- CREATE OR REPLACE changes the body behind the same OID.
drop trigger if exists receipts_require_owner on stock_receipts;

create trigger receipts_require_owner
  before insert or update on stock_receipts
  for each row execute function public.pf_require_owner_to_price();

comment on function public.pf_require_owner_to_price() is
  'BEFORE INSERT OR UPDATE on stock_receipts, SECURITY DEFINER so it can read the cost column it protects. Refuses a non-zero cost from a non-owner, and refuses state=confirmed from a non-owner. Zero cost is allowed so receiving is never blocked. Cost stays un-selectable to authenticated; owners read it via pf_receipt_costs.';
