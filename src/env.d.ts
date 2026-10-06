/**
 * Build-time constants injected by `vite.config.ts` via `define`.
 *
 * `__DEV_SERVER__` is the gate on demo authentication. It is `true` only when Vite
 * is running `vite dev` (`command === 'serve'`) and `false` for every production
 * build, in both the client and the SSR/worker bundle.
 *
 * It replaces `import.meta.env.DEV` for that purpose because `define` is applied to
 * every environment Vite builds, whereas `import.meta.env.DEV` is left as a runtime
 * lookup in the SSR bundle this project builds with `@cloudflare/vite-plugin`. A gate
 * that folds in only one of the two outputs is not a gate.
 *
 * It is deliberately not derived from any environment variable. `PUBLIC_DEMO_MODE`
 * is read from the build's environment, so a CI variable, a copied `.env`, or a
 * platform dashboard setting could set it — which is why a flag could never carry
 * this guarantee on its own.
 */
declare const __DEV_SERVER__: boolean;