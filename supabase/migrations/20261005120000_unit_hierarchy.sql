-- ============================================================================
-- Multi-unit inventory: packaging audit trail + unit-write authorisation
-- ============================================================================
--
-- Additive only. Nothing here drops or rewrites data, and the initial migration
-- (20261002160000) is left exactly as committed.
--
-- ## What already worked, and is deliberately NOT changed
--
-- `medicines.units` was already a jsonb array of flat factors
-- (`{key, name, multiplier, sellingPrice}`) where `multiplier` counts BASE
-- units, and `pf_check_base_unit` already required element 0 to be the base
-- unit. `sale_items` already snapshotted `unit_key`, `unit_name`,
-- `unit_multiplier`, `quantity` and `base_units_total`, so sales reporting and
-- FEFO allocation were already unit-correct and base-unit-canonical.
--
-- A chain hierarchy (`box = 10 cards`, `card = 10 pieces`) was considered and
-- rejected: once flattened it is the same integer, it cannot be circular or
-- ambiguous by construction, and it would require re-deriving every existing
-- multiplier for no gain. The hierarchy is presentational — derived on read.
--
-- ## What this migration adds
--
-- 1. `stock_receipts` records the unit the delivery was actually counted in.
--    `base_units_received` alone cannot answer "did the supplier send five boxes
--    or five hundred tablets?", and it silently reinterprets itself if the
--    pharmacy later defines a box as 120 pieces instead of 100.
-- 2. Unit validation is strengthened from "element 0 has multiplier 1" to a
--    full check of every unit.
-- 3. Changing packaging becomes owner-only. Until now `units` sat in the plain
--    UPDATE grant, so any signed-in attendant could redefine a box from 100
--    pieces to 1 and silently restate every price, margin and stock figure in
--    the catalogue.
--
-- ============================================================================

-- ---------------------------------------------------------------- receipts
--
-- Additive columns, all nullable: a receipt that predates this migration has
-- no entered-unit context, and NULL correctly means "not recorded" rather than
-- "counted in base units". The backfill below records legacy rows honestly.

alter table stock_receipts
  add column if not exists received_quantity        integer,
  add column if not exists received_unit_key       text,
  add column if not exists received_unit_name      text,
  add column if not exists received_unit_multiplier integer;

-- Constraints are added NOT VALID so they are checked on new and updated rows
-- without a table rewrite, then validated separately. A receipt with no entered
-- unit is legitimate (recorded before this migration); a receipt with a partial
-- one is not.
alter table stock_receipts
  drop constraint if exists stock_receipts_received_quantity_positive;
alter table stock_receipts
  add constraint stock_receipts_received_quantity_positive
  check (received_quantity is null or received_quantity > 0) not valid;

alter table stock_receipts
  drop constraint if exists stock_receipts_received_unit_multiplier_positive;
alter table stock_receipts
  add constraint stock_receipts_received_unit_multiplier_positive
  check (received_unit_multiplier is null or received_unit_multiplier > 0) not valid;

alter table stock_receipts
  drop constraint if exists stock_receipts_received_unit_coherent;
alter table stock_receipts
  add constraint stock_receipts_received_unit_coherent
  check (
    num_nonnulls(received_quantity, received_unit_key, received_unit_multiplier) in (0, 3)
  ) not valid;

-- Backfill. Legacy receipts predate unit capture, so the only honest reading is
-- "counted directly in base units": quantity 1, multiplier 1, unit 'base'.
-- Recorded as a snapshot like any other, so these rows keep their original
-- meaning even if a base unit is ever renamed.
update stock_receipts r
set received_quantity        = r.base_units_received,
    received_unit_key       = 'base',
    received_unit_name      = 'Base unit',
    received_unit_multiplier = 1
where r.received_quantity is null
  and r.base_units_received is not null;

alter table stock_receipts
  validate constraint stock_receipts_received_quantity_positive;
alter table stock_receipts
  validate constraint stock_receipts_received_unit_multiplier_positive;
alter table stock_receipts
  validate constraint stock_receipts_received_unit_coherent;

create index if not exists stock_receipts_received_unit_idx
  on stock_receipts (medicine_id, received_unit_key)
  where received_unit_key is not null;

-- ------------------------------------------------------------ unit validation

-- Replaces `pf_check_base_unit`, which only asserted element 0. This checks
-- every unit, because each rule below has a concrete way to corrupt stock:
--
--   multiplier <= 0      a box containing zero pieces would silently delete
--                         stock on receipt, or multiply it on sale;
--   non-integer          fractional tablets, and rounding that quietly invents
--                         or destroys inventory;
--   duplicate key        two units answering to one key, so the POS and the
--                         receipt resolve "box" to different factors;
--   two base units       "the base unit" becomes ambiguous, doubling or
--                         halving every deduction;
--   negative price       a credit note masquerading as a catalogue entry.
create or replace function pf_validate_medicine_units()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  element       jsonb;
  unit_key      text;
  unit_name     text;
  multiplier    numeric;
  selling_price numeric;
  seen_keys     text[] := '{}';
  base_count    integer := 0;
  idx           integer;
