/**
 * Phase 1 — catalogue read path.
 *
 * Two things are pinned here, and they are different kinds of claim.
 *
 * **Source-level.** The catalogue repository must name its columns. This is not
 * style. `medicines` withholds `SELECT` on `cost_per_base_unit`,
 * `do_not_sell_locked_by` and `do_not_sell_locked_at` from `authenticated`, and
 * `medicine_batches` withholds `cost_per_base_unit`, so a `select('*')` needs a
 * privilege no caller has. An earlier version of `catalog.ts` used `*`
 * throughout and *every function in it failed* with `42501` against the real
 * project — including for the owner. A wildcard is therefore not a simplification,
 * it is an outage, and only a source assertion can catch its return.
 *
 * The hook must not fall back to the store in live mode. `useSuppliers` does, and
 * copying that pattern here would render fifteen seeded products on a real
 * deployment, both while loading and after a failure.
 *
 * **Database-level.** The cost boundary and branch isolation are asserted against
 * the real migration chain, as a customer would meet them.
 */

import {
  asActor,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedMedicine,
  seedTenants,
} from './harness.mjs';

const { check, section, finish } = createReporter('verify-catalogue-read');

const REPO = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3';
const CATALOG = `${REPO}/src/lib/supabase/catalog.ts`;
const HOOK = `${REPO}/src/hooks/use-medicines.ts`;
const OWNER_HOOK = `${REPO}/src/hooks/use-is-owner.ts`;
const MAPPING = `${REPO}/src/hooks/medicine-mapping.ts`;

const catalog = await Bun.file(CATALOG).text();
const hook = await Bun.file(HOOK).text();
const ownerHook = await Bun.file(OWNER_HOOK).text();
const mapping = await Bun.file(MAPPING).text();

/** Strip comments so prose about `*` cannot satisfy an assertion about `*`. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const catalogCode = code(catalog);
const hookCode = code(hook);

/* ------------------------------------------------------------------ source */

section('the catalogue read path names its columns');

/**
 * Wildcards are forbidden on the BASE tables only.
 *
 * `pf_medicine_costs` and `pf_batch_costs` are views whose whole output is already
 * owner-gated by a `WHERE pf_is_owner()` inside the view definition, so `select('*')`
 * there is harmless — it is in fact the right thing to ask for, since the point is to
 * take whatever cost the owner is entitled to. Scoping these assertions to the base
 * tables keeps them honest instead of failing on the one place a wildcard is allowed.
 */
