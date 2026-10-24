import { createClient } from '@supabase/supabase-js';

const url = 'https://xnhsuifcbplnwtxnpedw.supabase.co';
const key = 'sb_publishable_a6_In_Iy4Qu5mTJvmAUb0Q_-NMacTUB';
const supabase = createClient(url, key);

async function inspect() {
  // Check what the anon key can see via information_schema
  console.log('=== information_schema.tables (public schema) ===');
  const { data: tables, error } = await supabase
    .from('information_schema.tables')
    .select('table_name, table_type, table_schema')
    .eq('table_schema', 'public')
    .order('table_name');
  console.log('Tables count:', tables?.length);
  console.log('Tables:', tables?.map(t => t.table_name).join(', '));
  console.log('Error:', error?.message);

  console.log('\n=== information_schema.views ===');
  const { data: views, error: vErr } = await supabase
    .from('information_schema.views')
    .select('table_name, view_definition')
    .eq('table_schema', 'public')
    .order('table_name');
  console.log('Views count:', views?.length);
  console.log('Views:', views?.map(v => v.table_name).join(', '));
  console.log('Error:', vErr?.message);

  console.log('\n=== Functions (pg_proc) ===');
  const { data: funcs, error: fErr } = await supabase
    .from('pg_proc')
    .select('proname, pronargs')
    .ilike('proname', 'pf_%')
    .order('proname');
  console.log('PF functions:', funcs?.map(f => f.proname).join(', '));
  console.log('Error:', fErr?.message);

  console.log('\n=== pg_proc all functions ===');
  const { data: allFuncs, error: afErr } = await supabase
    .from('pg_proc')
    .select('proname, pronargs')
    .ilike('proname', '%')
    .order('proname');
  console.log('All functions count:', allFuncs?.length);
  console.log('All functions:', allFuncs?.map(f => f.proname).filter(f => f.startsWith('pf_')).join(', '));
  console.log('Error:', afErr?.message);

  console.log('\n=== Check specific columns ===');
  const { data: pCols, error: pErr } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable, column_default')
    .eq('table_schema', 'public')
    .eq('table_name', 'profiles')
    .order('ordinal_position');
  console.log('Profiles columns:', pCols?.map(c => c.column_name).join(', '));
  console.log('Error:', pErr?.message);

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

  // Check pg_views
  console.log('\n=== pg_views ===');
  const { data: pgViews } = await supabase
    .from('pg_views')
    .select('viewname, definition')
    .ilike('viewname', 'pf_%');
  console.log('Views:', pgViews?.map(v => v.viewname).join(', '));

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