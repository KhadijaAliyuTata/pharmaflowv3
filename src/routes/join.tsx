import { useEffect, useState } from 'react';
import { Navigate, createFileRoute, useNavigate } from '@tanstack/react-router';
import { BadgeCheck, KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Toaster } from '~/components/ui/sonner';
import { toast } from 'sonner';
import { BrandLogo } from '~/components/brand-logo';
import { DEMO_ACCOUNTS, configProblem, isDemoMode, signIn, signUpWithInvitation, useSession } from '~/lib/session';
import { MIN_PASSWORD_LENGTH } from '~/lib/accept-invite';
import { redeemInvitation } from '~/lib/supabase/staff';

/**
 * Join a pharmacy with an invitation.
 *
 * The counterpart to `pf_create_invitation`. Someone who has been sent a code
 * comes here, creates their own account with their own password, and the
 * invitation is exchanged for a membership in the branch that issued it.
 *
 * ## Why this page is reachable without signing in
 *
 * It has to be: the person using it does not have an account yet. That is the
 * whole reason this design avoids `auth.admin.createUser` and therefore avoids a
 * `service_role` key in the browser. The trade is that this route is the one
 * place an unauthenticated visitor can attempt a write, which is exactly why the
 * write itself is a `SECURITY DEFINER` function that re-checks the code, the
 * pending state and the caller's own email address. Nothing here is trusted.
 *
 * ## What the code does *not* decide
 *
 * The form cannot choose a branch or a role. Both come from the invitation row,
 * and there is no request this page can make that would change them.
 */
export const Route = createFileRoute('/join')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: Join,
});

