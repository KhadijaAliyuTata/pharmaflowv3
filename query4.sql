SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
FROM pg_proc p 
JOIN pg_namespace n ON n.oid = p.pronamespace 
WHERE n.nspname = 'public' 
  AND p.proname = 'pf_apply_sale_item_stock';