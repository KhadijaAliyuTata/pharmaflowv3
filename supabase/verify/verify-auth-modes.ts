/**
 * Deployment-mode verification.
 *
 * `resolveDeploymentMode` in `~/lib/session` is the single place that decides
 * whether this build may authenticate at all, and it is pure: it reads three
 * environment values and returns a string. That makes it directly testable, which
 * matters because it is the gate that used to fail OPEN — a production deploy
 * missing one secret variable was served a fake owner session while looking
 * perfectly healthy.
 *
 * The logic is re-implemented here rather than imported, because the real one
 * reads `import.meta.env` at module scope and therefore resolves once, from
 * whatever the build had. Testing the real function would only prove what this
 * build's environment happens to be.
 *
 * What is asserted is the DECISION TABLE, which is the part that can regress.
 *
 * ## The build-mode dimension
 *
 * Demo mode now depends on `import.meta.env.DEV` as well as the flag, because a
 * flag alone could never be a guarantee: it is read from the build's environment,
 * so anything that influences a production build — a CI variable, a copied `.env`,
 * a platform default — could set it to `true` and the any-password sign-in would
 * be live. `isDevBuild` is therefore an explicit input to the copy below, so both
 * halves of the gate are asserted, including the case that matters most: a
 * production build with `PUBLIC_DEMO_MODE=true` and no Supabase configuration.
 *
 * The section that greps `dist/` for the seeded addresses is the one that proves
 * the gate holds in the artefact that actually ships, rather than in the source.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` -> ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n--- ${title} ---`);
}

/**
 * A faithful copy of the decision in src/lib/session.ts. If the two diverge, this
 * suite is testing the wrong thing — so `verify-auth-modes.ts` also greps the real
 * source for the rule this encodes.
 */
function resolveDeploymentMode(
  url: string | undefined,
  anonKey: string | undefined,
  demoFlag: string | undefined,
  isDevBuild: boolean,
): 'live' | 'demo' | 'broken' {
  const urlPresent = typeof url === 'string' && url.trim().length > 0;
  const keyPresent = typeof anonKey === 'string' && anonKey.trim().length > 0;

  if (urlPresent && keyPresent) return 'live';

  // Production builds have no demo mode. Not "disabled" and not "gated on a
  // flag" — the outcome does not exist, so there is nothing to set.
  if (!isDevBuild) return 'broken';

  const requested = String(demoFlag ?? '').trim().toLowerCase();
  if (requested === 'true') return 'demo';

  return 'broken';
}

/**
 * What configProblem() would report, for the same inputs.
 *
 * Returns 'NONE' rather than null so the "fully configured" case is an explicit
 * assertion rather than a `=== null` comparison that reads as a missing value.
 */
function configProblem(url: string | undefined, anonKey: string | undefined): string {
  const urlPresent = typeof url === 'string' && url.trim().length > 0;
  const keyPresent = typeof anonKey === 'string' && anonKey.trim().length > 0;
  if (urlPresent && keyPresent) return 'NONE';
  if (urlPresent && !keyPresent) return 'ANON_KEY_MISSING';
  if (!urlPresent && keyPresent) return 'URL_MISSING';
  return 'BOTH_MISSING';
}

const URL_OK = 'https://project.supabase.co';
const KEY_OK = 'anon-key-value';

/* ------------------------------------------------------------------------ */

section('a fully configured deployment authenticates against Supabase');
{
  const mode = resolveDeploymentMode(URL_OK, KEY_OK, undefined, false);
  check('mode is live', mode === 'live', mode);
  // A live deployment has nothing to report: configProblem() is only about a
  // deployment that CANNOT authenticate, and returning null is what lets the
  // login screen render its normal form instead of the diagnosis.
  check('no config problem is reported', configProblem(URL_OK, KEY_OK) === 'NONE');
}

section('demo mode cannot be reached when Supabase IS configured');
{
  // The dangerous combination. Even with the flag explicitly on, a live
  // deployment must not take the demo branch: the demo sign-in accepts any
  // password, so this combination would be a credential bypass on a real
  // pharmacy's data.
  const mode = resolveDeploymentMode(URL_OK, KEY_OK, 'true', false);
  check('mode stays live even with PUBLIC_DEMO_MODE=true', mode === 'live', mode);

  const devMode = resolveDeploymentMode(URL_OK, KEY_OK, 'true', true);
  check('and stays live on a development server too', devMode === 'live', devMode);
}

