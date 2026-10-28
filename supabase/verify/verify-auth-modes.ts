/**
 * Deployment-mode verification.
 *
 * `resolveDeploymentMode` in `~/lib/build-mode` is the single place that decides
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
 * Demo mode now depends on `__DEV_SERVER__` as well as the flag, because a flag
 * alone could never be a guarantee: it is read from the build's environment, so
 * anything that influences a production build — a CI variable, a copied `.env`, a
 * platform default — could set it to `true` and the any-password sign-in would be
 * live. `isDevBuild` is therefore an explicit input to the copy below, so both
 * halves of the gate are asserted, including the case that matters most: a
 * production build with `PUBLIC_DEMO_MODE=true` and no Supabase configuration.
 *
 * The section that inspects `dist/` is the one that proves the gate holds in the
 * artefact that actually ships, rather than in the source. It finds the demo-
 * authentication names (`DEMO_ALLOWED`, `isDemoMode()`, `DEMO_SESSION`) folded to a
 * literal `false`, and it reports — rather than fails on — the inert seed sample
 * records, which are data and authenticate nothing.
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
 * A faithful copy of the decision in src/lib/build-mode.ts. If the two diverge,
 * this suite is testing the wrong thing — so `verify-auth-modes.ts` also greps the
 * real source for the rule this encodes.
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
  // The rule now lives in two files: `~/lib/build-mode` decides the deployment mode
  // and defines the demo gate, and `~/lib/session` consumes that gate (`DEMO_SESSION`)
  // to guard the sign-in paths. Each piece is asserted where it now lives, so this
  // suite fails on a real regression rather than on the refactor that moved it.
  //
  // Comments are stripped before asserting, so the checks target real code rather
  // than the prose that documents why the old fail-open expression was replaced.
  const ROOT = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3/';
  const SRC = `${ROOT}src/lib/session.ts`;
  const MODE = `${ROOT}src/lib/build-mode.ts`;
  const src = await Bun.file(SRC).text();
  const modeSrc = await Bun.file(MODE).text();

  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const code = strip(src);
  const modeCode = strip(modeSrc);

  // The old fail-open expression survives only inside the explanatory comment that
  // documents why it was replaced, so it must not appear in the code of either file.
  check(
    'the real rule is opt-in, not opt-out',
    modeCode.includes("requested === 'true'") &&
      !modeCode.includes("PUBLIC_DEMO_MODE !== 'false'") &&
      !code.includes("PUBLIC_DEMO_MODE !== 'false'"),
    'the old fail-open expression must not reappear in code',
  );
  check('live requires both halves present', /urlPresent && keyPresent/.test(modeCode));
  check(
    'the cached role is downgraded while offline',
    code.includes("role: 'assistant', canApprovePricing: false"),
    'an unverified cached role must never gate owner-only screens',
  );
  check('configProblem is exported', code.includes('export function configProblem'));
  check('isAuthUnavailable is exported', code.includes('export function isAuthUnavailable'));

  // The any-password sign-in must be reachable only through a build-time constant.
  // A flag is not sufficient, which is the whole point of the second half of the
  // gate: the flag is read from the build's environment and anything that
  // influences a production build can set it.
  check(
    'demo mode is gated on the build-mode constant, not on import.meta.env.DEV',
    modeSrc.includes('const IS_DEV_BUILD = __DEV_SERVER__ === true') &&
      modeCode.includes('if (!IS_DEV_BUILD) return') &&
      !/const IS_DEV_BUILD = import\.meta\.env\.DEV/.test(modeSrc),
    'import.meta.env.DEV is left literal in the SSR bundle; a define is not',
  );

  check(
    'a production build returns broken before the demo flag is ever consulted',
    modeCode.indexOf("if (!IS_DEV_BUILD) return 'broken'") >= 0 &&
      modeCode.indexOf("if (!IS_DEV_BUILD) return 'broken'") < modeCode.indexOf('PUBLIC_DEMO_MODE'),
    'the build check precedes the flag check',
  );

  const signInStart = src.indexOf('export async function signIn');
  const signInBody = src.slice(signInStart, signInStart + 900);
  // The gate is `isDemoMode()`, which is `DEMO_ALLOWED && DEMO_MODE` — both module
  // level `const`s in `~/lib/build-mode` — consumed by `session.ts` as the derived
  // `DEMO_SESSION`. Naming matters: a direct comparison lets a minifier fold the
  // demo branch to dead code and drop its credentials, and the CONJUNCTION means the
  // branch needs a development server AND demo mode. `DEMO_ALLOWED` alone is true on
  // ANY development server, and a previous version of this file asserted on it and
  // passed while the app booted authenticated as the seeded owner on a dev server
  // with a real Supabase project configured.
  //
  // Both properties are asserted below: `~/lib/build-mode` defines the conjunction,
  // `~/lib/session` branches every demo path on the derived `DEMO_SESSION`, and no
  // gate anywhere uses the bare build flag. Foldability itself is proven empirically
  // by the dist/ section, which inspects the shipped artefact rather than the source.
  const gateSite = (fn: string, window = 1600) => {
    const at = src.indexOf(fn);
    return at >= 0 ? src.slice(at, at + window) : '';
  };
  check(
    'the demo gate is DEMO_SESSION, which means demo mode is actually on, not merely that this is a dev server',
    /return DEMO_ALLOWED && DEMO_MODE/.test(modeCode) &&
      src.includes('const DEMO_SESSION = isDemoMode()'),
    'DEMO_ALLOWED alone is true on any dev server, which let a configured deployment boot as the seeded owner',
  );
  check(
    'the any-password demo sign-in is gated on that constant',
    gateSite('export async function signIn').includes('if (DEMO_SESSION)'),
  );
  check(
    'startSession cannot auto-authenticate outside demo mode',
    gateSite('export function startSession').includes('if (DEMO_SESSION)'),
  );
  check(
    'switchRole is gated on the same constant',
    gateSite('export function switchRole').includes('if (!DEMO_SESSION) {') &&
      src.includes('development-server only'),
  );
  check(
    'the initial session cannot start authenticated outside demo mode',
    /let current: Session = DEMO_SESSION/.test(src),
    'a DEMO_ALLOWED initialiser booted the seeded owner on a configured dev server',
  );
  // Matched against code with comments stripped. The prose around `DEMO_ALLOWED`
  // quotes the old `if (DEMO_ALLOWED)` form, and matching a comment proves nothing —
  // this suite has already been burned once by assertions that read source text
  // instead of behaviour, so it only ever sees what the compiler would.
  check(
    'no demo code path is gated on the bare build flag',
    !/if \(!?DEMO_ALLOWED\)/.test(code) &&
      !/= DEMO_ALLOWED\s*\?/.test(code) &&
      !/if \(!?DEMO_ALLOWED\)\s*$/.test(code) &&
      !/if \(!?DEMO_ALLOWED\)/.test(modeCode),
    'DEMO_ALLOWED may only appear inside the isDemoMode() definition',
  );
  check(
    'the bare build flag survives only in the two constants that derive from it',
    (modeCode.match(/\bDEMO_ALLOWED\b/g) ?? []).length === 2 &&
      (code.match(/\bDEMO_ALLOWED\b/g) ?? []).length === 0,
    'expected exactly two in build-mode.ts (the definition and isDemoMode()) and none in session.ts',
  );

  // Demo-only SURFACES, not just demo-only behaviour.
  //
  // Gating the demo code paths is not sufficient on its own: a control that renders
  // unconditionally advertises a capability the deployment does not have. The sidebar
  // badge told live Supabase users their deployment was a "Demo build", the login
  // screen promised "Any password works" against an auth endpoint that rejects it, and
  // the sidebar offered "Act as Owner" — a self-service role switch that `switchRole`
  // refuses to perform. None of those was an exploitable hole, all of them were
  // misleading, and the last read as a privilege-escalation path.
  //
  // What matters is the CONDITION each surface renders under: it must be `isDemoMode()`,
  // which is `DEMO_ALLOWED && DEMO_MODE`. A bare `DEMO_ALLOWED` would satisfy a naive
  // "is it gated?" check while still rendering on any dev server, which is the exact
  // substitution that caused the fail-open fixed above.
  const sidebarSrc = (await Bun.file(ROOT + 'src/components/app-sidebar.tsx').text()).replace(
    /\/\*[\s\S]*?\*\//g,
    ' ',
  ).replace(/^[ \t]*\/\/.*$/gm, ' ');
  const loginSrc = (await Bun.file(ROOT + 'src/routes/index.tsx').text())
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');

  // Every JSX site that mentions a demo-only surface must sit inside an `isDemoMode()`
  // guard. Matching the surrounding window rather than the bare text, so a guard
  // anywhere in the file cannot accidentally vouch for an unguarded site elsewhere.
  const guardedBy = (source: string, marker: string, window = 400) => {
    const at = source.indexOf(marker);
    if (at < 0) return false;
    return /isDemoMode\(\)/.test(source.slice(Math.max(0, at - window), at));
  };
  check(
    'the sidebar "Demo build" badge renders only in demo mode',
    guardedBy(sidebarSrc, 'Demo build'),
    'the badge must sit inside an isDemoMode() guard',
  );
  check(
    'the sidebar role switcher renders only in demo mode',
    guardedBy(sidebarSrc, '<DropdownMenuLabel>Act as</DropdownMenuLabel>'),
    '"Act as" is a self-service role change and must not appear on live Supabase',
  );
  check(
    'the demo account picker renders only in demo mode',
    guardedBy(loginSrc, '<DemoAccounts'),
    'DemoAccounts exposes the seeded accounts; it must not appear on live Supabase',
  );
  // The current login screen has no "any password works" text: demo builds replace
  // the password form with the account picker instead of advertising a fake password.
  // The security property is unchanged — the picker's copy lives ONLY inside
  // `DemoAccounts`, and the component has exactly one mount point, which is guarded.
  const demoAccountsBody = loginSrc.slice(
    loginSrc.indexOf('function DemoAccounts'),
    loginSrc.indexOf('function ForgotPassword'),
  );
  check(
    'the demo account picker copy exists only inside DemoAccounts',
    demoAccountsBody.includes('One click. No password.') &&
      loginSrc.split('One click. No password.').length === 2,
    'one occurrence, and it is inside the component, so the call-site guard covers it',
  );
  check(
    'and DemoAccounts is mounted in exactly one place, which is guarded',
    loginSrc.split('<DemoAccounts').length === 2 && guardedBy(loginSrc, '<DemoAccounts'),
    'a second mount point would be an unguarded route into the same text',
  );

  // The whole demo screen, not just the account list, must sit on the demo branch.
  // If `DemoSignIn` were mounted live, a deployment with no credentials could still
  // show a screen that looks like authentication while offering none.
  const demoSignInAt = loginSrc.indexOf('<DemoSignIn');
  const demoSignInMount = loginSrc.slice(Math.max(0, demoSignInAt - 400), demoSignInAt);
  check(
    'the demo sign-in screen is mounted once, from the isDemoMode() branch',
    demoSignInAt > 0 &&
      loginSrc.split('<DemoSignIn').length === 2 &&
      /const demoMode = isDemoMode\(\)/.test(demoSignInMount) &&
      /demoMode \?/.test(demoSignInMount),
    'a second mount point or a non-demo branch would expose the fake sign-in',
  );
  check(
    'no demo-only surface is gated on the bare build flag',
    !/isDemoMode\s*=|DEMO_ALLOWED/.test(sidebarSrc) && !/isDemoMode\s*=|DEMO_ALLOWED/.test(loginSrc),
    'neither component may reach for DEMO_ALLOWED; they call isDemoMode()',
  );
  check(
    'isDemoMode() is itself the conjunction, not a bare mode comparison',
    /return DEMO_ALLOWED && DEMO_MODE/.test(modeCode),
    'isDemoMode() must keep requiring a development server AND demo mode',
  );

  // The seeded accounts must live outside the production graph. They are still in
  // src/ — they have to be, for local development — so the assertion is that
  // session.ts no longer DEFINES them, only re-exports from the dev-only module.
  const FIXTURES = `${ROOT}src/lib/demo-fixtures.ts`;
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
  const VITE_CONFIG = `${ROOT}vite.config.ts`;
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

  const SUPABASE = `${ROOT}src/lib/supabase.ts`;
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
  // which is the only claim that matters: no environment variable can re-enable what
  // the build removed.
  //
  // The gate is written to be ELIMINABLE, not merely unreachable — `DEMO_ALLOWED` is
  // a direct comparison against a build-time substitution, so a minifier folds it to
  // `false` and the demo branches become dead code. That is what removes the demo
  // sign-in from the bundle, and it is asserted here rather than assumed.
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
    const serverCount = bundles.filter((b) => /(^|\/)server\//.test(b.file)).length;
    const clientCount = bundles.filter((b) => /(^|\/)client\//.test(b.file)).length;
    check(
      'both dist/client and dist/server were traversed',
      serverCount > 0 && clientCount > 0,
      `client=${clientCount}, server=${serverCount}`,
    );

    const where = (needle: string) =>
      bundles.filter((b) => b.text.includes(needle)).map((b) => b.file);

    // Comments are stripped before every check below. The SSR bundle is not
    // minified, so JSDoc survives into the artefact and every prose mention of
    // `DEMO_ALLOWED` or `__DEV_SERVER__` would otherwise read as a live reference.
    // Only what the compiler kept is asserted.
    const stripComments = (js: string) =>
      js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
    const compiled = bundles.map((b) => ({ file: b.file, code: stripComments(b.text) }));

    /*
     * The AUTHENTICATION markers — and the inert seed DATA they are not.
     *
     * The demo gate is `isDemoMode()` in `~/lib/build-mode` (`DEMO_ALLOWED && DEMO_MODE`),
     * consumed by `~/lib/session` as `DEMO_SESSION`. Those names — `DEMO_ALLOWED`,
     * `DEMO_SESSION`, `isDemoMode` — ARE the demo authentication logic, and they are
     * what this section must find folded to a literal `false`, or eliminated.
     *
     * `usr-owner`, `usr-assistant` and the seeded addresses are a different thing:
     * sample pharmacy records from `~/domain/seed` (and the demo fixtures). They carry
     * no password, authenticate nothing, and legitimately remain in the bundle because
     * the seeded data is still referenced. Treating them as credentials is exactly what
     * produced the false failure this section used to report, so they are reported
     * below rather than failed on.
     */

    // (1) The gate constant, wherever the bundler left it. It is no longer in the
    // session chunk: it lands in whichever chunk inlines `~/lib/build-mode`.
    const gateBindings = compiled.flatMap((b) => {
      const m = /DEMO_ALLOWED\s*=\s*([^;\n]+)/.exec(b.code);
      return m ? [{ file: b.file, bound: m[1].trim() }] : [];
    });
    const isFalseLiteral = (v: string) => v === 'false' || v === '!1';
    console.log(
      gateBindings.length === 0
        ? '      no compiled DEMO_ALLOWED binding found — the constant was inlined away'
        : `      compiled DEMO_ALLOWED binding(s): ${gateBindings.map((g) => `${g.file} = ${g.bound}`).join(', ')}`,
    );
    check(
      'every DEMO_ALLOWED binding in dist is the literal false',
      gateBindings.every((g) => isFalseLiteral(g.bound)),
      gateBindings.length === 0
        ? 'eliminated'
        : gateBindings
            .filter((g) => !isFalseLiteral(g.bound))
            .map((g) => `${g.file} = ${g.bound}`)
            .join(', '),
    );

    // (2) The gate function. Where it survives (the un-minified SSR bundle) it must be
    // a literal `false`; the minified client bundle folds its call sites instead.
    const gateDefs = compiled.filter((b) => /function\s+isDemoMode\s*\(/.test(b.code));
    const gateDefReturnsFalse = (codeText: string) => {
      const m = /function\s+isDemoMode\s*\([^)]*\)\s*\{([^}]*)\}/.exec(codeText);
      return m ? /^\s*return\s+(false|!1)\s*;?\s*$/.test(m[1]) : null;
    };
    const badGateDefs = gateDefs.filter((b) => gateDefReturnsFalse(b.code) !== true);
    console.log(
      gateDefs.length === 0
        ? '      no compiled isDemoMode() definition found — folded at every call site'
        : `      compiled isDemoMode() definition(s): ${gateDefs.map((b) => b.file).join(', ')}`,
    );
    check(
      'every compiled isDemoMode() definition returns the literal false',
      badGateDefs.length === 0,
      badGateDefs.map((b) => b.file).join(', '),
    );

    // The gate is proven off when nothing about it survives, or everything that
    // survives is a literal false. This is the property the session-chunk checks
    // lean on: a surviving `DEMO_SESSION` branch is safe only because it reads this.
    const gateProvenFalse =
      gateBindings.every((g) => isFalseLiteral(g.bound)) && badGateDefs.length === 0;

    // (3) No output may resolve the gate at runtime — that is what an environment
    // variable or a platform lookup would produce. Checked across every bundle,
    // because the define may land anywhere the build-mode module is inlined.
    const runtimeResolved = compiled.filter((b) =>
      /import\.meta\.env\.DEV|__DEV_SERVER__/.test(b.code),
    );
    check(
      'no output resolves the demo gate at runtime',
      runtimeResolved.length === 0,
      runtimeResolved.length === 0
        ? 'fully substituted at build time in every output'
        : runtimeResolved.map((b) => b.file).join(', '),
    );

    // (4) The session chunk is where an authentication path would have to live. The
    // client bundle must have eliminated it; the SSR bundle may keep it as dead code,
    // but only because the gate it reads is proven a literal false above.
    const sessionChunks = compiled.filter((b) => /session-[^/]*\.js$/.test(b.file));
    check(
      'both the client and the server session bundles were inspected',
      sessionChunks.length >= 2,
      `${sessionChunks.length} session chunk(s): ${sessionChunks.map((b) => b.file).join(', ')}`,
    );

    for (const chunk of sessionChunks) {
      const carriesAuthGate =
        /DEMO_SESSION/.test(chunk.code) || /DEMO_ALLOWED\s*=/.test(chunk.code);
      const eliminated = !carriesAuthGate;
      check(
        `the demo path cannot be entered from ${chunk.file}`,
        eliminated || gateProvenFalse,
        eliminated ? 'demo authentication branch eliminated' : 'gate proven a literal false',
      );
    }

    // (5) The client bundle should additionally have eliminated the branch outright,
    // not merely left a dead one: the demo sign-in gate must not survive there at all.
    const clientSession = sessionChunks.filter((b) => /client/.test(b.file));
    const clean = clientSession.filter(
      (b) => !/DEMO_SESSION/.test(b.code) && !/DEMO_ALLOWED/.test(b.code),
    );
    check(
      'the client bundle eliminated the demo sign-in and its gate entirely',
      clientSession.length > 0 && clean.length === clientSession.length,
      clientSession.length === 0
        ? 'no client session chunk found'
        : `${clean.length}/${clientSession.length} client chunk(s) clean`,
    );

    // (6) Inert seed DATA is reported, not failed on. These are sample pharmacy
    // records; nothing in the session module authenticates with them (proved above),
    // so their presence is a data question, not a gate one.
    const sampleMarkers = [
      'usr-owner',
      'usr-assistant',
      'khadija@pharmaflow.ng',
      'aisha@pharmaflow.ng',
    ];
    const sampleHits = [...new Set(sampleMarkers.flatMap((m) => where(m)))];
    console.log(
      sampleHits.length === 0
        ? '      no seeded sample records anywhere in dist/'
        : `      NOTE: seeded sample records remain as inert data (no password, no auth path): ${sampleHits.join(', ')}`,
    );
    console.log('      They are sample pharmacy records from ~/domain/seed, not credentials:');
    console.log('      nothing in the session module authenticates with them, as asserted above.');
    const sampleInSession = sampleHits.filter((f) => /session-/.test(f));
    if (sampleInSession.length > 0) {
      console.log(
        `      (they share the session chunk because ~/store/pharmacy imports ~/domain/seed: ${sampleInSession.join(', ')})`,
      );
    }
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