function Join() {
  const { status } = useSession();
  const { token: fromLink } = Route.useSearch();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const [token, setToken] = useState(fromLink ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Set once someone has signed in on the already-registered path.
   *
   * This exists because that path previously reported "redeeming your
   * invitation" and then returned without redeeming anything. The user ended up
   * signed in to a pharmacy they had no membership in, with `profiles.branch_id`
   * still null and an empty app, and no message saying so. Redemption is now an
   * explicit step they take, and this flag is what makes it reachable.
   */
  const [signedInWithCode, setSignedInWithCode] = useState(false);

  useEffect(() => {
    if (fromLink) setToken(fromLink);
  }, [fromLink]);

  const problem0 = configProblem();
  if (problem0) return <NotAvailable />;

  /**
   * Someone who already has a session, holding an invitation code, has an
   * unfinished job: the code has not been redeemed.
   *
   * Two routes lead here. They confirmed their address on an earlier visit and
   * came back with the link, or they had an account before the invitation and
   * signed in above. Both used to be redirected straight to the dashboard, which
   * left the invitation permanently unredeemed and told them nothing.
   *
   * Signed in with no code, there is nothing to do here and the old redirect is
   * correct.
   */
  // The session is client-only (Supabase keeps it in storage), so the server
  // cannot know whether this visitor is already signed in. Branching on
  // `status` during the first client render made the two trees disagree: the
  // server painted the join form and the client painted the redeem step. Paint
  // the anonymous form on both until mount, then let the real session decide.
  if (mounted && (status === 'authenticated' || signedInWithCode)) {
    if (!token.trim()) return <Navigate to="/dashboard" />;
    return <RedeemScreen token={token.trim()} />;
  }

  const submit = async () => {
    setBusy(true);
    setProblem(null);

    const result = await signUpWithInvitation(email.trim(), password, token.trim());

    if (result.ok) {
      toast.success('Welcome to the team');
      return;
    }

    setBusy(false);

    // An existing account at this address is a fork in the road, not a rejection:
    // they can sign in with the password they already have, and redeem the same
    // code on the next screen. It is NOT redeemed here.
    if (result.code === 'already_registered') {
      const signedIn = await signIn(email.trim(), password);
      if (signedIn.ok) {
        setSignedInWithCode(true);
        return;
      }
      setProblem(
        'That password did not match the existing account at this address. Sign in with your current password, then open the invitation link again to redeem it.',
      );
      return;
    }

    // The account exists and the person is signed in, but the membership was not
    // granted — a withdrawn or expired invitation, most often. The session is real,
    // so the next step is redemption, not another password. This is the case that
    // previously left someone re-entering their password to reach the same screen.
    if (result.code === 'redeem_failed') {
      setSignedInWithCode(true);
      return;
    }

    // Every other outcome has one correct next step and its own message. Nothing
    // here is hedged: a failed acceptance is reported as a failed acceptance.
    setProblem(result.error);
  };

  return (
    <div className="flex min-h-dvh items-start justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm space-y-6">
        {/* The same lockup the sign-in screen shows, so somebody arriving from an
            invitation email meets the product they were invited to rather than a
            bare form. */}
        <div className="space-y-5">
          <BrandLogo tagline />

          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Join your pharmacy</h1>
            <p className="text-sm text-muted-foreground">
              Use the code your owner sent you, and choose your own password.
            </p>
          </div>
        </div>

        {isDemoMode() && (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            Demo mode: there is no backend to join. Sign in with a seeded account instead —{' '}
            {DEMO_ACCOUNTS.map((account) => account.email).join(', ')}.
          </p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="join-token">Invitation code</Label>
            <Input
              id="join-token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="paste the code you were sent"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="join-email">Your email address</Label>
            <Input
              id="join-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Must match the address the invitation was sent to.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="join-password">Choose a password</Label>
            <Input
              id="join-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At least {MIN_PASSWORD_LENGTH} characters. It goes straight to the sign-in
              service, which stores it — this app never sees or keeps it.
            </p>
          </div>

          {problem && (
            <p role="alert" className="rounded-lg border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning">
              {problem}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy || !token.trim() || !email.trim()}>
            {busy ? 'Setting up…' : 'Create my account'}
          </Button>
        </form>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            The code only works for the address it was sent to. If you were sent it by
            mistake, ask your owner for a new one.
          </span>
        </p>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span>
            Already have an account? Enter your existing password above and use the same
            code. You will be signed in, then asked to redeem the invitation on the next
            screen.
          </span>
        </p>
      </div>

      <Toaster position="bottom-right" />
    </div>
  );
}

/**
 * The explicit redemption step.
 *
 * Reached two ways: a session already existed when the link was opened, or the
 * already-registered path signed the person in just above. Both mean the same
 * thing — authenticated, holding a code that has not been exchanged for a
 * membership.
 *
 * Redemption is a button and not something that happens on arrival, for two
 * reasons. It is the step that can fail (a withdrawn code, a code issued to a
 * different address, an expired invitation), and a failure that happens silently
 * on page load is exactly how the previous version lost the membership without
 * saying so. And the person has just signed in or confirmed an address; being
 * told what the next action is beats being dropped into an app they cannot use
 * yet.
 */
function RedeemScreen({ token }: { token: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState(false);

  const redeem = async () => {
    setBusy(true);
    setProblem(null);

    const result = await redeemInvitation(token);

    setBusy(false);

    if (!result.ok) {
      // Nothing is claimed here. `redeemInvitation` also sets `profiles.branch_id`,
      // so a failure after the membership was created is a partial success and
      // its message says so rather than pretending nothing happened.
      setProblem(result.error);
      return;
    }

    setRedeemed(true);
  };

  if (redeemed) {
    return (
      <div className="flex min-h-dvh items-start justify-center overflow-y-auto p-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-success-subtle text-success">
            <BadgeCheck className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">You&rsquo;re on the team</h1>
            <p className="text-sm text-muted-foreground">
              Your invitation has been accepted and you have access to this pharmacy.
            </p>
          </div>
          <Button type="button" className="w-full" onClick={() => void navigate({ to: '/dashboard' })}>
            Go to the dashboard
          </Button>
        </div>

        <Toaster position="bottom-right" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-start justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Redeem your invitation</h1>
          <p className="text-sm text-muted-foreground">
            You&rsquo;re signed in. One more step to give you access to this pharmacy.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="redeem-token">Invitation code</Label>
          <Input
            id="redeem-token"
            value={token}
            readOnly
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        {problem && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-warning"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{problem}</span>
          </p>
        )}

        <Button
          type="button"
          className="w-full"
          disabled={busy || !token.trim()}
          onClick={() => void redeem()}
        >
          {busy ? 'Redeeming…' : 'Redeem invitation'}
        </Button>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            The code only works for the address it was sent to. If it was withdrawn, or
            sent to someone else, ask your owner for a new one.
          </span>
        </p>
      </div>

      <Toaster position="bottom-right" />
    </div>
  );
}

/** Shown when the deployment cannot authenticate anyone at all. */
function NotAvailable() {
  return (
    <div className="flex min-h-dvh items-start justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Not available</h1>
        <p className="text-sm text-muted-foreground">
          This deployment cannot create accounts. Ask your owner for a direct link, or sign
          in if you already have a password.
        </p>
      </div>
    </div>
  );
}