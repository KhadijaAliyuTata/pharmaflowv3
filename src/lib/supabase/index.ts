/**
 * Supabase data access.
 *
 * One import for the repository layer:
 *
 *   import { listMedicines, loadTenantContext } from '~/lib/supabase';
 *
 * Design rules this layer holds to, all of them consequences of the schema rather
 * than preferences:
 *
 *   * **No service-role key, ever.** Authorization is RLS. Repositories send the
 *     anon key and the user's own JWT, and let Postgres refuse what it should
 *     refuse. A browser-side service-role key would quietly void every policy.
 *
 *   * **No branch filters.** RLS already scopes each row to `pf_current_branch()`,
 *     so a `branch_id` argument is unnecessary and a liability — a caller can
 *     filter on the wrong tenant, and a hostile client omits the filter entirely.
 *     Isolation does not depend on the frontend remembering anything.
 *
 *   * **Never write a derived column.** `medicines.total_quantity` and
 *     `medicines.state` are maintained by triggers and are omitted from insert
 *     types, so a client cannot set stock by writing an aggregate.
 *
 *   * **Cost goes through the owner-gated views.** `cost_per_base_unit` is not
 *     selectable on the base tables. Read `pf_medicine_costs`, `pf_batch_costs`,
 *     `pf_receipt_costs` or `pf_sale_item_costs` instead; they return zero rows
 *     for anyone who is not an owner.
 *
 * Branch switching is available via listAvailableBranches() / switchBranch();
 * AppState.branch remains a single object until the store is migrated.
 *
 * Nothing here is wired into the running app yet. The screens still read from
 * the localStorage store, deliberately — see `docs/PHASE-0-DATA-MIGRATION.md`
 * for the order in which they should be pointed at these repositories.
 */

export { client, hasSession, isSupabaseConfigured, type Client } from './client';
export { fail, fromList, fromQuery, ok, type Result } from './result';
export { subscribeToStockChanges, type StockEvent } from './realtime';

export {
  listAvailableBranches,
  listBranchStaff,
  removeBranchMembership,
  setBranchMembership,
  switchBranch,
  type AvailableBranch,
  type BranchSelection,
} from './branches';

export {
  currentBranchId,
  isOwner,
  isStaff,
  loadCurrentBranch,
  loadTenantContext,
  type TenantContext,
} from './tenant';

export {
  addBatch,
  createMedicine,
  getMedicine,
  listBatchCosts,
  listBatches,
  listExpiring,
  listMedicineCosts,
  listMedicines,
  searchMedicines,
  setBatchRecalled,
  updateMedicine,
} from './catalog';

export {
  createSale,
  getSale,
  listCreditAccounts,
  listCreditLedger,
  listSaleItemCosts,
  listSales,
  recordCreditPayment,
  voidSale,
} from './sales';

export {
  createCustomer,
  getMyCustomerRecord,
  listAuditEvents,
  listCustomers,
  listSuppliers,
  recordAuditEvent,
} from './parties';