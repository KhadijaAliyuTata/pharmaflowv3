/**
 * Creating a catalogue product from Stock Receiving.
 *
 * This suite runs against the real migration chain in PGlite, not the demo
 * store. It covers the live `pf_create_medicine` contract and then the complete
 * receive-after-create path, because a product that saves but cannot be received
 * or priced is not actually usable.
 *
 * The hard requirements pinned here:
 *
 *   - the branch comes from the signed-in profile, never the payload;
 *   - duplicate name + strength + form and duplicate barcode are refused;
 *   - a legitimate second brand sharing a generic name is not refused;
 *   - an assistant may create the row but cannot set its price;
 *   - a failed create writes no product and no receipt;
 *   - the created product can be received, appears in stock, and can be priced
 *     by the owner afterwards.
 */

import {
  asAnon,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-product-create');

const db = await freshDatabase();
const ids = await seedTenants(db);

/** Run as an actor under the authenticated role, restoring both afterwards. */
async function as(actorId, fn) {
  await db.query(`select set_actor($1)`, [actorId]);
  return asAuthenticated(db, fn);
}

function product(overrides = {}) {
  return {
    name: 'Paracetamol Extra',
    generic_name: 'Paracetamol',
    strength: '500 mg',
    dosage_form: 'Tablet',
    barcode: '1234567890123',
    unit_name: 'Tablet',
    unit_key: 'tablet',
    prescription_class: 'otc',
    selling_price: 250,
    ...overrides,
  };
}

async function create(actorId, payload) {
  return as(actorId, () =>
    query(db, `select public.pf_create_medicine($1::jsonb) as created`, [JSON.stringify(payload)]),
  );
}

function unitsOf(row) {
  return Array.isArray(row.units) ? row.units : JSON.parse(row.units);
}

section('owner creates a product in the branch resolved from the profile');
let createdId = null;
{
  const result = await create(ids.OWNER_A, product());
  check('owner create succeeds', result.ok, result.ok ? '' : `REFUSED: ${result.err}`);
  createdId = result.ok ? result.value[0]?.created?.id : null;
  check('the function returns the saved product id', Boolean(createdId), String(createdId));

  const rows = await query(
    db,
    `select id, branch_id, barcode, name, generic_name, strength, dosage_form,
            prescription_class, price_per_base_unit, total_quantity, units,
            expiry_date > current_date as expiry_future,
            purchase_date = current_date as purchased_today
       from medicines where id = $1`,
    [createdId],
  );
  const row = rows[0];
  check('the product is persisted', Boolean(row), row?.id ?? 'not found');
  check('it belongs to the caller\'s branch', row?.branch_id === ids.BRANCH_A, String(row?.branch_id));
  check('name and whitespace are normalised', row?.name === 'Paracetamol Extra', row?.name);
  check('generic name is stored', row?.generic_name === 'Paracetamol', row?.generic_name);
  check('strength and dosage form are stored', row?.strength === '500 mg' && row?.dosage_form === 'Tablet');
  check('barcode is stored', row?.barcode === '1234567890123', String(row?.barcode));
  check('prescription class is stored', row?.prescription_class === 'otc', row?.prescription_class);
  check('the owner price is stored', Number(row?.price_per_base_unit) === 250, String(row?.price_per_base_unit));
  check('creation does not create stock', row?.total_quantity === 0, String(row?.total_quantity));
  check('the expiry placeholder is in the future', row?.expiry_future === true);
  check('the purchase date is today', row?.purchased_today === true);

  const units = row ? unitsOf(row) : [];
  check(
    'exactly one base unit is created with the owner price',
    units.length === 1 &&
      units[0].key === 'tablet' &&
      units[0].name === 'Tablet' &&
      units[0].multiplier === 1 &&
      Number(units[0].sellingPrice) === 250,
    JSON.stringify(units),
  );
}

section('the create is audited and visible through RLS');
{
  const audit = await query(
    db,
    `select action, actor_id, branch_id, metadata
       from audit_events
      where action = 'product_created'
        and metadata ->> 'medicine_id' = $1`,
    [createdId],
  );
  check('one product_created audit event exists', audit.length === 1, `${audit.length} row(s)`);
  check('the audit names the caller', audit[0]?.actor_id === ids.OWNER_A, String(audit[0]?.actor_id));
  check('the audit is in the same branch', audit[0]?.branch_id === ids.BRANCH_A);

  const visible = await as(ids.OWNER_A, () =>
    query(db, `select id from medicines where id = $1`, [createdId]),
  );
  check(
    'the owner can read the new product through RLS',
    visible.ok && visible.value.length === 1,
    visible.ok ? `${visible.value.length} row(s)` : `REFUSED: ${visible.err}`,
  );

  const otherTenant = await as(ids.OWNER_B, () =>
    query(db, `select id from medicines where id = $1`, [createdId]),
  );
  check(
    'another pharmacy cannot see it',
    otherTenant.ok && otherTenant.value.length === 0,
    otherTenant.ok ? `${otherTenant.value.length} row(s)` : `REFUSED: ${otherTenant.err}`,
  );
}

section('duplicates are refused, similar products are not');
{
  const exact = await create(
    ids.OWNER_A,
    product({
      name: '  paracetamol   extra  ',
      strength: '500   mg',
      dosage_form: ' tablet ',
      // Do not let the barcode rule answer this check first: the same-product
      // name/strength/form rule is what is being pinned.
      barcode: null,
    }),
  );
  check(
    'case and whitespace do not bypass the duplicate check',
    !exact.ok && /already exists/i.test(exact.err),
    exact.ok ? 'CREATED A DUPLICATE' : exact.err,
  );

  const barcode = await create(
    ids.OWNER_A,
    product({ name: 'A Different Product', barcode: '1234567890123' }),
  );
  check(
    'a reused barcode is refused',
    !barcode.ok && /barcode/i.test(barcode.err),
    barcode.ok ? 'CREATED WITH A DUPLICATE BARCODE' : barcode.err,
  );

  // Same generic name, strength and form, but a different product name. This is
  // exactly the "check for possible duplicates" warning case: the user decides.
  const branded = await create(
    ids.OWNER_A,
    product({
      name: 'Paracetamol Extra (Brand B)',
      generic_name: 'Paracetamol',
      barcode: null,
    }),
  );
  check(
    'a different brand sharing a generic name is allowed',
    branded.ok,
    branded.ok ? String(branded.value[0]?.created?.id) : branded.err,
  );

  if (!branded.ok) note('similar-product creation failed; the duplicate rule may be too broad');
}

section('required fields, unit and price validation');
{
  const before = await query(db, `select count(*)::int as n from medicines where branch_id = $1`, [
    ids.BRANCH_A,
  ]);

  const cases = [
    ['blank name', product({ name: '   ' }), /name is required/i],
    ['missing strength', product({ strength: '' }), /strength is required/i],
    ['missing dosage form', product({ dosage_form: '' }), /dosage form is required/i],
    ['missing unit', product({ unit_name: '' }), /unit of measurement is required/i],
    ['invalid class', product({ prescription_class: 'herbal' }), /prescription class/i],
    ['negative price', product({ selling_price: -1 }), /zero or more/i],
    ['fractional kobo', product({ selling_price: 12.345 }), /two decimal places/i],
    ['missing unit key', product({ unit_key: '' }), /unit identifier is invalid/i],
  ];

  for (const [label, payload, expected] of cases) {
    const result = await create(ids.OWNER_A, payload);
    check(
      `${label} is refused`,
      !result.ok && expected.test(result.err),
      result.ok ? 'ACCEPTED INVALID INPUT' : result.err,
    );
  }

  const after = await query(db, `select count(*)::int as n from medicines where branch_id = $1`, [
    ids.BRANCH_A,
  ]);
  check(
    'no refused request created a product',
    before[0].n === after[0].n,
    `${before[0].n} before, ${after[0].n} after`,
  );
}

section('tenant isolation and anonymous access');
{
  // Same product identity in another branch is a different catalogue row.
  const b = await create(ids.OWNER_B, product());
  const id = b.ok ? b.value[0]?.created?.id : null;
  check('the same identity can exist in another branch', b.ok, b.ok ? String(id) : b.err);

  if (id) {
    const rows = await query(db, `select branch_id from medicines where id = $1`, [id]);
    check('the second row belongs to branch B', rows[0]?.branch_id === ids.BRANCH_B);
  }

  // A payload branch is ignored: the function has no branch argument at all.
  const ignored = await create(
    ids.OWNER_B,
    product({ name: 'Branch B Only', branch_id: ids.BRANCH_A, barcode: null }),
  );
  check('a payload branch_id cannot direct the write', ignored.ok, ignored.ok ? '' : ignored.err);
  if (ignored.ok) {
    const row = await query(db, `select branch_id from medicines where id = $1`, [
      ignored.value[0].created.id,
    ]);
    check('it still landed in branch B', row[0]?.branch_id === ids.BRANCH_B, String(row[0]?.branch_id));
  }

  // An authenticated user with no profile/branch is not a member of anything.
  const orphan = 'cccccccc-0000-0000-0000-000000000001';
  const noBranch = await create(orphan, product({ name: 'No Branch', barcode: null }));
  check(
    'an actor with no active pharmacy is refused',
    !noBranch.ok && /no active pharmacy/i.test(noBranch.err),
    noBranch.ok ? 'CREATED WITHOUT A BRANCH' : noBranch.err,
  );

  const anon = await asAnon(db, () =>
    query(db, `select public.pf_create_medicine($1::jsonb)`, [JSON.stringify(product({ name: 'Anon' }))]),
  );
  check(
    'anon cannot execute the create function',
    !anon.ok,
    anon.ok ? 'ANON CREATED A PRODUCT' : anon.err,
  );
}

section('assistant create and the complete receive -> price path');
let assistantProduct = null;
{
  const made = await create(
    ids.ASSISTANT_A,
    product({
      name: 'Assistant Amoxicillin',
      generic_name: 'Amoxicillin',
      strength: '250 mg',
      dosage_form: 'Capsule',
      barcode: null,
      unit_name: 'Capsule',
      unit_key: 'capsule',
      prescription_class: 'prescription',
      selling_price: 999,
    }),
  );
  check('an assistant can add a product', made.ok, made.ok ? '' : made.err);
  assistantProduct = made.ok ? made.value[0]?.created?.id : null;

  const row = assistantProduct
    ? (
        await query(
          db,
          `select price_per_base_unit, units from medicines where id = $1`,
          [assistantProduct],
        )
      )[0]
    : null;
  check(
    'an assistant cannot set the selling price',
    row && Number(row.price_per_base_unit) === 0 && Number(unitsOf(row)[0].sellingPrice) === 0,
    row ? `price=${row.price_per_base_unit} unit=${JSON.stringify(unitsOf(row))}` : 'no row',
  );

  const receipt = assistantProduct
    ? await as(ids.ASSISTANT_A, () =>
        query(
          db,
          `select public.pf_receive_stock($1::jsonb) as received`,
          [
            JSON.stringify({
              receipt_number: 'GRN-ASST-CREATE-1',
              medicine_id: assistantProduct,
              batch_number: 'LOT-ASST-1',
              base_units_received: 12,
              expiry_date: '2027-12-31',
              cost_per_base_unit: 100,
              price_per_base_unit: 500,
              received_quantity: 12,
              received_unit_key: 'capsule',
              received_unit_name: 'Capsule',
              received_unit_multiplier: 1,
            }),
          ],
        ),
      )
    : null;

  check('the assistant can receive the product just created', Boolean(receipt?.ok), receipt?.ok ? '' : receipt?.err);
  check(
    'a receipt without owner cost waits for pricing',
    receipt?.ok ? receipt.value[0]?.received?.state === 'pending_pricing' : false,
    receipt?.ok ? receipt.value[0]?.received?.state : 'no receipt',
  );

  if (assistantProduct) {
    const stock = await query(
      db,
      `select m.total_quantity, m.price_per_base_unit, b.quantity, b.batch_number
         from medicines m
         join medicine_batches b on b.medicine_id = m.id
        where m.id = $1`,
      [assistantProduct],
    );
    check(
      'the first receipt creates the batch and moves stock',
      stock[0]?.total_quantity === 12 && stock[0]?.quantity === 12 && stock[0]?.batch_number === 'LOT-ASST-1',
      JSON.stringify(stock[0]),
    );
    check(
      'receiving does not invent an assistant price',
      Number(stock[0]?.price_per_base_unit) === 0,
      String(stock[0]?.price_per_base_unit),
    );

    const priced = await as(ids.OWNER_A, () =>
      query(
        db,
        `select * from public.pf_update_medicine_price($1, 'capsule', 500, 0, 'first receipt')`,
        [assistantProduct],
      ),
    );
    check('the owner can price the product after the first receipt', priced.ok, priced.ok ? '' : priced.err);

    const pricedRow = await query(
      db,
      `select price_per_base_unit, units from medicines where id = $1`,
      [assistantProduct],
    );
    const pricedUnits = pricedRow[0] ? unitsOf(pricedRow[0]) : [];
    check(
      'the price is now saleable',
      Number(pricedRow[0]?.price_per_base_unit) === 500 && Number(pricedUnits[0]?.sellingPrice) === 500,
      JSON.stringify(pricedRow[0]),
    );
  }
}

section('receipt terms and reload-safe price synchronisation');
{
  // The receipt carries the supplier and cost, so the fixture must be a real
  // branch supplier rather than an id the RPC will refuse.
  const supplier = (
    await query(
      db,
      `insert into suppliers (branch_id, name)
       values ($1, 'Receipt Terms Supplier')
       returning id`,
      [ids.BRANCH_A],
    )
  )[0];

  const created = await create(
    ids.OWNER_A,
    product({
      name: 'Reload Cefixime',
      generic_name: 'Cefixime',
      strength: '200 mg',
      dosage_form: 'Capsule',
      barcode: null,
      unit_name: 'Capsule',
      unit_key: 'capsule',
      prescription_class: 'prescription',
      selling_price: 0,
    }),
  );
  const reloadProductId = created.ok ? created.value[0]?.created?.id : null;
  check('an unpriced product can be created for the receipt flow', created.ok, created.ok ? '' : created.err);

  const received = reloadProductId
    ? await as(ids.OWNER_A, () =>
        query(db, `select public.pf_receive_stock($1::jsonb) as received`, [
          JSON.stringify({
            receipt_number: 'GRN-RELOAD-TERMS-1',
            medicine_id: reloadProductId,
            batch_number: 'LOT-RELOAD-1',
            base_units_received: 10,
            supplier_id: supplier.id,
            expiry_date: '2027-12-31',
            cost_per_base_unit: 300,
            price_per_base_unit: 500,
            received_quantity: 10,
            received_unit_key: 'capsule',
            received_unit_name: 'Capsule',
            received_unit_multiplier: 1,
          }),
        ]),
      )
    : null;
  const receipt = received?.ok ? received.value[0]?.received : null;
  check('the owner can receive the newly created product', Boolean(receipt), received?.ok ? '' : received?.err);
  check('the receipt is confirmed with the owner price', receipt?.state === 'confirmed', receipt?.state);

  const rows = reloadProductId
    ? await query(
        db,
        `select m.supplier_id, m.cost_per_base_unit, m.price_per_base_unit,
                b.id as batch_id, b.supplier_id as batch_supplier_id,
                b.cost_per_base_unit as batch_cost, b.quantity
           from medicines m
           join medicine_batches b on b.medicine_id = m.id
          where m.id = $1`,
        [reloadProductId],
      )
    : [];
  const row = rows[0];
  check(
    'receipting still leaves the product row supplier and cost unset',
    row?.supplier_id === null && Number(row?.cost_per_base_unit) === 0,
    JSON.stringify(row),
  );
  check(
    'the product is still unpriced until the explicit sync',
    Number(row?.price_per_base_unit) === 0,
    String(row?.price_per_base_unit),
  );
  check(
    'the lot records the supplier, cost and quantity',
    row?.batch_supplier_id === supplier.id &&
      Number(row?.batch_cost) === 300 &&
      row?.quantity === 10,
    JSON.stringify(row),
  );

  const ownerCosts = reloadProductId
    ? await as(ids.OWNER_A, async () => ({
        medicine: await query(
          db,
          `select cost_per_base_unit from pf_medicine_costs where id = $1`,
          [reloadProductId],
        ),
        batch: await query(
          db,
          `select cost_per_base_unit from pf_batch_costs where id = $1`,
          [row.batch_id],
        ),
        receipt: receipt
          ? await query(
              db,
              `select cost_per_base_unit, price_per_base_unit
                 from pf_receipt_costs where id = $1`,
              [receipt.receipt_id],
            )
          : [],
      }))
    : null;
  check(
    'the owner cost view still reports zero for the product row',
    Number(ownerCosts?.value.medicine[0]?.cost_per_base_unit) === 0,
    JSON.stringify(ownerCosts?.value.medicine[0]),
  );
  check(
    'the owner lot cost view exposes the recorded 300',
    Number(ownerCosts?.value.batch[0]?.cost_per_base_unit) === 300,
    JSON.stringify(ownerCosts?.value.batch[0]),
  );
  check(
    'the receipt cost view carries both the cost and the selling price',
    Number(ownerCosts?.value.receipt[0]?.cost_per_base_unit) === 300 &&
      Number(ownerCosts?.value.receipt[0]?.price_per_base_unit) === 500,
    JSON.stringify(ownerCosts?.value.receipt[0]),
  );

  if (reloadProductId && row) {
    const assistantView = await as(ids.ASSISTANT_A, async () => ({
      batchCosts: await query(db, `select cost_per_base_unit from pf_batch_costs`),
      batchSupplier: await query(db, `select supplier_id from medicine_batches where id = $1`, [
        row.batch_id,
      ]),
    }));
    check(
      'an assistant sees no owner costs',
      assistantView.ok && assistantView.value.batchCosts.length === 0,
      assistantView.ok ? `${assistantView.value.batchCosts.length} row(s)` : assistantView.err,
    );
    check(
      'an assistant can still see which supplier delivered the lot',
      assistantView.ok && assistantView.value.batchSupplier[0]?.supplier_id === supplier.id,
      assistantView.ok ? String(assistantView.value.batchSupplier[0]?.supplier_id) : assistantView.err,
    );

    // A reload keeps only what the database persisted. Read the product and its
    // base unit again, then use that value as the optimistic lock for the same
    // owner RPC the screen calls after a receipt.
    const reloaded = await query(
      db,
      `select id, price_per_base_unit, units,
              (select id from medicine_batches where medicine_id = m.id
                order by received_date desc, expiry_date desc limit 1) as batch_id
         from medicines m where id = $1`,
      [reloadProductId],
    );
    const reloadedUnits = reloaded[0] ? unitsOf(reloaded[0]) : [];
    const baseUnit = reloadedUnits.find((unit) => unit.multiplier === 1);
    check(
      'a reload reads an unpriced base unit and the persisted lot',
      Number(reloaded[0]?.price_per_base_unit) === 0 &&
        Number(baseUnit?.sellingPrice) === 0 &&
        reloaded[0]?.batch_id === row.batch_id,
      JSON.stringify(reloaded[0]),
    );

    const priced = await as(ids.OWNER_A, () =>
      query(
        db,
        `select * from public.pf_update_medicine_price($1, $2, $3, $4, $5)`,
        [reloadProductId, baseUnit.key, 500, 0, 'selling price from receipt after reload'],
      ),
    );
    check('the existing secure price workflow accepts the post-reload price', priced.ok, priced.ok ? '' : priced.err);
    const pricedRow = await query(
      db,
      `select price_per_base_unit, units from medicines where id = $1`,
      [reloadProductId],
    );
    check(
      'the base unit and product price now match the receipt',
      Number(pricedRow[0]?.price_per_base_unit) === 500 &&
        Number(unitsOf(pricedRow[0]).find((unit) => unit.multiplier === 1)?.sellingPrice) === 500,
      JSON.stringify(pricedRow[0]),
    );
  }
}

section('a failed create leaves no receipt');
{
  const before = await query(db, `select count(*)::int as n from stock_receipts where branch_id = $1`, [
    ids.BRANCH_A,
  ]);
  const refused = await create(
    ids.OWNER_A,
    product({ name: 'Fractional Price Product', selling_price: 1.999 }),
  );
  check('the invalid create is refused', !refused.ok, refused.ok ? 'ACCEPTED' : refused.err);
  const after = await query(db, `select count(*)::int as n from stock_receipts where branch_id = $1`, [
    ids.BRANCH_A,
  ]);
  check('no receipt was written', before[0].n === after[0].n, `${before[0].n} before, ${after[0].n} after`);
}

process.exit(await finish(db));
