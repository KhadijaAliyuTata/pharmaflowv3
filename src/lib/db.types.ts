/**
 * TypeScript types for the PharmaFlow Supabase schema.
 *
 * Mirrors `supabase/migrations/20261002160000_initial_schema.sql`. Every column,
 * enum value, view and function here was read out of that migration — nothing is
 * invented. Regenerate after a schema change with:
 *
 *   supabase gen types typescript --local > src/lib/db.types.ts
 *
 * Three things in here are deliberate and will not match a naive generator:
 *
 * 1. `Insert` types omit server-owned and trigger-maintained columns
 *    (`id`, `total_quantity`, `state`, `created_at`, `updated_at`, and the two
 *    `do_not_sell_locked_*` columns). The database computes or defaults those, so
 *    a caller must not send them. `medicines.total_quantity` is overwritten by
 *    `pf_guard_total_quantity` on every write and `medicines.state` by
 *    `pf_medicine_state`, so sending either is not merely ignored — it is a lie.
 *
 * 2. The four `pf_*_costs` views are declared, because cost columns are not
 *    selectable on the base tables (see the grants in the migration). An owner
 *    reads purchase cost through these; an assistant reads zero rows.
 *
 * 3. `Relationships` is populated for the four child tables so PostgREST embedded
 *    selects (`sale_items(*, sales(*))`) typecheck. `sale_items` and
 *    `order_items` have no `branch_id` — they inherit isolation from their parent
 *    through the RLS policies — so the parent relation is the only route to them.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/* ------------------------------------------------------------------ enums */

export type StaffRole = 'owner' | 'assistant';
export type PrescriptionClass = 'otc' | 'prescription' | 'controlled';
export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock' | 'expiring_soon' | 'expired';
export type ReceiptState = 'pending_pricing' | 'confirmed';
export type SaleState = 'paid' | 'part_paid' | 'credit' | 'refunded' | 'voided';
export type PaymentKind = 'cash' | 'transfer' | 'pos_card' | 'wallet';
export type MovementKind = 'receipt' | 'sale' | 'adjustment' | 'return' | 'void' | 'disposal';
export type OrderState =
  | 'pending_review' | 'confirmed' | 'ready_for_pickup'
  | 'out_for_delivery' | 'completed' | 'cancelled';
export type RequestState = 'pending_restock' | 'restocked' | 'notified';
export type UrgencyLevel = 'routine' | 'urgent' | 'emergency';

/**
 * `medicines.units` is a jsonb array, not a table.
 *
 * `multiplier` is flat: base units in one of this unit. Exactly one unit must
 * have `multiplier = 1` and it must be element 0 — that is the base unit.
 *
 * Since 20261005120000_unit_hierarchy, `pf_validate_medicine_units` enforces the
 * whole shape server-side: non-empty array, non-empty unique `key`, non-empty
 * `name`, positive integer `multiplier`, non-negative `sellingPrice`, and
 * exactly one base unit in first position. Changing `units` is owner-only via
 * `pf_guard_unit_write`. The client mirror of this validation is
 * `validateUnitHierarchy` in `src/domain/units.ts`.
 */
export type TradeUnit = {
  key: string;
  name: string;
  multiplier: number;
  sellingPrice: number;
}

/* ---------------------------------------------------------------- tables */

export type BranchRow = {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  opening_hours: string;
  is_open_now: boolean;
  is_main_hub: boolean;
  rating: number;
  reviews_count: number;
  /**
   * Added by 20261005160000_branch_registration. Nullable: no branch has one
   * configured, and the screen renders "Not set" rather than inventing a number.
   */
  pcn_number?: string | null;
  premises_number?: string | null;
  created_at: string;
  updated_at: string;
}

export type ProfileRow = {
  id: string;
  full_name: string;
  phone: string;
  role: StaffRole;
  branch_id: string | null;
  license_number: string | null;
  is_customer: boolean;
  created_at: string;
  updated_at: string;
}

export type CustomerRow = {
  id: string;
  branch_id: string;
  auth_user_id: string | null;
  code: string;
  name: string;
  phone: string;
  email: string | null;
  wallet_balance: number;
  outstanding_debt: number;
  total_spent: number;
  purchase_count: number;
  consent_for_reminders: boolean;
  chronic_medications: string[];
  notes: string | null;
  registered_date: string;
  last_purchase_date: string | null;
  created_at: string;
  updated_at: string;
}

