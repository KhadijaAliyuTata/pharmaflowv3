import { useEffect, useState } from 'react';
import { Navigate, createFileRoute } from '@tanstack/react-router';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Toaster } from '~/components/ui/sonner';
import { toast } from 'sonner';
import { DEMO_ACCOUNTS, configProblem, isDemoMode, signIn, signUpWithInvitation, useSession } from '~/lib/session';

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

  const [token, setToken] = useState(fromLink ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (fromLink) setToken(fromLink);
  }, [fromLink]);

  // Already signed in: they should sign in instead of creating a second account.
  if (status === 'authenticated') return <Navigate to="/" />;

  const problem0 = configProblem();
  if (problem0) return <NotAvailable />;

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
    // they can sign in with the password they already have and redeem the same code.
    if (result.code === 'already_registered') {
      const signedIn = await signIn(email.trim(), password);
      if (signedIn.ok) {
        toast.success('Signed in — redeeming your invitation');
        return;
      }
      setProblem(
        'You already have an account at this address, and that password did not match. Sign in with your existing password to accept the invitation.',
      );
      return;
    }

    setProblem(result.error);
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Join your pharmacy</h1>
          <p className="text-sm text-muted-foreground">
            Use the code your owner sent you, and choose your own password.
          </p>
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
              It goes straight to the sign-in service. This app never stores it.
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
            Already have an account? Use your existing password above and the same code —
            you will be signed in and the invitation redeemed.
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
    <div className="flex min-h-dvh items-center justify-center p-6">
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