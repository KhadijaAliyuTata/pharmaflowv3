import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, createFileRoute } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { KeyRound, Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { Skeleton } from '~/components/ui/skeleton';
import { Toaster } from '~/components/ui/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { BRAND } from '~/lib/nav';
import { DEMO_ACCOUNTS, configProblem, signIn, useSession } from '~/lib/session';

/**
 * Sign in. One route, two tabs, two form components.
 *
 * v2 had four modes in one 802-line `LoginScreen.tsx` — staff, customer, customer
 * register, and a hand-rolled forgot-password modal built from a plain `div`
 * with no focus trap, no escape handling and no `role="dialog"`. The split here
 * is by component, not by a `mode` string threaded through every branch, and
 * the modal is a real `Dialog` from `~/components/ui`.
 */
export const Route = createFileRoute('/login')({
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
  if (status === 'authenticated') return <Navigate to="/" />;
  if (status === 'loading' && mounted) return <LoginSkeleton />;

  // A deployment that cannot authenticate at all gets a diagnosis instead of a
  // sign-in form. Offering a form here is what made the old fail-open behaviour
  // invisible: an operator saw a normal login screen and had no reason to suspect
  // the backend was missing.
  const problem = configProblem();
  if (problem) return <NotConfigured problem={problem} />;

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <BrandPanel />

      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground">
              {BRAND.defaultBranch} · Lagos
            </p>
          </div>

          <Tabs defaultValue="staff" className="gap-4">
            <TabsList className="w-full">
              <TabsTrigger value="staff">Staff</TabsTrigger>
              <TabsTrigger value="customer">Customer</TabsTrigger>
            </TabsList>

            <TabsContent value="staff">
              <StaffSignInForm />
            </TabsContent>

            <TabsContent value="customer">
              <CustomerSignInForm />
            </TabsContent>
          </Tabs>
        </div>
      </main>

      {/* Outside `_app`, so this screen owns its own toaster. */}
      <Toaster position="bottom-right" />
    </div>
  );
}

/* ------------------------------------------------------------- staff form */

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
            To run against seeded demo data instead, set{' '}
            <code className="font-mono">PUBLIC_DEMO_MODE=true</code> and restart. Demo mode is
            opt-in precisely so that a missing variable cannot silently produce a
            working-looking sign-in.
          </p>
        </div>
      </main>
    </div>
  );
}

const staffSchema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
  remember: z.boolean(),
});

type StaffValues = z.infer<typeof staffSchema>;

function StaffSignInForm() {
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
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
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
          <Button type="submit" className="h-9">
            Sign in
          </Button>
          <ForgotPassword />
        </div>

        <DemoAccounts
          onPick={(account) => {
            form.setValue('email', account.email, { shouldValidate: true });
            form.setValue('password', 'demo', { shouldValidate: true });
          }}
        />
      </form>
    </Form>
  );
}

/* ---------------------------------------------------------- customer form */

const customerSchema = z.object({
  phone: z
    .string()
    .regex(/^(?:\+?234|0)\d{10}$/, 'Enter a Nigerian phone number'),
  password: z.string().min(1, 'Enter your password'),
});

type CustomerValues = z.infer<typeof customerSchema>;

const NO_CUSTOMER_AUTH = 'Customer accounts are not part of this build. Staff sign-in is the way in.';

/**
 * A real form, deliberately wired to a refusal. v3's `Role` is
 * `'owner' | 'assistant'` and `Customer` is a pharmacy record, not a login —
 * there is no customer credential to check, so this validates the input and
 * then says so rather than pretending a session exists.
 */
function CustomerSignInForm() {
  const form = useForm<CustomerValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: { phone: '', password: '' },
  });

  const onSubmit = () => {
    form.setError('password', { message: NO_CUSTOMER_AUTH });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone</FormLabel>
              <FormControl
                render={<Input type="tel" inputMode="tel" autoComplete="tel" className="h-9" />}
                {...field}
              />
              <FormDescription>Registered on an order or prescription.</FormDescription>
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

        <Button type="submit" variant="outline" className="h-9 w-full">
          Sign in
        </Button>

        <Alert>
          <Lock />
          <AlertTitle>Staff only</AlertTitle>
          <AlertDescription>
            This build has no customer credentials. Ordering and prescription
            uploads come with the patient app.
          </AlertDescription>
        </Alert>
      </form>
    </Form>
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
        <Badge variant="secondary">Demo</Badge>
        <p className="text-xs text-muted-foreground">
          Any password works. Accounts live in this browser only.
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
              <span className="shrink-0 text-xs text-muted-foreground">Fill</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------- forgot password */

/**
 * States the gap instead of faking it. v2's modal showed "a 6-digit recovery
 * code has been sent to …" and sent nothing at all.
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
          <DialogTitle>Password reset is not wired up</DialogTitle>
          <DialogDescription>
            Nothing was sent, because there is nowhere to send it. Two pieces
            are missing:
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 text-sm">
          <li className="flex gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">A token table.</span> One row per
              request: user id, hashed token, expiry, and when it was used.
            </span>
          </li>
          <li className="flex gap-2">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">An email provider.</span> Resend,
              Postmark, or Cloudflare Email Service, plus a Worker binding to
              send through.
            </span>
          </li>
        </ul>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------- brand panel */

/** `hidden` below `lg`, where the card is the whole screen. */
function BrandPanel() {
  return (
    <aside className="hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
      <div className="flex items-center gap-2">
        <div className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-md text-sm font-bold">
          {BRAND.mark}
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">{BRAND.name}</p>
          <p className="text-xs text-muted-foreground">{BRAND.defaultBranch}</p>
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="text-2xl font-semibold tracking-tight">
          One till. Every screen.
        </h2>
        <ul className="space-y-3 text-sm">
          <Feature>Sell in boxes, cards or tablets</Feature>
          <Feature>Pricing and margin stay with the owner</Feature>
          <Feature>Expiry and reorder before they bite</Feature>
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">
        Demo build · data is stored in this browser
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