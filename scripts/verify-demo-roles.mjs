/**
 * Demo role and dashboard routing checks.
 *
 * These are source-level assertions, deliberately: the bugs this file prevents
 * were wiring bugs between modules (a branch fixture overriding the session role,
 * a role switch that did not navigate, a login redirect that skipped the
 * dashboard). A unit test of any one function would have passed while the app
 * still showed the wrong screen.
 *
 * No database and no browser are needed. The companion browser check exercises
 * the same paths against the demo build.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${name}${detail ? `\n      ${detail}` : ''}`);
}

const session = read('src/lib/session.ts');
const store = read('src/store/pharmacy.ts');
const branchContext = read('src/lib/supabase/branch-context.ts');
const dashboard = read('src/routes/_app/dashboard.tsx');
const sidebar = read('src/components/app-sidebar.tsx');
const login = read('src/routes/index.tsx');
const demo = read('src/routes/demo.tsx');
const investorDemo = read('src/routes/investor-demo.tsx');
const appLayout = read('src/routes/_app.tsx');
const ownerGate = read('src/hooks/use-is-owner.ts');
const nav = read('src/lib/nav.ts');
const pos = read('src/routes/_app/pos.tsx');

check(
  'a demo role switch persists the role used on reload',
  /export function switchRole[\s\S]{0,900}localStorage\.setItem\(DEMO_ROLE_KEY, role\)/.test(session),
  'switchRole must write DEMO_ROLE_KEY, not only the profile cache',
);

check(
  'demo branch state takes its role from the session',
  /function demoRole\(\)[\s\S]{0,220}peekSession\(\)\.user\?\.role/.test(branchContext),
  'the seeded branch must not hardcode owner',
);

check(
  'storage hydration cannot overwrite the session actor',
  /currentUser:\s*this\.state\.currentUser/.test(store),
  'a stale persisted currentUser must not disagree with the role key after boot',
);

check(
  'the store actor updates when the server confirms a different role',
  /current\.role === user\.role/.test(store) &&
    /current\.canApprovePricing === user\.canApprovePricing/.test(store),
  'the provisional cached assistant role must not survive the same user id being confirmed as owner',
);

check(
  'the owner gate re-asks after the session and branch resolve',
  /session\.status !== 'authenticated'/.test(ownerGate) &&
    /branch\.status === 'idle'/.test(ownerGate) &&
    /branch\.currentBranchId/.test(ownerGate) &&
    /branch\.source === 'cache'/.test(ownerGate),
  'a live owner must not be left with the anonymous mount-time answer',
);

check(
  'roleForBranch resolves the demo session role',
  /export function roleForBranch[\s\S]{0,420}if \(isDemoMode\(\)\) return demoRole\(\)/.test(branchContext),
  'the sidebar and shell must see a role switch on the next render',
);

check(
  'the dashboard mounts a separate Assistant view',
  dashboard.includes("import { AssistantDashboard } from '~/components/app/assistant-dashboard'") &&
    /return role === 'owner' \? <Dashboard \/> : <AssistantDashboard \/>/.test(dashboard),
  'an Assistant must not land on the owner overview',
);

check(
  'switching role navigates to the role dashboard',
  /switchRole\(next\);[\s\S]{0,500}navigate\(\{ to: '\/dashboard' \}\)/.test(sidebar),
  'the old screen stays mounted without an explicit navigation',
);

check(
  'authenticated login redirects both roles to /dashboard',
  /if \(status === 'authenticated'\) \{[\s\S]{0,360}<Navigate to="\/dashboard" \/>/.test(login) &&
    !login.includes("user?.role === 'assistant' ? '/pos' : '/dashboard'"),
  'the old assistant redirect skipped the dashboard',
);

check(
  'demo account picker sends both staff roles to /dashboard',
  /enterDemoSession\(account\.role\);[\s\S]{0,380}navigate\(\{ to: '\/dashboard' \}\)/.test(login),
  'the assistant demo account must not be sent straight to /pos',
);

check(
  'the live sign-in form cannot leak a password before hydration',
  login.includes('ready={mounted}') &&
    login.includes('method="post"') &&
    login.includes('disabled={!ready}'),
  'the native fallback must be POST-only and disabled until React is ready',
);

check(
  'the demo POS exposes explicit tablet, card and box choices',
  /isDemoMode\(\)\s*&&\s*medicine\.units\.length > 1/.test(pos) &&
    /aria-pressed=\{selected\}/.test(pos) &&
    /chooseUnit\(medicine, option\.key\)/.test(pos) &&
    /value=\{unit\?\.sellingPrice \?\? medicine\.pricePerBaseUnit\}/.test(pos),
  'a touch-screen demo must not depend on the hidden `u` shortcut, and the price must follow the chosen unit',
);

check(
  'both demo hubs open the Assistant dashboard',
  demo.includes("enter('assistant', '/dashboard')") &&
    investorDemo.includes("enter('assistant', '/dashboard')"),
  'the investor and public demo entry points must agree',
);

check(
  'the app layout rejects owner-only URLs for the signed-in role',
  appLayout.includes('findNavItem(location.pathname)') &&
    /item\?\.roles && !item\.roles\.includes\(role\)/.test(appLayout) &&
    /throw redirect\(\{ to: '\/dashboard' \}\)/.test(appLayout),
  'direct URL access must be checked, not only the sidebar',
);

check(
  'the layout does not reject a route from a provisional cached role',
  /const confirmed = status === 'authenticated' && !offline/.test(appLayout) &&
    /confirmed && requestedItem\?\.roles/.test(appLayout),
  'an owner opening /staff on a live reload must not be redirected before adoptSession finishes',
);

check(
  'the layout redirects a confirmed restricted route after the session resolves',
  /if \(restricted\) \{[\s\S]{0,80}<Navigate to="\/dashboard" replace \/>/.test(appLayout),
  'beforeLoad runs before startSession, so the post-resolution guard must also send the Assistant away',
);

for (const [label, path] of [
  ['Pricing', "/pricing'"],
  ['Stock Value', "/stock-value'"],
  ['Reports', "/reports'"],
  ['Staff & Audit', "/staff'"],
  ['Suppliers', "/suppliers'"],
  ['Credit Accounts', "/credit-accounts'"],
]) {
  const start = nav.indexOf(path);
  const snippet = start >= 0 ? nav.slice(Math.max(0, start - 260), start + 160) : '';
  check(
    `${label} is marked owner-only in navigation`,
    snippet.includes("roles: ['owner']"),
    'a hidden financial/staff screen must also be filtered from the Assistant nav',
  );
}

check(
  'the Assistant dashboard has no cost, margin or valuation query',
  !/stockValuation|grossProfitToday|valueAtCost|todayMargin|est(?:imated)?Cost/i.test(
    read('src/components/app/assistant-dashboard.tsx'),
  ),
  'the counter dashboard must not mount owner-only figures',
);

console.log(`\nDemo roles: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
