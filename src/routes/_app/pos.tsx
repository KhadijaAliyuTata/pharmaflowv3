import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  Banknote,
  FileText,
  Minus,
  Plus,
  ScanLine,
  Search,
  ShoppingCart,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { BarcodeScanner } from '~/components/barcode-scanner';
import {
  PrescriptionDialog,
  type PrescriptionDraft,
} from '~/components/prescription-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Switch } from '~/components/ui/switch';
import { Money, PageHeader, StatTile, StatusBadge } from '~/components/app/primitives';
import {
  ReceiptDialog,
  ReceiptPrintArea,
  type ReceiptData,
} from '~/components/app/sale-receipt';
import { cn } from '~/lib/cn';
import { useHotkeys } from '~/lib/use-hotkeys';
import { isDemoMode, useSession } from '~/lib/session';
// The module directly, not `~/lib/supabase`: that specifier resolves to the
// client singleton in `src/lib/supabase.ts`, which shadows the `supabase/`
// directory. The barrel has the same export, but this path is unambiguous.
import { completeSale as completeSaleRemote } from '~/lib/supabase/sales';
import { createCustomer } from '~/lib/supabase/parties';
import { toCustomer } from '~/hooks/customer-mapping';
import {
  effectiveRole,
  roleForBranch,
  useActiveBranch,
} from '~/lib/supabase/branch-context';
import { add, money, multiply, subtract, sum } from '~/domain/money';
import { convertToBaseUnits, findUnit } from '~/domain/units';
import {
  saleBlock,
  salesSince,
  searchMedicines,
  sellableQuantity,
  stockStatus,
  summariseSales,
} from '~/domain/selectors';
import { useMedicines } from '~/hooks/use-medicines';
import { useCustomers } from '~/hooks/use-customers';
import { useSales } from '~/hooks/use-sales';
import { useCurrentUser, usePharmacy, usePharmacyActions } from '~/store/pharmacy';
import type { CartLine, Medicine, PaymentMethod, Sale, StaffRole, TradeUnit } from '~/domain/types';
import type { LocalRole } from '~/offline/db-schema';
// ---------------------------------------------------------------------------
// Phase 3 — offline sale safety net for THIS screen only.
//
// One screen, one server path: a sale that cannot reach the server is recorded
// durably under the SAME idempotency key the online path would have used, and
// the sync engine drains it through the existing `pf_complete_sale` RPC. No
// other module is offline, and none of these imports make it so.
import { probeServer, type ProbeResult } from '~/offline/probe';
import { createSyncEngine } from '~/offline/sync-engine';
import {
  OfflineRepo,
  OfflineStorageError,
  VERY_STALE_MS,
  type StorageFailureKind,
} from '~/offline/local-db';
import { emptyDeviceSales, loadDeviceSales, type DeviceSales } from '~/offline/device-sales';
import {
  cachePosCatalogue,
  cachePosCustomers,
  formatCacheAge,
  isCachedSliceUsable,
  readPosCache,
  type PosCacheSnapshot,
  type PosCustomer,
} from '~/offline/pos-cache';
import {
  OFFLINE_CASH_ONLY_MESSAGE,
  offlineSettlementError,
} from '~/offline/payment-policy';
import {
  UNRESOLVED_ATTEMPT_META_KEY,
  attemptSettlementLabel,
  clearUnresolvedAttempt,
  isUnverifiedCompletedReplay,
  parseUnresolvedAttempt,
  persistUnresolvedAttempt,
  reconciliationRepoMatches,
  unresolvedAttemptBlock,
  unresolvedNonCashAttempt,
  type UnresolvedSaleAttempt,
} from '~/offline/settlement-reconciliation';
import {
  POS_SALE_OP_TYPE,
  classifySaleFailure,
  createPosSaleHandler,
  recordSaleIntent,
  type ConfirmedSaleView,
  type PendingSaleView,
} from '~/offline/pos-offline';

/**
 * Attendant-facing reason for a persistence throw, keyed by the classified
 * kind. Kind-specific where the difference changes what the attendant does
 * (storage full vs. a reload needed), generic otherwise. A final "NOT saved"
 * sentence is always added by the caller, because a throw from persistence
 * means nothing was written anywhere the attendant could rely on.
 */
const STORAGE_FAILURE_TEXT: Record<StorageFailureKind, string> = {
  quota: 'device storage is full',
  clone: 'the sale could not be stored on this device',
  constraint: 'the device refused to store the sale',
  version: 'this device needs a page reload to store sales',
  blocked: 'storage is blocked — close the other tabs on this device and reload before selling',
  abort: 'the write was interrupted',
  unknown: 'the device storage failed',
};

const describeStorageFailure = (error: unknown): string =>
  error instanceof OfflineStorageError ? STORAGE_FAILURE_TEXT[error.kind] : STORAGE_FAILURE_TEXT.unknown;

export const Route = createFileRoute('/_app/pos')({
  component: PointOfSale,
});

/** A cart entry is only a choice; everything priced is derived at checkout. */
interface CartEntry {
  medicineId: string;
  unitKey: string;
  quantity: number;
}

interface DeviceSalesState {
  /** The repo identity this state belongs to. Prevents one branch flashing into another. */
  identityKey: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: DeviceSales;
  error: string | null;
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'pos_card', label: 'POS card' },
  { value: 'wallet', label: 'Wallet' },
];

/** How the total is settled, as the four tills states people actually use. */
type PayMode = 'full' | 'part' | 'debt' | 'split';

const PAY_MODES: { value: PayMode; label: string; hint: string }[] = [
  { value: 'full', label: 'Full', hint: 'Pays the whole total now, in one method' },
  { value: 'part', label: 'Part', hint: 'Some now — the rest is written to the customer\'s debt' },
  { value: 'debt', label: 'Debt', hint: 'Takes the medicines now, pays the whole total later' },
  { value: 'split', label: 'Split', hint: 'Two methods together — cash plus bank transfer' },
];

const NO_ACCOUNT = 'none';

/**
 * A key the server can recognise a repeated submission by.
 *
 * `crypto.randomUUID` is not available on every origin this has to run on, so
 * the fallback is not decorative. Uniqueness only has to hold per cart, and the
 * timestamp prefix keeps two carts in the same millisecond apart.
 */
function newIdempotencyKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `pos-${uuid}`;
}

