-- ============================================================================
-- Product creation from Stock Receiving: pf_create_medicine
-- ----------------------------------------------------------------------------
-- Apply with:  supabase db push
--
-- Additive. Nothing above this file is edited, the chain still applies to a
-- fresh database, and the function is re-runnable.
--
-- ## Why an RPC rather than a direct insert
--
-- `medicines.branch_id` has no default, and a browser that supplies it is making
-- a tenant-isolation promise the database cannot verify. The function takes no
-- branch argument: `pf_current_branch()` resolves it from the signed-in profile,
-- then the same `branch_memberships` check used by `pf_receive_stock` proves the
-- caller still belongs there. RLS is not disabled; the function is a narrow,
-- audited capability that writes one row and nothing else.
--
-- ## What it deliberately does not do
--
-- This creates a catalogue product, not stock. No batch, quantity, movement or
-- receipt is written here. The existing `pf_receive_stock` remains the only
-- receiving path, so a failed create cannot leave a half-booked delivery.
--
-- ## Duplicate safety
--
-- The form checks too, but a client check is not a constraint. The function
-- normalises case and whitespace, blocks the same name + strength + dosage form,
-- blocks an existing barcode, and takes a transaction-scoped advisory lock on
-- both identities before looking. The barcode constraint remains the final
-- guard. A legitimate second brand with the same generic name is not blocked;
-- the form shows it as a warning and the user can decide.
-- ============================================================================

