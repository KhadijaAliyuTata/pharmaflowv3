import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarClock,
  ChartLine,
  CheckCircle2,
  ClipboardX,
  Compass,
  EyeOff,
  FlaskConical,
  Menu,
  MonitorSmartphone,
  PackageCheck,
  Plus,
  Radar,
  RotateCcw,
  ScanBarcode,
  SearchX,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Stethoscope,
  Truck,
  UserX,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { BrandLogo } from '~/components/brand-logo';
import { Button } from '~/components/ui/button';

/**
 * The public landing page, at `/`.
 *
 * ## Why it lives here and not on `/demo`
 *
 * `/demo` is the investor hub: four cards that open the seeded owner and
 * attendant experiences and the supplier and customer prototypes. This page is
 * the thing that *precedes* it — the problem, the product, and one clear route
 * into that demo. The two are deliberately different pages.
 *
 * ## Why `/` moved
 *
 * `/` used to be the signed-in dashboard. A public page has to own the root to
 * be a landing page at all, so the dashboard moved to `/dashboard` and the
 * references to the old path were updated with it (`nav.ts`, `login`, `join`,
 * the sidebar, breadcrumb, platform shell and the not-found screens).
 *
 * ## What this page may and may not claim
 *
 * Every figure on this page is invented, and every panel that shows one says
 * so. The owner and attendant experiences are the real application running on
 * seeded data; the supplier and customer experiences are labelled prototypes
 * that reach nothing. There are no live payments, supplier integrations,
 * real-time stock guarantees or fulfilled orders, and no customer counts,
 * testimonials, logos or competitor claims — because none of those are
 * verified.
 */

const DEMO_URL = 'https://pharmaflow-demo.aliyutatak.workers.dev/demo';

const NAV_LINKS = [
  { href: '#problem', label: 'The problem' },
  { href: '#platform', label: 'The solution' },
  { href: '#ecosystem', label: 'Who it connects' },
] as const;

const HIGHLIGHTS = [
  'Pharmacy operations in one connected platform',
  'Better visibility into sales, stock and staff activity',
  'A path to connecting pharmacies with customers online',
] as const;

/* ---------------------------------------------------------- decorations */

type MarkTone = 'navy' | 'green' | 'blue';

interface Mark {
  top: string;
  left: string;
  size: number;
  tone: MarkTone;
  anim: 'pf-float' | 'pf-drift' | 'pf-rise' | 'pf-twinkle';
  delay: string;
  dot?: boolean;
}

const LIGHT_TONE: Record<MarkTone, string> = {
  navy: 'text-navy-700/15',
  green: 'text-green-600/20',
  blue: 'text-navy-600/20',
};

const DARK_TONE: Record<MarkTone, string> = {
  navy: 'text-white/10',
  green: 'text-green-500/20',
  blue: 'text-white/10',
};

const HERO_MARKS: readonly Mark[] = [
  { top: '14%', left: '3%', size: 22, tone: 'green', anim: 'pf-float', delay: '-1s' },
  { top: '72%', left: '6%', size: 14, tone: 'navy', anim: 'pf-rise', delay: '-5s' },
  { top: '20%', left: '46%', size: 9, tone: 'green', anim: 'pf-twinkle', delay: '-2s', dot: true },
  { top: '82%', left: '38%', size: 7, tone: 'blue', anim: 'pf-twinkle', delay: '-6s', dot: true },
  { top: '16%', left: '90%', size: 26, tone: 'navy', anim: 'pf-drift', delay: '-3s' },
  { top: '60%', left: '94%', size: 12, tone: 'green', anim: 'pf-rise', delay: '-9s' },
  { top: '40%', left: '74%', size: 7, tone: 'green', anim: 'pf-twinkle', delay: '-1.5s', dot: true },
  { top: '88%', left: '80%', size: 9, tone: 'navy', anim: 'pf-twinkle', delay: '-4.5s', dot: true },
  { top: '52%', left: '58%', size: 5, tone: 'blue', anim: 'pf-twinkle', delay: '-7s', dot: true },
];

const SOLUTION_MARKS: readonly Mark[] = [
  { top: '10%', left: '4%', size: 20, tone: 'green', anim: 'pf-float', delay: '-2s' },
  { top: '46%', left: '2%', size: 12, tone: 'navy', anim: 'pf-rise', delay: '-7s' },
  { top: '70%', left: '8%', size: 8, tone: 'green', anim: 'pf-twinkle', delay: '-3s', dot: true },
  { top: '18%', left: '94%', size: 24, tone: 'navy', anim: 'pf-drift', delay: '-5s' },
  { top: '58%', left: '96%', size: 10, tone: 'green', anim: 'pf-rise', delay: '-10s' },
  { top: '34%', left: '88%', size: 7, tone: 'blue', anim: 'pf-twinkle', delay: '-1s', dot: true },
  { top: '84%', left: '90%', size: 6, tone: 'green', anim: 'pf-twinkle', delay: '-6s', dot: true },
];

