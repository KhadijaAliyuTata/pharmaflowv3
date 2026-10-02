import { useMemo, useState } from 'react';
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
import { add, money, multiply, subtract, sum } from '~/domain/money';
import {
  saleBlock,
  salesSince,
  searchMedicines,
  sellableQuantity,
  stockStatus,
  summariseSales,
} from '~/domain/selectors';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';
import type { CartLine, Medicine, PaymentMethod, TradeUnit } from '~/domain/types';

export const Route = createFileRoute('/_app/pos')({
  component: PointOfSale,
});

/** A cart entry is only a choice; everything priced is derived at checkout. */
interface CartEntry {
  medicineId: string;
  unitKey: string;
  quantity: number;
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'pos_card', label: 'POS card' },
  { value: 'wallet', label: 'Wallet' },
];

const NO_ACCOUNT = 'none';

function PointOfSale() {
  const medicines = usePharmacy((state) => state.medicines);
  const creditAccounts = usePharmacy((state) => state.creditAccounts);
  const today = usePharmacy((state) => summariseSales(salesSince(state.sales, 24)));
  const { checkout } = usePharmacyActions();

  // The cart is a register session, not domain data. Persisting it would let a
  // half-finished sale survive a reload and be rung up against yesterday's stock.
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [query, setQuery] = useState('');

  const [discountInput, setDiscountInput] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [tenderedInput, setTenderedInput] = useState('');
  const [customerId, setCustomerId] = useState(NO_ACCOUNT);
  const [creditAccountId, setCreditAccountId] = useState(NO_ACCOUNT);
  const [dispensedAgainstPrescription, setDispensedAgainstPrescription] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [prescriptionOpen, setPrescriptionOpen] = useState(false);

  const results = useMemo(() => searchMedicines(medicines, query).slice(0, 12), [medicines, query]);

  const lines = useMemo<CartLine[]>(
    () =>
      cart.flatMap((entry) => {
        const medicine = medicines.find((m) => m.id === entry.medicineId);
        const unit = medicine?.units.find((u) => u.key === entry.unitKey);
        if (!medicine || !unit) return [];

        return [
          {
            medicineId: medicine.id,
            unitKey: unit.key,
            unitName: unit.name,
            unitMultiplier: unit.multiplier,
            unitPrice: unit.sellingPrice,
            quantity: entry.quantity,
            baseUnitsTotal: multiply(unit.multiplier, entry.quantity),
            lineTotal: multiply(unit.sellingPrice, entry.quantity),
          },
        ];
      }),
    [cart, medicines],
  );

  const subtotal = sum(lines.map((line) => line.lineTotal));
  const discount = money(Number(discountInput) || 0);
  const total = subtract(subtotal, discount);

  // More cash handed over than the sale costs is change, not revenue. Recording
  // the tendered amount as paid would break every margin report in the app.
  const tendered = money(Number(tenderedInput) || 0);
  const changeDue = subtract(tendered, total);
  const amountPaid = tendered > total ? total : tendered;
  const outstanding = subtract(total, amountPaid);

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
   * Scanning cannot express "one tablet" the way the unit picker can, so this
   * picks the largest tradeable unit — a carton of paracetamol is what a
   * customer carrying a stack of boxes wants, and the attendant can still
   * switch units with the picker on the search result.
   */
  const defaultUnit = (medicine: Medicine) =>
    medicine.units.reduce<TradeUnit | null>(
      (largest, unit) => (largest === null || unit.multiplier > largest.multiplier ? unit : largest),
      null,
    );

  /**
   * Scanning into the cart goes through the same `saleBlock` gate the manual
   * Add button uses. A recall lock or an expired batch must not be
   * bypassable by a faster path, so the check is not duplicated here — the
   * blocked product simply reports and stops.
   */
  const onBarcode = (code: string) => {
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
    setTenderedInput('');
    setCustomerId(NO_ACCOUNT);
    setCreditAccountId(NO_ACCOUNT);
    setDispensedAgainstPrescription(false);
    setCheckoutError(null);
  };

  const completeSale = () => {
    setCheckoutError(null);

    const result = checkout({
      lines,
      paymentMethod,
      amountPaid,
      discount,
      ...(discountReason.trim() ? { discountReason } : {}),
      ...(customerId !== NO_ACCOUNT ? { customerId } : {}),
      ...(creditAccountId !== NO_ACCOUNT ? { creditAccountId } : {}),
      ...(dispensedAgainstPrescription ? { dispensedAgainstPrescription } : {}),
    });

    if (!result.ok) {
      setCheckoutError(result.error);
      return;
    }

    toast.success(`${result.value.sale.receiptNumber} completed`);
    clearSale();
  };

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

      <div className="grid gap-4 xl:grid-cols-3">
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
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Name, generic, strength or barcode"
                  className="h-11 pl-9"
                  autoComplete="off"
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                onClick={() => setScannerOpen(true)}
                aria-label="Scan barcode">
                <ScanLine />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                onClick={() => setPrescriptionOpen(true)}
                aria-label="Read prescription">
                <FileText />
              </Button>
            </div>
          </Field>

          <div className="space-y-2">
            {results.length === 0 ? (
              <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                No product matches that search.
              </p>
            ) : (
              results.map((medicine) => {
                const block = saleBlock(medicine);
                return (
                  <Card key={medicine.id} size="sm">
                    <CardContent className="flex flex-wrap items-center gap-3">
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

                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Per base unit</p>
                          <Money
                            value={medicine.pricePerBaseUnit}
                            className="text-sm font-semibold"
                          />
                        </div>

                        {block ? (
                          <Button disabled className="h-11 w-28">
                            Blocked
                          </Button>
                        ) : (
                          <UnitPicker medicine={medicine} onAdd={addToCart} />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
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
                  <FieldLabel htmlFor="pos-method">Method</FieldLabel>
                  <Select
                    value={paymentMethod}
                    onValueChange={(value) => setPaymentMethod((value as PaymentMethod) ?? 'cash')}
                  >
                    <SelectTrigger id="pos-method" className="h-11 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((method) => (
                        <SelectItem key={method.value} value={method.value}>
                          {method.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
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

                <div className="grid gap-3 sm:grid-cols-2">
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

                  <div className="space-y-2 self-end">
                    <TotalRow label="Subtotal" value={subtotal} />
                    <TotalRow label="Discount" value={discount} tone="warning" />
                    <TotalRow label="Total" value={total} emphasis />
                    {changeDue > 0 && (
                      <TotalRow label="Change due" value={changeDue} tone="success" />
                    )}
                    {outstanding > 0 && (
                      <TotalRow label="Outstanding" value={outstanding} tone="destructive" />
                    )}
                  </div>
                </div>
              </FieldGroup>

              {controlledLines.length > 0 && (
                <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-warning-foreground">
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

              {(outstanding > 0 || creditAccountId !== NO_ACCOUNT) && (
                <FieldGroup>
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

                  <Field>
                    <FieldLabel htmlFor="pos-customer">Customer</FieldLabel>
                    <CustomerSelect
                      value={customerId}
                      onChange={setCustomerId}
                      disabled={creditAccountId !== NO_ACCOUNT}
                    />
                  </Field>
                </FieldGroup>
              )}

              {checkoutError && (
                <p role="alert" className="text-sm text-destructive">
                  {checkoutError}
                </p>
              )}

              <Button
                className="h-11 w-full"
                onClick={completeSale}
                disabled={lines.length === 0}
              >
                Complete sale
                <Money value={total} />
              </Button>
            </CardContent>
          </Card>

          <TodayTile today={today} />
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
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function UnitPicker({
  medicine,
  onAdd,
}: {
  medicine: Medicine;
  onAdd: (medicine: Medicine, unitKey: string) => void;
}) {
  const [unitKey, setUnitKey] = useState(medicine.units[0]?.key ?? '');
  const unit = medicine.units.find((u) => u.key === unitKey) ?? medicine.units[0];

  return (
    <div className="flex items-center gap-2">
      {medicine.units.length > 1 ? (
        <Select value={unitKey} onValueChange={(value) => setUnitKey(value ?? unitKey)}>
          <SelectTrigger className="h-11 w-32" aria-label={`Unit for ${medicine.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {medicine.units.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="flex h-11 w-32 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
          {medicine.units[0]?.name}
        </div>
      )}

      <Button
        className="h-11"
        onClick={() => unit && onAdd(medicine, unit.key)}
        aria-label={`Add ${medicine.name}`}
      >
        <Plus />
        Add
      </Button>
    </div>
  );
}

function CustomerSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const customers = usePharmacy((state) => state.customers);

  return (
    <Select value={value} onValueChange={(next) => onChange(next ?? NO_ACCOUNT)}>
      <SelectTrigger id="pos-customer" className="h-11 w-full" disabled={disabled}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ACCOUNT}>Walk-in customer</SelectItem>
        {customers.map((customer) => (
          <SelectItem key={customer.id} value={customer.id}>
            {customer.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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

function TodayTile({ today }: { today: ReturnType<typeof summariseSales> }) {
  return (
    <StatTile
      label="Taken today"
      value={<Money value={today.net} compact />}
      hint={`${today.count} sales`}
      icon={<Banknote className="size-4" />}
    />
  );
}