const baseWildcard = /from\('(medicines|medicine_batches)'\)[\s\S]{0,400}?\.select\(\s*['"`]\*/;

check(
  'no select(\'*\') survives against a catalogue base table',
  !baseWildcard.test(catalogCode),
  'a wildcard needs SELECT on cost_per_base_unit, which authenticated does not have',
);
check(
  'no bare .select() survives on a base table (it defaults to *)',
  !/from\('(medicines|medicine_batches)'\)[\s\S]{0,400}?\.select\(\s*\)/.test(catalogCode),
  'bare .select() after insert/update is the same failure as a literal wildcard',
);
check(
  'no medicine_batches(*) embed survives',
  !/medicine_batches\(\s*['"`]\*/.test(catalogCode),
  'the embedded batches would expand to include batch cost',
);
check(
  'the owner-gated cost views are still read with a wildcard',
  /from\('pf_medicine_costs'\)\.select\('\*'\)/.test(catalogCode),
  'the view already filters on pf_is_owner(), so * is exactly the owner entitlement',
);
check(
  'the medicine read model is a named, exported column list',
  /export const MEDICINE_COLUMNS/.test(catalogCode),
  'a named constant cannot be silently widened by an edit elsewhere',
);
check(
  'the batch read model is a named, exported column list',
  /export const BATCH_COLUMNS/.test(catalogCode),
);

section('catalogue reads never request a withheld column');

const medCols = (catalogCode.match(/MEDICINE_COLUMNS\s*=\s*([\s\S]*?);\n/) || [])[1] || '';
const batchCols = (catalogCode.match(/BATCH_COLUMNS\s*=\s*([\s\S]*?);\n/) || [])[1] || '';

check(
  'MEDICINE_COLUMNS omits cost_per_base_unit',
  !/cost_per_base_unit/.test(medCols),
  'cost is owner-only and arrives through pf_medicine_costs, never here',
);
check(
  'MEDICINE_COLUMNS omits the safety-lock attribution columns',
  !/do_not_sell_locked_by/.test(medCols) && !/do_not_sell_locked_at/.test(medCols),
);
check(
  'BATCH_COLUMNS omits cost_per_base_unit',
  !/cost_per_base_unit/.test(batchCols),
);
check(
  'cost is still reachable for an owner, through the gated views',
  /from\('pf_medicine_costs'\)/.test(catalogCode) && /from\('pf_batch_costs'\)/.test(catalogCode),
  'the views filter on pf_is_owner() and return zero rows otherwise',
);

section('the write path is absent rather than present-and-broken');

check(
  'createMedicine is no longer exported',
  !/export async function createMedicine/.test(catalogCode),
  'writes are a later phase; a callable-looking write that always 42501s is worse',
);
check(
  'updateMedicine is no longer exported',
  !/export async function updateMedicine/.test(catalogCode),
);
check(
  'the absence is explained where a reader will look',
  /not part of the read-only migration/.test(catalog),
);

section('no service-role or legacy key is introduced');

const allCatalogue = [catalog, hook, ownerHook, mapping].join('\n');
check(
  'no service_role key anywhere in the new code',
  !/service_role|SUPABASE_SERVICE_ROLE/i.test(allCatalogue),
);
check(
  'no legacy JWT key material',
  !/eyJ[A-Za-z0-9_-]{20,}\./.test(allCatalogue),
);
check(
  'no new-style secret key either',
  !/sb_secret_/.test(allCatalogue),
);

section('the live catalogue has no localStorage fallback');

check(
  'useMedicines never returns the store catalogue in live mode',
  !/medicines: localMedicines/.test(hookCode.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' '))
    || /source: 'demo'/.test(hook),
  'the local collection is reachable only from the demo branch',
);
check(
  'the local collection is gated on demo mode',
  /if \(demo\)/.test(hookCode) && /demo = isDemoMode\(\)/.test(hookCode),
  'isDemoMode() is constant-false in a production build, so the branch cannot ship',
);
check(
  'the unresolved live state is empty, not stale',
  /medicines: \[\]/.test(hookCode),
);
check(
  'a failed read surfaces as an error rather than falling back',
  /setError\('The product catalogue could not be loaded\.'\)/.test(hookCode),
);
check(
  'a branch that failed to resolve is reported as an error',
  /status === 'error'/.test(hookCode),
  'another pharmacy\'s cached rows must never stand in',
);

section('ownership follows the authoritative branch membership role');

check(
  'useIsOwner delegates to the existing pf_is_owner helper',
  /from '~\/lib\/supabase\/tenant'/.test(ownerHook) && /queryIsOwner/.test(ownerHook),
  'tenant.ts already asks the database; role logic is not duplicated',
);
check(
  'useIsOwner does not read profiles.role',
  !/currentUser\.role/.test(ownerHook.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')) ||
    /demo/i.test(ownerHook),
  'profiles.role is a display cache; the demo branch is the only legitimate use',
);
check(
  'the catalogue repository never filters on branch_id',
  !/\.eq\('branch_id'/.test(catalogCode),
  'RLS already scopes every row; a client filter is a check a hostile caller omits',
);

section('search ranking is unchanged');

const selectors = await Bun.file(`${REPO}/src/domain/selectors.ts`).text();
check(
  'the client-side ranker still exists',
  /export function searchMedicines/.test(selectors),
);
check(
  'it still scores name before generic before strength',
  /name\.startsWith/.test(selectors) && /generic\.startsWith/.test(selectors) &&
    /strength\.includes/.test(selectors),
  'the eight-tier ladder is the behaviour the UI has always had',
);
check(
  'the repository is not presented as a drop-in for it',
  /not the search path/i.test(catalog),
  'the DB version is unranked and matches no strength or category',
);

section('the mapping translates rather than invents');

check(
  'cost is omitted from the mapped object, not defaulted to zero',
  !/costPerBaseUnit:\s*0/.test(mapping) && !/costPerBaseUnit:\s*Number\(/.test(mapping),
  'unknown cost and free must not look alike',
);
check(
  'the database id becomes the medicine identity',
  /id: row\.id/.test(mapping),
  'seed ids are demo-only and are never mapped onto a row',
);
check(
  'branch_id is not carried onto the domain object',
  !/branch_id:/.test(mapping.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')),
  'the row is already scoped; carrying it invites a client-side filter',
);
check(
  'the prescription enum is translated in both directions',
  /otc: 'OTC'/.test(mapping) && /controlled: 'Controlled'/.test(mapping),
);
check(
  'doNotSell keeps its nested shape',
  /doNotSell:\s*\{\s*active:/.test(mapping.replace(/\s+/g, ' ')),
);

/* --------------------------------------------------------------- database */

section('branch isolation and cost protection, against the real migrations');

// The harness pattern, copied from verify-tenant-isolation.mjs, which is the
// suite that already proves these properties:
//
//   1. `set_actor(id)` establishes the JWT subject, because `pf_current_branch()`
//      resolves through `auth.uid()`.
//   2. `asAuthenticated(db, fn)` then drops the role to `authenticated` so RLS
//      applies, and returns `{ ok, value, err }` instead of throwing.
//
// The first version of this suite used `asActor` alone. That sets the subject but
// leaves the role as the database owner, which bypasses RLS — so every isolation
// and cost assertion passed or failed for the wrong reason. Four failures here were
// a harness bug, not a schema finding, which is the trap `verify-harness-isolation`
// exists to catch.
const database = await freshDatabase();
const ids = await seedTenants(database);
const own = await seedMedicine(database, { branchId: ids.BRANCH_A });

// A second medicine in another branch, so isolation has something to hide.
await asActor(database, null, () =>
  query(database, `select set_actor($1)`, [ids.OWNER_B]),
);
await database.query(
  `insert into branch_memberships (user_id, branch_id, role) values ($1, $2, 'owner')
   on conflict do nothing`,
  [ids.OWNER_B, ids.BRANCH_B],
);
const theirs = await seedMedicine(database, { branchId: ids.BRANCH_B });

check(
  'two branches each hold one medicine',
  (await query(database, 'select count(*)::int as n from medicines')).at(0)?.n === 2,
);

check(
  'a medicine exists in branch A',
  (await query(database, 'select count(*)::int as n from medicines where branch_id = $1', [ids.BRANCH_A]))
    .at(0)?.n === 1,
);

// ---- branch isolation -------------------------------------------------------
await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);

const crossBranch = await asAuthenticated(database, () =>
  query(database, 'select id from medicines'),
);
check(
  'an assistant reads only their own branch catalogue',
  crossBranch.ok && crossBranch.value.length === 1 && crossBranch.value[0].id === own.medicineId,
  crossBranch.ok
    ? `${crossBranch.value.length} row(s); own branch's medicine ${crossBranch.value[0]?.id === own.medicineId ? 'present' : 'MISSING'}`
    : crossBranch.err,
);

const crossBranchExplicit = await asAuthenticated(database, () =>
  query(database, 'select id from medicines where branch_id <> pf_current_branch()'),
);
check(
  'an explicit cross-branch filter returns nothing',
  crossBranchExplicit.ok && crossBranchExplicit.value.length === 0,
  crossBranchExplicit.ok ? `${crossBranchExplicit.value.length} rows` : crossBranchExplicit.err,
);

const otherBranchId = await asAuthenticated(database, () =>
  query(database, 'select id from medicines where id = $1', [theirs.medicineId]),
);
check(
  "another branch's medicine is not readable by id either",
  otherBranchId.ok && otherBranchId.value.length === 0,
  otherBranchId.ok ? `${otherBranchId.value.length} rows` : otherBranchId.err,
);

// ---- cost confidentiality --------------------------------------------------
for (const [table, column] of [
  ['medicines', 'cost_per_base_unit'],
  ['medicine_batches', 'cost_per_base_unit'],
]) {
  const r = await asAuthenticated(database, () => query(database, `select ${column} from ${table}`));
  check(
    `an assistant cannot select ${table}.${column}`,
    !r.ok,
    r.ok ? 'READ SUCCEEDED - cost confidentiality is broken' : `refused: ${r.err}`,
  );
}

const costView = await asAuthenticated(database, () => query(database, 'select * from pf_medicine_costs'));
check(
  'the owner-gated cost view returns no rows to an assistant rather than an error',
  costView.ok && costView.value.length === 0,
  costView.ok ? `${costView.value.length} rows` : costView.err,
);

// ---- assistant writes: retail yes, cost no ---------------------------------
await database.query(`select set_actor($1)`, [ids.ASSISTANT_A]);

const priceWrite = await asAuthenticated(database, () =>
  query(database, 'update medicines set price_per_base_unit = 120 where id = $1', [own.medicineId]),
);
check(
  'an assistant CAN change the retail price',
  priceWrite.ok,
  priceWrite.ok ? 'accepted' : priceWrite.err,
);

const costWrite = await asAuthenticated(database, () =>
  query(database, 'update medicines set cost_per_base_unit = 1 where id = $1', [own.medicineId]),
);
check(
  'an assistant CANNOT change purchase cost',
  !costWrite.ok && /owner/i.test(costWrite.err),
  costWrite.ok ? 'ACCEPTED - cost boundary broken' : `refused: ${costWrite.err}`,
);

const unitsWrite = await asAuthenticated(database, () =>
  query(
    database,
    `update medicines
       set units = '[{"key":"t","name":"Tablet","multiplier":1,"sellingPrice":10},
                     {"key":"box","name":"Box","multiplier":50,"sellingPrice":400}]'::jsonb
     where id = $1`,
    [own.medicineId],
  ),
);
check(
  'an assistant CANNOT repackage a product',
  !unitsWrite.ok && /owner/i.test(unitsWrite.err),
  unitsWrite.ok ? 'ACCEPTED - unit-write boundary broken' : `refused: ${unitsWrite.err}`,
);

/**
 * DELETE under RLS filters rather than raises: a row the policy excludes is simply
 * not visible to the statement, so the query succeeds having matched nothing.
 * Asserting on `ok` alone would read as "the delete succeeded", which is the
 * opposite of what happened - the first version of this suite made exactly that
 * mistake. The row surviving is the actual claim.
 */
const deleteTry = await asAuthenticated(database, () =>
  query(database, 'delete from medicines where id = $1', [own.medicineId]),
);
check(
  'an assistant delete statement is accepted but matched no rows',
  deleteTry.ok,
  deleteTry.ok ? 'RLS filtered it, as expected' : deleteTry.err,
);
const stillThere = await asAuthenticated(database, () =>
  query(database, 'select id from medicines where id = $1', [own.medicineId]),
);
check(
  '...so the medicine is still there afterwards',
  stillThere.ok && stillThere.value.length === 1,
  stillThere.ok ? `${stillThere.value.length} row(s) remain` : stillThere.err,
);

// ---- owner writes ----------------------------------------------------------
await database.query(`select set_actor($1)`, [ids.OWNER_A]);

/**
 * No `RETURNING cost_per_base_unit` here, and the omission is load-bearing.
 * RETURNING needs SELECT on the returned column, and `authenticated` has no SELECT
 * on `cost_per_base_unit` - including the owner. So the natural-looking
 * `... returning cost_per_base_unit` fails with `permission denied for table
 * medicines` even on a legitimate owner write. That is a trap for the write phase;
 * it is asserted explicitly below rather than quietly worked around.
 */
const ownerCost = await asAuthenticated(database, () =>
  query(database, 'update medicines set cost_per_base_unit = 77 where id = $1', [own.medicineId]),
);
check(
  'an owner CAN set purchase cost',
  ownerCost.ok,
  ownerCost.ok ? 'accepted' : ownerCost.err,
);

const ownerCostReturning = await asAuthenticated(database, () =>
  query(
    database,
    'update medicines set cost_per_base_unit = 78 where id = $1 returning cost_per_base_unit',
    [own.medicineId],
  ),
);
check(
  'but RETURNING on the cost column is refused for an owner too (it needs SELECT)',
  !ownerCostReturning.ok,
  ownerCostReturning.ok
    ? 'RETURNING succeeded - the column grant is not withholding cost'
    : `refused: ${ownerCostReturning.err}`,
);

const ownerUnits = await asAuthenticated(database, () =>
  query(
    database,
    `update medicines
       set units = '[{"key":"t","name":"Tablet","multiplier":1,"sellingPrice":10},
                     {"key":"box","name":"Box","multiplier":50,"sellingPrice":400}]'::jsonb
     where id = $1`,
    [own.medicineId],
  ),
);
check(
  'an owner CAN repackage a product',
  ownerUnits.ok,
  ownerUnits.ok ? 'accepted' : ownerUnits.err,
);

const ownerCostView = await asAuthenticated(database, () =>
  query(database, 'select * from pf_medicine_costs'),
);
check(
  'the owner-gated cost view DOES return the cost to an owner',
  ownerCostView.ok && ownerCostView.value.length === 1,
  ownerCostView.ok ? `${ownerCostView.value.length} row(s)` : ownerCostView.err,
);

section('catalogue writes are gated, not silently local');

/**
 * The catalogue READS from Supabase but the write actions still rewrite
 * `state.medicines` in localStorage. Left clickable, "Adjust stock" on a real
 * product would have appeared to succeed, changed nothing in Postgres, and then
 * reverted on the next render. These assertions pin the gate that prevents it.
 *
 * The gate lives in the UI layer on purpose. The stronger place would be the store,
 * which cannot be bypassed by a caller that forgets to check � but `session.ts`
 * imports `setPharmacyCurrentUser` from `~/store/pharmacy`, so a store import back
 * to `session.ts` would close a cycle. Disabling the controls is what actually stops
 * the click. The residual risk is a future caller using `usePharmacyActions()`
 * without consulting the gate; that is called out in the write-phase notes.
 */
const gate = await Bun.file(`${REPO}/src/lib/catalogue-writes.ts`).text();
const inventorySrc = await Bun.file(`${REPO}/src/routes/_app/inventory.tsx`).text();
const unitEditorSrc = await Bun.file(`${REPO}/src/components/app/unit-editor.tsx`).text();
const gateCode = code(gate);

check(
  'a catalogue-write gate exists and derives from demo mode',
  /export function catalogueWritesAvailable/.test(gate) && /isDemoMode\(\)/.test(gate),
  'demo mode is the only configuration where the store IS the catalogue',
);
check(
  'the gate explanation says nothing was changed',
  /Nothing has been changed/.test(gate),
  'the user must not read a refusal as a silent success or as a permission problem',
);
check(
  'the gate is demo-mode based, not a build flag',
  !/DEMO_ALLOWED|__DEV_SERVER__|import\.meta\.env\.DEV/.test(gateCode),
  'a raw build flag would re-open this in every dev server against a real project',
);
check(
  'the inventory action handler refuses before opening the dialog',
  /if \(!writesAvailable\)[\s\S]{0,200}CATALOGUE_WRITE_UNAVAILABLE[\s\S]{0,200}return/.test(inventorySrc) &&
    /setPending\(next\)/.test(inventorySrc),
  'setPending must be unreachable in live mode, so no dialog can submit',
);
check(
  'the inventory refusal is shown to the user, not swallowed',
  /actionNotice/.test(inventorySrc) && /role="alert"/.test(inventorySrc),
);
check(
  'the packaging editor refuses its save before calling updateUnits',
  /if \(!writesAvailable\)[\s\S]{0,200}setError\(CATALOGUE_WRITE_UNAVAILABLE\)/.test(unitEditorSrc) &&
    /catalogueWritesAvailable/.test(unitEditorSrc),
);
check(
  'no local medicine write action was given a Supabase implementation',
  !/export async function updateMedicine/.test(catalogCode) &&
    !/export async function createMedicine/.test(catalogCode),
  'writes are a later phase; implementing them here would exceed the read scope',
);
check(
  'the read behaviour is untouched by the write gate',
  /export async function listMedicines/.test(catalogCode) &&
    /from\('medicines'\)/.test(catalogCode),
  'reads and writes are separate modules and must stay separate',
);
check(
  'ownership is still resolved from pf_is_owner, not the cache',
  /pf_is_owner/.test(ownerHook),
  'the authoritative call must be the live-mode path',
);
check(
  'profiles.role is read only on the demo branch, where there is no backend',
  (code(ownerHook).match(/currentUser\.role/g) || []).length === 1 &&
    /const demo = isDemoMode\(\)/.test(ownerHook) &&
    /if \(demo\) return demoRole === 'owner'/.test(ownerHook),
  'one occurrence in code, and it is the demo fallback; isDemoMode() is constant-false in a production build',
);
section('pf_guard_unit_write is attached to UPDATE only');
const trig = await query(
  database,
  "select pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'medicines_guard_units'",
);
check(
  'the units guard fires on BEFORE UPDATE',
  /BEFORE UPDATE ON/.test(trig.at(0)?.def || ''),
  trig.at(0)?.def,
);
check(
  'so OLD is assigned and the function may read old.units',
  !/BEFORE INSERT OR UPDATE ON/.test(trig.at(0)?.def || ''),
  'an INSERT trigger would leave OLD unassigned and the comparison would raise',
);

// Leave no actor behind: `set_actor` is session state and outlives the statement.
await asActor(database, null, () => query(database, 'select set_actor(null)'));

await finish();
