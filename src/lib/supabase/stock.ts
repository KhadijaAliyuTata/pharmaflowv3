import type { Json, ReceiptRow, ReceiptState, StaffRole, StockMovementRow } from '../db.types';
import { client, hasSession, isSupabaseConfigured } from './client';
import { fromList, type Result } from './result';

/**
 * Stock receipts and movements: the read model, and the receiving write.
 *
 * ## Cost is absent from every read here, and that is not an oversight
 *
 * `stock_receipts.cost_per_base_unit` is withheld from `authenticated` (the grant
 * is a column list, not `*`), and `stock_movements` holds no cost at all. A
 * `stock_receipts(*)` select therefore fails its own privilege check for every
 * role including the owner, which is the same bug `SALE_ITEM_COLUMNS` documents in
 * `sales.ts`. So every column is named. An owner who needs the purchase cost reads
 * it through `pf_receipt_costs`; it never travels as part of a receipt list.
 *
 * ## Isolation is the policies'
 *
 * `receipts_read` and `movements_read` are `branch_id = pf_current_branch()`, so
 * neither query carries a branch filter of its own — adding one would be a second,
 * weaker restatement of a rule the database already applies.
 *
 * ## The write is one database function
 *
 * Receiving is receipt + lot + movement, and PostgREST has no transaction across
 * three tables (the debt `createSale` in `sales.ts` still carries). `pf_receive_stock`
 * does all three in one function body, so a receipt cannot exist without its lot.
 */

const OFFLINE = 'Supabase is not configured';
const NO_SESSION = 'Not signed in';

/** The `stock_receipts` columns that are readable by `authenticated`. */
export const STOCK_RECEIPT_COLUMNS =
  'id,' +
  'receipt_number,' +
  'medicine_id,' +
  'batch_number,' +
  'base_units_received,' +
  'supplier_id,' +
  'expiry_date,' +
  'received_at,' +
  'received_by,' +
  'state,' +
  'price_per_base_unit,' +
  'priced_by,' +
  'priced_at,' +
  'received_quantity,' +
  'received_unit_key,' +
  'received_unit_name,' +
  'received_unit_multiplier';

/** The `stock_movements` columns. None is withheld, so this is the whole row. */
export const STOCK_MOVEMENT_COLUMNS =
  'id,' +
  'medicine_id,' +
  'batch_id,' +
  'kind,' +
  'quantity_changed,' +
  'resulting_quantity,' +
  'performed_by,' +
  'note,' +
  'reference_id,' +
  'created_at';

/** The product name every receipt and movement is shown by. */
export const MEDICINE_REF_COLUMNS = 'id,name';

/**
 * The staff columns a receipt's receiver, or a movement's actor, is shown by.
 *
 * `profiles_read` is narrower than the receipt and movement policies — a person
 * who has left the branch, or become a customer, is no longer readable — so the
 * embed may be `null`. The mapper, not the query, decides what that gap looks
 * like. `role` is carried because the domain types render it.
 */
export const STAFF_REF_COLUMNS = 'id,full_name,role';

/** `branch_id` is dropped: the read policy has already chosen the rows. */
export type StockReceiptSelect = Omit<ReceiptRow, 'branch_id' | 'cost_per_base_unit'>;

export type StaffRef = { id: string; full_name: string; role: StaffRole };
export type MedicineRef = { id: string; name: string };

/**
 * A receipt row with its product and its receiver embedded.
 *
 * `db.types` declares no `Relationship` for `stock_receipts`, so the parsed row
 * type does not carry these keys even though PostgREST returns them — the same
 * cast `audit.ts` uses for its `profiles` embed.
 */
export type ReceiptWithRefs = StockReceiptSelect & {
  medicines: MedicineRef | null;
  profiles: StaffRef | null;
};

/** A movement row with its product and its actor embedded. */
export type StockMovementSelect = Omit<StockMovementRow, 'branch_id'>;

export type StockMovementWithRefs = StockMovementSelect & {
  medicines: MedicineRef | null;
  profiles: StaffRef | null;
};

/** Recent receipts with product and receiver, newest first. */
export async function listStockReceipts(limit = 50): Promise<Result<ReceiptWithRefs[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('stock_receipts')
    .select(
      `${STOCK_RECEIPT_COLUMNS},medicines(${MEDICINE_REF_COLUMNS}),profiles(${STAFF_REF_COLUMNS})`,
    )
    .order('received_at', { ascending: false })
    .limit(limit);

  return fromList<ReceiptWithRefs>({
    data: (query.data ?? null) as unknown as ReceiptWithRefs[] | null,
    error: query.error,
  });
}