export type SupplierRow = {
  id: string;
  branch_id: string;
  name: string;
  contact_person: string;
  phone: string;
  address: string;
  email: string | null;
  lead_time_days: number;
  rating: number;
  created_at: string;
  updated_at: string;
}

export type MedicineRow = {
  id: string;
  branch_id: string;
  barcode: string | null;
  name: string;
  generic_name: string;
  strength: string;
  dosage_form: string;
  category: string;
  supplier_id: string | null;
  units: TradeUnit[];
  total_quantity: number;
  low_stock_threshold: number;
  average_daily_sales: number;
  /**
   * Owner-only. Not in the `grant select` list for `authenticated`; read it
   * through the `pf_medicine_costs` view instead. Absent for assistants.
   */
  cost_per_base_unit?: number;
  price_per_base_unit: number;
  expiry_date: string;
  purchase_date: string;
  common_use: string;
  storage: string;
  prescription_class: PrescriptionClass;
  warnings: string[];
  is_brand: boolean;
  generic_equivalent_id: string | null;
  do_not_sell: boolean;
  do_not_sell_reason: string | null;
  do_not_sell_locked_by: string | null;
  do_not_sell_locked_at: string | null;
  nafdac_reg_number: string | null;
  manufacturer: string | null;
  /** Maintained by `pf_medicine_state`. */
  state: StockState;
  created_at: string;
  updated_at: string;
}

export type BatchRow = {
  id: string;
  branch_id: string;
  medicine_id: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  /** Owner-only. Read through `pf_batch_costs`. */
  cost_per_base_unit?: number;
  supplier_id: string | null;
  received_date: string;
  is_recalled: boolean;
  recall_reason: string | null;
  created_at: string;
}

export type ReceiptRow = {
  id: string;
  branch_id: string;
  receipt_number: string;
  medicine_id: string;
  batch_number: string;
  base_units_received: number;
  supplier_id: string | null;
  expiry_date: string;
  received_at: string;
  received_by: string;
  state: ReceiptState;
  /**
   * The unit the delivery was actually counted in, as a snapshot.
   *
   * Added by 20261005120000_unit_hierarchy. A supplier's paperwork says "5 boxes"
   * while `base_units_received` says 500; both are kept so the receipt keeps its
   * meaning even if the pharmacy later redefines a box as 120 pieces. Backfilled
   * for pre-existing rows as "counted in base units" (quantity = base_units_received,
   * multiplier = 1, key 'base'). Null means "never recorded" — not zero.
   */
  received_quantity: number | null;
  received_unit_key: string | null;
  received_unit_name: string | null;
  received_unit_multiplier: number | null;
  /** Owner-only. Read through `pf_receipt_costs`. */
  cost_per_base_unit?: number | null;
  price_per_base_unit: number | null;
  priced_by: string | null;
  priced_at: string | null;
}

export type StockMovementRow = {
  id: string;
  branch_id: string;
  medicine_id: string;
  /**
   * The lot that moved. NULL for a movement recorded against a lot that has since
   * been deleted - the id is preserved in 
ote in that case, because inside an
   * AFTER DELETE the lot row no longer exists and the FK could not be satisfied.
   */
  batch_id: string | null;
  kind: MovementKind;
  quantity_changed: number;
  resulting_quantity: number;
  /**
   * NULLABLE. These rows are written by pf_record_stock_movement, a trigger,
   * and a batch edited outside any authenticated request (a migration, a seed, a
   * service-role job) has no actor. NULL means "written by the database, no
   * authenticated actor" - honest, where inventing an owner would not be.
   */
  performed_by: string | null;
  note: string;
  reference_id: string | null;
  created_at: string;
};

