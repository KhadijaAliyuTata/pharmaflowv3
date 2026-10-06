import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * Plugin order is load-bearing:
 *   1. cloudflare()  — must come first so the ssr environment targets workerd
 *   2. tanstackStart()
 *   3. react()
 *   4. tailwindcss()
 */
export default defineConfig(({ command }) => ({
    // -------------------------------------------------------------- DEV_SERVER
    //
    // A compile-time constant that is `true` only when Vite is serving
    // (`vite dev`) and `false` for every production build, including the SSR/worker
    // bundle. `~/lib/session` uses it as the sole gate on demo authentication.
    //
    // Why a `define` and not `import.meta.env.DEV`:
    //
    //   `import.meta.env.DEV` is substituted in the CLIENT bundle but is left as a
    //   literal in the SSR bundle this project builds with `@cloudflare/vite-plugin`,
    //   where it is resolved at runtime from the platform environment instead. That
    //   was verified by inspecting `dist/server/assets/*.js` after a build: the client
    //   chunk had it folded to `false`, the server chunk had not been substituted at
    //   all. A gate that only folds in one of the two outputs is not a gate.
    //
    //   `define` is applied to every environment Vite builds, so the constant is
    //   replaced with a literal `true` or `false` in both. `command === 'serve'` is
    //   the build-mode signal: 'serve' for the dev server, 'build' for a production
    //   build. It is not derived from any environment variable, so nothing that can
    //   influence a production build — a CI variable, a copied `.env`, a platform
    //   dashboard setting — can make it true.
    define: {
      __DEV_SERVER__: JSON.stringify(command === 'serve'),
    },
  // Vite only exposes env vars matching `envPrefix` to client code, and the
  // default is `VITE_`. This project reads `PUBLIC_SUPABASE_*` from
  // `import.meta.env` (see src/lib/supabase.ts), so without this the values are
  // stripped at build time and the app silently falls back to demo mode.
  envPrefix: ['VITE_', 'PUBLIC_'],

  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // shadcn's base registry imports the merge helper as a bare `cn`
      // specifier in every component. Alias it once rather than editing
      // 27 generated files.
      //
      // It points at lib/cn.ts, not lib/utils.ts: utils re-exports *from* this
      // module, so aliasing it here would be circular.
      cn: fileURLToPath(new URL('./src/lib/cn.ts', import.meta.url)),
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
}));
