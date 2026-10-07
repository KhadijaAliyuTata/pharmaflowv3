import { isDemoMode } from '~/lib/session';

/**
 * May a catalogue row be edited yet?
 *
 * ## The mismatch this exists to close
 *
 * The catalogue **reads** from Supabase in live mode, through `useMedicines`. The
 * catalogue **writes** still go through `usePharmacyActions()`, which rewrites
 * `state.medicines` and persists the whole `AppState` to `pharmaflow:state:v3`.
 *
 * Those two are no longer talking about the same rows. The list a pharmacist is
 * looking at came from Postgres; the collection an edit mutates is the seeded
 * prototype copy in localStorage. So "Adjust stock" on a real product would have
 * appeared to succeed, changed nothing in the database, and then reverted on the
 * next render because the screen re-read from Supabase — or worse, silently
 * diverged if something else still read the store.
 *
 * That is the failure mode the whole migration exists to remove, arriving through
 * the write side. So the write controls are **disabled in live mode** until the
 * write paths are migrated, rather than left clickable and quietly wrong.
 *
 * ## Why this lives in the UI layer
 *
 * The store would be the stronger place for this guard — it cannot be bypassed by a
 * caller that forgets to check. It is deliberately *not* put there: `session.ts`
 * imports `setPharmacyCurrentUser` from `~/store/pharmacy`, so a store import back
 * to `session.ts` would close a cycle. Introducing one to carry a boolean is a worse
 * trade than disabling the controls, which is what actually prevents the click.
 *
 * The residual risk is that a future caller invokes `usePharmacyActions()` without
 * consulting this module. That is called out in the write-phase notes.
 *
 * ## Demo mode is unaffected
 *
 * `isDemoMode()` is constant-false in a production build (`DEMO_ALLOWED` folds), so
 * the available branch is dead code there and the demo credentials are tree-shaken
 * out. In a dev build with demo mode on, the store *is* the catalogue and editing
 * works exactly as it always did.
 */
export function catalogueWritesAvailable(): boolean {
  return isDemoMode();
}

/**
 * Shown in place of the write controls. Says what happened and what is coming, so a
 * pharmacist reads it as "not yet", not as "you are not allowed".
 */
export const CATALOGUE_WRITE_UNAVAILABLE =
  'Editing the live catalogue is not available yet — this pharmacy’s catalogue is being moved to the database. Nothing has been changed.';
