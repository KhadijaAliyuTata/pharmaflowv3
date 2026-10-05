-- ============================================================================
-- Branch registration details: PCN number and premises number
-- ============================================================================
--
-- Additive only. The two earlier migrations are untouched and all three remain
-- safe to re-run.
--
-- ## Why
--
-- An owner dashboard has to state which pharmacy it is speaking for. PCN
-- (Pharmacy Council of Nigeria) number and premises number are the two
-- identifiers a regulator recognises, and neither existed anywhere in the schema:
-- `branches` had address and phone but no registration identity.
--
-- `User.licenseNumber` already exists but is a *person's* licence held by a staff
-- member, not the pharmacy's registration. Putting a branch registration number
-- there would make it change when a different owner signs in, which is exactly
-- the kind of quiet wrongness this schema avoids elsewhere — so these are
-- branch-level, where they belong.
--
-- ## Nullable on purpose
--
-- Both stay NULL for every existing branch. A missing number must render as "Not
-- set" on screen, never as a blank or a zero: an invented registration number on
-- a compliance surface is worse than an admitted gap. No backfill, because there
-- is no truthful source to backfill from.
--
-- ## Authorization
--
-- `branches` already has `branches_read` (select) and `branches_owner_write`
-- (all, owner-only), and the column grant at the bottom of the initial migration
-- is table-level for `branches`, so these two columns inherit both. No new grant,
-- no new policy, no new role.
--
-- ============================================================================

alter table branches
  add column if not exists pcn_number      text,
  add column if not exists premises_number text;

comment on column branches.pcn_number is
  'Pharmacy Council of Nigeria registration number for this pharmacy. Null = not configured; render as "Not set", never invent one.';
comment on column branches.premises_number is
  'Physical premises registration number. Null = not configured; render as "Not set", never invent one.';

-- Normalise obvious junk at the storage boundary so the UI never has to guess:
-- an empty string is "not configured", and a PCN is stored uppercase without
-- inner padding. Comparison and lookup are case-insensitive in practice.
create or replace function pf_normalise_registration_numbers()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pcn_number is not null then
    new.pcn_number := nullif(upper(btrim(new.pcn_number)), '');
  end if;
  if new.premises_number is not null then
    new.premises_number := nullif(btrim(new.premises_number), '');
  end if;
  return new;
end;
$$;

drop trigger if exists branches_normalise_registration on branches;
create trigger branches_normalise_registration
  before insert or update of pcn_number, premises_number on branches
  for each row execute function pf_normalise_registration_numbers();
