import { createClient } from '@supabase/supabase-js';

const url = 'https://xnhsuifcbplnwtxnpedw.supabase.co';
const key = 'sb_publishable_a6_In_Iy4Qu5mTJvmAUb0Q_-NMacTUB';
const supabase = createClient(url, key);

async function inspect() {
  // Check what tables actually exist in the schema
  console.log('=== All tables in public schema ===');
  const { data: tables, error } = await supabase
    .from('information_schema.tables')
    .select('table_name, table_type')
    .eq('table_schema', 'public')
    .order('table_name');
  console.log('Tables:', tables?.map(t => t.table_name).join(', '));
  console.log('Error:', error?.message);

  // Check views
  console.log('\n=== All views in public schema ===');
  const { data: views, error: vErr } = await supabase
    .from('information_schema.views')
    .select('table_name, view_definition')
    .eq('table_schema', 'public')
    .order('table_name');
  console.log('Views:', views?.map(v => v.table_name).join(', '));

  // Check functions
  console.log('\n=== Functions ===');
  const { data: funcs, error: fErr } = await supabase
    .from('pg_proc')
    .select('proname, pronargs')
    .ilike('proname', 'pf_%')
    .order('proname');
  console.log('PF functions:', funcs?.map(f => f.proname).join(', '));

  // Check for specific tables we care about
  const importantTables = [
    'profiles', 'branches', 'branch_memberships', 'staff_invitations',
    'medicines', 'medicine_batches', 'stock_receipts', 'sales', 'sale_items',
    'customers', 'suppliers', 'credit_accounts', 'credit_ledger',
    'customer_orders', 'order_items', 'medicine_requests',
    'audit_events', 'notifications', 'stock_movements', 'sales',
    'sale_items', 'credit_accounts', 'credit_ledger', 'customer_orders',
    'order_items', 'medicine_requests', 'audit_events', 'notifications',
    'stock_movements', 'sale_items', 'credit_accounts', 'credit_ledger',
    'customer_orders', 'order_items', 'medicine_requests', 'audit_events',
    'notifications', 'stock_movements', 'branch_memberships',
    'staff_invitations', 'medicine_batches', 'stock_receipts', 'sales',
    'sale_items', 'credit_accounts', 'credit_ledger', 'customer_orders',
    'order_items', 'medicine_requests', 'audit_events', 'notifications',
    'stock_movements', 'pf_my_branches', 'pf_platform_pharmacies',
    'pf_platform_activity', 'pf_platform_orders'
  ];

  console.log('\n=== Table/Column Details ===');
  for (const table of [
    'profiles', 'branches', 'branch_memberships', 'staff_invitations',
    'medicines', 'medicine_batches', 'stock_receipts', 'sales',
    'sale_items', 'customers', 'suppliers', 'credit_accounts',
    'credit_ledger', 'customer_orders', 'order_items', 'medicine_requests',
    'audit_events', 'notifications', 'stock_movements', 'branches',
    'profiles', 'branch_memberships', 'staff_invitations'
  ]) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .limit(1);
    console.log(`Table ${table}: exists=${!error}, columns=${data ? Object.keys(data[0] || {}).length : 0}, error=${error?.message}`);
  }
}

inspect().catch(console.error);