import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppState, Branch } from '~/domain/state';
import type { User } from '~/domain/types';
import { createEmptyState, createSeedState } from '~/domain/seed';
import { isDemoMode } from '~/lib/build-mode';
import * as ops from '~/domain/operations';
import type { Result } from '~/domain/operations';

const STORAGE_KEY = 'pharmaflow:state:v3';

/**
 * A tiny external store rather than context.
 *
 * v2's 2,711-line context meant every sale re-rendered the sidebar, the navbar
 * and every screen. `useSyncExternalStore` with a selector gives each component
 * only the slice it reads, and the equality check stops unchanged slices from
 * causing a render at all.
 *
 * The initial state is the seed in a demo build and empty in a live one, chosen
 * from a build-time constant so the server snapshot and the first client render
 * agree. Persisted state — which only a demo build has — is applied after mount.
 */
class PharmacyStore {
  /**
   * Created on first read, never at module evaluation.
   *
   * The Workers runtime has no clock while modules are evaluated, so seeding
   * there anchors every demo date to 1970 on the server while the browser seeds
   * against the real date — a guaranteed hydration mismatch. Deferring to the
   * first render puts both sides on the same request-time clock.
   */
  private _state: AppState | null = null;
  private get state(): AppState {
    return (this._state ??= isDemoMode() ? createSeedState() : createEmptyState());
  }
  private set state(next: AppState) {
    this._state = next;
  }

  /**
   * The snapshot the server rendered, kept immutable for hydration.
   *
   * `useSyncExternalStore` compares the first client render against this value,
   * not against the live store. Persisted demo state must never land here: a
   * store write during React's hydration pass would change text the server
   * already sent (React #418) — which it did whenever `localStorage` held a
   * sale.
   */
  private _serverState: AppState | null = null;
  private listeners = new Set<() => void>();
  private hydrated = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AppState => this.state;

  /**
   * Server snapshot. Must be referentially stable across calls.
   *
   * This is the seed, never the live store: React uses it for the hydration
   * render, so it has to describe exactly what the server sent even if the
   * persisted state has already been read.
   */
  getServerState = (): AppState =>
    (this._serverState ??= isDemoMode() ? createSeedState() : createEmptyState());

  private emit() {
    for (const listener of this.listeners) listener();
  }

  setState(next: AppState) {
    this.state = next;
    this.emit();
    this.schedulePersist();
  }

  /**
   * Loads persisted state, once. Safe to call on every mount — repeats are
   * no-ops. Never called during render, because it reads localStorage.
   */
  hydrate(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    this.hydrated = true;

    // Live mode has no legitimate persisted state: the only thing this key ever
    // held is the demo prototype. Merging it back would resurrect seeded rows
    // into a live session on every reload — the exact failure this gating exists
    // to remove — so hydration is a demo-only path.
    if (!isDemoMode()) return;

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as Partial<AppState>;
      if (!parsed || typeof parsed !== 'object') return;

      // Merge onto the seed so a state written by an older build is still
      // usable after this one adds a collection.
      this.state = { ...createSeedState(), ...parsed };
      this.emit();
    } catch {
      // Corrupt payload. Start clean rather than leaving the app unusable.
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }

  /**
   * Debounced so a burst of edits writes once. POS typing into a cart does not
   * serialise the whole state on every keystroke.
   */
  private schedulePersist() {
    // Persistence is the demo prototype's only. In live mode nothing reads this
    // key (hydration returns early above), so writing it would only leave a stale
    // copy of the tenant identity behind — skip it.
    if (!isDemoMode()) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        // Quota exceeded or private mode. The app still works in memory.
      }
    }, 400);
  }

  reset() {
    this.state = isDemoMode() ? createSeedState() : createEmptyState();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.emit();
  }
}

const store = new PharmacyStore();