const CTA_MARKS: readonly Mark[] = [
  { top: '18%', left: '6%', size: 18, tone: 'green', anim: 'pf-float', delay: '-3s' },
  { top: '64%', left: '10%', size: 10, tone: 'navy', anim: 'pf-rise', delay: '-8s' },
  { top: '26%', left: '88%', size: 20, tone: 'green', anim: 'pf-drift', delay: '-6s' },
  { top: '72%', left: '84%', size: 8, tone: 'blue', anim: 'pf-twinkle', delay: '-2s', dot: true },
  { top: '14%', left: '42%', size: 6, tone: 'green', anim: 'pf-twinkle', delay: '-4s', dot: true },
  { top: '80%', left: '56%', size: 5, tone: 'blue', anim: 'pf-twinkle', delay: '-7s', dot: true },
];

const PROBLEM_MARKS: readonly Mark[] = [
  { top: '6%', left: '2%', size: 18, tone: 'green', anim: 'pf-float', delay: '-2.5s' },
  { top: '31%', left: '96%', size: 22, tone: 'navy', anim: 'pf-drift', delay: '-6s' },
  { top: '54%', left: '1%', size: 10, tone: 'navy', anim: 'pf-rise', delay: '-9s' },
  { top: '76%', left: '97%', size: 8, tone: 'green', anim: 'pf-twinkle', delay: '-3s', dot: true },
  { top: '90%', left: '3%', size: 6, tone: 'blue', anim: 'pf-twinkle', delay: '-5.5s', dot: true },
  { top: '44%', left: '98%', size: 5, tone: 'green', anim: 'pf-twinkle', delay: '-1.5s', dot: true },
];

const STEPS_MARKS: readonly Mark[] = [
  { top: '12%', left: '2%', size: 16, tone: 'green', anim: 'pf-float', delay: '-4s' },
  { top: '66%', left: '3%', size: 9, tone: 'navy', anim: 'pf-rise', delay: '-7s' },
  { top: '20%', left: '96%', size: 18, tone: 'navy', anim: 'pf-drift', delay: '-2s' },
  { top: '82%', left: '95%', size: 7, tone: 'green', anim: 'pf-twinkle', delay: '-5s', dot: true },
  { top: '42%', left: '98%', size: 5, tone: 'blue', anim: 'pf-twinkle', delay: '-8s', dot: true },
];

const ECOSYSTEM_MARKS: readonly Mark[] = [
  { top: '10%', left: '3%', size: 18, tone: 'green', anim: 'pf-float', delay: '-1.5s' },
  { top: '62%', left: '1%', size: 11, tone: 'navy', anim: 'pf-rise', delay: '-10s' },
  { top: '22%', left: '95%', size: 20, tone: 'navy', anim: 'pf-drift', delay: '-5s' },
  { top: '74%', left: '97%', size: 8, tone: 'green', anim: 'pf-twinkle', delay: '-3.5s', dot: true },
  { top: '46%', left: '92%', size: 6, tone: 'blue', anim: 'pf-twinkle', delay: '-7.5s', dot: true },
];

const FOOTER_MARKS: readonly Mark[] = [
  { top: '22%', left: '2%', size: 14, tone: 'green', anim: 'pf-float', delay: '-3.5s' },
  { top: '70%', left: '4%', size: 8, tone: 'navy', anim: 'pf-rise', delay: '-8.5s' },
  { top: '30%', left: '95%', size: 16, tone: 'navy', anim: 'pf-drift', delay: '-4.5s' },
  { top: '78%', left: '92%', size: 6, tone: 'green', anim: 'pf-twinkle', delay: '-2.5s', dot: true },
  { top: '56%', left: '98%', size: 5, tone: 'blue', anim: 'pf-twinkle', delay: '-6.5s', dot: true },
];

const ROADMAP_MARKS: readonly Mark[] = [
  { top: '6%', left: '2%', size: 16, tone: 'green', anim: 'pf-float', delay: '-3s' },
  { top: '28%', left: '97%', size: 20, tone: 'navy', anim: 'pf-drift', delay: '-7s' },
  { top: '52%', left: '1%', size: 9, tone: 'navy', anim: 'pf-rise', delay: '-11s' },
  { top: '72%', left: '98%', size: 7, tone: 'green', anim: 'pf-twinkle', delay: '-2s', dot: true },
  { top: '88%', left: '4%', size: 5, tone: 'blue', anim: 'pf-twinkle', delay: '-6s', dot: true },
];

type MarkVariant =
  | 'hero'
  | 'problem'
  | 'solution'
  | 'steps'
  | 'ecosystem'
  | 'roadmap'
  | 'cta'
  | 'footer';

const MARKS: Record<MarkVariant, readonly Mark[]> = {
  hero: HERO_MARKS,
  problem: PROBLEM_MARKS,
  solution: SOLUTION_MARKS,
  steps: STEPS_MARKS,
  ecosystem: ECOSYSTEM_MARKS,
  roadmap: ROADMAP_MARKS,
  cta: CTA_MARKS,
  footer: FOOTER_MARKS,
};

