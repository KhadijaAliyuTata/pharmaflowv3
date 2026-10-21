/**
 * The sign-out decision for local offline data.
 *
 * A purge is only safe when the device has no unsynchronised or unresolved
 * evidence. Pending outbox rows, terminal conflicts, foreign-stamped strays and
 * a valid unresolved-settlement note all count: deleting any of them could
 * silently destroy evidence of a sale the server has not settled. In every
 * uncertain or non-empty case the data is retained and the user is warned.
 */

import type { OfflineIdentityWork } from './local-db';

export type SignOutDecision =
  | { action: 'purge'; pending: 0; warning: null }
  | { action: 'retain'; pending: number; warning: string }
  | { action: 'retain-unidentified'; pending: 0; warning: string };

export function decideOfflineSignOut(
  work: OfflineIdentityWork | null,
): SignOutDecision {
  if (!work) {
    return {
      action: 'retain-unidentified',
      pending: 0,
      warning:
        'Signed out. This device could not verify which offline till data belongs to the account, so any saved sales were left in place instead of being deleted.',
    };
  }

  const pending = work.outbox + work.conflicts + work.strays;
  const unresolved = work.unresolved ?? 0;
  if (unresolved > 0) {
    const evidence = unresolved === 1 ? 'item remains' : 'items remain';
    const pendingNote =
      pending > 0
        ? ` ${pending} unsynchronised ${pending === 1 ? 'item also remains' : 'items also remain'}; those were kept too.`
        : '';
    return {
      action: 'retain',
      pending: pending + unresolved,
      warning: `${unresolved} unresolved settlement evidence ${evidence} on this device. It was kept, not deleted. Sign back in and check the sales ledger before re-ringing anything.${pendingNote}`,
    };
  }
  if (pending > 0) {
    const noun = pending === 1 ? 'item' : 'items';
    return {
      action: 'retain',
      pending,
      warning: `${pending} unsynchronised ${noun} remain on this device. They were kept, not deleted. Sign back in to sync or review them.`,
    };
  }

  return { action: 'purge', pending: 0, warning: null };
}
