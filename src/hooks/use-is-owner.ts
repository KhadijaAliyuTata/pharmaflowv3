import { useEffect, useState } from 'react';
import { isOwner as queryIsOwner } from '~/lib/supabase/tenant';
import { isSupabaseConfigured } from '~/lib/supabase/client';
import { isDemoMode } from '~/lib/session';
import { usePharmacy } from '~/store/pharmacy';

/**
 * The authoritative role: is this session an owner, according to the database?
 *
 * ## Why this exists rather than `role === 'owner'`
 *
 * Thirteen screens derived ownership from `state.currentUser.role`, which comes
 * from `profiles.role`. That column is a **display cache**. Migration 8 made
 * `branch_memberships.role` the authoritative source: `pf_current_role()` reads the
 * membership row scoped to `pf_current_branch()`, and `profiles.role` is written
 * only by `pf_sync_profile_membership` with `on conflict do nothing` — which means
 * the cache is never *repaired*. A user demoted at their branch keeps the owner UI
 * indefinitely, and the UI would then contradict what the database actually allows.
 *
 * `tenant.ts#isOwner` already asks the right question, calling `pf_is_owner()`.
 * This hook is the React-shaped wrapper around it.
 *
 * ## What it is not
 *
 * This is display gating. It decides which buttons render, not what is permitted.
 * An assistant who forges this to `true` still cannot delete a medicine, cannot
 * write a purchase cost, and cannot change packaging units, because each of those
 * is refused by an RLS policy or a BEFORE trigger in the database. The UI check
 * being wrong in the permissive direction is a cosmetic problem; the reverse would
 * merely hide functionality from a legitimate owner.
 *
 * In demo mode there is no backend, so it falls back to the seeded user, which is
 * what keeps the demo build working.
 *
 * @returns `true` / `false`, or `null` before the answer arrives. `null` is not
 *          treated as owner: callers use it to withhold owner affordances until the
 *          database has actually spoken.
 */
export function useIsOwner(): boolean {
  const [owner, setOwner] = useState<boolean | null>(null);

  // Demo only. In a production build `isDemoMode()` is constant-false, so this
  // branch is dead code and cannot ship.
  const demoRole = usePharmacy((state) => state.currentUser.role);
  const demo = isDemoMode();

  useEffect(() => {
    if (demo || !isSupabaseConfigured()) {
      setOwner(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // `isOwner` returns false on any error, so a failed check resolves to the
      // attendant view. That is the direction to fail in.
      const result = await queryIsOwner();
      if (!cancelled) setOwner(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [demo]);

  if (demo) return demoRole === 'owner';
  return owner ?? false;
}
