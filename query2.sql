SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.prokind 
FROM pg_proc p 
JOIN pg_namespace n ON n.oid = p.pronamespace 
WHERE n.nspname = 'public' 
  AND p.proname LIKE 'pf_%' 
ORDER BY p.proname;