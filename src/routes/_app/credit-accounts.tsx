import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Landmark, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty';
import { Field, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Progress } from '~/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet';
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
} from '~/components/app/primitives';
import { formatDate, formatNaira, formatWhen, money, percentOf, subtract, sum } from '~/domain/money';
import { creditAccountsOverLimit } from '~/domain/operations';
import type { CreditAccount } from '~/domain/types';
import { useCurrentUser, usePharmacy, usePharmacyActions } from '~/store/pharmacy';

export const Route = createFileRoute('/_app/credit-accounts')({
  component: CreditAccountsScreen,
});

const ACCOUNT_TYPE: Record<CreditAccount['type'], string> = {
  school: 'School',
  company: 'Company',
  family: 'Family',
  clinic: 'Clinic',
  business: 'Business',
};

function isOverLimit(account: CreditAccount): boolean {
  return account.outstandingBalance > account.creditLimit;
}

function utilisation(account: CreditAccount): number {
  return percentOf(account.outstandingBalance, account.creditLimit);
}

function CreditAccountsScreen() {
  const accounts = usePharmacy((state) => state.creditAccounts);
  const { role } = useCurrentUser();
  const { recordCreditPayment } = usePharmacyActions();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const overLimit = useMemo(() => creditAccountsOverLimit(accounts), [accounts]);

  const totalOutstanding = sum(accounts.map((a) => a.outstandingBalance));
  const totalLimit = sum(accounts.map((a) => a.creditLimit));

  if (role !== 'owner') {
    return (
      <div className="space-y-6">
        <PageHeader title="Credit Accounts" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldAlert />
            </EmptyMedia>
            <EmptyTitle>Not available for your role</EmptyTitle>
            <EmptyDescription>
              Credit limits, ledgers and repayments are owner-only. Switch to the owner
              account to see them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const submitPayment = () => {
    if (!selected) return;
    setError(null);

    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }

    const result = recordCreditPayment(selected.id, money(parsed), note);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setAmount('');
    setNote('');
  };

  // The balance a typed amount would leave, so it is never a surprise.
  const typed = Number(amount);
  const previewBalance =
    selected && Number.isFinite(typed) && typed > 0
      ? Math.max(0, subtract(selected.outstandingBalance, money(typed)))
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credit Accounts"
        description="Limits, utilisation and repayment ledger."
        meta={
          <p className="text-xs text-muted-foreground">
            Opening, closing and re-levying accounts is not wired up. Payments are.
          </p>
        }
      />

      {overLimit.length > 0 && (
        <Card className="ring-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="size-4" />
              {overLimit.length} account{overLimit.length > 1 ? 's' : ''} over the limit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {overLimit.map((account) => (
                <li
                  key={account.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{account.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {ACCOUNT_TYPE[account.type]} · limit <Money value={account.creditLimit} />
                    </p>
                  </div>
                  <div className="text-right">
                    <Money
                      value={account.outstandingBalance}
                      className="text-sm font-semibold text-destructive"
                    />
                    <p className="text-xs text-muted-foreground">
                      <Percent value={utilisation(account)} /> used
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="Outstanding"
          value={<Money value={totalOutstanding} />}
          hint={`${accounts.filter((a) => a.status === 'active').length} active accounts`}
          icon={<Landmark className="size-4" />}
        />
        <StatTile
          label="Total credit extended"
          value={<Money value={totalLimit} />}
          hint={
            totalLimit > 0
              ? `${percentOf(totalOutstanding, totalLimit)}% utilised overall`
              : 'No limits set'
          }
        />
        <StatTile
          label="Over the limit"
          value={overLimit.length}
          hint={overLimit.length === 0 ? 'All accounts within limit' : 'Needs a decision'}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {accounts.map((account) => {
          const used = utilisation(account);
          const over = isOverLimit(account);

          return (
            <Card
              key={account.id}
              className={over ? 'ring-destructive/40' : undefined}
            >
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{account.name}</CardTitle>
                    <p className="truncate text-xs text-muted-foreground">
                      {account.contactPerson} · {account.phone}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge variant="secondary">{ACCOUNT_TYPE[account.type]}</Badge>
                    <Badge variant={account.status === 'active' ? 'success' : 'warning'}>
                      {account.status === 'active' ? 'Active' : 'Suspended'}
                    </Badge>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      <Money value={account.outstandingBalance} /> of{' '}
                      <Money value={account.creditLimit} />
                    </span>
                    <span
                      data-numeric
                      className={
                        over
                          ? 'tabular text-xs font-medium text-destructive'
                          : 'tabular text-xs font-medium text-muted-foreground'
                      }
                    >
                      <Percent value={used} />
                    </span>
                  </div>
                  <Progress
                    value={Math.min(used, 100)}
                    className={over ? '[&_[data-slot=progress-indicator]]:bg-destructive' : undefined}
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Open since {formatDate(account.createdAt)} · {account.ledger.length} ledger
                    entries
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setSelectedId(account.id)}>
                    Open ledger
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null);
            setAmount('');
            setNote('');
            setError(null);
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name}</SheetTitle>
                <SheetDescription>
                  {ACCOUNT_TYPE[selected.type]} · {selected.contactPerson} · {selected.phone}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 overflow-y-auto px-4 pb-4">
                <div className="grid grid-cols-2 gap-2">
                  <StatTile
                    label="Outstanding"
                    value={<Money value={selected.outstandingBalance} />}
                  />
                  <StatTile label="Limit" value={<Money value={selected.creditLimit} />} />
                </div>

                <div className="space-y-2">
                  <SectionTitle>Record payment</SectionTitle>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="credit-amount">Amount</FieldLabel>
                      <Input
                        id="credit-amount"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        value={amount}
                        onChange={(event) => {
                          setAmount(event.target.value);
                          setError(null);
                        }}
                        aria-invalid={error !== null}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="credit-note">Note</FieldLabel>
                      <Input
                        id="credit-note"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Transfer, cash, cheque"
                      />
                    </Field>
                    {error && <FieldError>{error}</FieldError>}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={submitPayment}>Record payment</Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setAmount(String(selected.outstandingBalance));
                          setError(null);
                        }}
                      >
                        Pay in full
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {previewBalance === null
                          ? `Balance ${formatNaira(selected.outstandingBalance)}`
                          : `Leaves ${formatNaira(previewBalance)}`}
                      </span>
                    </div>
                  </FieldGroup>
                </div>

                <div className="space-y-2">
                  <SectionTitle>Ledger</SectionTitle>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Balance after</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selected.ledger.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="text-muted-foreground">
                            {formatWhen(entry.date)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={entry.type === 'payment' ? 'success' : 'secondary'}>
                              {entry.type === 'payment' ? 'Payment' : 'Charge'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Money value={entry.amount} signed={entry.type === 'charge'} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Money value={entry.balanceAfter} />
                          </TableCell>
                          <TableCell className="max-w-40 truncate text-muted-foreground">
                            {entry.note}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
