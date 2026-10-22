/**
 * TypeScript types for the PharmaFlow Supabase schema.
 *
 * Mirrors the initial schema plus the later migrations in this repository. The
 * medicine catalogue additions were transcribed from
 * `20261019120000_medicine_knowledge_base.sql`; nothing is invented. Regenerate
 * after a schema change with:
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
export type PharmacyStatus = 'pending' | 'active' | 'suspended';
export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock' | 'expiring_soon' | 'expired';
export type ReceiptState = 'pending_pricing' | 'confirmed';
export type SaleState = 'paid' | 'part_paid' | 'credit' | 'refunded' | 'voided';
/** 20261018120000 adds 'split' (two methods collected on one sale). */
export type PaymentKind = 'cash' | 'transfer' | 'pos_card' | 'wallet' | 'split';
export type MovementKind = 'receipt' | 'sale' | 'adjustment' | 'return' | 'void' | 'disposal';
export type OrderState =
  | 'pending_review' | 'confirmed' | 'ready_for_pickup'
  | 'out_for_delivery' | 'completed' | 'cancelled';
export type RequestState = 'pending_restock' | 'restocked' | 'notified';
export type UrgencyLevel = 'routine' | 'urgent' | 'emergency';

/* ------------------------------------------------ shared medicine catalogue */
/** From 20261019120000_medicine_knowledge_base. */
export type MedicineVerificationStatus =
  | 'draft' | 'pending_review' | 'verified' | 'rejected' | 'outdated';
export type MedicineRegistrationStatus =
  | 'unverified' | 'pending' | 'verified' | 'mismatch' | 'not_applicable';
export type ClinicalSectionStatus =
  | 'not_established' | 'not_verified' | 'verified' | 'not_applicable';
export type ClinicalSection =
  | 'indications' | 'dosage' | 'administration' | 'food'
  | 'contraindications' | 'precautions' | 'common_adverse_effects'
  | 'serious_adverse_effects' | 'interactions' | 'pregnancy' | 'breastfeeding'
  | 'paediatric' | 'older_adult' | 'renal' | 'hepatic' | 'storage'
  | 'warnings' | 'professional_assessment';
export type MedicineSourceType =
  | 'product_label' | 'regulator' | 'guideline' | 'reference' | 'manufacturer' | 'other';
export type MedicineFoodInstruction =
  | 'with_food' | 'before_food' | 'after_food' | 'without_regard_to_food'
  | 'not_established' | 'not_applicable';
export type MedicineSubmissionStatus =
  | 'draft' | 'submitted' | 'under_review' | 'accepted' | 'rejected' | 'withdrawn';
export type MedicineImportStatus =
  | 'pending' | 'valid' | 'duplicate' | 'rejected' | 'imported' | 'needs_review';
export type MedicineAliasType = 'brand' | 'synonym' | 'common_name' | 'misspelling';

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
  /**
   * Optional link to the shared clinical catalogue, added by
   * 20261019120000_medicine_knowledge_base. Nullable: an inventory row does not
   * need a shared dossier, and linking is owner/reviewer-only in the database.
   */
  catalogue_product_id?: string | null;
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
  /**
   * The portion of accepted returns applied against `outstanding`.
   *
   * The original total, amount paid and outstanding are never rewritten by a
   * return. Effective outstanding is `outstanding - returned_credit`. See
   * 20261020120000_returns_and_price_updates.sql.
   */
  returned_credit: number;
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

/**
 * One payment against a sale, from 20261018120000_pos_payments_split.
 *
 * Append-only audit: the split parts of the collected money at checkout, and
 * every repayment afterwards, each row carrying its method, amount and the
 * staff member. `sales.amount_paid` remains the money of record.
 */
export type SalePaymentRow = {
  id: string;
  sale_id: string;
  branch_id: string;
  method: PaymentKind;
  amount: number;
  recorded_by: string;
  recorded_at: string;
  note: string | null;
}

export type SalePaymentInsert = {
  sale_id: string;
  branch_id: string;
  method: PaymentKind;
  amount: number;
  recorded_by?: string;
  recorded_at?: string;
  note?: string | null;
}

/* ------------------------------------------------------- returns, 20261020 */

