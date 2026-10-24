[35m.env.example[m[36m:[m[32m11[m[36m:[m[1;31mPUBLIC_DEMO_MODE[m=true
[35msrc/env.d.ts[m[36m:[m[32m13[m[36m:[m * It is deliberately not derived from any environment variable. `[1;31mPUBLIC_DEMO_MODE[m`
[35msrc/lib/build-mode.ts[m[36m:[m[32m27[m[36m:[m * The flag used to fail OPEN: `!isSupabaseConfigured() && [1;31mPUBLIC_DEMO_MODE[m !==
[35msrc/lib/build-mode.ts[m[36m:[m[32m82[m[36m:[m  const requested = String(import.meta.env.[1;31mPUBLIC_DEMO_MODE[m ?? '').trim().toLowerCase();
[35msrc/lib/session.ts[m[36m:[m[32m66[m[36m:[m  // real fix. It used to end with "or set [1;31mPUBLIC_DEMO_MODE[m=true", which was true
[35msrc/lib/session.ts[m[36m:[m[32m68[m[36m:[m  return 'Supabase is not configured. Set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY. Demo data is available on a development server via [1;31mPUBLIC_DEMO_MODE[m=true, but never in a production build.';
[35msrc/routes/login.tsx[m[36m:[m[32m131[m[36m:[m            <code className="font-mono">[1;31mPUBLIC_DEMO_MODE[m=true</code>. It is not available in a
