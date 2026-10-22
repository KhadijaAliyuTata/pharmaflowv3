import { createPortal } from 'react-dom';
import { CheckCircle2, Printer } from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { formatNaira } from '~/domain/money';

/**
 * A completed sale, flattened for the customer's copy.
 *
 * Deliberately contains no cost or margin field: a receipt is the customer's
 * document, and the same component is rendered in the attendant's dialog, so
 * nothing cost-bearing may travel into it.
 */
export interface ReceiptLine {
  name: string;
  unitName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface ReceiptPaymentPart {
  method: string;
  amount: number;
}

export interface ReceiptData {
  receiptNumber: string;
  issuedAt: string;
  attendantName: string;
  customerName?: string;
  customerPhone?: string;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  discountReason?: string;
  total: number;
  amountPaid: number;
  outstanding: number;
  changeDue?: number;
  paymentMethod: string;
  paymentBreakdown?: ReceiptPaymentPart[];
  dispensedAgainstPrescription?: boolean;
  branchName: string;
  branchAddress?: string;
  branchPhone?: string;
  /**
   * Set when the sale is durable but not yet confirmed by the server (saved
   * offline). The receipt says so rather than inventing an official number.
   */
  pendingNote?: string;
}

const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Cash',
  transfer: 'Bank transfer',
  pos_card: 'POS card',
  wallet: 'Wallet',
  split: 'Split payment',
};

function paymentLabel(method: string): string {
  return PAYMENT_LABEL[method] ?? method;
}

function formatIssuedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ReceiptRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className={strong ? 'flex justify-between gap-2 font-semibold' : 'flex justify-between gap-2'}>
      <dt className="min-w-0">{label}</dt>
      <dd className="tabular shrink-0">{value}</dd>
    </div>
  );
}

/**
 * The paper itself. Rendered twice: once in the confirmation dialog and once in
 * the hidden `#sale-receipt-print` copy that `@media print` exposes, so the
 * printed sheet is exactly the one that was reviewed.
 *
 * Width is 80mm, the common thermal till roll. The palette is fixed to the
 * light colours on purpose — a dark-mode till must still print black on white.
 */