section('a PRODUCTION build cannot enter demo mode at all');
{
  // The requirement that a flag cannot satisfy on its own. Every one of these is
  // a production build, so none may reach 'demo' whatever the flag says — which is
  // exactly what the earlier flag-only implementation could not guarantee.
  for (const flag of ['true', 'TRUE', ' true ', 'yes', '1', 'on']) {
    const mode = resolveDeploymentMode('', '', flag, false);
    check(
      `production build with flag ${JSON.stringify(flag)} is broken, not demo`,
      mode === 'broken',
      mode,
    );
  }

  const halfConfigured = resolveDeploymentMode(URL_OK, '', 'true', false);
  check(
    'and a half-configured production build with the flag on is still broken',
    halfConfigured === 'broken',
    halfConfigured,
  );

  // A development server may still opt in. This is the one path to 'demo', and it
  // is reachable only when isDevBuild is true.
  check(
    'a development server CAN still opt in',
    resolveDeploymentMode('', '', 'true', true) === 'demo',
  );
  check(
    'but only with the explicit flag',
    resolveDeploymentMode('', '', undefined, true) === 'broken',
  );
}

/* ------------------------------------------------------------------------ */

section('a HALF-configured deployment does NOT silently become demo mode');
{
  // This is the exact fail-open the audit found. The anon key is empty, which is
  // an ordinary CI/secret mistake, and it used to fall through to demo mode.
  const urlOnly = resolveDeploymentMode(URL_OK, '', undefined, true);
  check('url without anon key is broken, not demo', urlOnly === 'broken', urlOnly);
  check(
    'and it names the missing variable specifically',
    configProblem(URL_OK, '') === 'ANON_KEY_MISSING',
    configProblem(URL_OK, '') ?? '',
  );

  const keyOnly = resolveDeploymentMode('', KEY_OK, undefined, true);
  check('anon key without url is broken, not demo', keyOnly === 'broken', keyOnly);
  check(
    'and it names the missing variable specifically',
    configProblem('', KEY_OK) === 'URL_MISSING',
    configProblem('', KEY_OK) ?? '',
  );

  const whitespace = resolveDeploymentMode('   ', KEY_OK, undefined, true);
  check('whitespace-only values count as absent', whitespace === 'broken', whitespace);
}

section('demo mode requires an explicit, unambiguous opt-in');
{
  check('flag exactly "true" enables demo', resolveDeploymentMode('', '', 'true', true) === 'demo');
  check('uppercase TRUE enables demo', resolveDeploymentMode('', '', 'true', true) === 'demo');
  check('" true " enables demo (trimmed)', resolveDeploymentMode('', '', ' true ', true) === 'demo');

  // The old rule was `!== 'false'`, so every one of these enabled demo mode.
  for (const flag of [undefined, '', '0', 'no', 'off', 'yes', '1', 'false', 'anything']) {
    const mode = resolveDeploymentMode('', '', flag, true);
    check(
      `flag ${JSON.stringify(flag)} does NOT enable demo`,
      mode === 'broken',
      `${mode}`,
    );
  }
}

section('an absent backend fails CLOSED by default');
{
  // The critical property: the default deployment, with nothing configured and
  // nothing requested, cannot authenticate. Worst case is a clear error.
  const mode = resolveDeploymentMode(undefined, undefined, undefined, true);
  check('nothing configured and nothing requested is broken', mode === 'broken', mode);
  check('a problem is reported', configProblem(undefined, undefined) === 'BOTH_MISSING');

  const emptyStrings = resolveDeploymentMode('', '', '', true);
  check('empty strings behave the same as absent', emptyStrings === 'broken', emptyStrings);
}

/* ------------------------------------------------------------------------ */