/** Recent stock movements with product and actor, newest first. */
export async function listStockMovements(limit = 50): Promise<Result<StockMovementWithRefs[]>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const query = await client()
    .from('stock_movements')
    .select(
      `${STOCK_MOVEMENT_COLUMNS},medicines(${MEDICINE_REF_COLUMNS}),profiles(${STAFF_REF_COLUMNS})`,
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  return fromList<StockMovementWithRefs>({
    data: (query.data ?? null) as unknown as StockMovementWithRefs[] | null,
    error: query.error,
  });
}

/* ------------------------------------------------------- receiving write path */

/**
 * One delivery, as the caller sees it.
 *
 * `baseUnitsReceived` is already in base units: the screen converts "5 boxes" with
 * the product's own packaging before sending, and a lot is always stored in base
 * units. The counted unit travels alongside as a snapshot for the delivery note.
 */
export interface ReceiveStockInput {
  /**
   * The receipt number, and the idempotency key.
   *
   * `stock_receipts_number_unique` is `(branch_id, receipt_number)`, so the same
   * number twice on a branch returns the receipt that already exists instead of
   * booking the goods again. The caller must therefore generate it once per
   * delivery attempt and keep it across retries — the `/stock-receiving` form
   * does, and only mints a new one after a submit succeeds.
   */
  receiptNumber: string;
  medicineId: string;
  batchNumber: string;
  baseUnitsReceived: number;
  supplierId?: string;
  expiryDate: string;
  /** Owner only. A non-owner's cost is dropped by the database, not refused. */
  costPerBaseUnit?: number;
  pricePerBaseUnit?: number;
  /** The counted unit, snapshotted. Send all three or none. */
  receivedQuantity?: number;
  receivedUnitKey?: string;
  receivedUnitName?: string;
  receivedUnitMultiplier?: number;
}

export interface ReceiveStockResult {
  receiptId: string;
  /** Null only if the lot could not be resolved on an idempotent replay. */
  batchId: string | null;
  receiptNumber: string;
  state: ReceiptState;
  baseUnitsReceived: number;
  /** True when this number had already been received and nothing new was written. */
  alreadyReceived: boolean;
}

/**
 * Book in a delivery.
 *
 * The receipt, the lot and the movement are written by `pf_receive_stock` in one
 * transaction. Branch, actor and the received date are resolved server-side; the
 * caller supplies no branch, and the function refuses a transaction the caller is
 * not a member of.
 *
 * A raised `raise exception` arrives from PostgREST as 400 with the message in
 * `message` — a sentence written for the person at the counter, so it is passed
 * through rather than replaced.
 */
export async function receiveStock(input: ReceiveStockInput): Promise<Result<ReceiveStockResult>> {
  if (!isSupabaseConfigured()) return { ok: false, error: OFFLINE };
  if (!(await hasSession())) return { ok: false, error: NO_SESSION };

  const { data, error } = await client().rpc('pf_receive_stock', {
    p_receipt: {
      receipt_number: input.receiptNumber,
      medicine_id: input.medicineId,
      batch_number: input.batchNumber,
      base_units_received: input.baseUnitsReceived,
      supplier_id: input.supplierId ?? null,
      expiry_date: input.expiryDate,
      cost_per_base_unit: input.costPerBaseUnit ?? null,
      price_per_base_unit: input.pricePerBaseUnit ?? null,
      received_quantity: input.receivedQuantity ?? null,
      received_unit_key: input.receivedUnitKey ?? null,
      received_unit_name: input.receivedUnitName ?? null,
      received_unit_multiplier: input.receivedUnitMultiplier ?? null,
    } satisfies Record<string, Json>,
  });

  if (error) return { ok: false, error: error.message, code: error.code };

  const row = data as
    | {
        receipt_id?: string;
        batch_id?: string | null;
        receipt_number?: string;
        state?: ReceiptState;
        base_units_received?: number;
        already_received?: boolean;
      }
    | null;

  if (!row?.receipt_id || !row.receipt_number) {
    return { ok: false, error: 'The delivery was not recorded.' };
  }

  return {
    ok: true,
    data: {
      receiptId: row.receipt_id,
      batchId: row.batch_id ?? null,
      receiptNumber: row.receipt_number,
      state: row.state ?? 'pending_pricing',
      baseUnitsReceived: Number(row.base_units_received ?? 0),
      alreadyReceived: row.already_received === true,
    },
  };
}
