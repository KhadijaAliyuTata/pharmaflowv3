import { Fragment, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Lock, Pencil, TrendingUp, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  Money,
  PageHeader,
  Percent,
  SectionTitle,
  StatTile,
  StatusBadge,
} from '~/components/app/primitives';
import { margin, money, multiply, subtract } from '~/domain/money';
import {
  marginPercent,
  portfolioRetail,
  portfolioValue,
  stockStatus,
  unitMargin,
} from '~/domain/selectors';
import { usePharmacy, usePharmacyActions } from '~/store/pharmacy';
import type { Result } from '~/domain/operations';
import type { Medicine, StockReceipt } from '~/domain/types';

export const Route = createFileRoute('/_app/pricing')({
  component: Pricing,
});

function Pricing() {
  const medicines = usePharmacy((state) => state.medicines);
  const pending = usePharmacy((state) =>
    state.stockReceipts.filter((receipt) => receipt.status === 'pending_pricing'),
  );
  const isOwner = usePharmacy((state) => state.currentUser.role === 'owner');
  const { approvePricing, updatePrice } = usePharmacyActions();

  const retailValue = portfolioRetail(medicines);
  const costValue = isOwner ? portfolioValue(medicines) : 0;
  const blendedMargin = subtract(retailValue, costValue);

  return (
    <div className="space-y-6">
      <PageHeader title="Pricing" description="Approve receipts and set prices." />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Awaiting pricing"
          value={pending.length}
          hint={pending.length > 0 ? 'Stock is on the shelf, unpriced' : 'Queue is clear'}
          icon={<TriangleAlert className="size-4" />}
        />
        <StatTile
          label="Retail value"
          value={<Money value={retailValue} compact />}
          hint={`${medicines.length} products`}
          icon={<TrendingUp className="size-4" />}
        />
        <StatTile
          label={isOwner ? 'Blended margin' : 'Margin'}
          value={
            isOwner ? (
              <Money value={blendedMargin} compact />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-base text-muted-foreground">
                <Lock className="size-4" />
                Owner only
              </span>
            )
          }
          hint={isOwner ? 'Retail less cost across the catalogue' : 'Cost and margin are hidden'}
          icon={<TrendingUp className="size-4" />}
        />
      </div>

      <section className="space-y-3">
        <SectionTitle>Approval queue</SectionTitle>

        {pending.length === 0 ? (
          <Card>
            <CardContent>
              <p className="py-6 text-center text-sm text-muted-foreground">
                No receipts waiting on pricing.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((receipt) => (
              <ApprovalCard
                key={receipt.id}
                receipt={receipt}
                medicine={medicines.find((m) => m.id === receipt.medicineId)}
                isOwner={isOwner}
                onApprove={approvePricing}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle>Price list</SectionTitle>

        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Generic</TableHead>
                  <TableHead>Strength</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {medicines.map((medicine) => (
                  <PriceRow
                    key={medicine.id}
                    medicine={medicine}
                    isOwner={isOwner}
                    onUpdate={updatePrice}
                  />
                ))}              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/* --------------------------------------------------------- approval queue */

function ApprovalCard({
  receipt,
  medicine,
  isOwner,
  onApprove,
}: {
  receipt: StockReceipt;
  medicine: Medicine | undefined;
  isOwner: boolean;
  onApprove: (receiptId: string, cost: number, price: number) => Result<boolean>;
}) {
  // Fall back to the product's current figures: a repriced receipt should not
  // quietly reset the shelf price to a stale number.
  const baseCost = medicine?.costPerBaseUnit ?? 0;
  const basePrice = medicine?.pricePerBaseUnit ?? multiply(baseCost, 1.5);

  const [costInput, setCostInput] = useState(String(baseCost));
  const [priceInput, setPriceInput] = useState(String(basePrice));
  const [error, setError] = useState<string | null>(null);

  const cost = money(Number(costInput) || 0);
  const price = money(Number(priceInput) || 0);
  const { value: marginValue, percent: marginRate } = margin(price, cost);
  const receiptValue = multiply(cost, receipt.baseUnitsReceived);

  const submit = () => {
    setError(null);
    const result = onApprove(receipt.id, cost, price);
    if (!result.ok) {
      setError(result.error ?? 'Could not approve this receipt');
      return;
    }
    toast.success(`${receipt.receiptNumber} priced`);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span data-numeric className="tabular">
            {receipt.receiptNumber}
          </span>
          <Badge variant="warning">Awaiting pricing</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {receipt.medicineName} · {receipt.batchNumber} ·{' '}
          {receipt.baseUnitsReceived.toLocaleString('en-NG')} base units ·{' '}
          {receipt.receivedBy}
        </p>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor={`cost-${receipt.id}`}>Cost</FieldLabel>
              <Input
                id={`cost-${receipt.id}`}
                type="number"
                inputMode="decimal"
                min={0}
                className="h-10"
                value={costInput}
                onChange={(event) => setCostInput(event.target.value)}
                disabled={!isOwner}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`price-${receipt.id}`}>Selling price</FieldLabel>
              <Input
                id={`price-${receipt.id}`}
                type="number"
                inputMode="decimal"
                min={0}
                className="h-10"
                value={priceInput}
                onChange={(event) => setPriceInput(event.target.value)}
                disabled={!isOwner}
              />
            </Field>
            <div className="self-end pb-2 text-sm">
              <span className="text-muted-foreground">Receipt value </span>
              <Money value={receiptValue} className="font-medium" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Margin <Money value={marginValue} className="font-medium text-foreground" /> (
              <Percent value={marginRate} />)
            </p>
            <Button className="h-10" onClick={submit} disabled={!isOwner}>
              {isOwner ? 'Approve pricing' : 'Owner approval required'}
            </Button>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- price list */

function PriceRow({
  medicine,
  isOwner,
  onUpdate,
}: {
  medicine: Medicine;
  isOwner: boolean;
  onUpdate: (medicineId: string, price: number) => Result<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [priceInput, setPriceInput] = useState(String(medicine.pricePerBaseUnit));
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setPriceInput(String(medicine.pricePerBaseUnit));
    setError(null);
    setEditing(true);
  };

  const save = () => {
    setError(null);
    const result = onUpdate(medicine.id, money(Number(priceInput) || 0));
    if (!result.ok) {
      setError(result.error ?? 'Could not change this price');
      return;
    }
    setEditing(false);
    toast.success(`${medicine.name} repriced`);
  };

  return (
    <Fragment>
      <TableRow>
        <TableCell className="whitespace-normal font-medium">{medicine.name}</TableCell>
        <TableCell className="whitespace-normal text-muted-foreground">
          {medicine.genericName}
        </TableCell>
        <TableCell data-numeric className="tabular">
          {medicine.strength}
        </TableCell>

        <TableCell className="text-right">
          {isOwner ? (
            <Money value={medicine.costPerBaseUnit} className="text-muted-foreground" />
          ) : (
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              title="Cost is visible to the owner only"
            >
              <Lock className="size-3" />
            </span>
          )}
        </TableCell>

        <TableCell className="text-right">
          {editing ? (
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              autoFocus
              aria-label={`New price for ${medicine.name}`}
              className="h-9 w-28 text-right"
              value={priceInput}
              onChange={(event) => setPriceInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') save();
                if (event.key === 'Escape') setEditing(false);
              }}
            />
          ) : (
            <Money value={medicine.pricePerBaseUnit} className="font-medium" />
          )}
        </TableCell>

        <TableCell className="text-right">
          {isOwner ? (
            <Money value={unitMargin(medicine)} />
          ) : (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Lock className="size-3" />
            </span>
          )}
        </TableCell>

        <TableCell className="text-right">
          {isOwner ? <Percent value={marginPercent(medicine)} /> : '—'}
        </TableCell>

        <TableCell>
          <StatusBadge status={stockStatus(medicine)} />
        </TableCell>

        <TableCell className="text-right">
          {editing ? (
            <div className="flex items-center justify-end gap-1">
              <Button size="icon" className="size-9" onClick={save} aria-label="Save price">
                <Pencil />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-9"
                onClick={() => setEditing(false)}
                aria-label="Cancel"
              >
                <X />
              </Button>
            </div>
          ) : isOwner ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-9"
              onClick={startEdit}
              aria-label={`Change price for ${medicine.name}`}
            >
              <Pencil />
            </Button>
          ) : null}
        </TableCell>
      </TableRow>

      {error && (
        <TableRow>
          <TableCell colSpan={9} className="whitespace-normal">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
