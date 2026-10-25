import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowRight, Minus, PackagePlus, Plus, ScanLine, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { BarcodeScanner } from '~/components/barcode-scanner';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Money, PageHeader, SectionTitle, StatTile } from '~/components/app/primitives';
import { formatCount, formatWhen, isoDate, money, multiply, sum } from '~/domain/money';
import {
  QUANTITY_PROBLEM,
  nextQuantity,
  normaliseQuantityTyping,
  parseQuantityText,
  type QuantityProblem,
} from '~/domain/quantity-input';
import { findBaseUnit, findUnit } from '~/domain/units';
import { useIsOwner } from '~/hooks/use-is-owner';
import { useMedicines } from '~/hooks/use-medicines';
import { useStockMovements } from '~/hooks/use-stock-movements';
import { useStockReceipts } from '~/hooks/use-stock-receipts';
import { isDemoMode } from '~/lib/session';
import { receiveStock as receiveStockRemote } from '~/lib/supabase/stock';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';
import type { ReceiptStatus, StockMovementType } from '~/domain/types';

export const Route = createFileRoute('/_app/stock-receiving')({
  component: StockReceiving,
});

/** Stock is a 24-month product. A year out is the safe default for a new batch. */
function oneYearOut(): string {
  return isoDate(new Date(Date.now() + 365 * 86_400_000));
}

/**
 * The receipt number for one delivery attempt.
 *
 * `stock_receipts_number_unique` is `(branch_id, receipt_number)`, so this number
 * is also the idempotency key: a resubmission of the *same* delivery — a
 * double-click, a retry after a dropped connection — books nothing twice, because
 * `pf_receive_stock` finds the number and returns the receipt it already wrote.
 *
 * That only holds if the number is stable across a retry and different for the
 * next delivery, so it is held in state and only replaced once a submit succeeds.
 * The random tail is what keeps two deliveries apart; the year is what makes it
 * readable on a delivery note. `crypto.randomUUID` is not available on every
 * origin this runs on, so the fallback is real, not decorative.
 */
function newReceiptNumber(): string {
  const tail =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `GRN-${new Date().getFullYear()}-${tail.toUpperCase()}`;
}

const MOVEMENT_LABEL: Record<StockMovementType, string> = {
  receipt: 'Received',
  sale: 'Sold',
  adjustment: 'Adjusted',
  return: 'Returned',
  void: 'Voided',
  disposal: 'Disposed',
};

const MOVEMENT_VARIANT: Record<
  StockMovementType,
  'success' | 'secondary' | 'warning' | 'destructive' | 'outline'
> = {
  receipt: 'success',
  sale: 'secondary',
  adjustment: 'outline',
  return: 'warning',
  void: 'destructive',
  disposal: 'destructive',
};

const RECEIPT_STATUS: Record<ReceiptStatus, { label: string; variant: 'warning' | 'success' }> = {
  pending_pricing: { label: 'Awaiting pricing', variant: 'warning' },
  confirmed: { label: 'Confirmed', variant: 'success' },
};

