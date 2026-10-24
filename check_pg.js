const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: '127.0.0.1',
    port: 54322,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres'
  });
  
  await client.connect();
  
  const res = await client.query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.prokind 
    FROM pg_proc p 
    JOIN pg_namespace n ON n.oid = p.pronamespace 
    WHERE n.nspname = 'public' 
      AND p.proname LIKE 'pf_apply_sale_item_stock%' 
    ORDER BY p.proname;
  `);
  
  console.log('Function signatures:');
  console.table(res.rows);
  
  await client.end();
}

main().catch(console.error);