/**
 * Caches a selector's result against the identity of the state it was derived
 * from.
 *
 * `useSyncExternalStore` compares snapshots with `Object.is` on every render,
 * so a selector that builds a new object or array (`state.sales.slice(0, 5)`,
 * `dashboardSnapshot(state)`) must not be re-run while the state is unchanged —
 * React would see a "changed" snapshot each pass, re-render, and run it again
 * until it gave up with "Maximum update depth exceeded".
 *
 * Keying the cache on the state object means the value is recomputed exactly
 * when the store changes and reused verbatim in between.
 */
function useSelectedSnapshot<T>(
  getState: () => AppState,
  selector: (state: AppState) => T,
): () => T {
  const cache = useRef<{ state: AppState; value: T } | undefined>(undefined);

  return useCallback((): T => {
    const current = getState();
    const hit = cache.current;

    if (hit !== undefined && hit.state === current) {
      return hit.value;
    }

    const value = selector(current);
    cache.current = { state: current, value };
    return value;
  }, [getState, selector]);
}

/**
 * False on the server and during the first client render, true once this
 * component has mounted.
 *
 * Persisted demo state must not replace the server-rendered snapshot until the
 * component that displays it has finished hydrating. Checking per component
 * (rather than once at the root) also covers lazily loaded routes, which finish
 * hydrating after the root effect has already run.
 */
function useIsMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Read a slice of state. The selector may be an inline arrow — derived values
 * are safe, because the result is cached per store state.
 *
 * The server snapshot is derived from the immutable seed (what the server
 * actually rendered), not from the live store, so persisted client state cannot
 * change the hydration render.
 */
export function usePharmacy<T>(selector: (state: AppState) => T): T {
  const mounted = useIsMounted();
  const getSnapshot = useSelectedSnapshot(store.getState, selector);
  const getServerSnapshot = useSelectedSnapshot(store.getServerState, selector);
  return useSyncExternalStore(
    store.subscribe,
    mounted ? getSnapshot : getServerSnapshot,
    getServerSnapshot,
  );
}

/** The whole state, for the rare component that genuinely needs it. */
export function usePharmacyState(): AppState {
  const mounted = useIsMounted();
  return useSyncExternalStore(
    store.subscribe,
    mounted ? store.getState : store.getServerState,
    store.getServerState,
  );
}

export function useHydratePharmacy() {
  useEffect(() => store.hydrate(), []);
}

export function useResetPharmacy() {
  return useCallback(() => store.reset(), []);
}

/* ---------------------------------------------------------------- actions */

/**
 * Runs an operation and applies it only on success, so a rejected sale leaves
 * the UI untouched and the error is shown where the attendant made it.
 */
function apply<T>(result: Result<T>): Result<T> {
  if (result.ok) store.setState(result.state);
  return result;
}

