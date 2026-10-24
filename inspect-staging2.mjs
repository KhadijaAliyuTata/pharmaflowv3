import { createClient } from '@supabase/supabase-js';

const url = 'https://xnhsuifcbplnwtxnpedw.supabase.co';
const key = 'sb_publishable_a6_In_Iy4Qu5mTJvmAUb0Q_-NMacTUB';
const supabase = createClient(url, key);

async function inspect() {
  // Check specific columns
  console.log('=== Profiles table - is_platform_admin column ===');
  const { data: profileCols, error: pErr } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, branch_id, is_platform_admin, is_customer')
    .limit(5);
  console.log('Profiles sample:', profileCols, pErr?.message);

  console.log('\n=== Branches table - status column ===');
  const { data: branchData, error: bErr } = await supabase
    .from('branches')
    .select('id, name, status, is_main_hub, pcn_number, premises_number')
    .limit(5);
  console.log('Branches sample:', branchData, bErr?.message);

  console.log('\n=== Branch Memberships ===');
  const { data: bmData, error: bmErr } = await supabase
    .from('branch_memberships')
    .select('user_id, branch_id, role, is_default')
    .limit(5);
  console.log('Branch memberships:', bmData, bmErr?.message);

  console.log('\n=== Staff Invitations ===');
  const { data: siData, error: siErr } = await supabase
    .from('staff_invitations')
    .select('id, branch_id, email, role, token, accepted_at, revoked_at')
    .limit(5);
  console.log('Staff invitations:', siData, siErr?.message);

  console.log('\n=== Branches status values ===');
  const { data: statusVals } = await supabase
    .from('branches')
    .select('status');
  console.log('Status values:', statusVals?.map(s => s.status));

  // Check if pf_current_branch RPC exists
  console.log('\n=== Check pf_current_branch RPC ===');
  const { data: cb, error: cbErr } = await supabase.rpc('pf_current_branch');
  console.log('pf_current_branch:', cb, cbErr?.message);
}

inspect().catch(console.error);