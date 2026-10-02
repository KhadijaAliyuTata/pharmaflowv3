/**
 * Hand-written mirror of `supabase/schema.sql`.
 *
 * In a repo with the Supabase CLI you would run `supabase gen types` and never
 * touch this file. It is written out here so the queries in `src/lib/sync.ts`
 * are checked against the real schema, and so a reviewer can see the columns
 * this app actually depends on without running a generator.
 *
 * Regenerate with:  supabase gen types typescript --local > src/lib/db.types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type StaffRole = 'owner' | 'assistant';
export type PrescriptionClass = 'otc' | 'prescription' | 'controlled';
export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock' | 'expiring_soon' | 'expired';
export type ReceiptState = 'pending_pricing' | 'confirmed';
export type SaleState = 'paid' | 'part_paid' | 'credit' | 'refunded' | 'voided';
export type PaymentKind = 'cash' | 'transfer' | 'pos_card' | 'wallet';
export type OrderState =
  | 'pending_review' | 'confirmed' | 'ready_for_pickup'
  | 'out_for_delivery' | 'completed' | 'cancelled';

export interface TradeUnitRow {
  key: string;
  name: string;
  multiplier: number;
  sellingPrice: number;
}

export interface BranchRow {
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
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
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

export interface CustomerRow {
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

export interface SupplierRow {
  id: string;
  branch_id: string;
  name: string;
  contact_person: string;
  phone: string;
  address: string;
  email: string | null;
  lead_time_days: number;
  rating: number;
}

export interface MedicineRow {
  id: string;
  branch_id: string;
  barcode: string | null;
  name: string;
  generic_name: string;
  strength: string;
  dosage_form: string;
  category: string;
  supplier_id: string | null;
  units: TradeUnitRow[];
  total_quantity: number;
  low_stock_threshold: number;
  average_daily_sales: number;
  /** Hidden from assistants by column grants — expect `undefined` for them. */
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
  nafdac_reg_number: string | null;
  manufacturer: string | null;
  state: StockState;
}

export interface BatchRow {
  id: string;
  branch_id: string;
  medicine_id: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  /** Hidden from assistants by column grants. */
  cost_per_base_unit?: number;
  supplier_id: string | null;
  received_date: string;
  is_recalled: boolean;
  recall_reason: string | null;
}

export interface ReceiptRow {
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
  cost_per_base_unit?: number | null;
  price_per_base_unit?: number | null;
  priced_by: string | null;
  priced_at: string | null;
}

export interface SaleRow {
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
  state: SaleState;
  amount_paid: number;
  outstanding: number;
  dispensed_against_prescription: boolean;
  status_reason: string | null;
  status_changed_by: string | null;
  status_changed_at: string | null;
}

export interface SaleItemRow {
  id: string;
  sale_id: string;
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
  cost_per_base_unit_snapshot: number;
}

export interface CreditAccountRow {
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
}

export interface CreditLedgerRow {
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

export interface CustomerOrderRow {
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

export interface MedicineRequestRow {
  id: string;
  branch_id: string;
  medicine_name: string;
  generic_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  quantity_requested: number;
  urgency: 'routine' | 'urgent' | 'emergency';
  state: 'pending_restock' | 'restocked' | 'notified';
  recorded_at: string;
  recorded_by: string;
}

export interface AuditEventRow {
  id: string;
  branch_id: string;
  actor_id: string;
  action: string;
  description: string;
  metadata: Json;
  created_at: string;
}

export interface NotificationRow {
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

/* ------------------------------------------------------ Supabase Database */

type Table<Row, Insert = Row, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
};

export interface Database {
  public: {
    Tables: {
      branches: Table<BranchRow>;
      profiles: Table<ProfileRow>;
      customers: Table<CustomerRow>;
      suppliers: Table<SupplierRow>;
      medicines: Table<MedicineRow>;
      medicine_batches: Table<BatchRow>;
      stock_receipts: Table<ReceiptRow>;
      stock_movements: Table<{
        id: string; branch_id: string; medicine_id: string;
        kind: string; quantity_changed: number; resulting_quantity: number;
        performed_by: string; note: string; reference_id: string | null;
        created_at: string;
      }>;
      sales: Table<SaleRow>;
      sale_items: Table<SaleItemRow>;
      credit_accounts: Table<CreditAccountRow>;
      credit_ledger: Table<CreditLedgerRow>;
      customer_orders: Table<CustomerOrderRow>;
      order_items: Table<{
        id: string; order_id: string; medicine_id: string | null;
        medicine_name: string; unit_name: string;
        quantity: number; line_total: number;
      }>;
      medicine_requests: Table<MedicineRequestRow>;
      audit_events: Table<AuditEventRow>;
      notifications: Table<NotificationRow>;
    };
    Views: Record<string, never>;
    Functions: {
      pf_current_branch: { Args: Record<string, never>; Returns: string | null };
      pf_current_role: { Args: Record<string, never>; Returns: StaffRole | null };
      pf_is_owner: { Args: Record<string, never>; Returns: boolean };
    };
    Enums: {
      staff_role: StaffRole;
      prescription_class: PrescriptionClass;
      stock_state: StockState;
      receipt_state: ReceiptState;
      sale_state: SaleState;
      payment_kind: PaymentKind;
      order_state: OrderState;
    };
  };
}