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
 */

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
): 'live' | 'demo' | 'broken' {
  const urlPresent = typeof url === 'string' && url.trim().length > 0;
  const keyPresent = typeof anonKey === 'string' && anonKey.trim().length > 0;

  if (urlPresent && keyPresent) return 'live';

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
  const mode = resolveDeploymentMode(URL_OK, KEY_OK, undefined);
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
  const mode = resolveDeploymentMode(URL_OK, KEY_OK, 'true');
  check('mode stays live even with PUBLIC_DEMO_MODE=true', mode === 'live', mode);
}

/* ------------------------------------------------------------------------ */

section('a HALF-configured deployment does NOT silently become demo mode');
{
  // This is the exact fail-open the audit found. The anon key is empty, which is
  // an ordinary CI/secret mistake, and it used to fall through to demo mode.
  const urlOnly = resolveDeploymentMode(URL_OK, '', undefined);
  check('url without anon key is broken, not demo', urlOnly === 'broken', urlOnly);
  check(
    'and it names the missing variable specifically',
    configProblem(URL_OK, '') === 'ANON_KEY_MISSING',
    configProblem(URL_OK, '') ?? '',
  );

  const keyOnly = resolveDeploymentMode('', KEY_OK, undefined);
  check('anon key without url is broken, not demo', keyOnly === 'broken', keyOnly);
  check(
    'and it names the missing variable specifically',
    configProblem('', KEY_OK) === 'URL_MISSING',
    configProblem('', KEY_OK) ?? '',
  );

  const whitespace = resolveDeploymentMode('   ', KEY_OK, undefined);
  check('whitespace-only values count as absent', whitespace === 'broken', whitespace);
}

section('demo mode requires an explicit, unambiguous opt-in');
{
  check('flag exactly "true" enables demo', resolveDeploymentMode('', '', 'true') === 'demo');
  check('uppercase TRUE enables demo', resolveDeploymentMode('', '', 'TRUE') === 'demo');
  check('" true " enables demo (trimmed)', resolveDeploymentMode('', '', ' true ') === 'demo');

  // The old rule was `!== 'false'`, so every one of these enabled demo mode.
  for (const flag of [undefined, '', '0', 'no', 'off', 'yes', '1', 'false', 'anything']) {
    const mode = resolveDeploymentMode('', '', flag);
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
  const mode = resolveDeploymentMode(undefined, undefined, undefined);
  check('nothing configured and nothing requested is broken', mode === 'broken', mode);
  check('a problem is reported', configProblem(undefined, undefined) === 'BOTH_MISSING');

  const emptyStrings = resolveDeploymentMode('', '', '');
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

  // The demo sign-in must remain gated behind DEMO_MODE, never reachable from a
  // configured deployment.
  const signInStart = src.indexOf('export async function signIn');
  const signInBody = src.slice(signInStart, signInStart + 600);
  check(
    'the any-password demo sign-in is still gated behind DEMO_MODE',
    signInBody.includes('if (DEMO_MODE)'),
  );

  const SUPABASE = 'C:/Users/LENOVO/OneDrive/Documents/Default Project/pharmaflowv3/src/lib/supabase.ts';
  const supabaseSrc = await Bun.file(SUPABASE).text();
  check(
    'isSupabaseConfigured trims, so whitespace does not count as configured',
    supabaseSrc.includes('url.trim().length > 0') &&
      supabaseSrc.includes('anonKey.trim().length > 0'),
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