function StockReceiving() {
  // Catalogue from Supabase in live mode; useMedicines has no local
  // fallback there, so a failed read surfaces as an error, not as seed data.
  const { medicines, refresh: refreshMedicines } = useMedicines();
  const suppliers = usePharmacy((state) => state.suppliers);
  // Receipts and movements, in whichever mode has them. Both read Supabase in a
  // live build and the seeded ledger in demo, so the counts and tables below are
  // the same figures either way.
  const {
    receipts,
    loading: receiptsLoading,
    error: receiptsError,
    refresh: refreshReceipts,
  } = useStockReceipts();
  const {
    movements,
    loading: movementsLoading,
    error: movementsError,
    refresh: refreshMovements,
  } = useStockMovements(20);
  /**
   * Owner, according to the database — not `state.currentUser.canApprovePricing`.
   *
   * `profiles.role` is a display cache that `branch_memberships.role` supersedes
   * and nothing repairs, so an owner demoted at their branch would keep the cost
   * fields. `useIsOwner()` asks `pf_is_owner()`, the same question the triggers
   * ask. It is display gating only: the database refuses a non-owner's cost
   * regardless of what this renders.
   */
  const canPrice = useIsOwner();
  // In demo mode the store *is* the pharmacy and receiving stays local, exactly
  // as it always was. In live mode the delivery is the database's to record.
  const live = !isDemoMode();
  const { receiveStock } = usePharmacyActions();
  const navigate = useNavigate();

  const [medicineId, setMedicineId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [quantity, setQuantity] = useState('');
  /** Set when the field holds something that cannot be received. Cleared on a valid edit. */
  const [quantityProblem, setQuantityProblem] = useState<QuantityProblem | null>(null);
  /** The idempotency key for the delivery being entered. See `newReceiptNumber`. */
  const [receiptNumber, setReceiptNumber] = useState(() => newReceiptNumber());
  const [submitting, setSubmitting] = useState(false);
  /**
   * Which packaging unit the count is in.
   *
   * A delivery note says "5 boxes" far more often than "500 tablets", so the
   * unit is a first-class choice here rather than an assumption. Empty means
   * "not chosen yet", which falls back to the base unit — the old behaviour.
   */
  const [receiveUnitKey, setReceiveUnitKey] = useState('');
  const [expiryDate, setExpiryDate] = useState(oneYearOut);
  const [costInput, setCostInput] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const medicine = medicines.find((m) => m.id === medicineId);
  const cost = money(Number(costInput) || 0);
  const price = money(Number(priceInput) || 0);
  /**
   * The count as a number for the preview only.
   *
   * `0` is a placeholder, never a submission: `submit` re-parses the field and
   * refuses to book anything when it is empty, zero, fractional or too large.
   * Parsing here (rather than `Number(quantity) || 0`) is what keeps `1.999`
   * from being rounded to `2` on its way to the ledger.
   */
  const parsedQuantity = parseQuantityText(quantity);
  const units = parsedQuantity.ok ? parsedQuantity.value : 0;

  const baseUnit = medicine ? findBaseUnit(medicine.units) : null;
  const receiveUnit = medicine
    ? findUnit(medicine.units, receiveUnitKey) ?? baseUnit
    : null;

  /** Live preview of what the entered count means in base units. */
  const incomingBaseUnits =
    medicine && receiveUnit && units > 0 ? multiply(receiveUnit.multiplier, units) : 0;
  const value = multiply(cost, incomingBaseUnits);

  /**
   * A scan selects an existing product or reports that there isn't one.
   *
   * It deliberately does not create a product. Receiving stock against a
   * barcode that matches nothing means either the barcode is not in the
   * catalogue yet or the attendant scanned the wrong pack — and silently
   * minting a new product from one of those is how a pharmacy ends up
   * dispensing a drug nobody chose. The fix is a deliberate product creation,
   * which is a different screen with pricing attached.
   */
  const onBarcode = (code: string) => {
    const match = medicines.find((medicine) => medicine.barcode === code);

    if (!match) {
      toast.error(`No product with barcode ${code}`, {
        description: 'Add the product to the catalogue first, then receive against it.',
      });
      return;
    }

    setMedicineId(match.id);
    setError(null);
    toast.success(`${match.name} selected`, { description: `${match.strength} · ${code}` });
  };

  /**
   * Book the delivery in.
   *
   * Demo mode keeps the original local path, because there the store genuinely is
   * the pharmacy. Live mode calls `pf_receive_stock`, which writes the receipt,
   * the lot and (through the batch trigger) the movement in one transaction and
   * resolves the branch, the actor and the received date itself. Only the counted
   * quantity, its unit and the paperwork's own fields are sent.
   *
   * The receipt number is reused across retries of the same attempt and replaced
   * only on success, which is what makes a double-click safe rather than a second
   * delivery. See `newReceiptNumber`.
   */
  const submit = async () => {
    if (submitting) return;
    setError(null);

    /**
     * The screen's own check, before either write path.
     *
     * The database function and `receiveStock` both refuse a bad count, but by
     * then the message is generic and the live path would send `0` base units.
     * Deciding here is what lets the field explain itself — and it means an
     * empty or zero quantity never reaches a mutation at all.
     */
    if (!medicine) {
      setError('Choose the product that arrived.');
      return;
    }
    if (!receiveUnit) {
      // Without a counted unit the live path would send zero base units. Refuse
      // here instead of booking an empty delivery against the product.
      setError('Choose the unit the delivery was counted in.');
      return;
    }

    const parsed = parseQuantityText(quantity);
    if (!parsed.ok) {
      setQuantityProblem(parsed.reason);
      return;
    }
    setQuantityProblem(null);
    const receivedQuantity = parsed.value;

    if (!live) {
      const result = receiveStock({
        medicineId,
        batchNumber,
        quantity: receivedQuantity,
        unitKey: receiveUnit?.key ?? '',
        supplierId,
        expiryDate,
        ...(canPrice && costInput ? { costPerBaseUnit: cost } : {}),
        ...(canPrice && priceInput ? { pricePerBaseUnit: price } : {}),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      const receipt = result.value;
      setBatchNumber('');
      setQuantity('');
      setQuantityProblem(null);

      if (receipt.status === 'pending_pricing') {
        toast('Sent for owner approval', {
          description: `${receipt.receiptNumber} · ${receipt.medicineName}`,
          action: { label: 'Open pricing', onClick: () => void navigate({ to: '/pricing' }) },
        });
        return;
      }

      toast.success(`${receipt.receiptNumber} received and priced`);
      return;
    }

    setSubmitting(true);
    try {
      const result = await receiveStockRemote({
        receiptNumber,
        medicineId,
        batchNumber: batchNumber.trim(),
        baseUnitsReceived: incomingBaseUnits,
        ...(supplierId ? { supplierId } : {}),
        expiryDate,
        ...(canPrice && costInput ? { costPerBaseUnit: cost } : {}),
        ...(canPrice && priceInput ? { pricePerBaseUnit: price } : {}),
        // The counted unit, snapshotted. Only when the count is a whole number in
        // that unit — the column is an integer and the note says "5 boxes".
        ...(receiveUnit && Number.isInteger(receivedQuantity) && receivedQuantity > 0
          ? {
              receivedQuantity,
              receivedUnitKey: receiveUnit.key,
              receivedUnitName: receiveUnit.name,
              receivedUnitMultiplier: receiveUnit.multiplier,
            }
          : {}),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      const saved = result.data;
      setBatchNumber('');
      setQuantity('');
      setQuantityProblem(null);
      // A new number for the next delivery. The one just used stays the key for a
      // retry of *this* attempt, which is the whole point of holding it in state.
      setReceiptNumber(newReceiptNumber());
      // The database moved stock: re-read so the counts and tables are current.
      refreshReceipts();
      refreshMovements();
      refreshMedicines();

      if (saved.alreadyReceived) {
        toast('Already recorded', {
          description: `${saved.receiptNumber} was not booked in a second time.`,
        });
        return;
      }

      if (saved.state === 'pending_pricing') {
        toast('Sent for owner approval', {
          description: saved.receiptNumber,
          action: { label: 'Open pricing', onClick: () => void navigate({ to: '/pricing' }) },
        });
        return;
      }

      toast.success(`${saved.receiptNumber} received and priced`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Stock Receiving" description="Book in a supplier delivery." />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Units on hand"
          value={sum(medicines.map((m) => m.totalQuantity)).toLocaleString('en-NG')}
          hint={`${medicines.length} products`}
          icon={<PackagePlus className="size-4" />}
        />
        <StatTile
          label="Awaiting pricing"
          value={receipts.filter((r) => r.status === 'pending_pricing').length}
          hint="Owner approval needed"
          icon={<TriangleAlert className="size-4" />}
          loading={receiptsLoading}
        />
        <StatTile
          label="Receipts logged"
          value={receipts.length}
          hint={`${movements.length} movements recorded`}
          icon={<PackagePlus className="size-4" />}
          loading={receiptsLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">New receipt</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="recv-medicine">Product</FieldLabel>
                  <div className="flex gap-2">
                    <Select value={medicineId} onValueChange={(value) => setMedicineId(value ?? '')}>
                      <SelectTrigger id="recv-medicine" className="h-10 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {medicines.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.name} · {option.strength}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-10 shrink-0"
                      onClick={() => setScannerOpen(true)}
                      aria-label="Scan barcode">
                      <ScanLine />
                    </Button>
                  </div>
                </Field>

                <Field>
                  <FieldLabel htmlFor="recv-batch">Batch number</FieldLabel>
                  <Input
                    id="recv-batch"
                    className="h-10"
                    placeholder="BN-ABC-2610A"
                    value={batchNumber}
                    onChange={(event) => setBatchNumber(event.target.value)}
                  />
                </Field>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="recv-unit">Counted in</FieldLabel>
                    <Select
                      value={receiveUnit?.key ?? ''}
                      onValueChange={(value) => setReceiveUnitKey(value ?? '')}
                      disabled={!medicine}
                    >
                      <SelectTrigger id="recv-unit" className="h-10">
                        <SelectValue placeholder={medicine ? 'Choose a unit' : 'Pick a product first'} />
                      </SelectTrigger>
                      <SelectContent>
                        {(medicine?.units ?? []).map((unit) => (
                          <SelectItem key={unit.key} value={unit.key}>
                            {unit.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {medicine && baseUnit && (
                      <p className="text-xs text-muted-foreground">
                        Base unit is {baseUnit.name}. Everything is stored in {baseUnit.name.toLowerCase()}s.
                      </p>
                    )}
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="recv-qty">Quantity</FieldLabel>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-10 shrink-0"
                        onClick={() => setQuantity(nextQuantity(quantity, -1))}
                        aria-label="Decrease quantity"
                      >
                        <Minus />
                      </Button>
                      {/* A text field with a numeric keypad, not `type="number"`:
                          see `~/domain/quantity-input` for why the native number
                          input made this field unreliable to type into. */}
                      <Input
                        id="recv-qty"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        pattern="[0-9]*"
                        placeholder="0"
                        className="h-10 text-center"
                        value={quantity}
                        aria-invalid={quantityProblem ? true : undefined}
                        aria-describedby={quantityProblem ? 'recv-qty-problem' : undefined}
                        onChange={(event) => {
                          const next = normaliseQuantityTyping(event.target.value);
                          if (next === null) {
                            // Keep the previous value and say why. Stripping the
                            // character instead would turn "1.5" into "15".
                            setQuantityProblem('not-whole');
                            return;
                          }
                          setQuantity(next);
                          if (quantityProblem) setQuantityProblem(null);
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-10 shrink-0"
                        // One press is one counted unit, not one multiplier.
                        onClick={() => setQuantity(nextQuantity(quantity, 1))}
                        aria-label="Increase quantity"
                      >
                        <Plus />
                      </Button>
                    </div>
                    {quantityProblem && (
                      <p id="recv-qty-problem" role="alert" className="text-sm text-destructive">
                        {QUANTITY_PROBLEM[quantityProblem]}
                      </p>
                    )}
                    {/* The conversion is shown as it happens. An attendant
                        keying in "5" must be able to see that this means 500
                        before they commit, not discover it on the batch. */}
                    {medicine && receiveUnit && units > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {formatCount(units)} × {receiveUnit.name} ={' '}
                        <span data-numeric className="tabular font-medium text-foreground">
                          {formatCount(incomingBaseUnits)}
                        </span>
                        {baseUnit ? ` × ${baseUnit.name}` : ' base units'}
                      </p>
                    )}
                    {medicine && (
                      <p className="text-xs text-muted-foreground">
                        {/* "480 × Tablet on hand" rather than "480 tablet" —
                            lowercasing a unit name reads as a typo, and unit
                            names legitimately carry counts ("Bottle (100ml)") so
                            pluralising them is not safe either. */}
                        {formatCount(medicine.totalQuantity)}
                        {baseUnit ? ` × ${baseUnit.name} on hand` : ' base units on hand'}
                      </p>
                    )}
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="recv-expiry">Expiry</FieldLabel>
                    <Input
                      id="recv-expiry"
                      type="date"
                      className="h-10"
                      value={expiryDate}
                      onChange={(event) => setExpiryDate(event.target.value)}
                    />
                  </Field>
                </div>

                <Field>
                  <FieldLabel htmlFor="recv-supplier">Supplier</FieldLabel>
                  <Select value={supplierId} onValueChange={(value) => setSupplierId(value ?? '')}>
                    <SelectTrigger id="recv-supplier" className="h-10 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers.map((supplier) => (
                        <SelectItem key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {canPrice && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="recv-cost">Cost per base unit</FieldLabel>
                      <Input
                        id="recv-cost"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        className="h-10"
                        value={costInput}
                        onChange={(event) => setCostInput(event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="recv-price">Selling price</FieldLabel>
                      <Input
                        id="recv-price"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        className="h-10"
                        value={priceInput}
                        onChange={(event) => setPriceInput(event.target.value)}
                      />
                    </Field>
                  </div>
                )}

                {!canPrice && (
                  <p className="rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm">
                    Assistants book stock in but cannot price it. This receipt goes to the owner
                    for approval.
                  </p>
                )}

                {canPrice && costInput && (
                  <p className="text-sm text-muted-foreground">
                    Receipt value <Money value={value} />
                  </p>
                )}

                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}

                <Button type="submit" className="h-10 w-full" disabled={submitting}>
                  {submitting ? 'Recording…' : 'Receive stock'}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="pb-2">
              <SectionTitle
                action={
                  <Button variant="ghost" size="sm" render={<Link to="/pricing" />}>
                    Pricing queue
                    <ArrowRight />
                  </Button>
                }
              >
                Recent receipts
              </SectionTitle>
            </CardHeader>
            <CardContent>
              {receiptsError ? (
                <p role="alert" className="py-6 text-center text-sm text-muted-foreground">
                  {receiptsError}
                </p>
              ) : receiptsLoading && receipts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Loading receipts…</p>
              ) : receipts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nothing received yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Receipt</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Received by</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipts.map((receipt) => {
                      const meta = RECEIPT_STATUS[receipt.status];
                      return (
                        <TableRow key={receipt.id}>
                          <TableCell data-numeric className="tabular font-medium">
                            {receipt.receiptNumber}
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <span className="block">{receipt.medicineName}</span>
                            <span className="block text-xs text-muted-foreground">
                              {receipt.batchNumber}
                            </span>
                          </TableCell>
                          <TableCell data-numeric className="tabular text-right">
                            {receipt.baseUnitsReceived.toLocaleString('en-NG')}
                          </TableCell>
                          <TableCell>
                            {suppliers.find((s) => s.id === receipt.supplier)?.name ??
                              receipt.supplier}
                          </TableCell>
                          <TableCell>{receipt.receivedBy}</TableCell>
                          <TableCell data-numeric className="tabular">
                            {formatWhen(receipt.dateReceived)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={meta.variant}>{meta.label}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <SectionTitle>Stock movements</SectionTitle>
            </CardHeader>
            <CardContent>
              {movementsError ? (
                <p role="alert" className="py-6 text-center text-sm text-muted-foreground">
                  {movementsError}
                </p>
              ) : movementsLoading && movements.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Loading movements…</p>
              ) : movements.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No movements recorded yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Change</TableHead>
                      <TableHead className="text-right">Resulting</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movements.map((movement) => (
                      <TableRow key={movement.id}>
                        <TableCell>
                          <Badge variant={MOVEMENT_VARIANT[movement.type]}>
                            {MOVEMENT_LABEL[movement.type]}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <span className="block">{movement.medicineName}</span>
                          <span className="block text-xs text-muted-foreground">
                            {movement.notes}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money
                            value={movement.quantityChanged}
                            signed
                            className={
                              movement.quantityChanged < 0 ? 'text-muted-foreground' : 'text-success'
                            }
                          />
                        </TableCell>
                        <TableCell data-numeric className="tabular text-right">
                          {movement.resultingQuantity.toLocaleString('en-NG')}
                        </TableCell>
                        <TableCell>{movement.performedBy}</TableCell>
                        <TableCell data-numeric className="tabular">
                          {formatWhen(movement.timestamp)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <BarcodeScanner
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onDetected={onBarcode}
        title="Scan product"
        description="Scan the barcode on the pack to select the product."
      />
    </div>
  );
}