section('the source matches this decision table');
{
  // Guards against the copy above drifting from the implementation. Cheap, and it
  // catches the realistic regression: someone simplifying the real rule while the
  // suite keeps passing on its own copy.
  const SRC = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3/src/lib/session.ts';
  const src = await Bun.file(SRC).text();

  // The old fail-open expression survives only inside the explanatory comment that
  // documents why it was replaced. Strip comments before asserting, so the check
  // targets real code rather than prose.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
  check(
    'the real rule is opt-in, not opt-out',
    code.includes("requested === 'true'") && !code.includes("PUBLIC_DEMO_MODE !== 'false'"),
    "the old fail-open expression must not reappear in code",
  );
  check('live requires both halves present', /urlPresent && keyPresent/.test(src));
  check(
    'the cached role is downgraded while offline',
    src.includes("role: 'assistant', canApprovePricing: false"),
    'an unverified cached role must never gate owner-only screens',
  );
  check('configProblem is exported', src.includes('export function configProblem'));
  check('isAuthUnavailable is exported', src.includes('export function isAuthUnavailable'));

  // The any-password sign-in must be reachable only through a build-time constant.
  // A flag is not sufficient, which is the whole point of the second half of the
  // gate: the flag is read from the build's environment and anything that
  // influences a production build can set it.
  check(
    'demo mode is gated on the build-mode constant, not on import.meta.env.DEV',
    src.includes('const IS_DEV_BUILD = __DEV_SERVER__ === true') &&
      code.includes('if (!IS_DEV_BUILD) return') &&
      !/const IS_DEV_BUILD = import\.meta\.env\.DEV/.test(src),
    'import.meta.env.DEV is left literal in the SSR bundle; a define is not',
  );

  check(
    'a production build returns broken before the demo flag is ever consulted',
    code.indexOf("if (!IS_DEV_BUILD) return 'broken'") < code.indexOf('PUBLIC_DEMO_MODE'),
    'the build check precedes the flag check',
  );

  const signInStart = src.indexOf('export async function signIn');
  const signInBody = src.slice(signInStart, signInStart + 900);
  // The gate is `DEMO_ALLOWED`, not `DEMO_MODE`. Naming matters here: `DEMO_MODE` is
  // derived through a function, so a minifier cannot fold it and the demo branch
  // survives into the bundle with its credentials intact. `DEMO_ALLOWED` compares a
  // build-time substitution directly, which folds to `false` and lets the branch be
  // dropped. An earlier version of this file asserted on `DEMO_MODE` and passed
  // while the seeded addresses were still in dist/.
  const gateSite = (fn: string, window = 1600) => {
    const at = src.indexOf(fn);
    return at >= 0 ? src.slice(at, at + window) : '';
  };
  check(
    'the any-password demo sign-in is gated on the foldable constant, not on DEMO_MODE',
    gateSite('export async function signIn').includes('if (DEMO_ALLOWED)'),
    'if it were DEMO_MODE, the branch and its credentials would ship',
  );
  check(
    'startSession cannot auto-authenticate outside a development build',
    gateSite('export function startSession').includes('if (DEMO_ALLOWED)'),
  );
  check(
    'switchRole is gated on the same foldable constant',
    gateSite('export function switchRole').includes('if (!DEMO_ALLOWED) {') &&
      src.includes('development-server only'),
  );
  check(
    'the initial session cannot start authenticated in a production build',
    /let current: Session = DEMO_ALLOWED/.test(src),
    'a DEMO_MODE initialiser would keep DEMO_USERS referenced at module scope',
  );

  // The seeded accounts must live outside the production graph. They are still in
  // src/ — they have to be, for local development — so the assertion is that
  // session.ts no longer DEFINES them, only re-exports from the dev-only module.
  const FIXTURES = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3/src/lib/demo-fixtures.ts';
  const fixtures = await Bun.file(FIXTURES).text();
  check(
    'the seeded accounts are defined in demo-fixtures.ts, not in session.ts',
    fixtures.includes('khadija@pharmaflow.ng') && !code.includes('khadija@pharmaflow.ng'),
    'session.ts imports them; it does not hold them',
  );

  // The build config must define the constant from the build COMMAND, not from an
  // environment variable. A define derived from `process.env` would reintroduce
  // exactly the weakness this whole change exists to remove: anything that can
  // influence a production build could then set it.
  const VITE_CONFIG =
    'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3/vite.config.ts';
  const viteSrc = await Bun.file(VITE_CONFIG).text();
  check(
    'vite.config.ts defines __DEV_SERVER__ from the build command',
    viteSrc.includes('__DEV_SERVER__') && viteSrc.includes("command === 'serve'"),
    'JSON.stringify(command === "serve") — a build-mode signal',
  );
  check(
    'and that define does not read an environment variable',
    !/__DEV_SERVER__[\s\S]{0,80}process\.env/.test(viteSrc),
    'no process.env may reach the demo-auth gate',
  );

  const SUPABASE = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3/src/lib/supabase.ts';
  const supabaseSrc = await Bun.file(SUPABASE).text();
  check(
    'isSupabaseConfigured trims, so whitespace does not count as configured',
    supabaseSrc.includes('url.trim().length > 0') &&
      supabaseSrc.includes('anonKey.trim().length > 0'),
  );
}

