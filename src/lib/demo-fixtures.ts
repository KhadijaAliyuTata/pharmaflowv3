/**
 * Seeded demo accounts. Development only.
 *
 * ## Why this is a separate module
 *
 * These are not credentials. They are two invented pharmacy staff accounts whose
 * point is to make the interface explorable without a backend, and they exist so
 * that a local developer can see the owner screens and the counter screens.
 *
 * They are separated from `~/lib/session` for one reason: so that a production
 * build does not carry them. `session.ts` gates demo mode on
 * `import.meta.env.DEV`, which Vite replaces with the literal `false` in a
 * production build, so the demo branch is constant-folded away and this module's
 * exports become unreferenced. A module of pure `const` exports with no side
 * effects is then tree-shaken out of the bundle entirely, which is verified by
 * grepping the built output for the addresses below.
 *
 * ## Why they are not credentials, in security terms
 *
 * They cannot authenticate against anything. There is no Supabase project here,
 * no password is checked against a stored hash, and the accounts grant access to
 * seeded in-memory data and nothing else. The demo sign-in path is still removed
 * from production code, because a bypass that exists only because nothing is
 * behind it is exactly the kind of bypass that later finds something behind it.
 *
 * Anything that reaches this file in a shipped bundle should be treated as a
 * defect. `verify-auth-modes.ts` asserts the gate, and asserts that these
 * addresses appear in `src/` but must not appear in `dist/`.
 */

import type { User } from '~/domain/types';

/**
 * The two seeded accounts. `DEMO_USERS[0]` is the account a demo build starts
 * signed in as, which is why it is the owner.
 */
export const DEMO_USERS: User[] = [
  {
    id: 'usr-owner',
    name: 'Khadija Bello',
    email: 'khadija@pharmaflow.ng',
    role: 'owner',
    phone: '+2348030000001',
    licenseNumber: 'PCN/NG/22341',
    canApprovePricing: true,
  },
  {
    id: 'usr-assistant',
    name: 'Aisha Yusuf',
    email: 'aisha@pharmaflow.ng',
    role: 'assistant',
    phone: '+2348030000002',
    canApprovePricing: false,
  },
];

export interface DemoAccount {
  name: string;
  email: string;
  role: 'owner' | 'assistant';
  blurb: string;
}

/** Seeded staff, for the one-click fill on the login screen. */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { name: 'Khadija Bello', email: 'khadija@pharmaflow.ng', role: 'owner', blurb: 'Pricing, margins, credit, staff' },
  { name: 'Aisha Yusuf', email: 'aisha@pharmaflow.ng', role: 'assistant', blurb: 'Counter only' },
];