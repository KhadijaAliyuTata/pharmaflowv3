/**
 * Build-time plugin that assembles the offline application-shell service worker.
 *
 * Runs in the Vite **client** build only. It takes the manifest of every emitted
 * client chunk, injects it into `src/offline/worker.js` at the substitution
 * point described there, and writes the assembled worker to the client output
 * directory, where the Cloudflare assets binding serves it at `/sw.js`.
 *
 * ## Why this exists
 *
 * `vite-plugin-pwa` + Workbox were evaluated first (approved plan, decision 2)
 * and in this stack are a silent no-op: under `@cloudflare/vite-plugin` +
 * TanStack Start's environment split the build exits 0 but emits no `sw.js`,
 * no precache manifest and no workbox code anywhere in `dist`. Two builds
 * confirmed it. The parts of that evaluation worth keeping — a real
 * build-time precache manifest covering every hashed chunk, including for
 * routes never visited online — are exactly what this file does itself, with
 * no additional runtime dependency.
 *
 * ## The manifest
 *
 * Everything under the emitted `assets/` directory: hashed chunks, stylesheets
 * and fonts. Not the service worker itself, not the `.assetsignore` marker, and
 * nothing outside `assets/` (documents are runtime-cached, never pre-cached).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

const WORKER_TEMPLATE = new URL('./worker.js', import.meta.url);
/** Marker in `worker.js` that the manifest is replaced with. */
const MANIFEST_MARKER = `'__OFFLINE_SHELL_MANIFEST__'`;

export function offlineShellPlugin(): Plugin {
  let clientOutDir: string | null = null;

  return {
    name: 'pharmaflow-offline-shell',
    configResolved(config: ResolvedConfig): void {
      if (clientOutDir) return;
      const ssrBuild = Boolean((config.build as { ssr?: unknown }).ssr);
      // The Cloudflare client output is marked by `.assetsignore`; without it the
      // directory is not the renderer's asset bundle.
      const resolved = path.resolve(config.root, config.build.outDir);
      if (!ssrBuild && fs.existsSync(path.join(resolved, '.assetsignore'))) {
        clientOutDir = resolved;
      }
    },
    closeBundle(): void {
      if (!clientOutDir) return;
      const assetsDir = path.join(clientOutDir, 'assets');
      if (!fs.existsSync(assetsDir)) return;

      // All hashed assets the renderer bundles live and only live under `assets/`.
      const manifest: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
            continue;
          }
          if (!entry.name.endsWith('.js') && !entry.name.endsWith('.css')) continue;
          // Fonts are not listed here — they reach the runtime cache on first use
          // and adding every glyph variant is not worth the install size.
          if (/\.(woff2?|ttf|otf)$/i.test(entry.name)) continue;
          manifest.push(`assets/${prefix}${entry.name}`);
        }
      };
      walk(assetsDir, '');

      if (manifest.length === 0) return;

      const worker = fs.readFileSync(WORKER_TEMPLATE, 'utf8').replace(
        MANIFEST_MARKER,
        JSON.stringify(manifest),
      );

      fs.writeFileSync(path.join(clientOutDir, 'sw.js'), worker, 'utf8');
    },
  };
}