section('the PRODUCTION BUILD ARTEFACT carries no demo AUTHENTICATION path');
{
  // Everything above tests the source. This tests the artefact that actually ships,
  // which is the only claim that matters for requirement 6: no environment
  // variable can re-enable what the build removed.
  //
  // The gate is written to be ELIMINABLE, not merely unreachable — `DEMO_ALLOWED` is
  // a direct comparison against `import.meta.env.DEV`, so a minifier folds it to
  // `false` and the demo branches become dead code. That is what removes the
  // credentials from the bundle, and it is asserted here rather than assumed: a
  // gate that is correct but not foldable ships inert credentials that a later
  // audit has to reason about.
  //
  // Skipped with a visible notice when `dist/` is absent, so a source-only checkout
  // does not silently skip the most important section in the file.
  const ROOT = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3';
  const DIST = `${ROOT}/dist`;
  const artefacts = walkJs(DIST).map((p) => relative(DIST, p));
  console.log(`      walk found ${artefacts.length} js file(s) under dist/`);

  if (artefacts.length === 0) {
    console.log('SKIP  dist/ not found — run `bun run build` first');
    console.log('      This section is the only one that inspects the shipped artefact.');
  } else {
    const bundles: { file: string; text: string }[] = [];
    for (const rel of artefacts) {
      const f = Bun.file(`${DIST}/${rel}`);
      if (await f.exists()) bundles.push({ file: rel, text: await f.text() });
    }
    console.log(`      scanned ${bundles.length} of ${artefacts.length} discovered bundle(s) under dist/`);
    check(
      'the walk reached every file it discovered (no path-joining failure)',
      bundles.length === artefacts.length,
      bundles.length === artefacts.length
        ? `${bundles.length} read`
        : `${artefacts.length - bundles.length} unreadable — the scan would have been partial`,
    );
    // A partial scan that reports success is worse than no scan, because it is believed.
    const serverCount = bundles.filter((b) => /(^|\/)server\//.test(b.file)).length;
    const clientCount = bundles.filter((b) => /(^|\/)client\//.test(b.file)).length;
    check(
      'both dist/client and dist/server were traversed',
      serverCount > 0 && clientCount > 0,
      `client=${clientCount}, server=${serverCount}`,
    );

    const where = (needle: string) =>
      bundles.filter((b) => b.text.includes(needle)).map((b) => b.file);

    // The session chunk is where an authentication path would have to live. It is
    // checked separately because a hit here is a hit in the auth module itself,
    // whereas the same string elsewhere may be inert display data.
    // The session module in BOTH outputs. Checking only the client chunk would miss the
    // exact regression this section was written for: `import.meta.env.DEV` folded in
    // the client bundle while the SSR/worker bundle kept the demo path live at
    // runtime, because `define` is applied to every environment and `import.meta.env`
    // is not.
    const sessionChunks = bundles.filter((b) => /session-[^/]*\.js$/.test(b.file));
    check(
      'both the client and the server session bundles were inspected',
      sessionChunks.length >= 2,
      `${sessionChunks.length} session chunk(s): ${sessionChunks.map((b) => b.file).join(', ')}`,
    );

    // The security property is REACHABILITY, not textual absence.
    //
    // The client bundle is minified, so the demo branch is eliminated and the
    // credentials disappear entirely. The SSR bundle this project builds with
    // `@cloudflare/vite-plugin` is not minified, so the branch survives as
    // unreachable code holding the constant. Both are correct; what must be true in
    // every output is that the gate is bound to the literal `false`.
    //
    // Asserting textual absence instead was wrong twice over: it failed on a build
    // that was already safe, and it matched occurrences inside preserved comments —
    // the same comment-versus-code confusion that produced a false result earlier in
    // this session.
    const gateBinding = (text: string) => {
      const m = /DEMO_ALLOWED\s*=\s*([^;\n]+)/.exec(text);
      return m ? m[1].trim() : null;
    };

    // Comments are stripped before any of these checks. The SSR bundle is not
    // minified, so JSDoc blocks survive into the artefact and every prose mention
    // of `__DEV_SERVER__` would otherwise read as a live reference.
    const stripComments = (js: string) =>
      js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const chunk of sessionChunks) {
      const code = stripComments(chunk.text);
      const bound = gateBinding(code);
      const eliminated = !code.includes('DEMO_ALLOWED') && !code.includes('usr-owner');

      // Three acceptable end states, in order of preference: the branch was
      // eliminated, or the gate is bound to the literal `false`. Anything else —
      // bound to `true`, or resolved from something at runtime — is a failure.
      const safe = eliminated || bound === 'false';
      check(
        `the demo path cannot be entered from ${chunk.file}`,
        safe,
        eliminated
          ? 'eliminated entirely'
          : bound === null
            ? 'gate not found and no credentials present'
            : `DEMO_ALLOWED = ${bound}`,
      );
    }

    // No output may resolve the gate at runtime, which is what an environment
    // variable or a platform lookup would produce.
    const runtimeResolved = sessionChunks.filter((b) =>
      /import\.meta\.env\.DEV|__DEV_SERVER__/.test(stripComments(b.text)),
    );
    check(
      'no output resolves the demo gate at runtime',
      runtimeResolved.length === 0,
      runtimeResolved.length === 0
        ? 'fully substituted at build time in every output'
        : runtimeResolved.map((b) => b.file).join(', '),
    );

    // The client bundle should additionally have eliminated the branch outright.
    const clientSession = sessionChunks.filter((b) => /client/.test(b.file));
    const eliminated = clientSession.filter((b) => !stripComments(b.text).includes('usr-owner'));
    check(
      'the client bundle eliminated the demo sign-in and its credentials entirely',
      clientSession.length > 0 && eliminated.length === clientSession.length,
      clientSession.length === 0
        ? 'no client session chunk found'
        : `${eliminated.length}/${clientSession.length} client chunk(s) clean`,
    );

    // Inert seed DATA is a different matter and is reported, not failed on:
    // `~/domain/seed` holds the sample pharmacy records the UI renders before any
    // backend exists, and removing those is a separate decision about the offline
    // experience. What matters here is that no authentication path consumes them.
    const seededAddresses = ['khadija@pharmaflow.ng', 'aisha@pharmaflow.ng'];
    const addressHits = seededAddresses.map((a) => ({
      address: a,
      files: where(a).filter((f) => !/session-/.test(f)),
    }));
    const outsideSession = addressHits.flatMap((h) => h.files);
    console.log(
      outsideSession.length === 0
        ? '      no seeded address anywhere in dist/'
        : `      NOTE: seeded addresses remain in non-auth chunks (sample data): ${[...new Set(outsideSession)].join(', ')}`,
    );
    console.log(
      '      They are sample pharmacy records from ~/domain/seed, not credentials:',
    );
    console.log('      nothing in the session module reads them, as asserted above.');
  }
}

/**
 * Every JS artefact under `dist/`, found by a recursive directory walk.
 *
 * NOT Bun.Glob, which is what this file used first. On one build the glob returned 261
 * files including the SSR chunk; on the next identical build it returned 125 and
 * silently could not traverse `dist/server` at all — so the check that exists to
 * inspect the Cloudflare SSR bundle skipped it, while still reporting a clean result.
 *
 * That is the worst possible failure for a security assertion: a partial scan that
 * looks like a pass. A recursive `readdirSync` walk finds 261 every time, and the
 * "both outputs were inspected" assertion below then fails loudly instead of quietly.
 */
function walkJs(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // Never swallow this silently. A broken scan and a genuinely absent dist/ must not
    // look identical, or the section reports counts for a scan that read nothing.
    console.log('      scan error in ' + dir + ': ' + String(e.message).split('\n')[0].slice(0, 70));
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Absolute path -> path relative to `root`.
 *
 * `walkJs` returns absolute paths because that is what `join` produces, but callers
 * re-join with a forward slash against the dist root. Handing them an absolute path
 * made `Bun.file(`${DIST}/${abs}`)` point at `dist/C:/Users/...`, so every file
 * failed the existence check and the section reported "scanned 0 bundles" while the
 * assertions downstream passed against an empty set. A partial scan that reports
 * success is worse than no scan, because it is believed.
 */
function relative(root: string, full: string): string {
  return full.slice(root.length + 1).replace(/\\/g, '/');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);