/**
 * Decorative healthcare marks and soft glows. Purely presentational: the
 * wrapper is `aria-hidden` and `pointer-events-none`, sits behind the content,
 * and every animation is disabled by `prefers-reduced-motion` in `index.css`.
 *
 * Every landing section renders a set, so the motif carries down the page
 * instead of stopping at the hero. White sections skip the large blurred
 * glows to keep the extra instances cheap to paint on mobile.
 */
function FloatingMarks({
  variant,
  dark = false,
  glow = variant === 'hero' || variant === 'solution' || variant === 'cta',
}: {
  variant: MarkVariant;
  dark?: boolean;
  glow?: boolean;
}) {
  const marks = MARKS[variant];
  const tones = dark ? DARK_TONE : LIGHT_TONE;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {glow && (
        <>
          <div className="pf-glow absolute -top-28 -left-24 size-72 rounded-full bg-green-500/10 blur-3xl" />
          <div
            className={cn(
              'pf-glow absolute top-1/3 -right-24 size-80 rounded-full blur-3xl',
              dark ? 'bg-white/5' : 'bg-navy-600/10',
            )}
            style={{ animationDelay: '-5s' }}
          />
        </>
      )}

      {marks.map((mark, index) =>
        mark.dot ? (
          <span
            key={index}
            className={cn('absolute rounded-full bg-current', mark.anim, tones[mark.tone])}
            style={{
              top: mark.top,
              left: mark.left,
              width: mark.size,
              height: mark.size,
              animationDelay: mark.delay,
            }}
          />
        ) : (
          <svg
            key={index}
            viewBox="0 0 24 24"
            className={cn('absolute', mark.anim, tones[mark.tone])}
            style={{
              top: mark.top,
              left: mark.left,
              width: mark.size,
              height: mark.size,
              animationDelay: mark.delay,
            }}
          >
            <path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z" fill="currentColor" />
          </svg>
        ),
      )}
    </div>
  );
}

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'PharmaFlow — Your pharmacy. Under control. Wherever you are.' },
      {
        name: 'description',
        content:
          'PharmaFlow connects pharmacy operations and online customer access in one platform, built for Nigerian community pharmacies. Explore the interactive demo.',
      },
      {
        property: 'og:title',
        content: 'PharmaFlow — Your pharmacy. Under control. Wherever you are.',
      },
      {
        property: 'og:description',
        content:
          'Pharmacy operations, stock and expiry visibility, staff accountability and customer access in one connected platform.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary' },
    ],
  }),
  component: LandingPage,
});

/* ------------------------------------------------------------------ page */

function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-navy-800 focus:shadow-lg"
      >
        Skip to main content
      </a>

      <SiteHeader />

      <main id="main">
        <Hero />
        <ProblemSection />
        <SolutionSection />
        <HowItWorksSection />
        <EcosystemSection />
        <RoadmapSection />
        <DemoSection />
      </main>

      <SiteFooter />
    </div>
  );
}

/* ---------------------------------------------------------------- header */

function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      className="sticky top-0 z-40 border-b border-border/70 bg-white/90 backdrop-blur"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setMenuOpen(false);
      }}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <a href="#main" className="shrink-0 rounded-md">
          <BrandLogo />
        </a>

        <nav aria-label="Primary" className="ml-auto hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-grey-700 transition-colors hover:bg-navy-50 hover:text-navy-800 motion-safe:transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-3">
          <Button
            render={<a href={DEMO_URL} target="_blank" rel="noopener noreferrer" />}
            className="hidden h-10 bg-green-700 px-4 text-white hover:brightness-95 sm:inline-flex"
          >
            Explore the Demo
            <ArrowUpRight aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </Button>

          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="landing-menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-white text-navy-800 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 lg:hidden"
          >
            {menuOpen ? <X aria-hidden /> : <Menu aria-hidden />}
            <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
          </button>
        </div>
      </div>

      {/* Rendered always so `aria-controls` never points at a missing node. */}
      <nav
        id="landing-menu"
        aria-label="Landing page"
        hidden={!menuOpen}
        className="border-t border-border bg-white lg:hidden"
      >
        <ul className="mx-auto max-w-6xl px-4 py-2 sm:px-6">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="block border-b border-border/60 py-3 text-sm font-medium text-navy-800"
              >
                {link.label}
              </a>
            </li>
          ))}
          <li>
            <a
              href={DEMO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-1.5 py-3 text-sm font-semibold text-green-700"
            >
              Explore the Demo
              <ArrowUpRight className="size-4" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
        </ul>
      </nav>
    </header>
  );
}

/* ------------------------------------------------------------------ hero */

