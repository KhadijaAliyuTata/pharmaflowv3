import { useEffect, type ReactNode } from 'react';
import { startSession } from '~/lib/session';
import { resolveActiveBranch } from '~/lib/supabase/branch-context';
import { syncLiveTenant } from '~/lib/tenant-sync';
import { useHydratePharmacy } from '~/store/pharmacy';

/**
 * Starts the auth listener, the domain store's persistence hydration, resolves the
 * active branch, and mirrors the live branch and team into the store.
 *
 * All four are effects because all four touch `localStorage` or the network, none
 * of which exist during SSR. Demo mode has already resolved by the time this runs —
 * `startSession` is a no-op there, `resolveActiveBranch` returns the seeded branch
 * synchronously, and `syncLiveTenant` returns immediately — so the server-rendered
 * HTML and the first client paint still agree.
 *
 * `resolveActiveBranch` runs after `startSession` because it needs a session to
 * ask `pf_my_branches` about. `syncLiveTenant` runs last because it reads the
 * branch that resolution committed. None of them throws: a failure resolves to a
 * status the UI can render, because a user with no branch membership must see that
 * plainly rather than a blank screen.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void (async () => {
      startSession();
      await resolveActiveBranch();
      await syncLiveTenant();
    })();
  }, []);

  useHydratePharmacy();

  return <>{children}</>;
}
