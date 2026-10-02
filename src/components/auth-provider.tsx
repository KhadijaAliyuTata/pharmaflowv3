import { useEffect, type ReactNode } from 'react';
import { startSession } from '~/lib/session';
import { useHydratePharmacy } from '~/store/pharmacy';

/**
 * Starts the auth listener and the domain store's persistence hydration.
 *
 * Both are effects because both touch `localStorage` and (for auth) the
 * network, neither of which exist during SSR. Demo mode has already resolved
 * by the time this runs, so `startSession` is a no-op there.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    startSession();
  }, []);

  useHydratePharmacy();

  return <>{children}</>;
}
