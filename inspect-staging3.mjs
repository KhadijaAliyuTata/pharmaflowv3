import { createClient } from '@supabase/supabase-js';

const url = 'https://xnhsuifcbplnwtxnpedw.supabase.co';
const key = 'sb_publishable_a6_In_Iy4Qu5mTJvmAUb0Q_-NMacTUB';
const supabase = createClient(url, key);

async function inspect() {
  // Try with service role key via the Worker
  console.log('=== Try with service role key via Worker route ===');
  
  // Try to call the Worker route that uses service role
  const response = await fetch('https://pharmaflow-staging.aliyutatak.workers.dev/api/platform/onboard-pharmacy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      pharmacyName: 'Test Pharmacy',
      ownerName: 'Test Owner',
      ownerEmail: 'test@example.com'
    })
  });
  console.log('Worker route status:', response.status);
  const text = await response.text();
  console.log('Response:', text.substring(0, 500));

  // Try to get schema info from information_schema
  console.log('\n=== Check information_schema.tables ===');
  const { data: tables, error: tErr } = await supabase
    .from('information_schema.tables')
    .select('table_name, table_schema, table_type')
    .eq('table_schema', 'public')
    .order('table_name');
  console.log('Tables:', tables?.map(t => t.table_name).join(', '), tErr?.message);

  // Check specific table columns
  console.log('\n=== Check profiles columns via information_schema ===');
  const { data: pCols } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable, column_default')
    .eq('table_schema', 'public')
    .eq('table_name', 'profiles')
    .order('ordinal_position');
  console.log('Profiles columns:', pCols?.map(c => c.column_name).join(', '));

  const { data: bCols } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable, column_default')
    .eq('table_schema', 'public')
    .eq('table_name', 'branches')
    .order('ordinal_position');
  console.log('Branches columns:', bCols?.map(c => c.column_name).join(', '));

  const { data: bmCols } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable, column_default')
    .eq('table_schema', 'public')
    .eq('table_name', 'branch_memberships')
    .order('ordinal_position');
  console.log('Branch memberships columns:', bmCols?.map(c => c.column_name).join(', '));

  // Check if pg_proc has the functions
  console.log('\n=== Check pg_proc for platform functions ===');
  const { data: funcs } = await supabase
    .from('pg_proc')
    .select('proname, pronargs, proargtypes')
    .ilike('proname', 'pf_%')
    .order('proname');
  console.log('PF functions:', funcs?.map(f => f.proname).join(', '));

  // Check pg_views
  console.log('\n=== Views ===');
  const { data: views } = await supabase
    .from('information_schema.views')
    .select('table_name, view_definition')
    .eq('table_schema', 'public')
    .ilike('table_name', 'pf_%');
  console.log('Views:', views?.map(v => v.table_name).join(', '));

  // Check pg_trigger
  console.log('\n=== Triggers ===');
  const { data: triggers } = await supabase
    .from('information_schema.triggers')
    .select('trigger_name, event_object_table, action_statement')
    .eq('trigger_schema', 'public')
    .order('trigger_name');
  console.log('Triggers:', triggers?.map(t => `${t.trigger_name} on ${t.event_object_table}`).join(', '));

  // Check policies
  console.log('\n=== Policies ===');
  const { data: policies } = await supabase
    .from('pg_policies')
    .select('polname, polcmd, polrelname')
    .order('polname');
  console.log('Policies:', policies?.map(p => `${p.polname} on ${p.polrelname}`).join(', '));
}

inspect().catch(console.error);