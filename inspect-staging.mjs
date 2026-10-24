import { createClient } from '@supabase/supabase-js';

const url = 'https://xnhsuifcbplnwtxnpedw.supabase.co';
const key = 'sb_publishable_a6_In_Iy4Qu5mTJvmAUb0Q_-NMacTUB';
const supabase = createClient(url, key);

async function inspect() {
  console.log('=== Supabase Migration Table ===');
  const { data: migrations, error: migError } = await supabase
    .from('supabase_migrations')
    .select('*')
    .order('version');
  console.log('Migrations:', migrations, migError?.message);

  console.log('\n=== Core Tables ===');
  const coreTables = [
    'profiles',
    'branches',
    'branch_memberships',
    'staff_invitations',
    'medicines',
    'medicine_batches',
    'stock_receipts',
    'sales',
    'sale_items',
    'customers',
    'suppliers',
    'credit_accounts',
    'credit_ledger',
    'customer_orders',
    'order_items',
    'medicine_requests',
    'audit_events',
    'notifications',
    'stock_movements',
    'sale_items',
    'pf_my_branches',
    'pf_platform_pharmacies',
    'branch_memberships',
    'staff_invitations',
    'medicine_batches',
    'stock_receipts',
    'stock_movements',
    'sales',
    'sale_items',
    'credit_accounts',
    'credit_ledger',
    'customer_orders',
    'order_items',
    'medicine_requests',
    'audit_events',
    'notifications',
  ];

  for (const table of coreTables) {
    const { data, error, count } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true });
    console.log(`Table ${table}: count=${count}, error=${error?.message ?? 'none'}`);
  }

  // Check views
  console.log('\n=== Views ===');
  const views = ['pf_my_branches', 'pf_platform_pharmacies', 'pf_platform_activity', 'pf_platform_orders'];
  for (const view of views) {
    const { data, error, count } = await supabase
      .from(view)
      .select('*', { count: 'exact', head: true });
    console.log(`View ${view}: count=${count}, error=${error?.message ?? 'none'}`);
  }

  // Check RPC functions
  console.log('\n=== RPC Functions ===');
  const rpcs = [
    'pf_is_platform_admin',
    'pf_create_pharmacy',
    'pf_grant_platform_admin',
    'pf_set_pharmacy_status',
    'pf_my_branches',
    'pf_my_branch_status',
    'pf_redeem_invitation',
    'pf_create_invitation',
    'pf_revoke_invitation',
    'pf_sync_profile_membership',
    'pf_current_branch',
    'pf_current_role',
    'pf_is_owner',
    'pf_is_staff',
    'pf_is_customer',
    'pf_is_staff',
    'pf_is_platform_admin',
  ];
  for (const rpc of rpcs) {
    const { data, error } = await supabase.rpc(rpc, {});
    console.log(`RPC ${rpc}: ${error?.message?.includes('Could not find') ? 'MISSING' : error?.message ?? 'EXISTS'}`);
  }

  // Check specific columns
  console.log('\n=== Profiles columns ===');
  const { data: profileCols } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable')
    .eq('table_schema', 'public')
    .eq('table_name', 'profiles')
    .order('ordinal_position');
  console.log('Profiles columns:', profileCols?.map(c => c.column_name).join(', '));

  // Check branches columns
  console.log('\n=== Branches columns ===');
  const { data: branchCols } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable')
    .eq('table_schema', 'public')
    .eq('table_name', 'branches')
    .order('ordinal_position');
  console.log('Branches columns:', branchCols?.map(c => c.column_name).join(', '));

  // Check branch_memberships columns
  console.log('\n=== Branch Memberships columns ===');
  const { data: bmCols } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable')
    .eq('table_schema', 'public')
    .eq('table_name', 'branch_memberships')
    .order('ordinal_position');
  console.log('Branch memberships columns:', bmCols?.map(c => c.column_name).join(', '));

  // Check branches status enum
  console.log('\n=== Branch status enum ===');
  const { data: statusEnum } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, udt_name')
    .eq('table_schema', 'public')
    .eq('table_name', 'branches')
    .eq('column_name', 'status');
  console.log('Status column:', statusEnum);

  // Check pf_my_branches view definition
  console.log('\n=== pf_my_branches view ===');
  const { data: viewDef } = await supabase
    .from('information_schema.views')
    .select('view_definition')
    .eq('table_schema', 'public')
    .eq('table_name', 'pf_my_branches');
  console.log('View definition:', viewDef?.[0]?.view_definition?.substring(0, 500));

  // Check pf_platform_pharmacies view
  console.log('\n=== pf_platform_pharmacies view ===');
  const { data: viewDef2 } = await supabase
    .from('information_schema.views')
    .select('view_definition')
    .eq('table_schema', 'public')
    .eq('table_name', 'pf_platform_pharmacies');
  console.log('View definition:', viewDef2?.[0]?.view_definition?.substring(0, 500));
}

inspect().catch(console.error);