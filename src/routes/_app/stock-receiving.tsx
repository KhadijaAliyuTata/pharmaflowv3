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
import { formatWhen, isoDate, money, multiply, sum } from '~/domain/money';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';
import type { ReceiptStatus, StockMovementType } from '~/domain/types';

export const Route = createFileRoute('/_app/stock-receiving')({
  component: StockReceiving,
});

/** Stock is a 24-month product. A year out is the safe default for a new batch. */
function oneYearOut(): string {
  return isoDate(new Date(Date.now() + 365 * 86_400_000));
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
  const medicines = usePharmacy((state) => state.medicines);
  const suppliers = usePharmacy((state) => state.suppliers);
  const receipts = usePharmacy((state) => state.stockReceipts);
  const movements = usePharmacy((state) => state.stockMovements.slice(0, 20));
  const canPrice = usePharmacy((state) => state.currentUser.canApprovePricing);
  const { receiveStock } = usePharmacyActions();
  const navigate = useNavigate();

  const [medicineId, setMedicineId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [quantity, setQuantity] = useState('');
  const [expiryDate, setExpiryDate] = useState(oneYearOut);
  const [costInput, setCostInput] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const medicine = medicines.find((m) => m.id === medicineId);
  const cost = money(Number(costInput) || 0);
  const price = money(Number(priceInput) || 0);
  const units = money(Number(quantity) || 0);
  const value = multiply(cost, units);

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

  const submit = () => {
    setError(null);

    const result = receiveStock({
      medicineId,
      batchNumber,
      baseUnitsReceived: units,
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

    if (receipt.status === 'pending_pricing') {
      toast('Sent for owner approval', {
        description: `${receipt.receiptNumber} · ${receipt.medicineName}`,
        action: { label: 'Open pricing', onClick: () => void navigate({ to: '/pricing' }) },
      });
      return;
    }

    toast.success(`${receipt.receiptNumber} received and priced`);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Stock Receiving" description="Book in a supplier delivery." />

      <div className="grid gap-3 sm:grid-cols-3">
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
        />
        <StatTile
          label="Receipts logged"
          value={receipts.length}
          hint={`${movements.length} movements recorded`}
          icon={<PackagePlus className="size-4" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">New receipt</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
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

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="recv-qty">Quantity</FieldLabel>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-10"
                        onClick={() =>
                          setQuantity(String(Math.max(0, units - (medicine?.units[0]?.multiplier ?? 1))))
                        }
                        aria-label="Decrease quantity"
                      >
                        <Minus />
                      </Button>
                      <Input
                        id="recv-qty"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        className="h-10 text-center"
                        value={quantity}
                        onChange={(event) => setQuantity(event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-10"
                        onClick={() =>
                          setQuantity(String(units + (medicine?.units[0]?.multiplier ?? 1)))
                        }
                        aria-label="Increase quantity"
                      >
                        <Plus />
                      </Button>
                    </div>
                    {medicine && (
                      <p className="text-xs text-muted-foreground">
                        In {medicine.units[0]?.name ?? 'base units'} —{' '}
                        {medicine.totalQuantity} on hand
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
                  <div className="grid gap-4 sm:grid-cols-2">
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
                  <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
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

                <Button type="submit" className="h-10 w-full">
                  Receive stock
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
              {receipts.length === 0 ? (
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
              {movements.length === 0 ? (
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
