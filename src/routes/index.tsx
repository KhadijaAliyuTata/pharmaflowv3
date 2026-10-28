import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { BrandLogo } from '~/components/brand-logo';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { Checkbox } from '~/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { Skeleton } from '~/components/ui/skeleton';
import { Toaster } from '~/components/ui/sonner';
import {
  DEMO_ACCOUNTS,
  configProblem,
  enterDemoSession,
  isDemoMode,
  signIn,
  useSession,
} from '~/lib/session';

/**
 * Sign in.
 *
 * Live builds use the staff email/password form. Demo builds have no password
 * to check, so they show the four seeded accounts instead and enter through
 * `enterDemoSession`; putting a real form beside accounts that accept any
 * password taught the wrong thing about the deployment.
 *
 * The customer tab is gone. It was a real form wired to a refusal — v3 has no
 * customer credential to check — and a tab that cannot succeed is a dead end,
 * not an explanation.
 *
 * v2 had four modes in one 802-line `LoginScreen.tsx` — staff, customer, customer
 * register, and a hand-rolled forgot-password modal built from a plain `div`
 * with no focus trap, no escape handling and no `role="dialog"`. The split here
 * is by component, not by a `mode` string threaded through every branch, and
 * the modal is a real `Dialog` from `~/components/ui`.
 */
export const Route = createFileRoute('/')({
  component: Login,
});

function Login() {
  const { status } = useSession();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // The session is `loading` on the server and on the client's first render, so
  // anything that branches on it has to agree across both — hence `mounted`.
  // Before it, the form renders: it is what the server sent, and it is the
  // correct thing to paint for anyone who is not already signed in.
  //
  // After mount, a session still reading `loading` gets a neutral skeleton
  // instead of a form nobody may use, and anyone signed in is replaced by a
  // redirect. The effect that resolves the session runs in the same commit as
  // this one, so a signed-in user does not normally see either.
  if (status === 'authenticated') {
    // The dashboard is role-aware. Both roles land there, so an attendant gets
    // the counter dashboard rather than being sent to the till screen or left
    // on the owner overview.
    return <Navigate to="/dashboard" />;
  }
  if (status === 'loading' && mounted) return <LoginSkeleton />;

  // A deployment that cannot authenticate at all gets a diagnosis instead of a
  // sign-in form. Offering a form here is what made the old fail-open behaviour
  // invisible: an operator saw a normal login screen and had no reason to suspect
  // the backend was missing.
  const problem = configProblem();
  if (problem) return <NotConfigured problem={problem} />;

  const demoMode = isDemoMode();

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <BrandPanel demo={demoMode} />

      <main className="flex items-center justify-center p-6">
        {demoMode ? (
          <DemoSignIn />
        ) : (
          <div className="w-full max-w-sm space-y-6">
            <div className="space-y-5">
              <BrandLogo tagline />

              <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            </div>

            <StaffSignInForm ready={mounted} />
          </div>
        )}
      </main>

      {/* Outside `_app`, so this screen owns its own toaster. */}
      <Toaster position="bottom-right" />
    </div>
  );
}

/* ------------------------------------------------------------- not configured */

/**
 * Shown when this deployment cannot authenticate at all.
 *
 * Deliberately not a sign-in form. If authentication is impossible, a form is a
 * dead end that looks like a password problem, and the operator has no signal
 * that the real fault is a missing build variable. Naming the variable is the
 * whole value of this screen.
 */
function NotConfigured({ problem }: { problem: string }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <BrandPanel />

      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Not configured</h1>
            <p className="text-sm text-muted-foreground">
              This build cannot sign anyone in.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle px-3 py-2.5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-sm text-warning">{problem}</p>
          </div>

          <p className="text-xs text-muted-foreground">
            Seeded demo data is available on a development server via{' '}
            <code className="font-mono">PUBLIC_DEMO_MODE=true</code>. It is not available in a
            production build at all: demo mode is decided by the build, so no environment variable
            can turn it on here.
          </p>
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------- staff form */

const staffSchema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
  remember: z.boolean(),
});

type StaffValues = z.infer<typeof staffSchema>;

function StaffSignInForm({ ready }: { ready: boolean }) {
  const form = useForm<StaffValues>({
    resolver: zodResolver(staffSchema),
    defaultValues: { email: '', password: '', remember: true },
  });

  const onSubmit = async (values: StaffValues) => {
    const result = await signIn(values.email, values.password, {
      remember: values.remember,
    });

    if (!result.ok) {
      form.setError('password', { message: result.error });
      return;
    }

    toast.success(`Signed in as ${result.user.name}`);
    // The `Navigate` in `Login` takes over now that the session resolved.
  };

  return (
    <Form {...form}>
      {/*
        The native form is a fallback that must fail safe. Before hydration the
        React submit handler does not exist, and a bare GET form puts the typed
        password in the query string. `method="post"` keeps it out of the URL,
        and the submit button stays disabled until the effect above has run.
      */}
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        method="post"
        className="space-y-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl
                render={<Input type="email" autoComplete="username" className="h-9" />}
                {...field}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl
                render={<Input type="password" autoComplete="current-password" className="h-9" />}
                {...field}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="remember"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl
                render={<Checkbox checked={field.value} onCheckedChange={field.onChange} />}
                name={field.name}
                onBlur={field.onBlur}
              />
              <FormLabel className="font-normal">Remember me</FormLabel>
            </FormItem>
          )}
        />

        <div className="flex items-center justify-between gap-2">
          <Button type="submit" className="h-9" disabled={!ready}>
            Sign in
          </Button>
          <ForgotPassword />
        </div>
      </form>
    </Form>
  );
}