function Hero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="relative overflow-hidden border-b border-border/60 bg-gradient-to-b from-white via-navy-50 to-white"
    >
      <FloatingMarks variant="hero" />

      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-green-600/25 bg-green-50 px-3 py-1 text-[11px] font-bold tracking-[0.12em] text-green-700 uppercase">
            <span className="size-1.5 rounded-full bg-green-600" aria-hidden />
            A smarter way to manage community pharmacies
          </p>

          <h1
            id="hero-heading"
            className="mt-5 text-4xl font-bold tracking-tight text-navy-900 sm:text-5xl lg:text-[3.35rem] lg:leading-[1.06]"
          >
            Your Pharmacy. Under Control. Wherever You Are.
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-relaxed text-grey-700 sm:text-lg">
            PharmaFlow is an integrated pharmacy management and online ordering platform designed
            to help community pharmacies manage sales, stock, purchasing, staff activity and
            returns while connecting customers with pharmacies.
          </p>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-grey-700">
            By bringing pharmacy operations and customer access together, PharmaFlow aims to
            reduce the challenges of manual record-keeping, improve visibility into daily
            activities, and help pharmacies serve their communities more efficiently.
          </p>

          <ul className="mt-6 grid gap-2.5 sm:grid-cols-3">
            {HIGHLIGHTS.map((highlight) => (
              <li
                key={highlight}
                className="flex items-start gap-2 text-sm leading-snug text-grey-700"
              >
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-700" aria-hidden />
                <span>{highlight}</span>
              </li>
            ))}
          </ul>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button
              render={<a href={DEMO_URL} target="_blank" rel="noopener noreferrer" />}
              className="h-12 bg-green-700 px-6 text-base text-white hover:brightness-95"
            >
              Explore the Demo
              <ArrowUpRight aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </Button>

            <Button
              variant="outline"
              render={<a href="#how-it-works" />}
              className="h-12 px-6 text-base"
            >
              See How It Works
              <ArrowRight aria-hidden />
            </Button>
          </div>

          <p className="mt-4 text-sm text-grey-700">
            The demo is a prototype running on fictional sample data — not a live pharmacy account.
          </p>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- problem */

const PROBLEMS = [
  {
    icon: EyeOff,
    title: 'Limited visibility when the owner is away',
    body: 'When pharmacy owners are not physically present, it can be difficult to maintain a clear view of sales, stock movements and day-to-day staff activity.',
  },
  {
    icon: ClipboardX,
    title: 'Sales and stock discrepancies',
    body: 'When sales, purchases and stock adjustments are recorded separately or inconsistently, the recorded quantities may no longer match the physical stock.',
  },
  {
    icon: CalendarClock,
    title: 'Expired medicines and approaching expiry dates',
    body: 'Without reliable batch and expiry records, pharmacies may struggle to identify products approaching expiry early enough to take appropriate action.',
  },
  {
    icon: UserX,
    title: 'Unclear accountability for staff activity',
    body: 'When staff transactions and stock movements are not properly documented, investigating discrepancies and reconciling records becomes more difficult.',
  },
  {
    icon: RotateCcw,
    title: 'Returned products that are not properly recorded',
    body: 'Products returned by customers and stock returned to suppliers need clear records. Poorly documented returns can create unexplained stock changes and make reconciliation more difficult.',
  },
  {
    icon: SearchX,
    title: 'Unmet customer demand goes unnoticed',
    body: 'Customers often request medicines a pharmacy does not currently stock. Without a reliable way to record these requests, pharmacies can miss valuable insights into what customers need, which products may be worth stocking, and where demand is going unmet.',
  },
] as const;

function ProblemSection() {
  return (
    <section
      id="problem"
      aria-labelledby="problem-heading"
      className="relative scroll-mt-24 overflow-hidden bg-white"
    >
      <FloatingMarks variant="problem" />

      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <SectionHeading
          id="problem-heading"
          eyebrow="The problems we are solving"
          title="Running a pharmacy shouldn't mean losing sight of the details."
          lede="Many community pharmacies still depend on notebooks, spreadsheets or disconnected tools to manage daily operations. These methods can make it harder to keep records consistent, monitor staff activity and respond quickly when stock changes."
        />

        <div className="pf-reveal mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PROBLEMS.map((problem, index) => (
            <article
              key={problem.title}
              className="group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-white p-6 transition duration-300 ease-out hover:-translate-y-1 hover:border-navy-700/30 hover:shadow-xl hover:shadow-navy-900/5 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-navy-700/25 to-transparent"
              />
              <div className="flex items-start justify-between gap-3">
                <span className="flex size-11 items-center justify-center rounded-xl bg-navy-50 text-navy-800 transition-colors duration-300 group-hover:bg-navy-100">
                  <problem.icon className="size-5" aria-hidden />
                </span>
                <span
                  aria-hidden="true"
                  className="text-xs font-bold tracking-widest text-grey-500 tabular-nums"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="mt-5 text-base font-semibold text-navy-900">{problem.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-grey-700">{problem.body}</p>
            </article>
          ))}
        </div>

        <p className="mt-10 max-w-3xl text-sm leading-relaxed text-grey-700">
          Not every pharmacy runs into all of these, and plenty are already well run. They are the
          gaps PharmaFlow is designed to reduce — each with a corresponding capability below.
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- platform */

