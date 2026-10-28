import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { enterDemoSession, exitDemoSession, isDemoMode, useSession } from '~/lib/session';

/**
 * The investor demo hub: `/demo`.
 *
 * Public route, no authentication gate, and no session claim of its own: the
 * four buttons either enter the SEEDED demo experiences (owner and attendant),
 * or open the self-contained supplier and customer prototypes. None of them
 * reaches real tenant data:
 *
 *   * Owner / attendant — `enterDemoSession`, development-server-only, which
 *     switches the seeded demo user and reuses the seeded store (isolated
 *     localStorage, never the production database).
 *   * Supplier / customer — open prototypes whose data lives in
 *     `~/lib/demo-ecosystem.ts` and component state. They never import the
 *     store, the session, or Supabase.
 *
 * In any build where demo mode is not possible (production bundle, or a dev
 * server with Supabase configured — "live"), the buttons are disabled with a
 * truthful explanation rather than pretending.
 */
export const Route = createFileRoute('/demo')({
  component: DemoHub,
});

const demoEnabled = isDemoMode();

function DemoHub() {
  const navigate = useNavigate();
  const session = useSession();
  const signedIn = session.status === 'authenticated';

  const enter = (role: 'owner' | 'assistant', to: string) => {
    enterDemoSession(role);
    void navigate({ to });
  };

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <BackToWebsite />

        <div className="mt-4">
          <RoleIndicator />
        </div>

        <header className="mt-6 space-y-3 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-[#2A932C]">
            PharmaFlow V3
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-[#043263] sm:text-4xl">
            Explore the PharmaFlow Demo
          </h1>
          <p className="mx-auto max-w-2xl text-slate-600">
            Explore how pharmacies, staff, suppliers and customers connect through
            PharmaFlow. No username or password required.
          </p>
        </header>

        {demoEnabled ? (
          <p className="mt-6 text-center text-sm text-slate-500">
            Everything below runs on fictional sample data — a demonstration, not a
            live pharmacy account.
          </p>
        ) : (
          <NotDemoMode />
        )}

        <section className="mt-10 grid gap-5 sm:grid-cols-2">
          <DemoCard
            enabled={demoEnabled}
            title="Pharmacy Owner"
            blurb="Overview, stock and expiry watch, sales history, costs of goods and margins, staff activity, credit and receivables - the owner's full oversight."
            features={['Owner dashboard & reports', 'Margins and stock value', 'Staff accountability']}
            onClick={() => enter('owner', '/dashboard')}
            accent="#064276"
          />
          <DemoCard
            enabled={demoEnabled}
            title="Pharmacy Attendant"
            blurb="The counter view: search stock, record a sample sale, receive stock and see only what a counter role is permitted to see - never purchase prices or margins."
            features={['Record a sample sale', 'Receiving and expiry lists', 'Role-restricted information']}
            onClick={() => enter('assistant', '/dashboard')}
            accent="#2A932C"
          />
          <DemoCard
            enabled={demoEnabled}
            title="Supplier"
            blurb="The supplier side - a labelled prototype: profile, fictional catalogue, pharmacy enquiries, preparing a sample quotation, fulfilment states and price comparison."
            features={['Sample quotations', 'Order status (simulated)', 'Price comparison']}
            onClick={() => { void navigate({ to: '/supplier' }); }}
            accent="#4FAE2A"
          />
          <DemoCard
            enabled={demoEnabled}
            title="Customer"
            blurb="The customer side - a labelled prototype: discover medicines and pharmacies, see indicative prices and availability, and place a simulated sample order that reaches nothing real."
            features={['Search & pharmacy chooser', 'Sample order', 'Simulated confirmation']}
            onClick={() => { void navigate({ to: '/customer' }); }}
            accent="#2A932C"
          />
        </section>

        <section className="mt-10 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
          <h2 className="font-semibold text-slate-900">How the pieces connect</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              One pharmacy runs the story: <strong>Endline Pharmacy, Kano</strong> - the
              owner and attendant demos show its internals; the same pharmacy appears
              as the buyer in the supplier prototype&apos;s enquiries.
            </li>
            <li>
              <strong>Grace Adeyemi</strong> is the sample customer whose order the
              customer prototype demonstrates.
            </li>
            <li>
              The suppliers - <strong>MedPlus Distributors</strong> and
              <strong> ABC Pharmacy Supplies</strong> - quote the same medicines the
              pharmacy shelves.
            </li>
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            No live supplier integrations, verified market prices, payments,
            fulfilled orders or real emails exist behind these screens. Cross-role
            interactions are simulated and labelled as such.
          </p>
        </section>

        <div className="mt-10 flex justify-center">
          <BackToWebsite />
        </div>

        {signedIn && demoEnabled ? (
          <div className="mt-8 text-center">
            <button
              type="button"
              onClick={() => exitDemoSession()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
            >
              Exit the demo and return here
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Visible exit from the demo hub back to the public landing page. */
function BackToWebsite() {
  return (
    <Link
      to="/"
      aria-label="Back to the PharmaFlow website"
      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-[#064276] shadow-sm transition hover:border-[#064276] hover:bg-slate-50"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back
    </Link>
  );
}

/** The demo-mode banner shown at the top of the hub (the fixed badge lives in __root). */
function RoleIndicator() {
  return (
    <div className="rounded-xl border border-[#2A932C]/30 bg-[#2A932C]/10 px-4 py-2 text-center text-xs font-semibold uppercase tracking-widest text-[#2A932C]">
      Demo mode - fictional sample data, no live accounts
    </div>
  );
}

function DemoCard(props: {
  enabled: boolean;
  title: string;
  blurb: string;
  features: string[];
  onClick: () => void;
  accent: string;
}) {
  return (
    <button
      type="button"
      disabled={!props.enabled}
      onClick={props.onClick}
      className={`rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition ${
        props.enabled
          ? 'cursor-pointer hover:-translate-y-0.5 hover:border-[#064276] hover:shadow-md'
          : 'cursor-not-allowed opacity-60'
      }`}
    >
      <h3 className="text-lg font-bold" style={{ color: props.accent }}>
        {props.title}
      </h3>
      <p className="mt-2 text-sm text-slate-600">{props.blurb}</p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {props.features.map((feature) => (
          <li
            key={feature}
            className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
          >
            {feature}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm font-semibold" style={{ color: props.accent }}>
        {props.enabled ? `Explore as ${props.title} \u2192` : 'Unavailable in this build'}
      </p>
    </button>
  );
}

/** Truthful no-demo panel. Nothing here can fake a demo in a live build. */
function NotDemoMode() {
  return (
    <div className="mx-auto mt-6 max-w-2xl rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <strong>This build cannot open the demo experiences.</strong> Demo mode exists
      only on a development server started with
      <code className="mx-1 rounded bg-amber-100 px-1">PUBLIC_DEMO_MODE=true</code>
      and no Supabase environment variables, so it always uses fictional data. The
      PharmaFlow team can share the exact demo start command.
    </div>
  );
}