/* ---------------------------------------------------------- demo accounts */

/**
 * Demo builds show the four seeded accounts instead of a password form.
 *
 * Owner and attendant enter the real demo shell; customer and supplier open
 * their prototype portals. Nothing here calls Supabase or writes the real
 * profile cache — `enterDemoSession` is the same demo-only path used by
 * `/investor-demo`.
 */
function DemoSignIn() {
  const navigate = useNavigate();

  const enter = (account: (typeof DEMO_ACCOUNTS)[number]) => {
    if (account.role === 'owner' || account.role === 'assistant') {
      enterDemoSession(account.role);
      // The dashboard chooses the owner or counter layout from the role. Sending
      // the attendant to `/pos` skipped the dashboard entirely, and sending them
      // to `/dashboard` without a role-aware dashboard showed owner content.
      void navigate({ to: '/dashboard' });
      return;
    }
    if (account.role === 'customer') {
      void navigate({ to: '/customer' });
      return;
    }
    if (account.role === 'supplier') {
      void navigate({ to: '/supplier' });
    }
  };

  return (
    <div className="w-full max-w-md space-y-6">
      <div className="space-y-5">
        <BrandLogo tagline />

        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">Explore PharmaFlow</h1>
          <p className="text-sm text-muted-foreground">
            Pick a demo account. No password, no setup.
          </p>
        </div>
      </div>

      {isDemoMode() ? <DemoAccounts onPick={enter} /> : null}

      <p className="text-xs text-muted-foreground">
        Sample data only. Accounts live in this browser and nothing is sent to a live
        pharmacy.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- demo panel */

/**
 * The demo accounts, out loud. v2 hid this behind a dropdown labelled
 * "Demo login"; here it is a panel on the sign-in screen, because the whole
 * point of this build is that anyone reading it knows the auth is fake.
 */
function DemoAccounts({ onPick }: { onPick: (account: (typeof DEMO_ACCOUNTS)[number]) => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="flex items-center gap-1.5">
        <Badge variant="secondary">Demo accounts</Badge>
        <p className="text-xs text-muted-foreground">
          One click. No password.
        </p>
      </div>

      <ul className="space-y-1">
        {DEMO_ACCOUNTS.map((account) => (
          <li key={account.email}>
            <button
              type="button"
              onClick={() => onPick(account)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{account.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {account.role} · {account.blurb}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">Enter</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------- forgot password */

/**
 * Names the person who can actually restore access, and stops there.
 *
 * Recovery is an owner's action, not a self-service flow: an owner issues a fresh
 * invitation and opening it lets the person set a new password. The dialog says
 * who to ask rather than describing machinery — token tables, mail providers —
 * that the person reading it cannot act on.
 *
 * It offers no form, deliberately. There is no request this screen could send, so
 * a "send reset email" field would be a control that does nothing.
 */
function ForgotPassword() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="link" className="h-9 px-0" />}>
        Forgot password
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset your password</DialogTitle>
          <DialogDescription>
            Password resets are handled by your pharmacy owner. Contact them to be
            re-invited.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------- brand panel */

/** `hidden` below `lg`, where the card is the whole screen. */
function BrandPanel({ demo = false }: { demo?: boolean }) {
  return (
    <aside className="hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
      <BrandLogo />

      <div className="space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight">
          {demo ? 'One pharmacy. Four views.' : 'One till. Every screen.'}
        </h2>
        <ul className="space-y-3 text-sm">
          {demo ? (
            <>
              <Feature>Owner: margins, stock and staff</Feature>
              <Feature>Attendant: the counter, with limits</Feature>
              <Feature>Customer: browse and place a sample order</Feature>
              <Feature>Supplier: quotes and fulfilment</Feature>
            </>
          ) : (
            <>
              <Feature>Sell in boxes, cards or tablets</Feature>
              <Feature>Pricing and margin stay with the owner</Feature>
              <Feature>Expiry and reorder before they bite</Feature>
            </>
          )}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">
        {demo
          ? 'Demo build · sample data stays in this browser'
          : 'PharmaFlow · pharmacy operations'}
      </p>
    </aside>
  );
}

function Feature({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">{children}</span>
    </li>
  );
}

/* --------------------------------------------------------------- skeleton */

/**
 * Neutral and centred. Deliberately not the brand panel or the form — either
 * would show someone who is already signed in the wrong screen, which is the
 * one thing this route must not do.
 */
function LoginSkeleton() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}