begin
  if new.units is null or jsonb_typeof(new.units) <> 'array' then
    raise exception 'Units for % must be a JSON array', new.name
      using errcode = 'check_violation';
  end if;

  if jsonb_array_length(new.units) = 0 then
    raise exception 'A medicine needs at least one unit: %', new.name
      using errcode = 'check_violation';
  end if;

  idx := 0;
  for element in select * from jsonb_array_elements(new.units) loop
    idx := idx + 1;

    unit_key := element ->> 'key';
    unit_name := coalesce(element ->> 'name', '');
    multiplier := (element ->> 'multiplier')::numeric;
    selling_price := coalesce((element ->> 'sellingPrice')::numeric, 0);

    if unit_key is null or btrim(unit_key) = '' then
      raise exception 'Unit % of % needs an identifier', idx, new.name
        using errcode = 'check_violation';
    end if;

    if unit_key = any (seen_keys) then
      raise exception 'Duplicate unit identifier "%" on %', unit_key, new.name
        using errcode = 'check_violation';
    end if;
    seen_keys := seen_keys || unit_key;

    if btrim(unit_name) = '' then
      raise exception 'Unit "%" of % needs a name', unit_key, new.name
        using errcode = 'check_violation';
    end if;

    if multiplier is null or multiplier <> trunc(multiplier) or multiplier < 1 then
      raise exception
        'Unit "%" of % must convert to a positive whole number of base units (got %)',
        unit_key, new.name, coalesce(multiplier::text, 'null')
        using errcode = 'check_violation';
    end if;

    if selling_price < 0 then
      raise exception 'Unit "%" of % has a negative selling price', unit_key, new.name
        using errcode = 'check_violation';
    end if;

    if multiplier = 1 then
      base_count := base_count + 1;
      if idx <> 1 then
        raise exception
          'The base unit (1 base unit) must be listed first: unit "%" of % is second',
          unit_key, new.name
          using errcode = 'check_violation';
      end if;
    end if;
  end loop;

  if base_count = 0 then
    raise exception
      'No unit of % converts to exactly 1 base unit — one unit must be the base unit',
      new.name
      using errcode = 'check_violation';
  end if;

  if base_count > 1 then
    raise exception
      '% units of % claim to be the base unit — exactly one may convert to 1',
      base_count, new.name
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists medicines_base_unit on medicines;
create trigger medicines_base_unit
  before insert or update of units on medicines
  for each row execute function pf_validate_medicine_units();

-- ------------------------------------------------- unit writes are owner-only
--
-- Packaging is a financial control, not catalogue tidying. Redefining a box from
-- 100 pieces to 1 would restate every unit price, margin, stock value and
-- reorder quantity in the branch, so it is gated exactly like cost: in the
-- existing per-branch role model, via `pf_is_owner()`, with no parallel system.
--
-- `auth.uid() is null` is the trusted server context (SQL editor, migration,
-- service_role) and is exempt for the same bootstrap reason as
-- `pf_guard_cost_write` and `pf_guard_profile_privileges`.
create or replace function pf_guard_unit_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.units is distinct from old.units and not pf_is_owner() then
    raise exception 'Only an owner can change a product''s packaging units'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists medicines_guard_units on medicines;
create trigger medicines_guard_units
  before update on medicines
  for each row execute function pf_guard_unit_write();

-- ------------------------------------------------------------------- grants
--
-- `revoke all` then a column grant, matching how the initial migration handles
-- this table. The new columns carry no cost, so they are safe to read by any
-- attendant in their own branch — RLS still scopes every row.

grant select (
  id, branch_id, receipt_number, medicine_id, batch_number, base_units_received,
  supplier_id, expiry_date, received_at, received_by, state,
  price_per_base_unit, priced_by, priced_at,
  received_quantity, received_unit_key, received_unit_name, received_unit_multiplier
) on stock_receipts to authenticated;

grant insert (
  branch_id, receipt_number, medicine_id, batch_number, base_units_received,
  supplier_id, expiry_date, received_by, state, cost_per_base_unit,
  price_per_base_unit, priced_by, priced_at,
  received_quantity, received_unit_key, received_unit_name, received_unit_multiplier
) on stock_receipts to authenticated;

-- Receiving is not editable: the count that happened is what happened. Only the
-- pricing columns may change afterwards, which is why these four are absent
-- from the update grant rather than added to it.

-- ------------------------------------------------ sale_items.batch_id grant
--
-- A gap inherited from the initial migration, found while verifying unit
-- conversion against FEFO.
--
-- `sale_items.batch_id` was added by 20261004090000, and
-- `pf_apply_sale_item_stock` decrements that named lot and writes the movement
-- ledger entry. But the initial migration's column grant on `sale_items` was
-- written before the column existed and was never extended:
--
--   grant insert (sale_id, medicine_id, ..., unit_price, line_total,
--                  cost_per_base_unit_snapshot) on sale_items to authenticated;
--
-- So `batch_id` was ungrantable. Every sale therefore arrived with a NULL
-- batch_id, which by design moves no stock and records no movement — the FEFO
-- write path could not be driven from the client at all. Granting the column is
-- what makes it reachable.
--
-- Safe: `batch_id` carries no cost, and the existing `sale_items_batch_medicine`
-- guard trigger already rejects a batch belonging to a different product. RLS
-- continues to scope the row to the caller's branch.
--
-- SELECT is granted too, and it is not optional: `RETURNING batch_id` requires
-- SELECT on the returned column, so without it even a successful insert reports
-- "permission denied for table sale_items". Reading it back is what lets a
-- client confirm which lot a line actually consumed — the answer FEFO reporting
-- needs — rather than guessing from the expiry dates.
grant insert (batch_id) on sale_items to authenticated;
grant select (batch_id) on sale_items to authenticated;

-- ------------------------------------------------------------------- realtime
--
-- `stock_receipts` is deliberately not in the realtime publication. It carries
-- `cost_per_base_unit`, and Realtime filters by RLS but not by column grant —
-- publishing it would hand every subscriber the cost column this schema works
-- hard to withhold. Unchanged from the initial migration; noted here so a
-- future "just add it to realtime" change meets the reason.
