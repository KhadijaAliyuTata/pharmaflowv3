import { useEffect, type ReactNode } from 'react';
import { startSession } from '~/lib/session';
import { resolveActiveBranch } from '~/lib/supabase/branch-context';
import { useHydratePharmacy } from '~/store/pharmacy';

/**
 * Starts the auth listener, the domain store's persistence hydration, and
 * resolves the active branch.
 *
 * All three are effects because all three touch `localStorage` or the network,
 * none of which exist during SSR. Demo mode has already resolved by the time this
 * runs — `startSession` is a no-op there and `resolveActiveBranch` returns the
 * seeded branch synchronously — so the server-rendered HTML and the first client
 * paint still agree.
 *
 * `resolveActiveBranch` runs after `startSession` because it needs a session to
 * ask `pf_my_branches` about. It never throws: a failure resolves to a status the
 * UI can render, because a user with no branch membership must see that plainly
 * rather than a blank screen.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void (async () => {
      startSession();
      await resolveActiveBranch();
    })();
  }, []);

  useHydratePharmacy();

  return <>{children}</>;
}