create or replace function public.pf_create_medicine(p_product jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_branch   uuid;
  v_owner    boolean;
  v_name     text;
  v_generic  text;
  v_strength text;
  v_form     text;
  v_barcode  text;
  v_unit_key text;
  v_unit_name text;
  v_class    public.prescription_class;
  v_class_text text;
  v_price    numeric := 0;
  v_id       uuid;
  v_existing public.medicines%rowtype;
  v_norm_name text;
  v_norm_strength text;
  v_norm_form text;
begin
  -- ----------------------------------------------------------- who is calling
  if v_actor is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  v_branch := public.pf_current_branch();
  if v_branch is null then
    raise exception 'This account has no active pharmacy'
      using errcode = 'insufficient_privilege';
  end if;

  -- SECURITY DEFINER bypasses RLS, so membership is checked here rather than
  -- trusting a branch in the payload. The payload has no branch to trust.
  if not exists (
    select 1
    from public.branch_memberships m
    where m.user_id = v_actor
      and m.branch_id = v_branch
  ) then
    raise exception 'Only staff of this pharmacy can add products'
      using errcode = 'insufficient_privilege';
  end if;

  v_owner := public.pf_is_owner();

  -- ---------------------------------------------------------------- the payload
  if p_product is null or jsonb_typeof(p_product) <> 'object' then
    raise exception 'A product is required' using errcode = 'check_violation';
  end if;

  v_name      := nullif(btrim(coalesce(p_product ->> 'name', '')), '');
  v_generic   := coalesce(btrim(p_product ->> 'generic_name'), '');
  v_strength  := nullif(btrim(coalesce(p_product ->> 'strength', '')), '');
  v_form      := nullif(btrim(coalesce(p_product ->> 'dosage_form', '')), '');
  v_barcode   := nullif(btrim(coalesce(p_product ->> 'barcode', '')), '');
  v_unit_key  := nullif(btrim(coalesce(p_product ->> 'unit_key', '')), '');
  v_unit_name := nullif(btrim(coalesce(p_product ->> 'unit_name', '')), '');
  v_class_text := nullif(btrim(coalesce(p_product ->> 'prescription_class', '')), '');

  if v_name is null then
    raise exception 'Product name is required' using errcode = 'check_violation';
  end if;
  if length(v_name) > 120 then
    raise exception 'Product name must be 120 characters or fewer'
      using errcode = 'check_violation';
  end if;
  if length(v_generic) > 120 then
    raise exception 'Generic name must be 120 characters or fewer'
      using errcode = 'check_violation';
  end if;
  if v_strength is null then
    raise exception 'Strength is required' using errcode = 'check_violation';
  end if;
  if length(v_strength) > 60 then
    raise exception 'Strength must be 60 characters or fewer'
      using errcode = 'check_violation';
  end if;
  if v_form is null then
    raise exception 'Dosage form is required' using errcode = 'check_violation';
  end if;
  if length(v_form) > 60 then
    raise exception 'Dosage form must be 60 characters or fewer'
      using errcode = 'check_violation';
  end if;
  if v_barcode is not null and length(v_barcode) > 64 then
    raise exception 'Barcode must be 64 characters or fewer'
      using errcode = 'check_violation';
  end if;
  if v_unit_name is null then
    raise exception 'Unit of measurement is required' using errcode = 'check_violation';
  end if;
  if length(v_unit_name) > 40 then
    raise exception 'Unit of measurement must be 40 characters or fewer'
      using errcode = 'check_violation';
  end if;
  if v_unit_key is null or v_unit_key !~ '^[a-z0-9][a-z0-9_-]{0,79}$' then
    raise exception 'The unit identifier is invalid' using errcode = 'check_violation';
  end if;

  if v_class_text is null or v_class_text not in ('otc', 'prescription', 'controlled') then
    raise exception 'Choose a valid prescription class' using errcode = 'check_violation';
  end if;
  v_class := v_class_text::public.prescription_class;

  -- Pricing is an owner decision, matching pf_update_medicine_price and
  -- pf_receive_stock. An assistant may add the catalogue row; the price is
  -- created at zero rather than refused, so receiving is not blocked by a
  -- permission the assistant does not have.
  begin
    v_price := coalesce(nullif(p_product ->> 'selling_price', '')::numeric, 0);
  exception when others then
    raise exception 'Selling price must be a number' using errcode = 'check_violation';
  end;

  if v_price = 'NaN'::numeric or v_price < 0 then
    raise exception 'Selling price must be zero or more' using errcode = 'check_violation';
  end if;
  if v_price > 999999999 then
    raise exception 'That selling price is too large' using errcode = 'check_violation';
  end if;
  if round(v_price, 2) <> v_price then
    raise exception 'Selling price supports at most two decimal places'
      using errcode = 'check_violation';
  end if;
  if not v_owner then
    v_price := 0;
  end if;

  -- ------------------------------------------------------- duplicate detection
  v_norm_name := lower(regexp_replace(v_name, '[[:space:]]+', ' ', 'g'));
  v_norm_strength := lower(regexp_replace(v_strength, '[[:space:]]+', ' ', 'g'));
  v_norm_form := lower(regexp_replace(v_form, '[[:space:]]+', ' ', 'g'));

  -- The identity lock closes the window between "no match" and INSERT. A
  -- hash collision only serialises two unrelated creates; it cannot merge them.
  perform pg_advisory_xact_lock(
    hashtext(v_branch::text || '|product|' || v_norm_name || '|' ||
             v_norm_strength || '|' || v_norm_form)
  );
  if v_barcode is not null then
    perform pg_advisory_xact_lock(
      hashtext(v_branch::text || '|barcode|' || lower(v_barcode))
    );
  end if;

  select m.* into v_existing
    from public.medicines m
   where m.branch_id = v_branch
     and (
       (v_barcode is not null and lower(btrim(coalesce(m.barcode, ''))) = lower(v_barcode))
       or (
         lower(regexp_replace(btrim(m.name), '[[:space:]]+', ' ', 'g')) = v_norm_name
         and lower(regexp_replace(btrim(m.strength), '[[:space:]]+', ' ', 'g')) = v_norm_strength
         and lower(regexp_replace(btrim(m.dosage_form), '[[:space:]]+', ' ', 'g')) = v_norm_form
       )
     )
   order by
     case when v_barcode is not null
               and lower(btrim(coalesce(m.barcode, ''))) = lower(v_barcode)
          then 0 else 1 end
   limit 1;

  if found then
    if v_barcode is not null
       and lower(btrim(coalesce(v_existing.barcode, ''))) = lower(v_barcode) then
      raise exception 'A product with this barcode already exists: %', v_existing.name
        using errcode = 'unique_violation';
    end if;
    raise exception
      'That product already exists: % - %. Select it instead of creating a duplicate.',
      v_existing.name, v_existing.strength
      using errcode = 'unique_violation';
  end if;

  -- ---------------------------------------------------------------- the write
  insert into public.medicines (
    branch_id,
    barcode,
    name,
    generic_name,
    strength,
    dosage_form,
    category,
    units,
    expiry_date,
    purchase_date,
    prescription_class,
    price_per_base_unit
  ) values (
    v_branch,
    v_barcode,
    v_name,
    v_generic,
    v_strength,
    v_form,
    '',
    jsonb_build_array(jsonb_build_object(
      'key', v_unit_key,
      'name', v_unit_name,
      'multiplier', 1,
      'sellingPrice', v_price
    )),
    -- No delivery is known at this point. One year is the same safe placeholder
    -- used elsewhere for a catalogue row with no batch; the receipt's own expiry
    -- is stored on the batch and drives sellability. This date never creates
    -- stock by itself.
    current_date + 365,
    current_date,
    v_class,
    v_price
  )
  returning id into v_id;

  insert into public.audit_events (branch_id, actor_id, action, description, metadata)
  values (
    v_branch,
    v_actor,
    'product_created',
    format('Added %s - %s to the catalogue', v_name, v_strength),
    jsonb_build_object(
      'medicine_id', v_id,
      'unit_key', v_unit_key,
      'unit_name', v_unit_name,
      'prescription_class', v_class,
      'barcode', v_barcode
    )
  );

  return jsonb_build_object(
    'id', v_id,
    'medicine_id', v_id,
    'name', v_name,
    'branch_id', v_branch
  );
end;
$$;

comment on function public.pf_create_medicine(jsonb) is
  'Creates one catalogue product in the caller''s current branch. Adds no stock, batch or receipt. Duplicate name+strength+form and duplicate barcode are refused. The branch is resolved server-side; non-owner selling prices are written as zero.';

revoke execute on function public.pf_create_medicine(jsonb) from public;
revoke execute on function public.pf_create_medicine(jsonb) from anon;
grant execute on function public.pf_create_medicine(jsonb) to authenticated;
