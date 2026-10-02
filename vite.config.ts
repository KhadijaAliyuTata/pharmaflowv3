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
export default defineConfig({
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
});