export type SaleRow = {
  id: string;
  branch_id: string;
  receipt_number: string;
  sold_at: string;
  attendant_id: string;
  customer_id: string | null;
  credit_account_id: string | null;
  subtotal: number;
  discount: number;
  discount_reason: string | null;
  total: number;
  payment_method: PaymentKind;
  /** Nullable in the database — it has a default but no NOT NULL. */
  state: SaleState | null;
  amount_paid: number;
  outstanding: number;
  dispensed_against_prescription: boolean;
  status_reason: string | null;
  status_changed_by: string | null;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SaleItemRow = {
  id: string;
  sale_id: string;
  /**
   * The lot this line consumed. NULLABLE and ON DELETE SET NULL on purpose:
   * historical sales predate the column and must stay valid, and deleting a lot
   * must not delete the record that it was sold. NULL means "untraced" and is
   * reported as unknown rather than wrong.
   *
   * pf_check_sale_item_batch enforces that the lot belongs to the same product
   * as the line - two independent foreign keys cannot express that alone.
   */
  batch_id: string | null;
  medicine_id: string;
  medicine_name: string;
  generic_name: string;
  unit_key: string;
  unit_name: string;
  unit_multiplier: number;
  quantity: number;
  base_units_total: number;
  unit_price: number;
  line_total: number;
  /**
   * Owner-only, and writable by any staff member (the till records what it
   * dispensed at). Read through `pf_sale_item_costs`.
   */
  cost_per_base_unit_snapshot?: number;
}

export type CreditAccountRow = {
  id: string;
  branch_id: string;
  name: string;
  kind: string;
  contact_person: string;
  phone: string;
  email: string | null;
  credit_limit: number;
  outstanding_balance: number;
  is_suspended: boolean;
  created_at: string;
  updated_at: string;
}

export type CreditLedgerRow = {
  id: string;
  account_id: string;
  branch_id: string;
  entry_at: string;
  kind: 'charge' | 'payment';
  amount: number;
  balance_after: number;
  note: string;
  reference_id: string | null;
  recorded_by: string;
}

export type CustomerOrderRow = {
  id: string;
  branch_id: string;
  order_number: string;
  customer_id: string;
  delivery_type: 'pickup' | 'delivery';
  delivery_address: string | null;
  payment_method: string;
  payment_state: 'pending' | 'paid';
  state: OrderState;
  subtotal: number;
  delivery_fee: number;
  total: number;
  prescription_attached: boolean;
  pharmacist_note: string | null;
  created_at: string;
  updated_at: string;
}

export type OrderItemRow = {
  id: string;
  order_id: string;
  medicine_id: string | null;
  medicine_name: string;
  unit_name: string;
  quantity: number;
  line_total: number;
}

export type MedicineRequestRow = {
  id: string;
  branch_id: string;
  medicine_name: string;
  generic_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  quantity_requested: number;
  urgency: UrgencyLevel;
  state: RequestState;
  recorded_at: string;
  recorded_by: string;
  notified_at: string | null;
}

export type AuditEventRow = {
  id: string;
  branch_id: string;
  actor_id: string;
  action: string;
  description: string;
  metadata: Json;
  created_at: string;
}

export type NotificationRow = {
  id: string;
  branch_id: string;
  recipient_id: string | null;
  kind: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'urgent';
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/* ----------------------------------------------------------------- views */

/**
 * Owner-gated cost projections. Each filters on `pf_is_owner()` and the caller's
 * branch, so a non-owner receives zero rows rather than a permission error. This
 * is how purchase cost is read at all: the columns are withheld from
 * `authenticated` on the base tables because a Postgres grant cannot be
 * conditional on which user is signed in.
 */
export type MedicineCostRow = {
  id: string;
  branch_id: string;
  cost_per_base_unit: number;
}

export type BatchCostRow = {
  id: string;
  medicine_id: string;
  branch_id: string;
  cost_per_base_unit: number;
}

export type ReceiptCostRow = {
  id: string;
  branch_id: string;
  cost_per_base_unit: number;
  price_per_base_unit: number;
}

export type SaleItemCostRow = {
  id: string;
  sale_id: string;
  branch_id: string;
  cost_per_base_unit_snapshot: number;
}

/* ---------------------------------------------------------------- inserts */
/**
 * Insert shapes are written out rather than derived with `Omit<Row, ...>`.
 *
 * Two reasons. First, `Omit` keeps a column required that the database defaults,
 * so every insert would have to send it. Second, `supabase-js` runs inserts
 * through `RejectExcessProperties`, which compares the value against the Insert
 * type key by key — a derived `Omit` type mismatches on optionality and the
 * whole call resolves to `never[]`.
 *
 * The rule each one follows: a column is optional here exactly when the database
 * supplies it (has a default, or is set by a trigger). Everything else is
 * required, and nullable exactly when the column is nullable.
 */

export type BranchInsert = {
  name: string;
  address?: string;
  city?: string;
  state?: string;
  phone?: string;
  opening_hours?: string;
  is_open_now?: boolean;
  is_main_hub?: boolean;
  rating?: number;
  reviews_count?: number;
};

/** `id`, `role`, `branch_id` and `is_customer` are all trigger/server-owned. */
export type ProfileInsert = {
  id: string;
  full_name: string;
  phone?: string;
  role?: StaffRole;
  branch_id?: string | null;
  license_number?: string | null;
  is_customer?: boolean;
};

export type CustomerInsert = {
  branch_id: string;
  code: string;
  name: string;
  phone: string;
  auth_user_id?: string | null;
  email?: string | null;
  wallet_balance?: number;
  outstanding_debt?: number;
  total_spent?: number;
  purchase_count?: number;
  consent_for_reminders?: boolean;
  chronic_medications?: string[];
  notes?: string | null;
  registered_date?: string;
  last_purchase_date?: string | null;
};

export type SupplierInsert = {
  branch_id: string;
  name: string;
  contact_person?: string;
  phone?: string;
  address?: string;
  email?: string | null;
  lead_time_days?: number;
  rating?: number;
};

/**
 * `total_quantity` and `state` are absent by design: `pf_guard_total_quantity` and
 * `pf_medicine_state` overwrite them on every write, so a value sent here would
 * be discarded. The two `do_not_sell_locked_*` columns are stamped by the lock
 * operation, not by the caller.
 */
export type MedicineInsert = {
  branch_id: string;
  name: string;
  generic_name: string;
  expiry_date: string;
  price_per_base_unit: number;
  barcode?: string | null;
  strength?: string;
  dosage_form?: string;
  category?: string;
  supplier_id?: string | null;
  units?: TradeUnit[];
  low_stock_threshold?: number;
  average_daily_sales?: number;
  cost_per_base_unit?: number;
  purchase_date?: string;
  common_use?: string;
  storage?: string;
  prescription_class?: PrescriptionClass;
  warnings?: string[];
  is_brand?: boolean;
  generic_equivalent_id?: string | null;
  do_not_sell?: boolean;
  do_not_sell_reason?: string | null;
  nafdac_reg_number?: string | null;
  manufacturer?: string | null;
};

export type MedicineUpdate = Partial<
  Omit<MedicineInsert, 'branch_id' | 'expiry_date'>
> & { do_not_sell_locked_by?: string | null; do_not_sell_locked_at?: string | null };

export type BatchInsert = {
  branch_id: string;
  medicine_id: string;
  batch_number: string;
  expiry_date: string;
  quantity?: number;
  cost_per_base_unit?: number;
  supplier_id?: string | null;
  received_date?: string;
  is_recalled?: boolean;
  recall_reason?: string | null;
};

export type BatchUpdate = Partial<
  Omit<BatchInsert, 'branch_id' | 'medicine_id' | 'batch_number'>
>;

export type ReceiptInsert = {
  branch_id: string;
  receipt_number: string;
  medicine_id: string;
  batch_number: string;
  base_units_received: number;
  expiry_date: string;
  received_by: string;
  supplier_id?: string | null;
  state?: ReceiptState;
  cost_per_base_unit?: number | null;
  price_per_base_unit?: number | null;
  priced_by?: string | null;
  priced_at?: string | null;
  /**
   * The counted unit, snapshotted. Send all four or none — the
   * `stock_receipts_received_unit_coherent` check constraint enforces that, so a
   * half-written snapshot cannot be stored.
   */
  received_quantity?: number | null;
  received_unit_key?: string | null;
  received_unit_name?: string | null;
  received_unit_multiplier?: number | null;
};

/**
 * Present for completeness and for backfills. The INSERT grant has been revoked
 * from uthenticated: movements are derived from medicine_batches by
 * pf_record_stock_movement, so this table has exactly one writer and a client
 * insert could only ever be a duplicate or a fabrication.
 */
export type StockMovementInsert = {
  branch_id: string;
  medicine_id: string;
  kind: MovementKind;
  quantity_changed: number;
  resulting_quantity: number;
  batch_id?: string | null;
  performed_by?: string | null;
  note?: string;
  reference_id?: string | null;
};

/** One pharmacy counter a user may switch between. */
export type BranchMembershipRow = {
  user_id: string;
  branch_id: string;
  role: StaffRole;
  is_default: boolean;
  created_at: string;
};

export type SaleInsert = {
  branch_id: string;
  receipt_number: string;
  attendant_id: string;
  subtotal: number;
  total: number;
  payment_method: PaymentKind;
  customer_id?: string | null;
  credit_account_id?: string | null;
  discount?: number;
  discount_reason?: string | null;
  amount_paid?: number;
  outstanding?: number;
  dispensed_against_prescription?: boolean;
};

/**
 * Sale updates. Deliberately narrow: the only post-hoc changes the schema permits
 * are the void/refund transition and its audit trail. Money, attendant and lines
 * are not updatable — `sales_staff_write` is INSERT-only and `sales_owner_void`
 * admits only an owner of that branch, and `sale_items` has no UPDATE policy at
 * all because line items are immutable.
 */
export type SaleUpdate = Partial<
  Pick<SaleRow, 'state' | 'status_reason' | 'status_changed_by' | 'status_changed_at'>
>;

export type SaleItemInsert = {
  sale_id: string;
  /** Omit for an untraced sale; pf_check_sale_item_batch validates the pairing. */
  batch_id?: string | null;
  medicine_id: string;
  medicine_name: string;
  generic_name: string;
  unit_key: string;
  unit_name: string;
  unit_multiplier: number;
  quantity: number;
  base_units_total: number;
  unit_price: number;
  line_total: number;
  cost_per_base_unit_snapshot?: number;
};

export type CreditAccountInsert = {
  branch_id: string;
  name: string;
  kind?: string;
  contact_person?: string;
  phone?: string;
  email?: string | null;
  credit_limit?: number;
  outstanding_balance?: number;
  is_suspended?: boolean;
};

export type CreditLedgerInsert = {
  account_id: string;
  branch_id: string;
  kind: 'charge' | 'payment';
  amount: number;
  balance_after: number;
  recorded_by: string;
  note?: string;
  reference_id?: string | null;
};

export type CustomerOrderInsert = {
  branch_id: string;
  order_number: string;
  customer_id: string;
  delivery_type?: 'pickup' | 'delivery';
  delivery_address?: string | null;
  payment_method?: string;
  payment_state?: 'pending' | 'paid';
  state?: OrderState;
  subtotal?: number;
  delivery_fee?: number;
  total?: number;
  prescription_attached?: boolean;
  pharmacist_note?: string | null;
};

export type OrderItemInsert = {
  order_id: string;
  medicine_name: string;
  unit_name: string;
  quantity: number;
  medicine_id?: string | null;
  line_total?: number;
};

export type MedicineRequestInsert = {
  branch_id: string;
  medicine_name: string;
  quantity_requested: number;
  recorded_by: string;
  generic_name?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  urgency?: UrgencyLevel;
  state?: RequestState;
  notified_at?: string | null;
};

export type AuditEventInsert = {
  branch_id: string;
  /** Forced to `auth.uid()` by `audit_insert`. */
  actor_id: string;
  action: string;
  description: string;
  metadata?: Json;
};

export type NotificationInsert = {
  branch_id: string;
  kind: string;
  title: string;
  recipient_id?: string | null;
  body?: string;
  severity?: 'info' | 'warning' | 'urgent';
  link?: string | null;
};

export type BranchMembershipInsert = {
  user_id: string;
  branch_id: string;
  role?: StaffRole;
  is_default?: boolean;
};

/* ---------------------------------------------------- Supabase Database */

/**
 * A foreign key, in the shape `supabase-js` uses to type PostgREST embedded
 * selects (`sale_items(*, sales(*))`). `Relationships` is a REQUIRED member of
 * `GenericTable` in this version of postgrest-js — omitting it makes the whole
 * table resolve to `never`, which surfaces as "not assignable to never[]" on
 * every insert.
 */
export type Relationship = {
  foreignKeyName: string;
  columns: string[];
  isOneToOne?: boolean;
  referencedRelation: string;
  referencedColumns: string[];
};

type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>, Rel extends Relationship[] = []> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: Rel;
};

/** A read-only projection. Views have no Insert or Update. */
type View<Row, Rel extends Relationship[] = []> = {
  Row: Row;
  Relationships: Rel;
};

/**
 * `sale_items` and `order_items` have no `branch_id` — they inherit isolation from
 * their parent through the RLS policies — so the parent relation is the only way
 * to reach them. Declaring it here is what lets `select('*, sale_items(*)')` type.
 */
type ToOne<TableName extends string, Column extends string> = {
  foreignKeyName: TableName;
  columns: [Column];
  isOneToOne: false;
  referencedRelation: string;
  referencedColumns: string[];
};

export type Database = {
  public: {
    Tables: {
      branches: Table<BranchRow, BranchInsert, Partial<BranchInsert>>;
      profiles: Table<ProfileRow, ProfileInsert, Partial<ProfileInsert>>;
      customers: Table<CustomerRow, CustomerInsert, Partial<CustomerInsert>>;
      suppliers: Table<SupplierRow, SupplierInsert, Partial<SupplierInsert>>;
      medicines: Table<MedicineRow, MedicineInsert, MedicineUpdate>;
      medicine_batches: Table<
        BatchRow,
        BatchInsert,
        BatchUpdate,
        [ToOne<'medicine_batches_medicine_id_fkey', 'medicine_id'>]
      >;
      stock_receipts: Table<ReceiptRow, ReceiptInsert, Partial<ReceiptInsert>>;
      stock_movements: Table<StockMovementRow, StockMovementInsert, Partial<StockMovementInsert>>;
      sales: Table<SaleRow, SaleInsert, SaleUpdate>;
      sale_items: Table<
        SaleItemRow,
        SaleItemInsert,
        Partial<SaleItemInsert>,
        [ToOne<'sale_items_sale_id_fkey', 'sale_id'>]
      >;
      credit_accounts: Table<CreditAccountRow, CreditAccountInsert, Partial<CreditAccountInsert>>;
      credit_ledger: Table<
        CreditLedgerRow,
        CreditLedgerInsert,
        Partial<CreditLedgerInsert>,
        [ToOne<'credit_ledger_account_id_fkey', 'account_id'>]
      >;
      customer_orders: Table<CustomerOrderRow, CustomerOrderInsert, Partial<CustomerOrderInsert>>;
      order_items: Table<
        OrderItemRow,
        OrderItemInsert,
        Partial<OrderItemInsert>,
        [ToOne<'order_items_order_id_fkey', 'order_id'>]
      >;
      medicine_requests: Table<MedicineRequestRow, MedicineRequestInsert, Partial<MedicineRequestInsert>>;
      audit_events: Table<AuditEventRow, AuditEventInsert, Partial<AuditEventInsert>>;
      notifications: Table<NotificationRow, NotificationInsert, Partial<NotificationInsert>>;
      branch_memberships: Table<BranchMembershipRow, BranchMembershipInsert, Partial<BranchMembershipInsert>>;
    };
    Views: {
      pf_medicine_costs: View<MedicineCostRow>;
      pf_batch_costs: View<BatchCostRow>;
      pf_receipt_costs: View<ReceiptCostRow>;
      pf_sale_item_costs: View<SaleItemCostRow>;
      pf_my_branches: View<BranchRow>;
    };
    /**
     * Only the scalar helpers are callable over PostgREST. The ten trigger
     * functions (`pf_touch_updated_at`, `pf_handle_new_user`,
     * `pf_guard_profile_privileges`, `pf_check_base_unit`, `pf_medicine_state`,
     * `pf_guard_cost_write`, `pf_require_owner_to_price`,
     * `pf_check_credit_ledger_balance`, `pf_guard_total_quantity`,
     * `pf_sync_total_quantity`) return `trigger` and are not exposed.
     */
    Functions: {
      pf_current_branch: { Args: Record<PropertyKey, never>; Returns: string | null };
      pf_current_role: { Args: Record<PropertyKey, never>; Returns: StaffRole | null };
      pf_is_owner: { Args: Record<PropertyKey, never>; Returns: boolean };
      pf_is_customer: { Args: Record<PropertyKey, never>; Returns: boolean };
      pf_is_staff: { Args: Record<PropertyKey, never>; Returns: boolean };
      pf_set_active_branch: { Args: { p_branch_id: string }; Returns: string };
    };
    Enums: {
      staff_role: StaffRole;
      prescription_class: PrescriptionClass;
      stock_state: StockState;
      receipt_state: ReceiptState;
      sale_state: SaleState;
      payment_kind: PaymentKind;
      movement_kind: MovementKind;
      order_state: OrderState;
      request_state: RequestState;
      urgency_level: UrgencyLevel;
    };
    CompositeTypes: Record<string, never>;
  };
}

/**
 * The `Views` block above lists the columns each view returns. Supabase's
 * generated types wrap views in the same `Table` shape with a `Row` member,
 * which `from()` expects, so this alias is applied at the point of use rather
 * than duplicating every interface.
 */
export type ViewRow<V> = V extends { Row: infer R } ? R : V;