export type MedicineReturnStatus = 'pending_review' | 'completed' | 'rejected';

export type MedicineReturnReason =
  | 'wrong_medicine'
  | 'damaged'
  | 'customer_changed_mind'
  | 'expired'
  | 'recalled'
  | 'other';

export type MedicineReturnMethod =
  | 'cash'
  | 'transfer'
  | 'pos_card'
  | 'wallet'
  | 'store_credit'
  | 'not_refunded';

export type MedicineReturnRow = {
  id: string;
  branch_id: string;
  sale_id: string;
  return_number: string;
  status: MedicineReturnStatus;
  reason: MedicineReturnReason;
  note: string;
  idempotency_key: string | null;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  completed_at: string | null;
  refund_value: number;
  credit_applied: number;
  refund_amount: number;
  refund_method: MedicineReturnMethod | null;
  created_at: string;
  updated_at: string;
};

export type MedicineReturnItemRow = {
  id: string;
  return_id: string;
  sale_item_id: string;
  medicine_id: string;
  quantity: number;
  base_units_total: number;
  unit_price: number;
  line_total: number;
  return_value: number;
  restocked_units: number;
  quarantined_units: number;
  created_at: string;
};

export type MedicineReturnAllocationRow = {
  id: string;
  return_item_id: string;
  batch_id: string | null;
  base_units: number;
  disposition: 'restocked' | 'quarantined';
  note: string;
  created_at: string;
};

export type MedicinePriceChangeRow = {
  id: string;
  branch_id: string;
  medicine_id: string;
  unit_key: string;
  unit_name: string;
  unit_multiplier: number;
  old_price: number;
  new_price: number;
  reason: string;
  changed_by: string;
  changed_at: string;
};

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

/* ------------------------------------------- shared medicine catalogue rows */
/**
 * The global clinical catalogue, from 20261019120000_medicine_knowledge_base.
 *
 * A product is shared across pharmacies. It is deliberately not a `medicines`
 * row: stock, price, batches and expiry stay tenant-scoped. Registration
 * verification and clinical review are separate facts, and both may be
 * `unverified`/`not_verified` without pretending the record is safe.
 */