export function SaleReceipt({ data }: { data: ReceiptData }) {
  return (
    <div className="mx-auto w-full max-w-[80mm] bg-white p-4 text-[0.75rem] text-[color:var(--grey-900)]">
      <header className="border-b border-dashed border-[color:var(--grey-300)] pb-3 text-center">
        <p className="text-sm font-semibold tracking-wide uppercase">{data.branchName}</p>
        {data.branchAddress && (
          <p className="mt-0.5 text-[0.7rem] text-[color:var(--grey-500)]">{data.branchAddress}</p>
        )}
        {data.branchPhone && (
          <p className="text-[0.7rem] text-[color:var(--grey-500)]">{data.branchPhone}</p>
        )}
        <p className="mt-2 text-[0.7rem] font-semibold tracking-[0.18em] uppercase">
          Sales receipt
        </p>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-dashed border-[color:var(--grey-300)] py-3 text-[0.7rem]">
        <dt className="text-[color:var(--grey-500)]">Receipt</dt>
        <dd className="tabular text-right font-medium">{data.receiptNumber}</dd>
        <dt className="text-[color:var(--grey-500)]">Date</dt>
        <dd className="text-right">{formatIssuedAt(data.issuedAt)}</dd>
        <dt className="text-[color:var(--grey-500)]">Served by</dt>
        <dd className="text-right">{data.attendantName}</dd>
        {data.customerName && (
          <>
            <dt className="text-[color:var(--grey-500)]">Customer</dt>
            <dd className="text-right">
              {data.customerName}
              {data.customerPhone ? ` · ${data.customerPhone}` : ''}
            </dd>
          </>
        )}
      </dl>

      <ul className="divide-y divide-dashed divide-[color:var(--grey-300)] border-b border-dashed border-[color:var(--grey-300)]">
        {data.lines.map((line, index) => (
          <li key={`${line.name}-${index}`} className="py-2">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 flex-1 font-medium">{line.name}</span>
              <span className="tabular shrink-0">{formatNaira(line.lineTotal)}</span>
            </div>
            <p className="text-[0.7rem] text-[color:var(--grey-500)]">
              {line.quantity} × {line.unitName} @ {formatNaira(line.unitPrice)}
            </p>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 py-3">
        <ReceiptRow label="Subtotal" value={formatNaira(data.subtotal)} />
        {data.discount > 0 && (
          <ReceiptRow
            label={data.discountReason ? `Discount · ${data.discountReason}` : 'Discount'}
            value={`−${formatNaira(data.discount)}`}
          />
        )}
        <ReceiptRow label="Total" value={formatNaira(data.total)} strong />
        <ReceiptRow
          label={
            data.amountPaid >= data.total
              ? `Paid · ${paymentLabel(data.paymentMethod)}`
              : data.amountPaid > 0
                ? `Paid now · ${paymentLabel(data.paymentMethod)}`
                : 'Paid now'
          }
          value={formatNaira(data.amountPaid)}
        />
        {data.paymentBreakdown &&
          data.paymentBreakdown.length > 1 &&
          data.paymentBreakdown.map((part) => (
            <ReceiptRow
              key={part.method}
              label={`· ${paymentLabel(part.method)}`}
              value={formatNaira(part.amount)}
            />
          ))}
        {data.outstanding > 0 && (
          <ReceiptRow label="Balance due" value={formatNaira(data.outstanding)} strong />
        )}
        {typeof data.changeDue === 'number' && data.changeDue > 0 && (
          <ReceiptRow label="Change" value={formatNaira(data.changeDue)} />
        )}
      </dl>

      {data.dispensedAgainstPrescription && (
        <p className="border-t border-dashed border-[color:var(--grey-300)] pt-2 text-[0.7rem] text-[color:var(--grey-500)]">
          Dispensed against prescription.
        </p>
      )}

      {data.pendingNote && (
        <p className="mt-2 rounded border border-dashed border-[color:var(--grey-300)] p-2 text-[0.7rem] text-[color:var(--grey-500)]">
          {data.pendingNote}
        </p>
      )}

      <footer className="mt-3 border-t border-dashed border-[color:var(--grey-300)] pt-3 text-center text-[0.7rem] text-[color:var(--grey-500)]">
        <p>Thank you for your purchase.</p>
        <p>Keep this receipt for returns and enquiries.</p>
      </footer>
    </div>
  );
}

/**
 * The post-sale confirmation. Opens as soon as a sale is recorded, shows the
 * customer's copy, and offers the one action the requirement asks for: print.
 */
export function ReceiptDialog({
  receipt,
  onClose,
}: {
  receipt: ReceiptData | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={receipt !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-[color:var(--green-600)]" />
            {receipt?.pendingNote ? 'Sale saved' : 'Sale completed'}
          </DialogTitle>
          <DialogDescription>
            {receipt
              ? receipt.pendingNote
                ? 'The sale is saved. Print a provisional copy for the customer.'
                : `Receipt ${receipt.receiptNumber}. Print it for the customer, or close to start the next sale.`
              : 'Sale completed.'}
          </DialogDescription>
        </DialogHeader>

        {receipt && (
          <div className="rounded-lg border border-dashed bg-[color:var(--grey-100)] p-2">
            <SaleReceipt data={receipt} />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            New sale
          </Button>
          <Button onClick={() => window.print()}>
            <Printer />
            Print receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Print rules live with the receipt rather than in the global stylesheet: while
 * a receipt exists the printer sees only the paper, and every other screen
 * keeps printing normally (and keeps the printer's own page size). 80mm is the
 * common thermal till roll; a normal printer still shows a narrow receipt.
 */
const PRINT_STYLES = `
@media print {
  body * {
    visibility: hidden;
  }
  #sale-receipt-print,
  #sale-receipt-print * {
    visibility: visible;
  }
  #sale-receipt-print {
    position: absolute;
    top: 0;
    left: 0;
    display: block;
    width: 100%;
  }
  @page {
    size: 80mm auto;
    margin: 4mm;
  }
}
`;

/**
 * The hidden copy the browser prints. Rendered into `document.body` so the
 * print stylesheet can position it against the page rather than the app inset,
 * which would otherwise offset the receipt by the sidebar's width.
 */
export function ReceiptPrintArea({ receipt }: { receipt: ReceiptData | null }) {
  if (!receipt) return null;
  const paper = (
    <>
      <style>{PRINT_STYLES}</style>
      <div id="sale-receipt-print" className="hidden print:block">
        <SaleReceipt data={receipt} />
      </div>
    </>
  );
  return typeof document === 'undefined' ? paper : createPortal(paper, document.body);
}