export function usePharmacyActions() {
  const checkout = useCallback(
    (input: Parameters<typeof ops.checkout>[1]) => apply(ops.checkout(store.getState(), input)),
    [],
  );

  const voidSale = useCallback(
    (saleId: string, reason: string) => apply(ops.voidSale(store.getState(), saleId, reason)),
    [],
  );

  const receiveStock = useCallback(
    (input: Parameters<typeof ops.receiveStock>[1]) =>
      apply(ops.receiveStock(store.getState(), input)),
    [],
  );

  const approvePricing = useCallback(
    (receiptId: string, cost: number, price: number) =>
      apply(ops.approvePricing(store.getState(), receiptId, cost, price)),
    [],
  );

  const updatePrice = useCallback(
    (medicineId: string, price: number) =>
      apply(ops.updatePrice(store.getState(), medicineId, price)),
    [],
  );

  const updateUnitPrice = useCallback(
    (medicineId: string, unitKey: string, sellingPrice: number) =>
      apply(ops.updateUnitPrice(store.getState(), medicineId, unitKey, sellingPrice)),
    [],
  );

  /** Owner-only, history-aware. See `ops.updateUnits`. */
  const updateUnits = useCallback(
    (medicineId: string, units: AppState['medicines'][number]['units']) =>
      apply(ops.updateUnits(store.getState(), medicineId, units)),
    [],
  );

  const setSafetyLock = useCallback(
    (medicineId: string, locked: boolean, reason?: string) =>
      apply(ops.setSafetyLock(store.getState(), medicineId, locked, reason)),
    [],
  );

  const setBatchRecall = useCallback(
    (batchId: string, recalled: boolean, reason?: string) =>
      apply(ops.setBatchRecall(store.getState(), batchId, recalled, reason)),
    [],
  );

  const adjustStock = useCallback(
    (medicineId: string, quantity: number, reason: string) =>
      apply(ops.adjustStock(store.getState(), medicineId, quantity, reason)),
    [],
  );

  const recordCreditPayment = useCallback(
    (accountId: string, amount: number, note: string) =>
      apply(ops.recordCreditPayment(store.getState(), accountId, amount, note)),
    [],
  );

  const registerCustomer = useCallback(
    (name: string, phone: string) =>
      apply(ops.registerCustomer(store.getState(), name, phone)),
    [],
  );

  const recordCustomerPayment = useCallback(
    (saleId: string, amount: number, method: Parameters<typeof ops.recordCustomerPayment>[3], note?: string) =>
      apply(ops.recordCustomerPayment(store.getState(), saleId, amount, method, note)),
    [],
  );

  const markNotificationRead = useCallback((id: string) => {
    store.setState(ops.markNotificationRead(store.getState(), id));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    store.setState(ops.markAllNotificationsRead(store.getState()));
  }, []);

  return {
    checkout,
    voidSale,
    receiveStock,
    approvePricing,
    updatePrice,
    updateUnitPrice,
    updateUnits,
    setSafetyLock,
    setBatchRecall,
    adjustStock,
    recordCreditPayment,
    registerCustomer,
    recordCustomerPayment,
    markNotificationRead,
    markAllNotificationsRead,
  };
}

/* ------------------------------------------------------------------ roles */

/**
 * Non-reactive reads, for callers that live outside React — the session layer
 * resolves a persisted user id against `state.users`, and route guards run
 * before anything is rendered.
 */
export function getPharmacyState(): AppState {
  return store.getState();
}

export function getPharmacyUsers(): User[] {
  return store.getState().users;
}

/**
 * Mirrors the signed-in person into `currentUser`, which is the actor that
 * operations stamp onto sales, receipts and audit events. Owned by
 * `~/lib/session`; idempotent, so restoring the same session on reload
 * notifies nobody.
 */
export function setPharmacyCurrentUser(user: User): void {
  const state = store.getState();
  if (state.currentUser.id === user.id) return;
  store.setState({ ...state, currentUser: user });
}

/**
 * Mirror the active branch into the store, for the header and settings screens.
 *
 * Owned by `~/lib/tenant-sync`, which reads it from `loadCurrentBranch()`. Before
 * that resolves, `state.branch` is the empty placeholder from
 * `createEmptyState()` — a blank label, never a plausible-looking number or a
 * seeded address. Display only: nothing security-relevant reads this object,
 * because it is client memory.
 */
export function setPharmacyBranch(branch: Branch): void {
  const state = store.getState();
  if (state.branch.id === branch.id && state.branch.name === branch.name) return;
  store.setState({ ...state, branch });
}

/**
 * Mirror the branch's team into the store, for the dashboard team table.
 *
 * Owned by `~/lib/tenant-sync`, which maps `listStaff()` onto `User`. Role here is
 * display only — the authoritative gate is `useIsOwner()`/`pf_is_owner`, not this
 * array.
 */
export function setPharmacyUsers(users: User[]): void {
  const state = store.getState();
  if (state.users === users) return;
  store.setState({ ...state, users });
}

export function useCurrentUser() {
  return usePharmacy((state) => state.currentUser);
}

export function useCan(action: Parameters<typeof ops.can>[1]) {
  const role = usePharmacy((state) => state.currentUser.role);
  return ops.can(role, action);
}