export type MedicineProductRow = {
  id: string;
  identity_key: string;
  generic_name: string;
  brand_name: string | null;
  product_name: string;
  strength_text: string;
  dosage_form: string;
  route: string;
  pack_size: string | null;
  manufacturer: string | null;
  marketing_authorisation_holder: string | null;
  nafdac_reg_number: string | null;
  nafdac_registration_status: MedicineRegistrationStatus;
  nafdac_verified_at: string | null;
  category: string;
  prescription_class: PrescriptionClass;
  is_combination: boolean;
  generic_product_id: string | null;
  clinical_review_status: MedicineVerificationStatus;
  clinical_reviewed_by: string | null;
  clinical_reviewed_at: string | null;
  last_clinical_review_date: string | null;
  version: number;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MedicineIngredientRow = {
  id: string;
  product_id: string;
  ingredient_name: string;
  strength_value: number | null;
  strength_unit: string | null;
  sort_order: number;
  created_at: string;
};

export type MedicineSourceRow = {
  id: string;
  product_id: string | null;
  section: ClinicalSection | null;
  source_type: MedicineSourceType;
  title: string;
  publisher: string | null;
  url: string | null;
  document_reference: string | null;
  retrieved_at: string;
  /** Client-local reference used to link a submission's sections and dosages. */
  source_ref: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type MedicineClinicalSectionRow = {
  id: string;
  product_id: string;
  section: ClinicalSection;
  content: string;
  status: ClinicalSectionStatus;
  food_instruction: MedicineFoodInstruction | null;
  source_id: string | null;
  retrieved_at: string | null;
  last_reviewed_at: string | null;
  reviewed_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type MedicineDosageRow = {
  id: string;
  product_id: string;
  population: string;
  indication: string | null;
  route: string | null;
  dose_text: string | null;
  frequency: string | null;
  duration: string | null;
  max_dose: string | null;
  notes: string | null;
  status: ClinicalSectionStatus;
  source_id: string | null;
  retrieved_at: string | null;
  last_reviewed_at: string | null;
  reviewed_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type MedicineProductAliasRow = {
  id: string;
  product_id: string;
  alias: string;
  alias_type: MedicineAliasType;
  source_id: string | null;
  created_at: string;
};

export type MedicineSourceRecordRow = {
  source_name: string;
  external_id: string;
  product_id: string;
  source_hash: string;
  imported_at: string;
};

export type MedicineProductRevisionRow = {
  id: string;
  product_id: string;
  version: number;
  snapshot: Json;
  changed_by: string | null;
  changed_at: string;
  change_reason: string | null;
};

export type MedicineSubmissionRow = {
  id: string;
  branch_id: string;
  submitted_by: string;
  status: MedicineSubmissionStatus;
  product_id: string | null;
  generic_name: string | null;
  brand_name: string | null;
  product_name: string | null;
  strength_text: string | null;
  dosage_form: string | null;
  route: string | null;
  pack_size: string | null;
  manufacturer: string | null;
  marketing_authorisation_holder: string | null;
  nafdac_reg_number: string | null;
  category: string | null;
  prescription_class: PrescriptionClass | null;
  source_type: MedicineSourceType | null;
  source_title: string | null;
  source_url: string | null;
  source_document_reference: string | null;
  source_retrieved_at: string | null;
  clinical_payload: Json;
  notes: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  accepted_product_id: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MedicineCatalogueAuditRow = {
  id: string;
  product_id: string | null;
  submission_id: string | null;
  actor_id: string | null;
  action: string;
  from_status: string | null;
  to_status: string | null;
  description: string;
  metadata: Json;
  created_at: string;
};

export type MedicineImportBatchRow = {
  id: string;
  source_name: string;
  source_url: string | null;
  source_retrieved_at: string | null;
  file_name: string | null;
  imported_by: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  total_rows: number;
  valid_rows: number;
  duplicate_rows: number;
  rejected_rows: number;
  imported_rows: number;
  source_license: string | null;
  source_terms_url: string | null;
  created_at: string;
  completed_at: string | null;
};

export type MedicineImportRow = {
  id: string;
  batch_id: string;
  external_id: string;
  source_hash: string;
  raw: Json;
  normalized: Json | null;
  identity_key: string | null;
  status: MedicineImportStatus;
  reason: string | null;
  product_id: string | null;
  created_at: string;
};

export type PharmacyMedicineAliasRow = {
  id: string;
  branch_id: string;
  medicine_id: string;
  alias: string;
  alias_type: MedicineAliasType;
  created_by: string | null;
  created_at: string;
};

/** Shape returned by `pf_search_medicine_catalogue`. */
export type MedicineCatalogueSearchRow = {
  id: string;
  product_name: string;
  generic_name: string;
  brand_name: string | null;
  strength_text: string;
  dosage_form: string;
  route: string;
  category: string;
  prescription_class: string;
  nafdac_reg_number: string | null;
  nafdac_registration_status: string;
  clinical_review_status: string;
  last_clinical_review_date: string | null;
  total_count: number;
};

/** Shape returned by `pf_medicine_duplicate_candidates`. */
export type MedicineDuplicateCandidateRow = {
  id: string;
  product_name: string;
  generic_name: string;
  brand_name: string | null;
  strength_text: string;
  dosage_form: string;
  route: string;
  manufacturer: string | null;
  nafdac_reg_number: string | null;
  clinical_review_status: string;
  match_score: number;
};

export type MedicineSubmissionInsert = {
  branch_id: string;
  submitted_by: string;
  status?: MedicineSubmissionStatus;
  product_id?: string | null;
  generic_name?: string | null;
  brand_name?: string | null;
  product_name?: string | null;
  strength_text?: string | null;
  dosage_form?: string | null;
  route?: string | null;
  pack_size?: string | null;
  manufacturer?: string | null;
  marketing_authorisation_holder?: string | null;
  nafdac_reg_number?: string | null;
  category?: string | null;
  prescription_class?: PrescriptionClass | null;
  source_type?: MedicineSourceType | null;
  source_title?: string | null;
  source_url?: string | null;
  source_document_reference?: string | null;
  source_retrieved_at?: string | null;
  clinical_payload?: Json;
  notes?: string | null;
  submitted_at?: string | null;
};

export type MedicineSubmissionUpdate = Partial<
  Omit<MedicineSubmissionInsert, 'branch_id' | 'submitted_by'>
> & {
  review_reason?: string | null;
  withdrawn_at?: string | null;
};

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
  /** Per-branch clinical reviewer capability. Owners are reviewers implicitly. */
  can_review_clinical: boolean;
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

/**
 * The columns an UPDATE may write. `read_at` is set once, when a recipient
 * clears a row, so it is not part of `NotificationInsert` (which omits
 * server-owned columns) and is named here instead — the same shape as
 * `SaleUpdate`.
 *
 * This is also the client-side statement of an RLS limit worth knowing: UPDATE
 * is `notifications_staff_update`, whose `using`/`with check` are both
 * `recipient_id = auth.uid()`. Only the addressed recipient can clear a row. A
 * branch-wide row (`recipient_id is null`) is readable by the whole branch
 * through `notifications_read` but is *not* updatable by it, so marking one read
 * matches zero rows.
 */
export type NotificationUpdate = Partial<Pick<NotificationRow, 'read_at'>>;

export type BranchMembershipInsert = {
  user_id: string;
  branch_id: string;
  role?: StaffRole;
  is_default?: boolean;
};

/**
 * A staff invitation, from `20261006090000_staff_invitations`.
 *
 * There is deliberately no `StaffInvitationInsert`. The table has no client
 * write path at all: `authenticated` holds SELECT only, and every mutation goes
 * through `pf_create_invitation` / `pf_revoke_invitation` / `pf_redeem_invitation`.
 * Modelling an insert type would invite a caller to build one.
 */
export type StaffInvitationRow = {
  id: string;
  branch_id: string;
  email: string;
  role: StaffRole;
  token: string;
  invited_by: string;
  created_at: string;
  /** The invited person, as the owner typed it. Display only — never an input to authorisation. */
  full_name: string | null;
  /** After this instant the code cannot be redeemed. */
  expires_at: string | null;
  /** When an acceptance attempt reserved this code. Never read by the browser. */
  claimed_at: string | null;
  /** When that reservation lapses and the code becomes claimable again. */
  claim_expires_at: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
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
      // Shared catalogue. Only medicine_submissions is client-writable; every
      // other new table is read-only to a browser session and maintained by
      // reviewer RPCs or the service-role importer.
      medicine_products: Table<MedicineProductRow, never, never>;
      medicine_ingredients: Table<MedicineIngredientRow, never, never>;
      medicine_sources: Table<MedicineSourceRow, never, never>;
      medicine_clinical_sections: Table<MedicineClinicalSectionRow, never, never>;
      medicine_dosages: Table<MedicineDosageRow, never, never>;
      medicine_product_aliases: Table<MedicineProductAliasRow, never, never>;
      medicine_source_records: Table<MedicineSourceRecordRow, never, never>;
      medicine_product_revisions: Table<MedicineProductRevisionRow, never, never>;
      medicine_submissions: Table<
        MedicineSubmissionRow,
        MedicineSubmissionInsert,
        MedicineSubmissionUpdate
      >;
      medicine_catalogue_audit: Table<MedicineCatalogueAuditRow, never, never>;
      medicine_import_batches: Table<MedicineImportBatchRow, never, never>;
      medicine_import_rows: Table<MedicineImportRow, never, never>;
      pharmacy_medicine_aliases: Table<PharmacyMedicineAliasRow, never, never>;
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
      // Append-only. No update model: payment records are audit rows, so the
      // third generic is `never` rather than a Partial insert.
      sale_payments: Table<SalePaymentRow, SalePaymentInsert, Partial<SalePaymentInsert>, [ToOne<'sale_payments_sale_id_fkey', 'sale_id'>]>;
      // Returns are written only by pf_create_return / pf_review_return and read
      // through branch-scoped RLS. `never` for insert/update is deliberate.
      medicine_returns: Table<
        MedicineReturnRow,
        never,
        never,
        [ToOne<'medicine_returns_sale_id_fkey', 'sale_id'>]
      >;
      medicine_return_items: Table<
        MedicineReturnItemRow,
        never,
        never,
        [ToOne<'medicine_return_items_return_id_fkey', 'return_id'>]
      >;
      medicine_return_allocations: Table<
        MedicineReturnAllocationRow,
        never,
        never,
        [ToOne<'medicine_return_allocations_return_item_id_fkey', 'return_item_id'>]
      >;
      medicine_price_changes: Table<MedicinePriceChangeRow, never, never>;
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
      notifications: Table<NotificationRow, NotificationInsert, NotificationUpdate>;
      branch_memberships: Table<BranchMembershipRow, BranchMembershipInsert, Partial<BranchMembershipInsert>>;
      // Select-only by grant. `never` for insert/update models that on purpose:
      // this table is not client-writable at any level.
      staff_invitations: Table<StaffInvitationRow, never, never>;
    };
    Views: {
      pf_medicine_costs: View<MedicineCostRow>;
      pf_batch_costs: View<BatchCostRow>;
      pf_receipt_costs: View<ReceiptCostRow>;
      pf_sale_item_costs: View<SaleItemCostRow>;
      pf_my_branches: View<BranchRow>;
/**
       * Platform administration views, from 20261012140000_platform_admin.
       *
       * `security_invoker = false`, so each carries a `pf_is_platform_admin()`
       * predicate in its own WHERE clause - that predicate, not the grant, is what
       * makes them safe. They select no cost column, no customer identity and no
       * audit `metadata`, deliberately.
       */
      pf_platform_pharmacies: View<{
        id: string;
        name: string;
        status: PharmacyStatus;
        address: string | null;
        city: string | null;
        state: string | null;
        phone: string | null;
        created_at: string;
        activated_at: string | null;
        suspended_at: string | null;
        suspended_reason: string | null;
        member_count: number;
        owner_name: string | null;
        owner_id: string | null;
        owner_invitation_email: string | null;
        owner_invited_at: string | null;
        owner_accepted_at: string | null;
        last_activity_at: string | null;
        /**
         * Last PRODUCT activity: a sale recorded, or stock received, moved,
         * adjusted or disposed of. Null means the pharmacy never transacted.
         *
         * Distinct from `last_activity_at`, which is ADMINISTRATION activity
         * (role changes, onboarding, status changes) and is NOT an adoption
         * signal. Use this one for adoption.
         */
        last_business_activity_at: string | null;
      }>;
      pf_platform_orders: View<{
        id: string;
        branch_id: string;
        pharmacy_name: string;
        order_number: string;
        state: string;
        payment_state: string;
        delivery_type: string;
        created_at: string;
        updated_at: string;
        item_count: number;
      }>;
      pf_platform_activity: View<{
        id: string;
        branch_id: string;
        pharmacy_name: string;
        actor_id: string | null;
        actor_name: string | null;
        action: string;
        description: string;
        created_at: string;
      }>;
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
      // From 20261006090000_staff_invitations. All three are SECURITY DEFINER and
      // are the ONLY way staff_invitations is written; the table itself holds a
      // SELECT grant and nothing else.
      pf_create_invitation: {
        Args: { p_email: string; p_role?: StaffRole; p_full_name?: string | null; p_expires_in?: string };
        Returns: Pick<
          StaffInvitationRow,
          'token' | 'email' | 'role' | 'created_at' | 'expires_at' | 'full_name'
        >[];
      };
      pf_revoke_invitation: { Args: { p_token: string }; Returns: boolean };
      /**
       * Reserves a live invitation for one acceptance attempt.
       *
       * Returns no rows when the invitation is withdrawn, accepted, expired, or
       * already held by a live lease. Reachable only by `service_role`; the browser
       * never calls this.
       */
      pf_claim_invitation: {
        Args: { p_token: string };
        Returns: Pick<StaffInvitationRow, 'email' | 'claim_expires_at'>[];
      };
      pf_redeem_invitation: {
        Args: { p_token: string };
        Returns: { branch: string; granted_role: StaffRole }[];
      };
       /**
        * Authoritative checkout, from 20261012120000_authoritative_checkout,
        * extended by M1 (p_sold_at) and 20261018120000 (p_payment_breakdown).
        *
        * The only thing the client may influence per line is *which* product,
        * *which* of its units, and *how many*. The multiplier, the unit price,
        * the base-unit total and every money figure are resolved server-side, so
        * a caller that forges them changes nothing. A split sale's breakdown
        * parts (jsonb array of {method, amount}) are re-validated server-side:
        * their sum must equal p_amount_paid. Returns no cost-bearing value,
        * which is what keeps purchase costs behind the owner-gated views.
        */
      pf_complete_sale: {
        Args: {
          p_lines: unknown;
          p_payment_method: PaymentKind;
          p_amount_paid: number;
          p_discount?: number;
          p_discount_reason?: string | null;
          p_customer_id?: string | null;
          p_credit_account_id?: string | null;
          p_dispensed_against_prescription?: boolean;
          p_idempotency_key?: string | null;
          p_sold_at?: string | null;
          p_payment_breakdown?: unknown;
        };
        Returns: {
          sale_id: string;
          receipt_number: string;
          total: number;
          line_count: number;
          already_completed: boolean;
        }[];
      };
      /**
       * Customer debt repayment, from 20261018120000_pos_payments_split.
       *
       * Locks the sale, refuses voided/refunded and walk-in sales, refuses
       * overpayment, then atomically moves sales.amount_paid / outstanding /
       * state, decrements customers.outstanding_debt and writes one
       * sale_payments audit row (method + staff member). Staff only; tenant is
       * resolved server-side.
       */
      pf_record_customer_payment: {
        Args: {
          p_sale_id: string;
          p_amount: number;
          p_method: PaymentKind;
          p_note?: string | null;
        };
        Returns: {
          sale_id: string;
          receipt_number: string;
          amount_paid: number;
          outstanding: number;
          state: string;
          customer_outstanding_debt: number;
        }[];
      };
      /**
       * Returnable quantities for one completed sale, from
       * 20261020120000_returns_and_price_updates.
       *
       * `quantity_remaining` excludes both completed and pending returns, so an
       * attendant cannot reserve the same unit twice while an owner decides.
       */
      pf_sale_returnable: {
        Args: { p_sale_id: string };
        Returns: {
          sale_item_id: string;
          medicine_id: string;
          medicine_name: string;
          unit_key: string;
          unit_name: string;
          unit_multiplier: number;
          quantity_sold: number;
          quantity_returned: number;
          quantity_pending: number;
          quantity_remaining: number;
          unit_price: number;
          line_total: number;
          return_value_per_unit: number;
        }[];
      };
      /**
       * Create a customer return. Owners complete it immediately; attendants
       * create a pending-review row. The RPC never edits the original sale or its
       * lines. Repeating p_idempotency_key returns the same row.
       */
      pf_create_return: {
        Args: {
          p_sale_id: string;
          p_items: unknown;
          p_reason: MedicineReturnReason;
          p_note?: string | null;
          p_refund_method?: MedicineReturnMethod | null;
          p_idempotency_key?: string | null;
        };
        Returns: {
          return_id: string;
          return_number: string;
          status: MedicineReturnStatus;
          refund_value: number;
          credit_applied: number;
          refund_amount: number;
          already_exists: boolean;
        }[];
      };
      /** Owner-only approval or rejection of a pending return. */
      pf_review_return: {
        Args: {
          p_return_id: string;
          p_approve: boolean;
          p_note?: string | null;
          p_refund_method?: MedicineReturnMethod | null;
        };
        Returns: {
          return_id: string;
          return_number: string;
          status: MedicineReturnStatus;
          refund_value: number;
          credit_applied: number;
          refund_amount: number;
        }[];
      };
      /**
       * Owner-only authoritative price update. `p_expected_price` is the price
       * the form was rendered with; a mismatch is refused, not overwritten.
       */
      pf_update_medicine_price: {
        Args: {
          p_medicine_id: string;
          p_unit_key: string;
          p_new_price: number;
          p_expected_price: number;
          p_reason?: string | null;
        };
        Returns: {
          medicine_id: string;
          unit_key: string;
          old_price: number;
          new_price: number;
          changed_at: string;
        }[];
      };
      /**
       * The receiving write path, from 20261012170000_receive_stock.
       *
       * SECURITY DEFINER, and the only way a receipt, a lot and the movement that
       * follows from it are written together. Branch and actor are resolved
       * server-side; the function accepts no branch and refuses a caller who is not
       * a member of the one it resolves. Idempotent on `(branch_id,
       * receipt_number)`: resubmitting the same number returns the receipt that
       * already exists. A non-owner's cost is dropped rather than refused, so the
       * delivery still books in and waits in the pricing queue.
       */
      pf_receive_stock: {
        Args: { p_receipt: Json };
        Returns: {
          receipt_id: string;
          batch_id: string | null;
          receipt_number: string;
          state: ReceiptState;
          base_units_received: number;
          already_received: boolean;
        };
      };
      /**
       * Platform administration, from 20261012140000_platform_admin.
       *
       * Onboarding and suspension are `service_role` only - no browser can
       * execute them - so the actor is an argument the Worker passes, not a JWT
       * claim. That is safe because the function re-resolves the id against
       * `profiles` rather than trusting it, and the caller was already verified
       * upstream. Returning the invitation token is deliberate: it goes into the
       * email inside the Worker and is never returned over the API.
       */
      pf_create_pharmacy: {
        Args: {
          p_actor: string;
          p_pharmacy_name: string;
          p_owner_name: string;
          p_owner_email: string;
          p_phone?: string;
          p_address?: string;
          p_city?: string;
          p_state?: string;
        };
        Returns: {
          branch_id: string;
          pharmacy_name: string;
          owner_invitation: string;
          invitation_token: string;
        }[];
      };
      pf_set_pharmacy_status: {
        Args: {
          p_actor: string;
          p_branch_id: string;
          p_status: PharmacyStatus;
          p_reason?: string | null;
        };
        Returns: boolean;
      };
      /** True only for an account granted platform administration by service_role. */
      pf_is_platform_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      /**
       * Status of the caller's own branch, including when it is suspended.
       *
       * Self-scoped: no arguments, so it cannot be pointed at another pharmacy.
       * Exists only so the UI can say *why* an empty screen is empty.
       */
      pf_my_branch_status: { Args: Record<PropertyKey, never>; Returns: PharmacyStatus };
      /**
       * Shared catalogue search. Verified and outdated products only; RLS is the
       * second gate. Paginated server-side so the browser never downloads the
       * whole catalogue.
       */
      pf_search_medicine_catalogue: {
        Args: {
          p_query?: string | null;
          p_dosage_form?: string | null;
          p_strength?: string | null;
          p_route?: string | null;
          p_category?: string | null;
          p_prescription_class?: string | null;
          p_verification?: string | null;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: MedicineCatalogueSearchRow[];
      };
      /** Candidate duplicates for an owner submission or the importer. */
      pf_medicine_duplicate_candidates: {
        Args: {
          p_generic_name: string;
          p_strength?: string | null;
          p_dosage_form?: string | null;
          p_route?: string | null;
          p_brand_name?: string | null;
          p_manufacturer?: string | null;
          p_nafdac?: string | null;
          p_exclude_id?: string | null;
        };
        Returns: MedicineDuplicateCandidateRow[];
      };
      /** True for a platform admin, owner, or a branch reviewer. */
      pf_can_review_clinical: { Args: Record<PropertyKey, never>; Returns: boolean };
    };
    Enums: {
      staff_role: StaffRole;
      prescription_class: PrescriptionClass;
      pharmacy_status: PharmacyStatus;
      stock_state: StockState;
      receipt_state: ReceiptState;
      sale_state: SaleState;
      payment_kind: PaymentKind;
      movement_kind: MovementKind;
      order_state: OrderState;
      request_state: RequestState;
      urgency_level: UrgencyLevel;
      medicine_verification_status: MedicineVerificationStatus;
      medicine_registration_status: MedicineRegistrationStatus;
      clinical_section_status: ClinicalSectionStatus;
      clinical_section: ClinicalSection;
      medicine_source_type: MedicineSourceType;
      medicine_food_instruction: MedicineFoodInstruction;
      medicine_submission_status: MedicineSubmissionStatus;
      medicine_import_status: MedicineImportStatus;
      medicine_alias_type: MedicineAliasType;
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