const SOLUTIONS = [
  {
    icon: MonitorSmartphone,
    title: 'Remote pharmacy oversight',
    body: 'Designed to help owners review sales, stock and operational information without depending solely on physical presence. What each person can see follows the permissions configured for their pharmacy.',
    badge: null,
  },
  {
    icon: Boxes,
    title: 'Connected sales and inventory records',
    body: 'Sales, purchasing and stock records sit together, helping teams keep inventory information consistent and making discrepancies easier to investigate.',
    badge: null,
  },
  {
    icon: CalendarCheck,
    title: 'Batch and expiry management',
    body: 'Batch-level stock records and expiry monitoring help pharmacy teams identify approaching expiry dates and decide what action to take.',
    badge: null,
  },
  {
    icon: ShieldCheck,
    title: 'Staff roles and accountability',
    body: 'Where implemented, role-based access and activity records help protect sensitive business information and make staff transactions easier to trace.',
    badge: null,
  },
  {
    icon: PackageCheck,
    title: 'Returned-product recording',
    body: 'Customer returns are recorded with a reason, quantity and outcome. Items approved for resale are separated from those quarantined as damaged, expired or otherwise unsuitable — a returned medicine is never added back to saleable stock automatically. Pharmacy procedures and safety requirements still apply.',
    badge: 'Supplier returns planned',
  },
  {
    icon: Radar,
    title: 'Demand Radar — Turn customer requests into stocking insights',
    body: "PharmaFlow's Demand Radar is designed to capture requests for medicines that are not currently in stock, helping pharmacies identify repeated customer needs and understand unmet demand. These insights can guide smarter purchasing and stocking decisions, helping pharmacies respond more effectively to what their customers are asking for. Request capture is in development; the demo shows the screen using seeded sample requests.",
    badge: 'In development',
  },
] as const;

function SolutionSection() {
  return (
    <>
      {/* Gradient bridge so the white problem section flows into the tinted
          solution section instead of meeting it with a hard edge. */}
      <div aria-hidden="true" className="relative h-20 bg-gradient-to-b from-white to-navy-50">
        <span className="absolute top-1/2 left-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-green-600/25 bg-white text-green-700 shadow-sm">
          <Plus className="size-4" />
        </span>
      </div>

      <section
        id="platform"
        aria-labelledby="platform-heading"
        className="relative scroll-mt-24 overflow-hidden bg-navy-50"
      >
        <FloatingMarks variant="solution" />

        <div className="relative mx-auto max-w-6xl px-4 pt-4 pb-16 sm:px-6 lg:pb-24">
          <SectionHeading
            id="platform-heading"
            eyebrow="The PharmaFlow solution"
            title="One connected platform. Better visibility. Smarter pharmacy operations."
            lede="PharmaFlow is designed to connect the essential parts of pharmacy operations — from recording sales and managing stock to tracking returns and helping customers discover pharmacies."
          />

          <div className="pf-reveal mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {SOLUTIONS.map((solution, index) => (
              <article
                key={solution.title}
                className="group relative flex flex-col rounded-2xl border border-border bg-white p-6 shadow-sm transition duration-300 ease-out hover:-translate-y-1 hover:border-green-600/40 hover:shadow-xl hover:shadow-navy-900/5 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              >
                <span
                  aria-hidden
                  className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-green-600/40 to-transparent"
                />
                <div className="flex items-start justify-between gap-3">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-green-50 text-green-700 transition-colors duration-300 group-hover:bg-green-100">
                    <solution.icon className="size-5" aria-hidden />
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-xs font-bold tracking-widest text-grey-500 tabular-nums"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 className="mt-5 text-base font-semibold text-navy-900">{solution.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-grey-700">{solution.body}</p>
                {solution.badge && (
                  <span className="mt-4 inline-flex w-fit rounded-full border border-amber-600/30 bg-amber-100 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-600 uppercase">
                    {solution.badge}
                  </span>
                )}
              </article>
            ))}
          </div>

          <StatusNote />
        </div>
      </section>
    </>
  );
}

/**
 * The honesty boundary, stated once and in the open rather than buried in a
 * footnote. Everything above is a capability; this is what is actually
 * demonstrable today.
 */