function PointOfSale() {
  // Catalogue from Supabase in live mode; useMedicines has no local
  // fallback there, so a failed read surfaces as an error, not as seed data.
  const {
    medicines: liveMedicines,
    loading: medicinesLoading,
    error: medicinesError,
    branchId: medicinesBranchId,
    refresh: refreshMedicines,
  } = useMedicines();
  // In demo mode the store *is* the pharmacy and checkout stays local, exactly
  // as it always was. In live mode the sale is the database's to record.
  const live = !isDemoMode();
  const currentUser = useCurrentUser();
  const creditAccounts = usePharmacy((state) => state.creditAccounts);
  // The ledger, in whichever mode has one. `useSales` reads Supabase in a live
  // build and the seeded ledger in demo, so this is the same figure either way —
  // but `state.sales` is empty live, which would pin "Taken today" at ₦0 however
  // busy the till was.
  const { sales, loading: salesLoading, error: salesError, refresh: refreshSales } = useSales();
  // Customers in either mode — demo store list or the live branch read. The
  // customer finder and the walk-in rules both read this one list.
  const {
    customers: liveCustomers,
    loading: customersLoading,
    error: customersError,
    branchId: customersBranchId,
    refresh: refreshCustomers,
  } = useCustomers();
  const { checkout, registerCustomer: registerCustomerAction } = usePharmacyActions();

  const today = useMemo(() => summariseSales(salesSince(sales, 24)), [sales]);

  // The cart is a register session, not domain data. Persisting it would let a
  // half-finished sale survive a reload and be rung up against yesterday's stock.
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [query, setQuery] = useState('');

  const [discountInput, setDiscountInput] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  /** Which of the four settlement states the checkout is in. */
  const [payMode, setPayMode] = useState<PayMode>('full');
  const [tenderedInput, setTenderedInput] = useState('');
  const [partPaidInput, setPartPaidInput] = useState('');
  const [splitCashInput, setSplitCashInput] = useState('');
  const [splitTransferInput, setSplitTransferInput] = useState('');
  const [customerId, setCustomerId] = useState(NO_ACCOUNT);
  const [creditAccountId, setCreditAccountId] = useState(NO_ACCOUNT);
  const [dispensedAgainstPrescription, setDispensedAgainstPrescription] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  /**
   * True while a server round trip is in flight.
   *
   * The complete button is disabled and the hotkeys are ignored while this is
   * set, so an attendant who double-clicks cannot submit twice. The idempotency
   * key below is the second line of defence: the server returns the original
   * sale for a repeated key, so even a submission that slipped past this guard
   * cannot ring up twice.
   */
  const [submitting, setSubmitting] = useState(false);
  /** One key per cart, reused across retries and replaced when the cart clears. */
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());
  /**
   * A non-cash attempt whose outcome the server never confirmed.
   *
   * Deliberately NOT a reason to mint a new key: reusing the old key is how the
   * server would replay the original non-cash sale, and a new key would hide
   * that uncertainty. The cart and this evidence stay put until a person checks
   * the ledger and explicitly resolves the attempt.
   */
  const [unresolvedAttempt, setUnresolvedAttempt] = useState<UnresolvedSaleAttempt | null>(
    null,
  );
  const [scannerOpen, setScannerOpen] = useState(false);
  const [prescriptionOpen, setPrescriptionOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** The last completed sale, flattened for the customer's receipt. */
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  /* --------------------------------------------------------------- offline */
  //
  // Phase 3 wiring: probe + sync + truthful device states, THIS SCREEN ONLY.
  // Demo mode keeps its original all-local path and opens nothing here.

  // The per-(pharmacy, user) device database only exists for a live, signed-in
  // session with an active branch — the same identity keys the sale carries.
  const session = useSession();
  const activeBranch = useActiveBranch();
  const { currentBranchId } = activeBranch;
  const offlineBranch = activeBranch.source === 'cache';
  const offlineIdentity = useMemo(() => {
    if (!live || !session.user || !currentBranchId) return null;
    return {
      pharmacyId: currentBranchId,
      userId: session.user.id,
      // A cached branch is never allowed to reopen an owner-scoped local cache.
      role: effectiveRole(
        activeBranch.source,
        roleForBranch(currentBranchId),
        session.user.role,
      ) as StaffRole,
    };
  }, [live, session.user, currentBranchId, activeBranch]);
  const offlineIdentityKey = offlineIdentity
    ? `${offlineIdentity.pharmacyId}:${offlineIdentity.userId}:${offlineIdentity.role}`
    : null;
  // The storage identity is branch+user; role changes open the same database.
  // Reconciliation evidence is cleared only when this key still matches the
  // identity that produced it.
  const offlineStorageIdentityKey = offlineIdentity
    ? `${offlineIdentity.pharmacyId}:${offlineIdentity.userId}`
    : null;
  // Mirror the unresolved attempt outside React state so an identity-change
  // effect whose closure predates the latest render cannot clear or replace it.
  const unresolvedAttemptRef = useRef<UnresolvedSaleAttempt | null>(null);
  const unresolvedAttemptOriginRef = useRef<string | null>(null);
  // The repository that owns the durable note, captured when the attempt began
  // (or when the matching note was restored). Resolution must use THIS handle,
  // never whatever repoRef happens to point at after an await/identity change.
  const unresolvedAttemptRepoRef = useRef<OfflineRepo | null>(null);
  const unresolvedAttemptPersistedRef = useRef(false);

  const repoRef = useRef<OfflineRepo | null>(null);
  const [repoReady, setRepoReady] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  // Durable device-side sale states for the panel: saved-but-not-synced,
  // needs-attention, and confirmed-by-server. The identity key ensures a state
  // read for an old branch can never be shown under a new branch.
  const [deviceSalesState, setDeviceSalesState] = useState<DeviceSalesState>({
    identityKey: null,
    status: 'idle',
    data: emptyDeviceSales(),
    error: null,
  });
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);

  // POS read cache. `null` means "not read yet"; a snapshot with `present:
  // false` is a real answer ("this device has never saved one").
  const [cacheState, setCacheState] = useState<PosCacheSnapshot | null>(null);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [cacheReadError, setCacheReadError] = useState<string | null>(null);
  // Re-evaluates the 24-hour cache limit while a till stays open offline; the
  // bucket captured at read time would otherwise stay "stale" forever.
  const [cacheClock, setCacheClock] = useState(() => Date.now());
  const [cacheSaveErrors, setCacheSaveErrors] = useState<{
    catalogue: string | null;
    customers: string | null;
  }>({ catalogue: null, customers: null });

  // Two separate answers, shown separately — the OS's opinion of the network
  // is never conflated with a confirmed server response.
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  // Stable callback set for the engine's onConfirmed: refreshes whatever the
  // latest render considers current (the ledger, the shelf, this panel).
  const onConfirmedRef = useRef<
    (info: {
      receiptNumber: string;
      alreadyCompleted: boolean;
      expectedTotal: number;
      serverTotal: number;
      reconciliation: { reason: string; details: Record<string, unknown> } | null;
    }) => void
  >(() => {});
  onConfirmedRef.current = (info) => {
    if (info.reconciliation) {
      // The server has recorded a sale, but not at the amount this device
      // quoted. Never call that a clean confirmation.
      toast.warning(`${info.receiptNumber} was recorded at a different total`, {
        description: 'Do not collect or refund the difference. Review the sale in the device panel.',
      });
    } else {
      toast.success(`${info.receiptNumber} confirmed by server`);
    }
    refreshSales();
    refreshMedicines();
    setDeviceRefresh((n) => n + 1);
  };

  useEffect(() => {
    repoRef.current = null;
    setRepoReady(false);
    setRepoError(null);
    setSyncError(null);
    // Never clear an unresolved attempt merely because the identity key changed:
    // the cart and idempotency key are still usable, so losing the block would
    // allow a same-key cash retry. The durable note is re-read below, but it can
    // only fill an empty slot; it must not replace an attempt already in memory.
    setCacheState(null);
    setCacheReadError(null);
    setCacheSaveErrors({ catalogue: null, customers: null });
    setCacheLoading(Boolean(offlineIdentity));
    setDeviceSalesState({
      identityKey: offlineIdentityKey,
      status: offlineIdentity ? 'loading' : 'idle',
      data: emptyDeviceSales(),
      error: null,
    });

    if (!offlineIdentity) return;
    const identity = offlineIdentity;
    let closed = false;
    let opened: OfflineRepo | null = null;
    OfflineRepo.open(identity, identity.role as LocalRole)
      .then((repo) => {
        if (closed) {
          repo.close();
          return;
        }
        opened = repo;
        repoRef.current = repo;
        setRepoReady(true);
        setDeviceRefresh((n) => n + 1);
        // Restore a reconciliation block that outlived the cart/reload. The
        // note is evidence only; it is NEVER read back as a queued sale.
        void repo
          .metaGet<unknown>(UNRESOLVED_ATTEMPT_META_KEY)
          .then((value) => {
            if (closed) return;
            const attempt = parseUnresolvedAttempt(value);
            if (!attempt) return;
            const currentAttempt = unresolvedAttemptRef.current;
            if (currentAttempt) {
              // A note from the new identity must not replace the attempt that
              // is still guarding this cart and key. If this IS the origin
              // identity and the note matches, bind its fresh handle so an
              // explicit resolution can clear the correct note later.
              if (
                currentAttempt.idempotencyKey === attempt.idempotencyKey &&
                reconciliationRepoMatches(repo, unresolvedAttemptOriginRef.current)
              ) {
                unresolvedAttemptRepoRef.current = repo;
                unresolvedAttemptPersistedRef.current = true;
              }
              return;
            }
            // The repository was opened for this effect's identity. Refuse to
            // adopt a note unless its actual branch/user agrees with the key.
            if (!reconciliationRepoMatches(repo, offlineStorageIdentityKey)) return;
            unresolvedAttemptRef.current = attempt;
            unresolvedAttemptOriginRef.current = offlineStorageIdentityKey;
            unresolvedAttemptRepoRef.current = repo;
            unresolvedAttemptPersistedRef.current = true;
            setUnresolvedAttempt(attempt);
          })
          .catch(() => {
            // Unreadable meta must not invent a block or claim the ledger is
            // clear; the till simply has no saved note to restore.
          });
      })
      .catch((error) => {
        // Storage may be unavailable (private mode, quota, a blocked upgrade).
        // The till stays online-dependent rather than pretending the sale was
        // saved, and the panel says why instead of silently disappearing.
        if (closed) return;
        const message = `Offline device storage is unavailable (${describeStorageFailure(
          error,
        )}). The online till still works, but offline sales cannot be saved or reopened on this device.`;
        setRepoReady(false);
        setRepoError(message);
        setCacheLoading(false);
        setDeviceSalesState({
          identityKey: offlineIdentityKey,
          status: 'error',
          data: emptyDeviceSales(),
          error: message,
        });
      });
    return () => {
      closed = true;
      opened?.close();
      repoRef.current = null;
    };
  }, [offlineIdentityKey]);

  // Recompute the panel from durable data whenever the outbox may have moved.
  // A read failure preserves whatever was already shown for this identity and
  // reports the failure; it never becomes an empty queue.
  useEffect(() => {
    if (!repoReady || !repoRef.current) return;
    const repo = repoRef.current;
    const identityKey = offlineIdentityKey;
    let stale = false;
    setDeviceSalesState((prev) =>
      prev.identityKey === identityKey
        ? { ...prev, status: 'loading', error: null }
        : {
            identityKey,
            status: 'loading',
            data: emptyDeviceSales(),
            error: null,
          },
    );
    void loadDeviceSales(repo).then((result) => {
      if (stale) return;
      setDeviceSalesState((prev) => {
        if (prev.identityKey !== identityKey) return prev;
        return result.ok
          ? { identityKey, status: 'ready', data: result.data, error: null }
          : { identityKey, status: 'error', data: prev.data, error: result.error };
      });
    });
    return () => {
      stale = true;
    };
  }, [repoReady, deviceRefresh, offlineIdentityKey]);

  const syncingRef = useRef(false);
  const syncNow = useCallback(async () => {
    const repo = repoRef.current;
    if (!repo || !repoReady || syncingRef.current) return;
    syncingRef.current = true;
    setSyncError(null);
    try {
      const engine = createSyncEngine({
        repo,
        handlers: {
          [POS_SALE_OP_TYPE]: createPosSaleHandler({
            completeSale: async (input) => {
              const result = await completeSaleRemote({
                ...input,
                paymentMethod: input.paymentMethod as PaymentMethod,
              });
              return result.ok
                ? { ok: true, ...result.data }
                : { ok: false, error: result.error, code: result.code };
            },
            onConfirmed: (info) => onConfirmedRef.current(info),
          }),
        },
      });
      const summary = await engine.runOnce();
      if (summary.errors.length > 0) {
        const shown = summary.errors.slice(0, 2).join('; ');
        const more =
          summary.errors.length > 2 ? ` (+${summary.errors.length - 2} more)` : '';
        setSyncError(`Automatic sync reported ${summary.errors.length} error(s): ${shown}${more}`);
      } else if (summary.stopped === 'auth-expired') {
        setSyncError(
          'The saved sign-in has expired, so queued sales were not sent. Sign in again; the sales remain on this device.',
        );
      }
      // The ledger itself is the durable confirmation record; refresh it and
      // let onConfirmed handle the notifications per op.
      setDeviceRefresh((n) => n + 1);
    } catch (error) {
      // runOnce reports every ordinary failure as data (summary.errors), so a
      // throw here is an unexpected defect, never a normal failed op. The
      // outbox is untouched — every op stays durably pending, which is what
      // the device panel shows. Refresh the panel and keep the probe loop
      // alive: nothing here may become an unhandled rejection.
      console.error('[pos] sale sync failed unexpectedly', error);
      setSyncError(
        'The automatic sync stopped unexpectedly. Queued sales remain on this device; check the panel before re-selling.',
      );
      setDeviceRefresh((n) => n + 1);
    } finally {
      syncingRef.current = false;
    }
  }, [repoReady]);

  // A periodic probe + a run `online` event. This is deliberately the ONLY
  // place anything drains the outbox, and it lives on this screen: until the
  // same wiring exists on others, a sale recorded there would sit pending —
  // which is exactly why nothing else records intents yet.
  useEffect(() => {
    if (!live || !repoReady) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || syncingRef.current) return;
      const result = await probeServer();
      if (!cancelled) setProbe(result);
      // The engine re-probes nothing; it only runs when the probe has actually
      // confirmed reachability — never on a favourable guess from onLine.
      if (result.serverReachable) await syncNow();
    };
    void tick();
    const timer = setInterval(tick, 15_000);
    const onOnline = () => void tick();
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [live, repoReady, syncNow]);

  /* ------------------------------------------------------- POS read cache */
  //
  // The live hooks remain the source on an online branch. A branch restored
  // from the saved-branch snapshot may read this snapshot instead, but only
  // when it is present and no older than the 24-hour policy threshold.

  useEffect(() => {
    if (!offlineBranch) {
      setCacheState(null);
      setCacheReadError(null);
      setCacheLoading(false);
      return;
    }
    if (!repoReady || !repoRef.current) return;

    const repo = repoRef.current;
    let stale = false;
    setCacheLoading(true);
    setCacheReadError(null);
    void readPosCache(repo)
      .then((snapshot) => {
        if (stale) return;
        setCacheState(snapshot);
        setCacheLoading(false);
      })
      .catch(() => {
        if (stale) return;
        setCacheState(null);
        setCacheReadError(
          'The saved offline catalogue could not be read. Reconnect before starting a sale.',
        );
        setCacheLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [offlineBranch, repoReady, offlineIdentityKey]);

  useEffect(() => {
    if (!offlineBranch) return;
    setCacheClock(Date.now());
    const timer = setInterval(() => setCacheClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [offlineBranch]);

  useEffect(() => {
    const repo = repoRef.current;
    if (
      !live ||
      !repoReady ||
      !repo ||
      activeBranch.source !== 'server' ||
      medicinesLoading ||
      medicinesError ||
      medicinesBranchId !== currentBranchId ||
      repo.identity.pharmacyId !== currentBranchId ||
      repo.identity.userId !== session.user?.id
    ) {
      return;
    }
    let stale = false;
    void cachePosCatalogue(repo, liveMedicines)
      .then(() => {
        if (!stale) {
          setCacheSaveErrors((prev) => ({ ...prev, catalogue: null }));
        }
      })
      .catch((error) => {
        if (stale) return;
        setCacheSaveErrors((prev) => ({
          ...prev,
          catalogue: `The offline product cache could not be saved on this device (${describeStorageFailure(
            error,
          )}). Offline reload may not have a usable catalogue.`,
        }));
      });
    return () => {
      stale = true;
    };
  }, [
    live,
    repoReady,
    activeBranch.source,
    currentBranchId,
    session.user?.id,
    liveMedicines,
    medicinesLoading,
    medicinesError,
    medicinesBranchId,
  ]);

  useEffect(() => {
    const repo = repoRef.current;
    if (
      !live ||
      !repoReady ||
      !repo ||
      activeBranch.source !== 'server' ||
      customersLoading ||
      customersError ||
      customersBranchId !== currentBranchId ||
      repo.identity.pharmacyId !== currentBranchId ||
      repo.identity.userId !== session.user?.id
    ) {
      return;
    }
    let stale = false;
    void cachePosCustomers(repo, liveCustomers)
      .then(() => {
        if (!stale) {
          setCacheSaveErrors((prev) => ({ ...prev, customers: null }));
        }
      })
      .catch((error) => {
        if (stale) return;
        setCacheSaveErrors((prev) => ({
          ...prev,
          customers: `The offline customer cache could not be saved on this device (${describeStorageFailure(
            error,
          )}). Walk-in sales still work online.`,
        }));
      });
    return () => {
      stale = true;
    };
  }, [
    live,
    repoReady,
    activeBranch.source,
    currentBranchId,
    session.user?.id,
    liveCustomers,
    customersLoading,
    customersError,
    customersBranchId,
  ]);

  const medicinesLiveReady =
    !live ||
    (!medicinesLoading &&
      medicinesError === null &&
      medicinesBranchId === currentBranchId);
  const customersLiveReady =
    !live ||
    (!customersLoading &&
      customersError === null &&
      customersBranchId === currentBranchId);
  const cachedCatalogueUsable =
    offlineBranch && isCachedSliceUsable(cacheState?.catalogue, cacheClock);
  const cachedCustomersUsable =
    offlineBranch && isCachedSliceUsable(cacheState?.customers, cacheClock);
  const usingCachedCatalogue = !medicinesLiveReady && cachedCatalogueUsable;
  const usingCachedCustomers = !customersLiveReady && cachedCustomersUsable;
  const medicines: Medicine[] = medicinesLiveReady
    ? liveMedicines
    : usingCachedCatalogue
      ? (cacheState?.catalogue.records ?? [])
      : [];
  const customers: PosCustomer[] = customersLiveReady
    ? liveCustomers
    : usingCachedCustomers
      ? (cacheState?.customers.records ?? [])
      : [];
  const offlineSalesBlocked =
    offlineBranch && !medicinesLiveReady && !cachedCatalogueUsable;
  const knownOfflineSettlement = offlineBranch && !medicinesLiveReady;
  // The UI follows both the confirmed offline-branch state and the latest
  // probe. The submission path re-checks the probe result, so neither a stale
  // render nor a keyboard path can submit a blocked settlement.
  const offlineCashOnly =
    knownOfflineSettlement || probe?.serverReachable === false;
  const customerLookupAvailable = customersLiveReady || usingCachedCustomers;
  const customerLookupPending =
    !customerLookupAvailable && (customersLoading || (offlineBranch && cacheLoading));
  const cacheSaveError =
    cacheSaveErrors.catalogue ?? cacheSaveErrors.customers ?? null;

  // If the connection drops while a credit/part/wallet/split settlement is
  // selected, return the form to the only settlement an offline sale may use.
  // The guard in `completeSale` is the authority; this keeps the visible form
  // honest as well.
  useEffect(() => {
    if (!offlineCashOnly) return;
    setPayMode('full');
    setPaymentMethod('cash');
    setPartPaidInput('');
    setSplitCashInput('');
    setSplitTransferInput('');
    setCreditAccountId(NO_ACCOUNT);
  }, [offlineCashOnly]);

  const results = useMemo(() => searchMedicines(medicines, query).slice(0, 12), [medicines, query]);

  // Roving cursor over `results`, defaulting to the best match so a search is
  // "type, Enter" rather than "type, Down, Enter". Focus never leaves the
  // search field: the list is driven with `aria-activedescendant`, which is
  // what lets an attendant keep typing to refine the match.
  const [cursor, setCursor] = useState(0);

  /**
   * Per-product unit choice, replacing the Select that used to sit on every
   * row. Only products the cursor has visited need an entry, so this stays
   * tiny instead of holding a key per medicine.
   */
  const [unitChoice, setUnitChoice] = useState<Record<string, string>>({});

  // Every keystroke re-ranks the list, so the old index is meaningless. Falling
  // back to the new best match is the whole point of the default. `active`
  // gates whether that index is honoured at all.
  useEffect(() => setCursor(0), [query]);

  /**
   * The highlighted result, if any.
   *
   * Deliberately nothing while the query is empty: `searchMedicines` returns
   * the whole catalogue then, so row 0 is not a match the attendant chose or
   * ranked — it is just whatever the store happens to list first. Presenting
   * that as "selected" would invite a mistyped ↵ to ring up an arbitrary
   * product. One keystroke of search makes it a real selection again.
   */
  const active = query.trim() ? results[cursor] : undefined;
  const activeId = active?.id;

  const searchRef = useRef<HTMLInputElement>(null);

  const lines = useMemo<CartLine[]>(
    () =>
      cart.flatMap((entry) => {
        const medicine = medicines.find((m) => m.id === entry.medicineId);
        const unit = medicine ? findUnit(medicine.units, entry.unitKey) : null;
        if (!medicine || !unit) return [];

        // One conversion, one place. `checkout` re-derives this same figure and
        // refuses the sale if it no longer agrees, so a cart left open across a
        // repackaging cannot deduct the wrong quantity.
        const conversion = convertToBaseUnits(medicine.units, unit.key, entry.quantity);
        if (!conversion.ok) return [];

        return [
          {
            medicineId: medicine.id,
            unitKey: unit.key,
            unitName: unit.name,
            unitMultiplier: unit.multiplier,
            unitPrice: unit.sellingPrice,
            quantity: entry.quantity,
            baseUnitsTotal: conversion.amount.baseUnits,
            lineTotal: multiply(unit.sellingPrice, entry.quantity),
          },
        ];
      }),
    [cart, medicines],
  );

  const subtotal = sum(lines.map((line) => line.lineTotal));
  // A discount larger than the basket would drive the total — and every margin
  // figure derived from it — negative. Clamped here rather than left to
  // checkout, so the totals on screen are the totals that get recorded.
  const discountEntered = money(Number(discountInput) || 0);
  const discount = discountEntered > subtotal ? subtotal : discountEntered;
  const total = subtract(subtotal, discount);

  // The collected amount follows the settlement state. More cash handed over
  // than the sale costs is change, not revenue — recording the tendered amount
  // as paid would break every margin report in the app.
  const tendered = money(Number(tenderedInput) || 0);
  const partCollected = money(Number(partPaidInput) || 0);
  const splitCash = money(Number(splitCashInput) || 0);
  const splitTransfer = money(Number(splitTransferInput) || 0);
  const splitTotal = money(splitCash + splitTransfer);
  const splitParts = [
    ...(splitCash > 0 ? [{ method: 'cash' as const, amount: splitCash }] : []),
    ...(splitTransfer > 0 ? [{ method: 'transfer' as const, amount: splitTransfer }] : []),
  ];

  const amountPaid = money(
    payMode === 'debt'
      ? 0
      : payMode === 'part'
        ? Math.min(partCollected, total)
        : payMode === 'split'
          ? Math.min(splitTotal, total)
          : tendered > total
            ? total
            : tendered,
  );
  const changeDue = payMode === 'full' ? subtract(tendered, total) : 0;
  const outstanding = subtract(total, amountPaid);
  // The payment kind the sale is recorded under: an ordinary method, or
  // 'split' when two methods were collected.
  const effectivePaymentMethod: PaymentMethod = payMode === 'split' ? 'split' : paymentMethod;

  const selectedCustomer = customerId === NO_ACCOUNT ? undefined : customers.find((c) => c.id === customerId);
  const customerSales = useMemo<Sale[]>(
    () =>
      selectedCustomer
        ? sales.filter(
            (sale) =>
              sale.customerId === selectedCustomer.id &&
              sale.status !== 'voided' &&
              sale.status !== 'refunded',
          )
        : [],
    [sales, selectedCustomer],
  );

  const creditAccount = creditAccounts.find((a) => a.id === creditAccountId);
  const balanceAfter = creditAccount
    ? add(creditAccount.outstandingBalance, outstanding)
    : 0;
  const overCreditLimit = creditAccount !== undefined && balanceAfter > creditAccount.creditLimit;

  const controlledLines = lines.filter((line) => {
    const status = medicines.find((m) => m.id === line.medicineId)?.prescriptionStatus;
    return status === 'Prescription' || status === 'Controlled';
  });

  const addToCart = (medicine: Medicine, unitKey: string) => {
    setCheckoutError(null);
    setCart((current) => {
      const existing = current.find(
        (entry) => entry.medicineId === medicine.id && entry.unitKey === unitKey,
      );
      if (existing) {
        return current.map((entry) =>
          entry === existing ? { ...entry, quantity: entry.quantity + 1 } : entry,
        );
      }
      return [...current, { medicineId: medicine.id, unitKey, quantity: 1 }];
    });
  };

  /**
   * The unit an unattended scan should ring up.
   *
   * Scanning cannot express "one tablet" the way a keyboard unit choice can, so
   * this picks the largest tradeable unit — a carton of paracetamol is what a
   * customer carrying a stack of boxes wants, and the attendant can still step
   * down a unit with `u` on the highlighted result.
   */
  const defaultUnit = (medicine: Medicine) =>
    medicine.units.reduce<TradeUnit | null>(
      (largest, unit) => (largest === null || unit.multiplier > largest.multiplier ? unit : largest),
      null,
    );

  /** The unit currently chosen for a product, defaulting to the largest. */
  const unitFor = (medicine: Medicine) => {
    const chosen = unitChoice[medicine.id];
    return medicine.units.find((u) => u.key === chosen) ?? defaultUnit(medicine);
  };

  /** Pick a specific trade unit for a product. */
  const chooseUnit = (medicine: Medicine, unitKey: string) => {
    setUnitChoice((choice) => ({ ...choice, [medicine.id]: unitKey }));
  };

  /** Step `u` cycles the highlighted product through its units. */
  const cycleUnit = (medicine: Medicine) => {
    if (medicine.units.length < 2) return;
    const current = unitFor(medicine);
    const index = current ? medicine.units.findIndex((u) => u.key === current.key) : -1;
    const next = medicine.units[(index + 1) % medicine.units.length];
    if (!next) return;
    setUnitChoice((choice) => ({ ...choice, [medicine.id]: next.key }));
  };

  /**
   * Add a product to the cart.
   *
   * Takes the product explicitly so a click can name the row it came from. It
   * used to read the highlight instead, and a click set the cursor with
   * `setCursor` first — a state update that has not landed when the add runs, so
   * clicking row 4 added row 3. The keyboard path still passes nothing and keeps
   * using the highlight.
   *
   * Deliberately does not clear the query: a sale is usually several lines from
   * one search, so keeping the list lets the next ↓ Enter go straight into the
   * next product.
   */
  const addHighlighted = (medicine: Medicine | null | undefined = active) => {
    if (offlineSalesBlocked) {
      toast.error('Offline catalogue unavailable', {
        description: 'Reconnect before starting a sale on this device.',
      });
      return;
    }
    if (!medicine) return;

    // Same gate as the Add button and the scanner, for the same reason: a
    // recall lock or expired batch must not be reachable by a faster path.
    const block = saleBlock(medicine);
    if (block) {
      toast.error(`${medicine.name} cannot be sold`, { description: block });
      return;
    }

    const unit = unitFor(medicine);
    if (!unit) {
      toast.error(`${medicine.name} has no tradeable unit`);
      return;
    }

    addToCart(medicine, unit.key);
    toast.success(`${medicine.name} · ${unit.name} added`);
  };

  /** Move the cursor, clamped to the list. */
  const moveCursor = (delta: number) => {
    setCursor((current) => {
      if (results.length === 0) return 0;
      const next = current + delta;
      if (next < 0) return 0;
      if (next >= results.length) return results.length - 1;
      return next;
    });
  };

  /**
   * Scanning into the cart goes through the same `saleBlock` gate the manual
   * Add button uses. A recall lock or an expired batch must not be
   * bypassable by a faster path, so the check is not duplicated here — the
   * blocked product simply reports and stops.
   */
  const onBarcode = (code: string) => {
    if (offlineSalesBlocked) {
      toast.error('Offline catalogue unavailable', {
        description: 'Reconnect before scanning products on this device.',
      });
      return;
    }
    const medicine = medicines.find((item) => item.barcode === code);

    if (!medicine) {
      toast.error(`No product with barcode ${code}`, {
        description: 'Check the pack, or find it by name.',
      });
      return;
    }

    const block = saleBlock(medicine);
    if (block) {
      toast.error(`${medicine.name} cannot be sold`, { description: block });
      return;
    }

    const unit = defaultUnit(medicine);
    if (!unit) {
      toast.error(`${medicine.name} has no tradeable unit`);
      return;
    }

    addToCart(medicine, unit.key);
    toast.success(`${medicine.name} · ${unit.name} added`);
  };

  /**
   * Map confirmed prescription lines onto real products.
   *
   * Deliberately match-only: a line that resolves to nothing is reported, not
   * invented. A guessed match here would put the wrong drug in front of a
   * customer.
   */
  const onPrescriptionConfirm = (items: PrescriptionDraft[]) => {
    if (offlineSalesBlocked) {
      toast.error('Offline catalogue unavailable', {
        description: 'Reconnect before adding prescription items on this device.',
      });
      return;
    }
    const unmatched: string[] = [];
    let matched = 0;

    for (const item of items) {
      const needle = `${item.name} ${item.strength}`.trim().toLowerCase();
      const hit =
        medicines.find((medicine) => medicine.name.toLowerCase() === needle) ??
        medicines.find((medicine) => `${medicine.name} ${medicine.strength}`.toLowerCase() === needle) ??
        medicines.find((medicine) => medicine.name.toLowerCase().includes(item.name.toLowerCase()));

      if (!hit) {
        unmatched.push(item.name);
        continue;
      }

      const block = saleBlock(hit);
      if (block) {
        toast.error(`${hit.name} cannot be sold`, { description: block });
        continue;
      }

      const unit = defaultUnit(hit);
      if (unit) {
        addToCart(hit, unit.key);
        matched += 1;
      }
    }

    if (matched > 0) {
      toast.success(`${matched} ${matched === 1 ? 'item' : 'items'} added from the script`, {
        description: 'Dispensed against prescription',
      });
    }

    if (unmatched.length > 0) {
      toast.error(`Not in the catalogue: ${unmatched.join(', ')}`, {
        description: 'Find them by name to add them.',
      });
    }
  };

  /**
   * Registers a customer inline, without leaving the sale.
   *
   * Demo mode mutates the store through the same pure operation every other
   * write uses. Live mode inserts the row through the existing customer write
   * path (`createCustomer`) — the database's `customers_phone_unique` is the
   * duplicate guard, checked client-side first for a message a person can act
   * on. Either way the new customer is selected for this sale immediately, so
   * a first-time buyer never leaves the till unnamed.
   */
  const registerNewCustomer = async (
    name: string,
    phone: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (live && (offlineBranch || !customerLookupAvailable)) {
      return {
        ok: false,
        error: offlineBranch
          ? 'Registering a customer needs the server. Reconnect first, or use a walk-in cash sale paid in full.'
          : 'The customer list could not be loaded. Register the customer after reconnecting, or use a walk-in cash sale paid in full.',
      };
    }
    if (!live) {
      const result = registerCustomerAction(name, phone);
      if (!result.ok) return { ok: false, error: result.error };
      setCustomerId(result.value.customer.id);
      return { ok: true };
    }
    if (!currentBranchId) {
      return { ok: false, error: 'No active pharmacy — pick one before registering a customer' };
    }
    const dupe = customers.find((c) => c.phone === phone.trim());
    if (dupe) {
      return {
        ok: false,
        error: `${dupe.name} is already registered with this number — search for them instead`,
      };
    }
    const created = await createCustomer({
      branch_id: currentBranchId,
      code: `C-${Date.now().toString(36).toUpperCase()}`,
      name: name.trim(),
      phone: phone.trim(),
    });
    if (!created.ok) return { ok: false, error: created.error };
    setCustomerId(toCustomer(created.data).id);
    refreshCustomers();
    return { ok: true };
  };

  const changeQuantity = (medicineId: string, unitKey: string, delta: number) => {
    setCart((current) =>
      current
        .map((entry) =>
          entry.medicineId === medicineId && entry.unitKey === unitKey
            ? { ...entry, quantity: entry.quantity + delta }
            : entry,
        )
        .filter((entry) => entry.quantity > 0),
    );
  };

  const removeLine = (medicineId: string, unitKey: string) => {
    setCart((current) =>
      current.filter(
        (entry) => !(entry.medicineId === medicineId && entry.unitKey === unitKey),
      ),
    );
  };

  const clearSale = () => {
    setCart([]);
    setDiscountInput('');
    setDiscountReason('');
    setPayMode('full');
    setTenderedInput('');
    setPartPaidInput('');
    setSplitCashInput('');
    setSplitTransferInput('');
    setCustomerId(NO_ACCOUNT);
    setCreditAccountId(NO_ACCOUNT);
    setDispensedAgainstPrescription(false);
    setCheckoutError(null);
    // A new cart is a new attempt, so it needs a new key.
    setIdempotencyKey(newIdempotencyKey());
  };

  /**
   * Clears an ambiguous non-cash attempt only after a person has checked the
   * ledger. `recorded` means the original sale is in the ledger, so the cart is
   * closed. Otherwise the cart is kept but gets a NEW key — a deliberate human
   * decision, never an automatic bypass of the uncertainty.
   */
  const resolveUnresolvedAttempt = async (recorded: boolean) => {
    const attempt = unresolvedAttemptRef.current;
    if (!attempt) return;
    // Use the handle captured with the evidence, never repoRef.current: after a
    // branch/account switch that ref may belong to a different identity.
    if (unresolvedAttemptPersistedRef.current) {
      const cleared = await clearUnresolvedAttempt(
        unresolvedAttemptRepoRef.current,
        unresolvedAttemptOriginRef.current,
        attempt.idempotencyKey,
      );
      if (!cleared) {
        setCheckoutError(
          'The reconciliation note belongs to the original branch/account and could not be cleared safely. Switch back to that branch/account and try again; this sale remains blocked.',
        );
        return;
      }
    }
    // No durable note was saved, so there is nothing to clear and the explicit
    // in-memory resolution can proceed.
    unresolvedAttemptRef.current = null;
    unresolvedAttemptOriginRef.current = null;
    unresolvedAttemptRepoRef.current = null;
    unresolvedAttemptPersistedRef.current = false;
    setUnresolvedAttempt(null);
    if (recorded) {
      clearSale();
    } else {
      setIdempotencyKey(newIdempotencyKey());
      setCheckoutError(null);
    }
  };

  /**
   * The receipt header. Branch name, address and phone come from the active
   * branch the sale is recorded against — never from the editable localStorage
   * copy, which is a label and not a source of truth.
   */
  const receiptBranch = () => {
    const branch = activeBranch.availableBranches.find(
      (candidate) => candidate.id === activeBranch.currentBranchId,
    );
    return {
      branchName: branch?.name ?? 'Pharmacy',
      ...(branch?.address ? { branchAddress: branch.address } : {}),
      ...(branch?.phone ? { branchPhone: branch.phone } : {}),
    };
  };

  /** A demo-mode sale already carries its own lines, totals and receipt number. */
  const receiptFromSale = (sale: Sale): ReceiptData => ({
    receiptNumber: sale.receiptNumber,
    issuedAt: sale.date,
    attendantName: sale.attendantName || currentUser.name || 'Staff',
    ...(sale.customerName ? { customerName: sale.customerName } : {}),
    ...(sale.customerPhone ? { customerPhone: sale.customerPhone } : {}),
    lines: sale.items.map((item) => ({
      name: item.medicineName,
      unitName: item.unitName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
    subtotal: sale.subtotal,
    discount: sale.discount,
    ...(sale.discountReason ? { discountReason: sale.discountReason } : {}),
    total: sale.total,
    amountPaid: sale.amountPaid,
    outstanding: sale.outstandingBalance,
    ...(changeDue > 0 ? { changeDue } : {}),
    paymentMethod: sale.paymentMethod,
    ...(sale.paymentBreakdown && sale.paymentBreakdown.length > 1
      ? {
          paymentBreakdown: sale.paymentBreakdown.map((part) => ({
            method: part.method,
            amount: part.amount,
          })),
        }
      : {}),
    ...(sale.dispensedAgainstPrescription ? { dispensedAgainstPrescription: true } : {}),
    ...receiptBranch(),
  });

  /**
   * A live sale. The server returns the receipt number but not the lines, so the
   * lines come from the cart that was just rung up — the same prices the screen
   * showed and the same ones the server charged.
   */
  const receiptFromCart = (input: {
    receiptNumber: string;
    issuedAt: string;
    total: number;
    amountPaid: number;
    outstanding: number;
    pendingNote?: string;
  }): ReceiptData => ({
    receiptNumber: input.receiptNumber,
    issuedAt: input.issuedAt,
    attendantName: currentUser.name || session.user?.name || 'Staff',
    ...(selectedCustomer
      ? { customerName: selectedCustomer.name, customerPhone: selectedCustomer.phone }
      : {}),
    lines: lines.map((line) => ({
      name: medicines.find((medicine) => medicine.id === line.medicineId)?.name ?? 'Item',
      unitName: line.unitName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    subtotal,
    discount,
    ...(discountReason.trim() ? { discountReason: discountReason.trim() } : {}),
    total: input.total,
    amountPaid: input.amountPaid,
    outstanding: input.outstanding,
    ...(changeDue > 0 ? { changeDue } : {}),
    paymentMethod: effectivePaymentMethod,
    ...(payMode === 'split' ? { paymentBreakdown: splitParts } : {}),
    ...(dispensedAgainstPrescription ? { dispensedAgainstPrescription: true } : {}),
    ...(input.pendingNote ? { pendingNote: input.pendingNote } : {}),
    ...receiptBranch(),
  });

  /**
   * Rings up the cart.
   *
   * Live mode goes to `pf_complete_sale`, which re-derives the quantities and the
   * money from the database's own packaging and pricing, allocates stock FEFO
   * under row locks, and writes the sale, its lines and the stock movements in
   * one transaction. Demo mode keeps the original local path, because there the
   * store genuinely is the pharmacy.
   *
   * Only `medicine_id`, `unit_key` and `quantity` are sent. The prices shown on
   * screen are the same unit prices the server charges, so a successful sale
   * always matches what the attendant saw.
   */
  const completeSale = async () => {
    if (submitting) return;
    // An unresolved non-cash attempt blocks every retry, including a switch to
    // Full + Cash. The same idempotency key would replay the original non-cash
    // sale, and a fresh key would hide the fact that the first attempt is still
    // unknown. Only the explicit resolution controls below clear this state.
    const unresolvedError = unresolvedAttemptBlock(unresolvedAttempt);
    if (unresolvedError) {
      setCheckoutError(unresolvedError);
      return;
    }
    // Pin the repository AND its storage identity before any await. If the user
    // switches branch/account while the request is in flight, the failure path
    // must not redirect this attempt's evidence into the new identity's database.
    const submissionRepo = repoRef.current;
    const submissionStorageIdentity = offlineStorageIdentityKey;
    if (offlineSalesBlocked) {
      setCheckoutError(
        'There is no usable saved catalogue on this device, so an offline sale cannot be composed safely. Reconnect before selling.',
      );
      return;
    }
    // The render-time check can be up to a minute old. Re-check against the
    // actual click time, so a till left open offline cannot cross the 24-hour
    // cache limit while a finished cart is waiting to be submitted.
    if (
      offlineBranch &&
      !medicinesLiveReady &&
      !isCachedSliceUsable(cacheState?.catalogue, Date.now())
    ) {
      setCheckoutError(
        'The saved catalogue is now more than 24 hours old. Reconnect before completing this sale.',
      );
      return;
    }
    // A cached branch with no live read is the known-offline path. Refuse a
    // blocked settlement here, before the probe, so the cart cannot be sent
    // with credit/wallet/part details just because the controls were bypassed.
    if (knownOfflineSettlement) {
      const settlementError = offlineSettlementError(payMode, effectivePaymentMethod);
      if (settlementError) {
        setCheckoutError(settlementError);
        return;
      }
    }
    setCheckoutError(null);

    // The counter's own settlement rules, checked before anything is sent:
    // a full payment must actually cover the total, a part payment sits
    // strictly between nothing and the total, a split carries money on both
    // methods, and no balance is left without someone to owe it.
    const gateError =
      (payMode === 'full' && outstanding > 0
        ? offlineCashOnly
          ? 'Offline sales must be paid in full in cash — collect the full total before completing the sale'
          : 'The amount received does not cover the total — choose Part payment or Debt'
        : null) ??
      (payMode === 'part' && (partCollected <= 0 || partCollected >= total)
        ? 'Collect more than nothing and less than the full total — otherwise use Full or Debt'
        : null) ??
      (payMode === 'split' && splitTotal <= 0
        ? 'Enter the amounts collected in cash and by transfer'
        : null) ??
      (payMode === 'split' && splitTotal > total
        ? 'The two methods add up to more than the sale — that is change, not payment'
        : null) ??
      (payMode === 'split' && splitParts.length < 2
        ? 'A split needs money on both methods — for one method, use Part payment'
        : null) ??
      (outstanding > 0 && customerId === NO_ACCOUNT && creditAccountId === NO_ACCOUNT
        ? 'Record a customer before leaving a balance'
        : null);
    if (gateError) {
      setCheckoutError(gateError);
      return;
    }

    if (!live) {
      const result = checkout({
        lines,
        paymentMethod: effectivePaymentMethod,
        amountPaid,
        discount,
        ...(discountReason.trim() ? { discountReason } : {}),
        ...(customerId !== NO_ACCOUNT ? { customerId } : {}),
        ...(creditAccountId !== NO_ACCOUNT ? { creditAccountId } : {}),
        ...(dispensedAgainstPrescription ? { dispensedAgainstPrescription } : {}),
        ...(payMode === 'split' ? { paymentBreakdown: splitParts } : {}),
      });

      if (!result.ok) {
        setCheckoutError(result.error);
        return;
      }

      setReceipt(receiptFromSale(result.value.sale));
      toast.success(`${result.value.sale.receiptNumber} completed`);
      clearSale();
      // Hand focus back to search so the next sale starts from the keyboard
      // without a reach for the mouse.
      setQuery('');
      searchRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      // One quick gate before the round trip: a till that cannot reach the
      // server should never wait for a fetch timeout with a customer waiting.
      // A confirmed-reachable probe is NOT a promise of success — it just
      // decides which of two honest paths runs.
      const gate = await probeServer({ timeoutMs: 2500 });
      setProbe(gate);

      // The immutable quote. It is captured at the moment the sale is
      // committed, stored with the outbox row, and compared with the server's
      // confirmed total. It never overrides server pricing.
      const expected = {
        subtotal,
        discount,
        total,
        amountPaid,
        lines: lines.map((line) => ({
          medicineId: line.medicineId,
          unitKey: line.unitKey,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        })),
      };

      const intent = {
        lines: lines.map((line) => ({
          medicineId: line.medicineId,
          unitKey: line.unitKey,
          quantity: line.quantity,
        })),
        paymentMethod: effectivePaymentMethod,
        amountPaid,
        expected,
        ...(discount > 0 ? { discount } : {}),
        ...(discountReason.trim() ? { discountReason } : {}),
        ...(customerId !== NO_ACCOUNT ? { customerId } : {}),
        ...(creditAccountId !== NO_ACCOUNT ? { creditAccountId } : {}),
        ...(dispensedAgainstPrescription ? { dispensedAgainstPrescription } : {}),
        ...(payMode === 'split'
          ? {
              paymentBreakdown: splitParts.map((part) => ({
                method: part.method,
                amount: part.amount,
              })),
            }
          : {}),
      };

      if (!gate.serverReachable) {
        // The probe, not the last render, decides whether this sale is offline.
        // Enforce the same cash-only rule here even when the UI had no chance
        // to react to a connection that dropped while the cart was open.
        const settlementError = offlineSettlementError(payMode, effectivePaymentMethod);
        if (settlementError) {
          setCheckoutError(settlementError);
          return;
        }
        // OFFLINE PATH - this is the ONLY place a sale is created offline.
        // The intent and its idempotency key are durable BEFORE this screen
        // reports the sale saved; the sync engine sends it later through the
        // same authoritative RPC, key unchanged.
        const repo = repoRef.current;
        if (!repo) {
          setCheckoutError(
            'No connection to the pharmacy server, and offline saving is unavailable on this device — the sale was NOT recorded',
          );
          return;
        }
        let recorded: Awaited<ReturnType<typeof recordSaleIntent>>;
        try {
          recorded = await recordSaleIntent(repo, intent, idempotencyKey);
        } catch (error) {
          // Persistence failed, so nothing was written anywhere — and the gate
          // above had already failed to reach the server, so the sale cannot
          // have gone through server-side either. "NOT recorded" is a fact
          // here, not a guess. The cart stays for an explicit retry.
          setCheckoutError(
            `Offline saving failed on this device (${describeStorageFailure(error)}) — the sale was NOT recorded; the cart is kept`,
          );
          return;
        }
        if (!recorded.ok) {
          // Refused locally (storage failure or a key carrying a different
          // sale). The cart stays; the attendant decides what to do next.
          setCheckoutError(recorded.error);
          return;
        }
        setReceipt(
          receiptFromCart({
            receiptNumber: 'Pending sync',
            issuedAt: recorded.data.soldAt,
            total,
            amountPaid,
            outstanding,
            pendingNote:
              'Saved on this device. The official receipt number, total and stock are confirmed only when this sale syncs. This is not a server-confirmed receipt.',
          }),
        );
        toast.success(
          recorded.data.duplicate
            ? 'Already saved on this device'
            : 'Saved on this device — it syncs when the pharmacy reconnects',
        );
        clearSale();
        setDeviceRefresh((n) => n + 1);
        setQuery('');
        searchRef.current?.focus();
        return;
      }

      let result: Awaited<ReturnType<typeof completeSaleRemote>>;
      try {
        result = await completeSaleRemote({
          ...intent,
          // Online sale: the server's `now()` stamps it, exactly as before.
          soldAt: null,
          idempotencyKey,
        });
      } catch (thrown) {
        // An unexpected throw is still an unobserved outcome: the server may
        // have committed the sale before the connection died. Classify it like
        // a lost response so the reconciliation guard below can apply.
        const message =
          typeof thrown === 'object' && thrown !== null && 'message' in thrown
            ? String((thrown as { message?: unknown }).message)
            : String(thrown);
        result = {
          ok: false,
          error: message || 'The server did not answer',
        };
      }

      if (!result.ok) {
        const failure = classifySaleFailure({ error: result.error, code: result.code });
        if (failure.kind === 'network') {
          // A connection can also drop after the probe said "reachable". This
          // attempt is now ambiguous, but it must not become a queued credit,
          // wallet, part or split sale. Keep the cart and the attempt evidence.
          // The key stays unchanged, so a later cash submission cannot replay
          // the original non-cash settlement as a fresh cash receipt; all
          // retries stay blocked until a person checks the ledger.
          const settlementError = offlineSettlementError(payMode, effectivePaymentMethod);
          if (settlementError) {
            const attempt = unresolvedNonCashAttempt({
              failureKind: failure.kind,
              payMode,
              paymentMethod: effectivePaymentMethod,
              idempotencyKey,
              amountPaid,
              total,
            });
            let evidenceSaved = false;
            if (attempt) {
              unresolvedAttemptRef.current = attempt;
              unresolvedAttemptOriginRef.current = submissionStorageIdentity;
              unresolvedAttemptRepoRef.current = submissionRepo;
              unresolvedAttemptPersistedRef.current = false;
              setUnresolvedAttempt(attempt);
              // The helper verifies submissionRepo.identity, so a stale/closed
              // handle or a switched identity fails closed instead of writing
              // into another database.
              evidenceSaved = await persistUnresolvedAttempt(
                submissionRepo,
                submissionStorageIdentity,
                attempt,
              );
              unresolvedAttemptPersistedRef.current = evidenceSaved;
            }
            setCheckoutError(
              `${settlementError} The connection dropped while this sale was being sent, so it was not queued for offline retry. This attempt is held for reconciliation under key ${idempotencyKey}; it may have reached the server, so check the sales ledger before re-ringing it — do not retry this cart as cash. ${evidenceSaved ? 'The reconciliation note is saved on this device.' : 'This device could not save the reconciliation note in the original branch/account database; keep this screen open until the ledger is checked.'}`,
            );
            return;
          }
          // The server never answered. The sale MIGHT have gone through -
          // which is precisely why no new key is minted: the intent is
          // recorded under the SAME key, the engine re-sends it, and the
          // server's replay short-circuit (not a guess) settles the outcome.
          const repo = repoRef.current;
          if (repo) {
            let recorded: Awaited<ReturnType<typeof recordSaleIntent>>;
            try {
              recorded = await recordSaleIntent(repo, intent, idempotencyKey);
            } catch (error) {
              // The server never answered (it MIGHT have processed the sale)
              // and the device copy also failed. Never claim "NOT recorded" —
              // the only honest state here is uncertainty about the server;
              // the attendant checks the ledger before re-selling.
              setCheckoutError(
                `The pharmacy server did not answer, and saving on this device also failed (${describeStorageFailure(error)}) — the sale may have gone through; check the connection and the sales ledger before re-selling`,
              );
              return;
            }
            if (recorded.ok) {
              setReceipt(
                receiptFromCart({
                  receiptNumber: 'Pending confirmation',
                  issuedAt: recorded.data.soldAt,
                  total,
                  amountPaid,
                  outstanding,
                  pendingNote:
                    'The server has not confirmed this sale yet. The official receipt number, total and stock are confirmed only when it does.',
                }),
              );
              toast.message('Saved on this device — the server will confirm it');
              clearSale();
              setDeviceRefresh((n) => n + 1);
              setQuery('');
              searchRef.current?.focus();
              void syncNow();
              return;
            }
          }
          setCheckoutError(
            'The pharmacy server did not answer, and offline saving is unavailable — check the connection and try again',
          );
          return;
        }
        // Server looked at the sale and refused (stock, quantity, money shape).
        // The cart is kept and nothing was written anywhere.
        setCheckoutError(result.error);
        // The catalogue may have moved under the cart — a colleague sold the
        // same stock, or the packaging changed. Re-read so a retry is made
        // against current numbers rather than the ones that just failed.
        refreshMedicines();
        return;
      }

      // A server replay proves a sale exists under this key; it does NOT prove
      // the settlement now on screen is the one that was stored. If this key
      // belongs to an unresolved non-cash attempt, never dress the replay up as
      // a fresh cash receipt. Keep the cart and send the cashier to the ledger.
      if (
        isUnverifiedCompletedReplay({
          alreadyCompleted: result.data.alreadyCompleted,
          attempt: unresolvedAttempt,
          idempotencyKey,
        })
      ) {
        setCheckoutError(
          `The server matched key ${idempotencyKey} to an earlier attempt this till could not confirm. That original settlement may differ from the one on screen. Check the sales ledger before re-ringing this cart.`,
        );
        return;
      }

      const totalDiffers = Math.abs(result.data.total - total) > 0.01;
      const lineCountDiffers = result.data.lineCount !== lines.length;
      const mismatch = totalDiffers || lineCountDiffers;

      // The server has committed this sale. If it differs from the quote, keep a
      // durable review record even when the outbox was never involved (an online
      // sale has no outbox row once it completes). A local storage failure must
      // not turn a confirmed sale into a failed one, but it must also not make
      // the warning disappear on the next render, so report whether it was saved.
      let reviewSaved = true;
      if (mismatch) {
        const repo = repoRef.current;
        if (!repo) {
          reviewSaved = false;
        } else {
          try {
            await repo.recordConflict({
              opId: idempotencyKey,
              type: POS_SALE_OP_TYPE,
              payload: {
                expected,
                lines: intent.lines,
                payment_method: effectivePaymentMethod,
                amount_paid: amountPaid,
                discount,
                sold_at: new Date().toISOString(),
              },
              reason: 'server-total-mismatch',
              kind: 'server-mismatch',
              serverConfirmed: true,
              details: {
                expectedTotal: total,
                serverTotal: result.data.total,
                expectedLineCount: lines.length,
                serverLineCount: result.data.lineCount,
                amountPaid,
                paymentDifference: Math.round((result.data.total - amountPaid) * 100) / 100,
                receiptNumber: result.data.receiptNumber,
                saleId: result.data.saleId,
                source: 'online',
              },
            });
            setDeviceRefresh((n) => n + 1);
          } catch {
            reviewSaved = false;
          }
        }
      }

      setReceipt(
        receiptFromCart({
          receiptNumber: result.data.receiptNumber,
          issuedAt: new Date().toISOString(),
          total: result.data.total,
          amountPaid,
          outstanding: Math.max(0, subtract(result.data.total, amountPaid)),
          ...(mismatch
            ? {
                pendingNote:
                  'The server recorded this sale at a different total or line count from the till. Do not collect or refund a difference; ask an owner to review it.',
              }
            : {}),
        }),
      );
      if (mismatch) {
        toast.warning(`${result.data.receiptNumber} was recorded at a different total`, {
          description: reviewSaved
            ? 'Do not collect or refund the difference. It is saved in the device review panel.'
            : 'Do not collect or refund the difference. The review note could not be saved on this device; tell an owner before closing this screen.',
        });
      } else {
        toast.success(`${result.data.receiptNumber} completed`);
      }
      clearSale();
      // Stock moved on the server; this till's copy is stale until it re-reads.
      refreshMedicines();
      // So did the ledger behind "Taken today".
      refreshSales();
      setDeviceRefresh((n) => n + 1);
      setQuery('');
      searchRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * POS shortcuts. Everything here is also reachable by pointer — these only
   * remove the reach, they do not add a capability. `allowInInput` is needed
   * because the search field holds focus for almost the whole session.
   */
  useHotkeys({
    // Jump to search. `/` types a slash otherwise, hence the guard.
    '/': {
      allowInInput: true,
      handler: () => {
        if (query) return false;
        searchRef.current?.focus();
      },
    },
    arrowdown: {
      allowInInput: true,
      handler: () => moveCursor(1),
    },
    arrowup: {
      allowInInput: true,
      handler: () => moveCursor(-1),
    },
    enter: {
      allowInInput: true,
      handler: () => addHighlighted(),
    },
    u: {
      allowInInput: true,
      handler: () => {
        if (!active) return false;
        cycleUnit(active);
      },
    },
    f2: () => setScannerOpen(true),
    'mod+enter': () => {
      if (lines.length === 0) return false;
      // Returning false while a submission is in flight swallows the key, so a
      // held-down shortcut cannot queue a second one behind the first.
      if (submitting) return false;
      void completeSale();
    },
    'shift+/': () => setShortcutsOpen(true),
    escape: () => setShortcutsOpen(false),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Point of Sale"
        meta={
          <div className="flex gap-4 pt-1">
            <span data-numeric className="tabular text-sm text-muted-foreground">
              Today <Money value={today.net} /> · {today.count} sales
            </span>
          </div>
        }
      />

      {live && offlineBranch && (
        <OfflineCacheBanner
          cache={cacheState}
          now={cacheClock}
          loading={cacheLoading}
          readError={cacheReadError}
          liveReady={medicinesLiveReady}
          usingCachedCatalogue={usingCachedCatalogue}
          usingCachedCustomers={usingCachedCustomers}
          customerLookupAvailable={customerLookupAvailable}
          salesBlocked={offlineSalesBlocked}
        />
      )}

      {live && !offlineBranch && (medicinesError || customersError) && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <span className="font-medium">Server read failed.</span>{' '}
          {[medicinesError, customersError].filter(Boolean).join(' ')} The till cannot compose a
          reliable sale until the affected list loads.
        </div>
      )}

      {live && offlineIdentity && (repoReady || repoError || deviceSalesState.status === 'error') && (
        <ConnectivityAndDevicePanel
          probe={probe}
          pending={deviceSalesState.data.pending}
          needsAttention={deviceSalesState.data.needsAttention}
          conflicts={deviceSalesState.data.conflicts}
          confirmed={deviceSalesState.data.confirmed}
          deviceError={repoError ?? deviceSalesState.error}
          syncError={syncError}
          cacheError={cacheReadError ?? cacheSaveError}
          usingCachedCatalogue={usingCachedCatalogue}
          onRetryNow={() => void syncNow()}
        />
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* --------------------------------------------------------- search */}
        <div className="space-y-3 xl:col-span-2">
          <Field>
            <FieldLabel htmlFor="pos-search">Search</FieldLabel>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search
                  aria-hidden="true"
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                />
                <Input
                  id="pos-search"
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    offlineSalesBlocked
                      ? 'Offline catalogue unavailable — reconnect to search'
                      : 'Name, generic, strength or barcode'
                  }
                  className="h-11 pl-9"
                  autoComplete="off"
                  role="combobox"
                  disabled={offlineSalesBlocked}
                  aria-expanded={results.length > 0}
                  aria-controls="pos-results"
                  aria-autocomplete="list"
                  aria-activedescendant={activeId ? `pos-result-${activeId}` : undefined}
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                onClick={() => setScannerOpen(true)}
                aria-label="Scan barcode"
                disabled={offlineSalesBlocked}>
                <ScanLine />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                onClick={() => setPrescriptionOpen(true)}
                aria-label="Read prescription"
                disabled={offlineSalesBlocked}>
                <FileText />
              </Button>
            </div>
          </Field>

          <ul
            id="pos-results"
            role="listbox"
            aria-label="Products"
            className="space-y-1.5"
          >
            {results.length === 0 ? (
              <li className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                {offlineSalesBlocked
                  ? 'Offline selling is blocked until a saved catalogue from the last 24 hours is available.'
                  : 'No product matches that search.'}
              </li>
            ) : (
              results.map((medicine, index) => {
                const block = saleBlock(medicine);
                // Matches the rule behind `active` above, including its
                // empty-query case: with no search term the list is the whole
                // catalogue, and marking row 0 selected announced an arbitrary
                // product as the chosen one.
                const highlighted = Boolean(query.trim()) && index === cursor;
                const unit = unitFor(medicine);

                return (
                  <li
                    key={medicine.id}
                    id={`pos-result-${medicine.id}`}
                    role="option"
                    aria-selected={highlighted}
                    aria-disabled={block ? true : undefined}
                    onClick={() => {
                      setCursor(index);
                      // The product is passed, not inferred. `setCursor` is a
                      // state update that has not been applied yet when this
                      // runs, so reading the highlight here added the previously
                      // highlighted line instead of the one clicked.
                      addHighlighted(medicine);
                    }}
                    className={cn(
                      'flex cursor-pointer flex-wrap items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
                      highlighted
                        ? 'border-ring bg-accent'
                        : 'border-transparent hover:bg-accent/50',
                      block && 'opacity-60',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{medicine.name}</p>
                        <StatusBadge status={stockStatus(medicine)} />
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {medicine.genericName} · {medicine.strength} · {sellableQuantity(medicine)}{' '}
                        base units
                      </p>
                      {block && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                          <TriangleAlert className="size-3" />
                          {block}
                        </p>
                      )}
                    </div>

                    {/* Demo testers are usually on a touch screen, so the demo
                        build shows the trade units as buttons instead of relying
                        on the `u` shortcut. Live keeps the compact text control. */}
                    <div
                      className="flex shrink-0 flex-col items-end gap-1.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {isDemoMode() && medicine.units.length > 1 ? (
                        <>
                          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                            Sell as
                          </span>
                          <div
                            role="group"
                            aria-label={`Selling unit for ${medicine.name}`}
                            className="flex flex-wrap justify-end gap-1"
                          >
                            {medicine.units.map((option) => {
                              const selected = unit?.key === option.key;
                              return (
                                <button
                                  key={option.key}
                                  type="button"
                                  aria-pressed={selected}
                                  onClick={() => chooseUnit(medicine, option.key)}
                                  className={cn(
                                    'rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
                                    selected
                                      ? 'border-primary bg-primary text-primary-foreground'
                                      : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                                  )}
                                >
                                  {option.name}
                                </button>
                              );
                            })}
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="text-right">
                              <Money
                                value={unit?.sellingPrice ?? medicine.pricePerBaseUnit}
                                className="text-sm font-semibold"
                              />
                              <p className="text-[11px] text-muted-foreground">
                                per {unit?.name ?? 'unit'}
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              disabled={Boolean(block)}
                              onClick={() => addHighlighted(medicine)}
                            >
                              <Plus className="size-3" /> Add
                            </Button>
                          </div>
                        </>
                      ) : (
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">
                            {unit?.name ?? '—'}
                            {medicine.units.length > 1 && (
                              <span className="ml-1 opacity-60">· press u</span>
                            )}
                          </p>
                          <Money
                            value={unit?.sellingPrice ?? medicine.pricePerBaseUnit}
                            className="text-sm font-semibold"
                          />
                        </div>
                      )}
                    </div>
                  </li>
                );
              })
            )}
          </ul>

          <p className="text-xs text-muted-foreground">
            <Key>↑</Key>
            <Key>↓</Key> move · <Key>↵</Key> add · <Key>u</Key> change unit ·{' '}
            <Key>F2</Key> scan · <Key>⌘</Key>
            <Key>↵</Key> complete sale
          </p>
        </div>

        {/* -------------------------------------------------------- checkout */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShoppingCart className="size-4" />
                Cart
                {lines.length > 0 && (
                  <Badge variant="secondary">{lines.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {lines.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Search a product to start a sale.
                </p>
              ) : (
                <ul className="space-y-3">
                  {lines.map((line) => {
                    const medicine = medicines.find((m) => m.id === line.medicineId);
                    const onHand = medicine ? sellableQuantity(medicine) : 0;
                    const short = medicine !== undefined && onHand < line.baseUnitsTotal;

                    return (
                      <li key={`${line.medicineId}-${line.unitKey}`} className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {medicine?.name ?? line.medicineId}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {line.unitName} · ×{line.unitMultiplier} ·{' '}
                              <Money value={line.unitPrice} /> each
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 text-muted-foreground"
                            onClick={() => removeLine(line.medicineId, line.unitKey)}
                            aria-label={`Remove ${medicine?.name ?? 'item'}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-11"
                            onClick={() =>
                              changeQuantity(line.medicineId, line.unitKey, -1)
                            }
                            aria-label="Decrease quantity"
                          >
                            <Minus />
                          </Button>
                          <div
                            data-numeric
                            className="tabular flex h-11 flex-1 items-center justify-center rounded-lg border border-border text-sm font-semibold"
                          >
                            {line.quantity}
                          </div>
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-11"
                            onClick={() =>
                              changeQuantity(line.medicineId, line.unitKey, 1)
                            }
                            aria-label="Increase quantity"
                          >
                            <Plus />
                          </Button>
                        </div>

                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            {line.baseUnitsTotal} base units
                          </span>
                          <Money value={line.lineTotal} className="text-sm font-semibold" />
                        </div>

                        {short && (
                          <p className="text-xs text-destructive">
                            Only {onHand} base units on hand
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {lines.length > 0 && (
                <Button
                  variant="ghost"
                  className="h-11 w-full text-muted-foreground"
                  onClick={() => {
                    clearSale();
                    setQuery('');
                  }}
                >
                  Clear sale
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>How is this being paid?</FieldLabel>
                  {offlineCashOnly && (
                    <div
                      role="status"
                      className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-xs text-warning"
                    >
                      <p className="text-sm font-medium">Offline settlement is cash only</p>
                      <p className="text-muted-foreground">{OFFLINE_CASH_ONLY_MESSAGE}</p>
                    </div>
                  )}
                  <div
                    role="group"
                    aria-label="Payment type"
                    className="grid grid-cols-4 gap-1.5"
                  >
                    {PAY_MODES.map((mode) => (
                      <Button
                        key={mode.value}
                        type="button"
                        title={
                          offlineCashOnly && mode.value !== 'full'
                            ? `${mode.hint} Unavailable offline.`
                            : mode.hint
                        }
                        aria-pressed={payMode === mode.value}
                        variant={payMode === mode.value ? 'default' : 'outline'}
                        className="h-10 px-2 text-sm"
                        disabled={offlineCashOnly && mode.value !== 'full'}
                        onClick={() => setPayMode(mode.value)}
                      >
                        {mode.label}
                      </Button>
                    ))}
                  </div>
                </Field>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="pos-discount">Discount</FieldLabel>
                    <Input
                      id="pos-discount"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      className="h-11"
                      value={discountInput}
                      onChange={(event) => setDiscountInput(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="pos-reason">Reason</FieldLabel>
                    <Input
                      id="pos-reason"
                      className="h-11"
                      placeholder="Staff, elderly, bulk"
                      value={discountReason}
                      onChange={(event) => setDiscountReason(event.target.value)}
                      disabled={discount <= 0}
                    />
                  </Field>
                </div>

                {(payMode === 'full' || payMode === 'part') && (
                  <Field>
                    <FieldLabel htmlFor="pos-method">Method</FieldLabel>
                    <Select
                      value={offlineCashOnly ? 'cash' : paymentMethod}
                      onValueChange={(value) => {
                        if (offlineCashOnly && value !== 'cash') return;
                        setPaymentMethod((value as PaymentMethod) ?? 'cash');
                      }}
                      disabled={offlineCashOnly}
                    >
                      <SelectTrigger id="pos-method" className="h-11 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_METHODS.filter(
                          (method) => !offlineCashOnly || method.value === 'cash',
                        ).map((method) => (
                          <SelectItem key={method.value} value={method.value}>
                            {method.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}

                {payMode === 'full' && (
                  <Field>
                    <FieldLabel htmlFor="pos-tendered">Amount received</FieldLabel>
                    <Input
                      id="pos-tendered"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      className="h-11"
                      value={tenderedInput}
                      onChange={(event) => setTenderedInput(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      className="mt-2 h-11 w-full"
                      onClick={() => setTenderedInput(String(total))}
                    >
                      Exact <Money value={total} />
                    </Button>
                  </Field>
                )}

                {payMode === 'part' && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="pos-part">Collected now</FieldLabel>
                      <Input
                        id="pos-part"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        className="h-11"
                        value={partPaidInput}
                        onChange={(event) => setPartPaidInput(event.target.value)}
                      />
                    </Field>
                    {/* The three figures the brief demands for a part payment,
                        always visible while the cashier types. */}
                    <div className="space-y-2 self-end">
                      <TotalRow label="Collected" value={Math.min(partCollected, total)} tone="success" />
                      <TotalRow label="Still owed" value={subtract(total, Math.min(partCollected, total))} tone="destructive" />
                      <p className="text-xs text-muted-foreground">
                        The balance is written to the selected customer's debt.
                      </p>
                    </div>
                  </div>
                )}

                {payMode === 'debt' && (
                  <div className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-xs text-warning">
                    <p className="text-sm font-medium">Pay later — whole balance</p>
                    <p className="text-muted-foreground">
                      Nothing is collected at the till. The full{' '}
                      <Money value={total} /> goes to the selected customer's
                      debt, so a named customer is required.
                    </p>
                  </div>
                )}

                {payMode === 'split' && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="pos-cash">Cash amount</FieldLabel>
                        <Input
                          id="pos-cash"
                          type="number"
                          inputMode="decimal"
                          min={0}
                          className="h-11"
                          value={splitCashInput}
                          onChange={(event) => setSplitCashInput(event.target.value)}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="pos-transfer">Bank transfer amount</FieldLabel>
                        <Input
                          id="pos-transfer"
                          type="number"
                          inputMode="decimal"
                          min={0}
                          className="h-11"
                          value={splitTransferInput}
                          onChange={(event) => setSplitTransferInput(event.target.value)}
                        />
                      </Field>
                    </div>
                    <div className="space-y-2">
                      <TotalRow label="Total paid (cash + transfer)" value={Math.min(splitTotal, total)} tone={splitTotal >= total ? 'success' : 'warning'} emphasis />
                      {splitTotal < total && (
                        <TotalRow label="Still owed" value={subtract(total, splitTotal)} tone="destructive" />
                      )}
                      {splitParts.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Recorded as{' '}
                          {splitParts
                            .map(
                              (part) =>
                                `${part.method === 'cash' ? 'cash' : 'transfer'} ₦${part.amount.toLocaleString('en-NG')}`,
                            )
                            .join(' + ')}
                          {outstanding > 0 && (
                            <>
                              {' '}
                              — the <Money value={outstanding} /> balance attaches to the customer
                            </>
                          )}
                          .
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                  <TotalRow label="Subtotal" value={subtotal} />
                  {discount > 0 && <TotalRow label="Discount" value={discount} tone="warning" />}
                  <TotalRow label="Total" value={total} emphasis />
                  {changeDue > 0 && <TotalRow label="Change due" value={changeDue} tone="success" />}
                  {outstanding > 0 && <TotalRow label="Outstanding" value={outstanding} tone="destructive" />}
                </div>
              </FieldGroup>

              {controlledLines.length > 0 && (
                <div className="space-y-2 rounded-lg border border-warning-border bg-warning-subtle p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
                    <TriangleAlert className="size-4" />
                    Prescription items in this sale
                  </p>
                  <ul className="text-xs text-muted-foreground">
                    {controlledLines.map((line) => {
                      const medicine = medicines.find((m) => m.id === line.medicineId);
                      return (
                        <li key={`${line.medicineId}-${line.unitKey}`}>
                          {medicine?.name} · {medicine?.prescriptionStatus}
                        </li>
                      );
                    })}
                  </ul>
                  <FieldLabel
                    htmlFor="pos-rx"
                    className="flex h-11 cursor-pointer items-center gap-3 rounded-lg border border-warning/40 px-3 text-sm font-normal"
                  >
                    <Switch
                      id="pos-rx"
                      checked={dispensedAgainstPrescription}
                      onCheckedChange={setDispensedAgainstPrescription}
                    />
                    Dispensed against prescription
                  </FieldLabel>
                </div>
              )}

              {lines.length > 0 && (
                <FieldGroup>
                  {(outstanding > 0 || creditAccountId !== NO_ACCOUNT) && (
                    <>
                      {/*
                        Demo only. The picker reads `state.creditAccounts`, which is
                        empty in a live build, so live it could only ever offer "No
                        account" — a credit control that cannot take credit. Hidden
                        until credit sales are migrated, rather than shown broken.
                      */}
                      {isDemoMode() && (
                        <>
                          <Field>
                            <FieldLabel htmlFor="pos-account">Credit account</FieldLabel>
                            <Select
                              value={creditAccountId}
                              onValueChange={(value) => setCreditAccountId(value ?? NO_ACCOUNT)}
                            >
                              <SelectTrigger id="pos-account" className="h-11 w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NO_ACCOUNT}>No account</SelectItem>
                                {creditAccounts.map((account) => (
                                  <SelectItem key={account.id} value={account.id}>
                                    {account.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Field>

                          {creditAccount && (
                            <p className="text-xs text-muted-foreground">
                              <Money value={creditAccount.outstandingBalance} /> of{' '}
                              <Money value={creditAccount.creditLimit} /> used ·{' '}
                              <Money value={balanceAfter} /> after this sale
                            </p>
                          )}

                          {overCreditLimit && creditAccount && (
                            <p className="text-sm text-destructive">
                              Over the credit limit by{' '}
                              <Money value={subtract(balanceAfter, creditAccount.creditLimit)} />.
                              Take a partial payment instead.
                            </p>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {/* Every sale names its customer — walk-in is the default and
                      stays legal only when the sale is fully paid. Searching by
                      name OR phone is how a returning customer is found without
                      leaving the till. */}
                  <Field>
                    <FieldLabel htmlFor="pos-customer-find">Customer</FieldLabel>
                    <CustomerFinder
                      value={customerId}
                      onChange={setCustomerId}
                      customers={customers}
                      onRegister={registerNewCustomer}
                      allowRegister={!offlineBranch}
                      loading={customerLookupPending}
                      disabled={!customerLookupAvailable && !customerLookupPending}
                      disabledMessage={
                        offlineBranch
                          ? 'Customer lookup is unavailable offline. Walk-in cash sales paid in full still work; reconnect to attach a customer.'
                          : 'The customer list could not be loaded. Walk-in cash sales paid in full still work.'
                      }
                    />
                  </Field>

                  {selectedCustomer && (
                    <CustomerRecap
                      customer={selectedCustomer}
                      sales={customerSales}
                      salesAvailable={!salesLoading && !salesError}
                    />
                  )}
                </FieldGroup>
              )}

              {unresolvedAttempt && (
                <div
                  role="alert"
                  className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs"
                >
                  <p className="text-sm font-medium">
                    An earlier {attemptSettlementLabel(unresolvedAttempt)} attempt is
                    unresolved
                  </p>
                  <p className="text-muted-foreground">
                    <Money value={unresolvedAttempt.amountPaid} /> of{' '}
                    <Money value={unresolvedAttempt.total} /> · key{' '}
                    <span className="font-mono">{unresolvedAttempt.idempotencyKey}</span> ·{' '}
                    {new Date(unresolvedAttempt.attemptedAt).toLocaleTimeString()}
                  </p>
                  <p className="text-muted-foreground">
                    The connection dropped before the server confirmed this sale, so it may
                    already be in the ledger. This till will not send this cart again until
                    you check the ledger and resolve the attempt. Do not retry it as cash.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // The original sale is in the ledger: do not ring it again.
                        void resolveUnresolvedAttempt(true);
                      }}
                    >
                      It is in the ledger — close this sale
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // A person has confirmed the original did NOT reach the
                        // server. Only now is a NEW key legitimate; the cart is
                        // kept so they can ring the corrected sale deliberately.
                        void resolveUnresolvedAttempt(false);
                      }}
                    >
                      It is not in the ledger — start a new sale
                    </Button>
                  </div>
                </div>
              )}

              {checkoutError && (
                <p role="alert" className="text-sm text-destructive">
                  {checkoutError}
                </p>
              )}

              <Button
                className="h-11 w-full"
                onClick={() => void completeSale()}
                disabled={
                  lines.length === 0 ||
                  submitting ||
                  offlineSalesBlocked ||
                  unresolvedAttempt !== null
                }
              >
                {submitting ? 'Completing…' : 'Complete sale'}
                <Money value={total} />
              </Button>
            </CardContent>
          </Card>

          <TodayTile today={today} loading={salesLoading} error={salesError} />
        </div>
      </div>

      <BarcodeScanner
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onDetected={onBarcode}
      />
      <PrescriptionDialog
        open={prescriptionOpen}
        onOpenChange={setPrescriptionOpen}
        onConfirm={onPrescriptionConfirm}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />
      <ReceiptPrintArea receipt={receipt} />
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border bg-muted px-1 py-px font-sans text-[0.7rem] font-medium">
      {children}
    </kbd>
  );
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['/'], label: 'Jump to product search' },
  { keys: ['↑', '↓'], label: 'Move through results' },
  { keys: ['↵'], label: 'Add the highlighted product' },
  { keys: ['u'], label: 'Change unit on the highlighted product' },
  { keys: ['F2'], label: 'Scan a barcode' },
  { keys: ['⌘', '↵'], label: 'Complete sale' },
  { keys: ['?'], label: 'Show this list' },
];

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="divide-y">
          {SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.label}
              className="flex items-center justify-between gap-4 py-2"
            >
              <dt className="text-sm text-muted-foreground">{shortcut.label}</dt>
              <dd className="flex shrink-0 items-center">
                {shortcut.keys.map((key) => (
                  <Key key={key}>{key}</Key>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The customer finder: search by name OR phone, one tap to select, and
 * registration without leaving the till.
 *
 * Kept deliberately plain — a type-ahead list, not a combobox library — so the
 * keyboard flow of the screen (type, read, choose) is not interrupted by a
 * dialog. The selected customer's name and phone are always on screen, which
 * is what the cashier confirms before completing a sale.
 */
function CustomerFinder({
  value,
  onChange,
  customers,
  onRegister,
  allowRegister = true,
  disabled = false,
  disabledMessage,
  loading = false,
}: {
  value: string;
  onChange: (value: string) => void;
  customers: PosCustomer[];
  onRegister: (name: string, phone: string) => Promise<{ ok: boolean; error?: string }>;
  allowRegister?: boolean;
  disabled?: boolean;
  disabledMessage?: string;
  loading?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (disabled || loading) {
    return (
      <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {loading
            ? 'Loading the customer list…'
            : (disabledMessage ?? 'Customer lookup is unavailable right now.')}
        </p>
        {!loading && value !== NO_ACCOUNT && (
          <Button
            variant="outline"
            className="h-9 px-3 text-xs"
            onClick={() => onChange(NO_ACCOUNT)}
          >
            Clear customer and use walk-in
          </Button>
        )}
      </div>
    );
  }

  const selected = customers.find((c) => c.id === value);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? customers
        .filter(
          (c) => c.name.toLowerCase().includes(needle) || c.phone.includes(needle),
        )
        .slice(0, 6)
    : [];

  const register = async () => {
    setRegisterError(null);
    setBusy(true);
    const result = await onRegister(newName, newPhone);
    setBusy(false);
    if (!result.ok) {
      setRegisterError(result.error ?? 'The customer could not be registered');
      return;
    }
    setNewName('');
    setNewPhone('');
    setQuery('');
    setShowRegister(false);
    toast.success(`${newName.trim()} registered and added to this sale`);
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        />
        <Input
          id="pos-customer-find"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or phone number"
          className="h-11 pl-9"
          autoComplete="off"
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-label="Find a customer by name or phone number"
        />
      </div>

      {matches.length > 0 && (
        <ul
          role="listbox"
          aria-label="Matching customers"
          className="divide-y overflow-hidden rounded-lg border"
        >
          {matches.map((customer) => (
            <li
              key={customer.id}
              role="option"
              aria-selected={customer.id === value}
              onClick={() => {
                onChange(customer.id);
                setQuery('');
              }}
              className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-accent/50"
            >
              <span className="truncate font-medium">{customer.name}</span>
              <span className="tabular shrink-0 text-xs text-muted-foreground">
                {customer.phone}
              </span>
            </li>
          ))}
        </ul>
      )}
      {needle && matches.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No customer matches “{query.trim()}” — register them below.
        </p>
      )}

      {selected ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <span className="truncate text-sm font-medium">
            {selected.name} · <span className="tabular">{selected.phone}</span>
          </span>
          <Button variant="ghost" className="h-8 shrink-0 px-2 text-xs" onClick={() => onChange(NO_ACCOUNT)}>
            Walk-in instead
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Walk-in — allowed only when the sale is paid in full.
        </p>
      )}

      {!allowRegister ? (
        <p className="text-xs text-muted-foreground">
          Registering a new customer needs the server. Reconnect to add one.
        </p>
      ) : !showRegister ? (
        <Button variant="outline" className="h-10 w-full" onClick={() => setShowRegister(true)}>
          <Plus /> Register a new customer
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg border p-3">
          <Field>
            <FieldLabel htmlFor="pos-new-customer-name">Customer name</FieldLabel>
            <Input
              id="pos-new-customer-name"
              className="h-10"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="pos-new-customer-phone">Phone number</FieldLabel>
            <Input
              id="pos-new-customer-phone"
              type="tel"
              className="h-10"
              value={newPhone}
              onChange={(event) => setNewPhone(event.target.value)}
            />
          </Field>
          {registerError && <p className="text-xs text-destructive">{registerError}</p>}
          <div className="flex gap-2">
            <Button
              className="h-10 flex-1"
              disabled={busy || newName.trim().length < 2 || newPhone.trim().length < 7}
              onClick={() => void register()}
            >
              {busy ? 'Saving…' : 'Save and use'}
            </Button>
            <Button
              variant="outline"
              className="h-10"
              disabled={busy}
              onClick={() => {
                setShowRegister(false);
                setRegisterError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The returning-customer recap, shown under the finder once somebody is
 * selected: who they are, how much they owe, and — from the same branch-scoped
 * ledger the Sales screen reads — their recent purchases, dates, medicines and
 * totals. Deliberately attendant-safe: nothing here reads a cost snapshot or a
 * margin, ever.
 */
function CustomerRecap({
  customer,
  sales,
  salesAvailable,
}: {
  customer: PosCustomer;
  sales: Sale[];
  salesAvailable: boolean;
}) {
  const recent = salesAvailable ? sales.slice(0, 3) : [];

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Purchases" value={salesAvailable ? sales.length : '—'} />
        <StatTile
          label="Owing"
          value={
            customer.outstandingDebt === undefined ? (
              <span className="text-xs">Offline</span>
            ) : (
              <Money value={customer.outstandingDebt} compact />
            )
          }
        />
        <StatTile
          label="Lifetime"
          value={
            salesAvailable ? (
              <Money
                value={sum(sales.map((sale) => sale.total))}
                compact
              />
            ) : (
              '—'
            )
          }
        />
      </div>

      {!salesAvailable ? (
        <p className="text-xs text-muted-foreground">
          Recent purchases and balances need the server. Reconnect to see them.
        </p>
      ) : recent.length === 0 ? (
        <p className="text-xs text-muted-foreground">No previous purchases on the ledger yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {recent.map((sale) => (
            <li key={sale.id} className="rounded-lg border bg-background px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="tabular font-medium">{sale.receiptNumber}</span>
                <span className="text-muted-foreground">
                  {new Date(sale.date).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </div>
              <p className="truncate text-muted-foreground">
                {sale.items
                  .slice(0, 3)
                  .map((item) => `${item.medicineName} ×${item.quantity}`)
                  .join(', ')}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    sale.outstandingBalance > 0 ? 'text-destructive' : 'text-success',
                  )}
                >
                  {sale.outstandingBalance > 0
                    ? <>Owing <Money value={sale.outstandingBalance} /></>
                    : 'Paid in full'}
                </span>
                <Money value={sale.total} className="font-semibold" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[0.7rem] text-muted-foreground">
        From this pharmacy's recent ledger only.
      </p>
    </div>
  );
}

function TotalRow({
  label,
  value,
  emphasis,
  tone,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
  tone?: 'warning' | 'destructive' | 'success';
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span
        className={
          tone === 'destructive'
            ? 'text-sm text-destructive'
            : tone === 'warning'
              ? 'text-sm text-warning'
              : tone === 'success'
                ? 'text-sm text-success'
                : 'text-sm text-muted-foreground'
        }
      >
        {label}
      </span>
      <Money
        value={value}
        className={emphasis ? 'text-base font-semibold' : 'text-sm font-medium'}
      />
    </div>
  );
}

/**
 * Today's takings, from the same ledger the Sales screen reads.
 *
 * `state.sales` is empty in a live build, so reading the store here pinned this
 * tile at ₦0 however busy the till was. It reads `useSales()` instead — the live
 * ledger in a live build, the seeded one in demo — and the caller re-reads after
 * a completed sale.
 *
 * `loading` covers the first read, so the tile shows a skeleton rather than a
 * confident ₦0, and a failed read says so instead of reporting a false zero. The
 * hook pages the ledger, so the sum covers the most recent page — the same bound
 * the Sales screen has.
 */
function TodayTile({
  today,
  loading,
  error,
}: {
  today: ReturnType<typeof summariseSales>;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <StatTile
      label="Taken today"
      value={error ? '—' : <Money value={today.net} compact />}
      hint={error ? 'Ledger unavailable' : `${today.count} sales`}
      icon={<Banknote className="size-4" />}
      loading={loading}
    />
  );
}

/* ----------------------------------------------------------- offline cache */

/**
 * Says exactly which saved snapshot the till is using and how old it is. The
 * 24-hour rule is enforced in code, not just described here: when the cache is
 * too old (or absent) `salesBlocked` is true and the search/checkout paths
 * refuse to compose a sale.
 */
function OfflineCacheBanner({
  cache,
  now,
  loading,
  readError,
  liveReady,
  usingCachedCatalogue,
  usingCachedCustomers,
  customerLookupAvailable,
  salesBlocked,
}: {
  cache: PosCacheSnapshot | null;
  now: number;
  loading: boolean;
  readError: string | null;
  liveReady: boolean;
  usingCachedCatalogue: boolean;
  usingCachedCustomers: boolean;
  customerLookupAvailable: boolean;
  salesBlocked: boolean;
}) {
  const catalogue = cache?.catalogue;
  const customers = cache?.customers;
  const ageOf = (slice: { cachedAt: number | null } | undefined): number | null =>
    slice?.cachedAt === null || slice?.cachedAt === undefined
      ? null
      : Math.max(0, now - slice.cachedAt);
  const catalogueAge = ageOf(catalogue);
  const customersAge = ageOf(customers);
  const details: string[] = [];
  let tone: 'destructive' | 'warning' | 'muted' = 'warning';
  let title = 'Using the saved offline catalogue';

  if (readError) {
    tone = 'destructive';
    title = 'Saved catalogue unreadable';
    details.push(readError);
  } else if (salesBlocked) {
    tone = 'destructive';
    title = 'Offline selling is blocked';
    if (loading) {
      details.push('Reading the saved catalogue on this device…');
    } else if (!catalogue?.present) {
      details.push('This device has no saved product catalogue for this branch.');
    } else if (catalogueAge !== null && catalogueAge >= VERY_STALE_MS) {
      details.push(
        `The saved catalogue is from ${formatCacheAge(catalogueAge)}. The 24-hour limit has passed.`,
      );
    } else {
      details.push('The saved product catalogue is not usable. Reconnect before starting a sale.');
    }
  } else if (liveReady) {
    tone = 'muted';
    title = 'Server read available';
    details.push(
      catalogue?.present
        ? `The catalogue was read from the server; the saved copy is from ${formatCacheAge(catalogueAge)}.`
        : 'The catalogue was read from the server.',
    );
  } else if (usingCachedCatalogue) {
    details.push(
      `Products: saved ${formatCacheAge(catalogueAge)}. Stock is a hint only and is not reserved.`,
    );
  }

  if (salesBlocked) {
    // The product message above already explains the block.
  } else if (liveReady && !usingCachedCustomers) {
    details.push('Customer data is from the server.');
  } else if (usingCachedCustomers) {
    details.push(
      `Customers: saved ${formatCacheAge(customersAge)}. Debt and wallet balances are not available offline.`,
    );
  } else if (!customerLookupAvailable) {
    details.push(
      'Customer lookup is unavailable offline. Walk-in cash sales paid in full still work.',
    );
  }

  if (!liveReady) {
    details.push(OFFLINE_CASH_ONLY_MESSAGE);
  }

  const toneClass =
    tone === 'destructive'
      ? 'border-destructive/30 bg-destructive/5 text-destructive'
      : tone === 'warning'
        ? 'border-warning/40 bg-warning-subtle text-warning'
        : 'border-border bg-muted/40 text-muted-foreground';

  return (
    <div role={tone === 'destructive' ? 'alert' : 'status'} className={cn('rounded-lg border px-3 py-2 text-sm', toneClass)}>
      <p className="font-medium">{title}</p>
      {details.map((detail) => (
        <p key={detail} className="mt-0.5">
          {detail}
        </p>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- device panel */

function deviceTime(iso: string | null): string {
  if (!iso) return 'unknown time';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'unknown time'
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type DeviceSaleView = PendingSaleView;

/**
 * The truthful device panel.
 *
 * Four states, exactly as the sync contract defines them, and never conflated:
 *   - Saved on this device / Pending sync — durable locally, not yet sent.
 *   - Needs attention — the engine stopped retrying; a person must act.
 *   - Confirmed by server — a trustworthy server response settled the sale.
 *
 * Deliberately scoped to claims this screen earns: nothing here says the
 * application is offline-ready — this panel is the POS's own safety net, and
 * the connectivity line keeps the OS's network opinion separate from a
 * confirmed server response.
 */
function ConnectivityAndDevicePanel({
  probe,
  pending,
  needsAttention,
  conflicts,
  confirmed,
  deviceError,
  syncError,
  cacheError,
  usingCachedCatalogue,
  onRetryNow,
}: {
  probe: ProbeResult | null;
  pending: DeviceSaleView[];
  needsAttention: DeviceSaleView[];
  conflicts: DeviceSaleView[];
  confirmed: ConfirmedSaleView[];
  deviceError: string | null;
  syncError: string | null;
  cacheError: string | null;
  usingCachedCatalogue: boolean;
  onRetryNow: () => void;
}) {
  const quiet =
    pending.length === 0 &&
    needsAttention.length === 0 &&
    conflicts.length === 0 &&
    confirmed.length === 0 &&
    !deviceError &&
    !syncError &&
    !cacheError &&
    probe?.serverReachable !== false;
  if (quiet) return null;

  const checked = probe !== null && probe.checkedAt ? new Date(probe.checkedAt).toLocaleTimeString() : null;
  const offline = probe?.serverReachable === false;

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={probe?.browserOnline ? 'secondary' : 'outline'}>
              Network: {probe?.browserOnline ? 'on (OS report)' : 'off'}
            </Badge>
            <Badge variant={probe?.serverReachable ? 'default' : 'outline'}>
              {probe?.serverReachable
                ? 'Server reachable'
                : probe === null
                  ? 'Server not checked yet'
                  : 'Server not reachable'}
            </Badge>
            {checked && <span className="text-muted-foreground text-xs">last checked {checked}</span>}
          </div>
          {pending.length > 0 && (
            <Button size="sm" variant="outline" onClick={onRetryNow}>
              Check pending sales now
            </Button>
          )}
        </div>
      </CardHeader>
      {(deviceError || syncError || cacheError) && (
        <CardContent className="space-y-1 py-2">
          {deviceError && (
            <p role="alert" className="text-sm text-destructive">
              {deviceError}
            </p>
          )}
          {syncError && (
            <p role="alert" className="text-sm text-destructive">
              {syncError}
            </p>
          )}
          {cacheError && (
            <p role="alert" className="text-sm text-destructive">
              {cacheError}
            </p>
          )}
        </CardContent>
      )}
      {offline && usingCachedCatalogue && (
        <CardContent className="py-2">
          <p className="text-sm text-amber-800">
            Stock shown here is only a cached estimate. It is not reserved, and another device may
            sell the same units while this till is offline.
          </p>
        </CardContent>
      )}
      {pending.length > 0 && (
        <CardContent className="py-2">
          <p className="text-sm font-medium">Saved on this device — waiting for server confirmation</p>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {pending.map((sale) => (
              <li key={sale.idempotencyKey}>
                Occurred {deviceTime(sale.soldAt)} · {sale.nextAction}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
      {needsAttention.length > 0 && (
        <CardContent className="py-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <TriangleAlert className="size-4" /> Needs attention — do not assume this sale is recorded
          </p>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {needsAttention.map((sale) => (
              <li key={sale.idempotencyKey}>
                Occurred {deviceTime(sale.soldAt)} — {sale.nextAction}
                {sale.reason ? ` (reason: ${sale.reason})` : ''}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
      {conflicts.length > 0 && (
        <CardContent className="py-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <TriangleAlert className="size-4" /> Sales needing reconciliation
          </p>
          <ul className="mt-1 space-y-2 text-sm text-muted-foreground">
            {conflicts.map((sale) => (
              <li key={sale.idempotencyKey}>
                <p>
                  {sale.receiptNumber ? `Receipt ${sale.receiptNumber} — ` : ''}
                  Occurred {deviceTime(sale.soldAt)} —{' '}
                  {sale.serverConfirmed
                    ? 'recorded by the server, but the amount differs'
                    : sale.serverRefused
                      ? 'refused by the server'
                      : 'local duplicate attempt — not sent'}
                </p>
                <p>{sale.reason}</p>
                <p className="font-medium">{sale.nextAction}</p>
                <p className="font-mono text-xs">ID {sale.idempotencyKey}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
      {confirmed.length > 0 && (
        <CardContent className="py-2">
          <p className="text-sm font-medium">Confirmed by the server</p>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {confirmed.slice(0, 5).map((sale) => (
              <li key={sale.idempotencyKey}>
                {sale.receiptNumber ?? 'Sale'} — occurred {deviceTime(sale.soldAt)}
                {sale.reconciliation ? (
                  <span className="text-destructive">
                    {' '}— total differs from the till; review before taking or refunding money
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