function StatusNote() {
  return (
    <div className="mt-8 rounded-2xl border border-border bg-white p-5">
      <p className="flex items-center gap-2 text-sm font-semibold text-navy-900">
        <ShieldCheck className="size-4 text-green-700" aria-hidden />
        What is running today
      </p>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-grey-700">
        The owner and attendant experiences run on the PharmaFlow application with seeded sample
        data — including sales, stock, batch and expiry records, staff roles and customer returns.
        The supplier and customer experiences are labelled prototypes: they simulate quotation,
        discovery and ordering flows and connect to nothing real. Supplier returns and online
        ordering beyond the prototype are planned. There are no live supplier integrations,
        payments, real-time stock guarantees or order fulfilment behind any of them.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------- how it works */

const STEPS = [
  {
    title: 'Set up the pharmacy',
    body: 'Add your branch, invite staff and assign roles, then bring in your stock list with batch numbers, quantities and expiry dates.',
  },
  {
    title: 'Run the counter as usual',
    body: 'Staff record sales, dispense from a specific batch and take customer orders — without a second set of books.',
  },
  {
    title: 'See the day as it happens',
    body: 'Stock levels, expiry windows, staff activity and order status update as the work happens, and the daily summary is readable from a phone.',
  },
] as const;

function HowItWorksSection() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-heading"
      className="relative scroll-mt-24 overflow-hidden border-y border-border/60 bg-white"
    >
      <FloatingMarks variant="steps" />

      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <SectionHeading
          id="how-it-works-heading"
          eyebrow="How it works"
          title="Set up once. Then just run your pharmacy."
          lede="PharmaFlow is designed to fit the way the counter already works, rather than adding a second job on top of it."
        />

        <ol className="mt-10 grid gap-6 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="border-t border-border pt-5">
              <span className="text-sm font-bold text-green-700 tabular-nums">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-2 text-base font-semibold text-navy-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-grey-700">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- ecosystem */

const ROLES = [
  {
    icon: Building2,
    title: 'Pharmacy Owner',
    body: 'Oversight and reports.',
    status: 'Demo · runs on the app',
    tone: 'live',
  },
  {
    icon: ScanBarcode,
    title: 'Pharmacy Attendant',
    body: 'Daily pharmacy operations.',
    status: 'Demo · runs on the app',
    tone: 'live',
  },
  {
    icon: Truck,
    title: 'Supplier',
    body: 'Supply information and quotations.',
    status: 'Prototype · simulated',
    tone: 'prototype',
  },
  {
    icon: ShoppingCart,
    title: 'Customer',
    body: 'Medicine discovery and orders.',
    status: 'Prototype · simulated',
    tone: 'prototype',
  },
] as const;

function EcosystemSection() {
  return (
    <section
      id="ecosystem"
      aria-labelledby="ecosystem-heading"
      className="relative scroll-mt-24 overflow-hidden border-y border-border/60 bg-white"
    >
      <FloatingMarks variant="ecosystem" />

      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <SectionHeading
          id="ecosystem-heading"
          eyebrow="Connected"
          title="From the pharmacy counter to the customer."
          lede="Four roles, one record of the day's work."
        />

        <ol className="mt-10 grid gap-4 md:grid-cols-4">
          {ROLES.map((role, index) => (
            <li key={role.title} className="relative">
              <div className="h-full rounded-xl border border-border bg-background p-5">
                <span className="flex size-10 items-center justify-center rounded-lg bg-navy-50 text-navy-800">
                  <role.icon className="size-5" aria-hidden />
                </span>
                <h3 className="mt-4 text-base font-semibold text-navy-900">{role.title}</h3>
                <p className="mt-1 text-sm text-grey-700">{role.body}</p>
                <span
                  className={cn(
                    'mt-4 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase',
                    role.tone === 'live'
                      ? 'border-green-600/30 bg-green-50 text-green-700'
                      : 'border-amber-600/30 bg-amber-100 text-amber-600',
                  )}
                >
                  {role.status}
                </span>
              </div>

              {index < ROLES.length - 1 && (
                <ArrowRight
                  className="absolute top-1/2 -right-3 hidden size-4 -translate-y-1/2 text-grey-300 md:block"
                  aria-hidden
                />
              )}
            </li>
          ))}
        </ol>

        <p className="mt-8 max-w-3xl text-sm leading-relaxed text-grey-700">
          Only the owner and attendant experiences run on the application today. Supplier and
          customer are prototypes, and the arrow shows how information is intended to move between
          roles — not a live connection.
        </p>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- roadmap */

type RoadmapTabId = 'available' | 'development' | 'future';

interface RoadmapFeature {
  icon: LucideIcon;
  title: string;
  body: string;
}

interface RoadmapTab {
  id: RoadmapTabId;
  label: string;
  icon: LucideIcon;
  features: readonly RoadmapFeature[];
  gridClass: string;
  panelClass: string;
  iconClass: string;
  lineClass: string;
  hoverClass: string;
}

/**
 * Category copy reflects the current implementation state.
 * - "Available Now": features demonstrably working in the seeded owner/attendant demos.
 * - "In Development & Validation": features with partial implementation or demo-only prototypes.
 * - "Future Direction": exploratory concepts without implementation.
 */
const ROADMAP_TABS: readonly RoadmapTab[] = [
  {
    id: 'available',
    label: 'Available Now',
    icon: CheckCircle2,
    gridClass: 'lg:grid-cols-3',
    panelClass: '',
    iconClass: 'bg-green-50 text-green-700',
    lineClass: 'from-green-600 via-green-500 to-green-600/30',
    hoverClass: 'hover:border-green-600/40',
    features: [
      {
        icon: ScanBarcode,
        title: 'Sales & Checkout',
        body: 'Record pharmacy sales, calculate transaction totals and update stock quantities when a sale is completed. Keep sales records organised to support daily reconciliation.',
      },
      {
        icon: Boxes,
        title: 'Inventory & Batch Tracking',
        body: 'Track medicine quantities by product and batch, including stock received and stock sold. Maintain clearer records of what is available and which batch each quantity belongs to.',
      },
      {
        icon: CalendarClock,
        title: 'Expiry Visibility',
        body: 'Monitor medicine expiry dates and identify batches approaching expiry. Help pharmacy teams prioritise checks and take appropriate action before products expire.',
      },
      {
        icon: Users,
        title: 'Staff Activity & Owner Visibility',
        body: 'Help pharmacy owners review relevant staff transactions, sales and stock information, including when they are away from the pharmacy. Role-based permissions help control access to sensitive business information.',
      },
      {
        icon: RotateCcw,
        title: 'Returned-Product Management',
        body: 'Record returned products, document return reasons and quantities, and support appropriate stock and transaction adjustments. Returned products must not automatically become available for sale when their condition or suitability has not been established.',
      },
    ],
  },
  {
    id: 'development',
    label: 'In Development & Validation',
    icon: FlaskConical,
    gridClass: 'lg:grid-cols-3',
    panelClass: '',
    iconClass: 'bg-navy-50 text-navy-700',
    lineClass: 'from-navy-700 via-navy-600 to-navy-700/30',
    hoverClass: 'hover:border-navy-700/40',
    features: [
      {
        icon: WifiOff,
        title: 'Offline Operations & Synchronisation',
        body: 'Core POS workflows (cash-only sales) work offline and sync when connectivity returns. Full offline catalogue, customer and stock operations are in validation. The experience depends on the operations supported by the current offline implementation.',
      },
      {
        icon: Radar,
        title: 'Demand Radar — Unmet Medicine Requests',
        body: 'Prototype for capturing requests for medicines not in stock. The demo (`/demand-radar`) shows the concept with seeded requests; live builds show a pilot notice. Not yet a live feature.',
      },
      {
        icon: Truck,
        title: 'Supplier Price Comparison & Smart Restocking',
        body: 'Help pharmacies compare available supplier prices and streamline the restocking process. The planned workflow aims to update inventory from recorded stock receipts, reducing duplicate data entry and making stock receiving easier.',
      },
      {
        icon: ShoppingBag,
        title: 'Customer Ordering & Pharmacy Availability',
        body: 'Develop a more connected experience that helps customers discover medicines and place orders with participating pharmacies. Accurate availability and order completion depend on participating pharmacies and validated workflows.',
      },
    ],
  },
  {
    id: 'future',
    label: 'Future Direction',
    icon: Compass,
    gridClass: 'lg:grid-cols-2',
    panelClass: 'mx-auto max-w-4xl',
    iconClass: 'bg-navy-50 text-navy-700',
    lineClass: 'from-navy-600 via-navy-600/70 to-navy-600/20',
    hoverClass: 'hover:border-navy-600/40',
    features: [
      {
        icon: Bot,
        title: 'AI & WhatsApp Assistance',
        body: 'Explore AI-assisted interactions through familiar messaging channels to help customers navigate pharmacy services and access relevant information.',
      },
      {
        icon: Stethoscope,
        title: 'Pharmacist Consultation',
        body: 'Explore ways for customers to connect with pharmacists for professional guidance through appropriate consultation channels.',
      },
      {
        icon: ChartLine,
        title: 'Smarter Pharmacy Business Intelligence',
        body: 'Build toward richer insights from pharmacy sales, inventory and demand patterns to support more informed operational and purchasing decisions.',
      },
      {
        icon: BadgeCheck,
        title: 'Medicine Verification & Recall Intelligence',
        body: 'Explore tools that support medicine verification and recall awareness using reliable, appropriate data sources. Any verification capability will depend on validated integrations and applicable requirements.',
      },
    ],
  },
];

/**
 * Interactive product roadmap. The three categories are real ARIA tabs with a
 * roving tabindex, arrow/Home/End keyboard support, and a single visible panel.
 * Only the selected panel is exposed; the others are `hidden`, so their cards
 * are neither seen nor reached by assistive technology.
 */
function RoadmapSection() {
  const [activeTab, setActiveTab] = useState<RoadmapTabId>('available');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const lastIndex = ROADMAP_TABS.length - 1;
    let nextIndex: number | null = null;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = index === lastIndex ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = index === 0 ? lastIndex : index - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = lastIndex;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = ROADMAP_TABS[nextIndex];
    if (!nextTab) return;

    setActiveTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <section
      id="roadmap"
      aria-labelledby="roadmap-heading"
      className="relative scroll-mt-24 overflow-hidden border-y border-border/60 bg-navy-50"
    >
      <FloatingMarks variant="roadmap" />

      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <SectionHeading
          id="roadmap-heading"
          eyebrow="The PharmaFlow roadmap"
          title="Built for Today's Pharmacy. Designed for What's Next."
          lede="PharmaFlow is evolving to help pharmacies strengthen operational control, make smarter stocking decisions, and connect with customers through a more integrated pharmacy experience."
        />

        <div className="mt-8 flex justify-center">
          <div
            role="tablist"
            aria-label="PharmaFlow roadmap categories"
            className="grid w-full max-w-3xl grid-cols-1 gap-1.5 rounded-2xl border border-border bg-white/80 p-1.5 shadow-sm sm:grid-cols-3"
          >
            {ROADMAP_TABS.map((tab, index) => {
              const selected = tab.id === activeTab;

              return (
                <button
                  key={tab.id}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`roadmap-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`roadmap-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700 motion-reduce:transition-none',
                    selected
                      ? 'bg-navy-800 text-white shadow-sm'
                      : 'text-grey-700 hover:bg-navy-50 hover:text-navy-800',
                  )}
                >
                  <tab.icon
                    className={cn(
                      'size-4 shrink-0',
                      selected ? 'text-green-500' : 'text-green-700',
                    )}
                    aria-hidden
                  />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {ROADMAP_TABS.map((tab) => {
          const selected = tab.id === activeTab;

          return (
            <div
              key={tab.id}
              role="tabpanel"
              id={`roadmap-panel-${tab.id}`}
              aria-labelledby={`roadmap-tab-${tab.id}`}
              hidden={!selected}
              tabIndex={selected ? 0 : -1}
              className="mt-8 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-green-700"
            >
              <div data-active={selected} className={cn('pf-tab-panel', tab.panelClass)}>
                <div className={cn('grid gap-4 sm:grid-cols-2', tab.gridClass)}>
                  {tab.features.map((feature) => (
                    <article
                      key={feature.title}
                      className={cn(
                        'group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-white p-6 shadow-sm transition duration-300 ease-out hover:-translate-y-0.5 hover:shadow-lg hover:shadow-navy-900/5 motion-reduce:transition-none motion-reduce:hover:translate-y-0',
                        tab.hoverClass,
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'absolute inset-x-0 top-0 h-1 bg-gradient-to-r',
                          tab.lineClass,
                        )}
                      />
                      <span
                        className={cn(
                          'flex size-11 items-center justify-center rounded-xl',
                          tab.iconClass,
                        )}
                      >
                        <feature.icon className="size-5" aria-hidden />
                      </span>
                      <h3 className="mt-5 text-base font-semibold text-navy-900">
                        {feature.title}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-grey-700">{feature.body}</p>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ demo */

function DemoSection() {
  return (
    <section
      id="demo"
      aria-labelledby="demo-heading"
      className="relative scroll-mt-24 overflow-hidden bg-navy-800 text-white"
    >
      <FloatingMarks variant="cta" dark />

      <div className="pf-reveal relative mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 lg:py-24">
        <p className="text-[11px] font-bold tracking-[0.16em] text-green-100 uppercase">
          The outcome
        </p>

        <h2
          id="demo-heading"
          className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl"
        >
          More clarity for pharmacy owners. Better access for customers.
        </h2>

        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-navy-100">
          PharmaFlow brings pharmacy operations and customer access into one connected experience,
          helping pharmacy teams work with clearer records while creating opportunities to serve
          customers beyond the counter.
        </p>

        <Button
          render={<a href={DEMO_URL} target="_blank" rel="noopener noreferrer" />}
          className="mt-8 h-12 bg-green-700 px-6 text-base text-white hover:brightness-95"
        >
          Explore the Demo
          <ArrowUpRight aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </Button>

        <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-navy-100">
          A prototype with fictional sample data. Nothing you see or do there touches a real
          pharmacy, and no order, payment or message reaches anyone.
        </p>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- footer */

function SiteFooter() {
  return (
    <footer className="relative overflow-hidden border-t border-border bg-white">
      <FloatingMarks variant="footer" />

      <div className="relative mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <BrandLogo tagline />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-grey-700">
              PharmaFlow connects pharmacy operations and online customer access in one platform,
              built for Nigerian community pharmacies.
            </p>
          </div>

          <FooterNav
            title="Sections"
            items={[
              { href: '#problem', label: 'The problem' },
              { href: '#platform', label: 'The solution' },
              { href: '#ecosystem', label: 'Who it connects' },
            ]}
          />

          <FooterNav
            title="Explore"
            items={[
              { href: '#how-it-works', label: 'How it works' },
              { href: '#demo', label: 'See the demo' },
            ]}
          />
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-border pt-6 text-xs text-grey-700 sm:flex-row sm:items-center sm:justify-between">
          <p>
            &copy; {new Date().getFullYear()} PharmaFlow. Smarter Pharmacies. Healthier Communities.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterNav({
  title,
  items,
}: {
  title: string;
  items: readonly { href: string; label: string }[];
}) {
  return (
    <nav aria-label={title}>
      <h2 className="text-[11px] font-bold tracking-[0.12em] text-grey-700 uppercase">{title}</h2>
      <ul className="mt-3 space-y-1">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              className="inline-block py-1 text-sm text-grey-700 transition-colors hover:text-navy-800 motion-safe:transition-colors"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* --------------------------------------------------------------- shared */

function SectionHeading({
  id,
  eyebrow,
  title,
  lede,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <div className="max-w-2xl">
      <p className="text-[11px] font-bold tracking-[0.14em] text-green-700 uppercase">{eyebrow}</p>
      <h2
        id={id}
        className="mt-3 text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl"
      >
        {title}
      </h2>
      {lede && <p className="mt-3 text-base leading-relaxed text-grey-700">{lede}</p>}
    </div>
  );
}
