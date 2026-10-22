import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  DEMO_COMPETITOR,
  DEMO_ENQUIRIES,
  DEMO_SAMPLE_ORDERS,
  DEMO_SUPPLIER,
  DEMO_SUPPLIER_COMPARISON,
  DEMO_WHOLESALE,
  demoNaira,
} from '~/lib/demo-ecosystem';

/**
 * The supplier prototype: `/supplier`.
 *
 * A PUBLIC, self-contained DEMO page. It has no session, no store import, and no
 * server call: quotation preparation and "sending" is local component state only,
 * so nothing can reach a real pharmacy, create a real order, or send a real
 * email. Where an interaction would in production notify a pharmacy, the page
 * says SIMULATED.
 *
 * `~/lib/demo-ecosystem.ts` supplies the fictional data; `sup-medplus` is the
 * same supplier id the seeded pharmacy buys from in the owner demo.
 */
export const Route = createFileRoute('/supplier')({
  component: SupplierDemo,
});

type Tab = 'profile' | 'catalogue' | 'enquiries' | 'quotation' | 'orders' | 'compare';

const TABS: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'catalogue', label: 'Catalogue & prices' },
  { id: 'enquiries', label: 'Pharmacy enquiries' },
  { id: 'quotation', label: 'Prepare quotation' },
  { id: 'orders', label: 'Order status' },
  { id: 'compare', label: 'Compare prices' },
];

interface SimulatedQuote {
  number: string;
  pharmacy: string;
  items: { name: string; packLabel: string; qty: number; price: number }[];
  total: number;
}

function SupplierDemo() {
  const [tab, setTab] = useState<Tab>('profile');
  // Quotation selection + the simulated pipeline, all in-memory and reset on reload.
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [quotes, setQuotes] = useState<SimulatedQuote[]>([]);
  const [sentNotice, setSentNotice] = useState<string | null>(null);

  const quoteItems = useMemo(
    () =>
      DEMO_WHOLESALE.filter((item) => (selected[item.medicineId] ?? 0) > 0).map(
        (item) => ({
          name: item.name,
          packLabel: item.packLabel,
          qty: selected[item.medicineId] ?? 0,
          price: item.wholesalePrice,
        }),
      ),
    [selected],
  );
  const quoteTotal = quoteItems.reduce(
    (total, line) => total + line.qty * line.price,
    0,
  );

  const sendQuote = () => {
    const number = `MP-2026-Q${430 + quotes.length + 1}`;
    setQuotes((prev) => [
      ...prev,
      {
        number,
        pharmacy: 'Endline Pharmacy - PharmaFlow Demo Pharmacy',
        items: quoteItems,
        total: quoteTotal,
      },
    ]);
    setSentNotice(
      `${number} prepared for Endline Pharmacy (SIMULATED - no message was sent to anyone)`,
    );
    setSelected({});
  };

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <PrototypeBanner
          label="DEMO PROTOTYPE - supplier experience"
          detail="Everything on this page is fictional sample data. No live supplier integration, verified market prices, purchase orders, payments or fulfilment exist. Actions here change nothing outside this page."
        />

        <div className="mt-5 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#043263]">
              {DEMO_SUPPLIER.name}
            </h1>
            <p className="text-sm text-slate-600">
              You are viewing what a supplier sees: enquiries from pharmacies, the
              catalogue you can quote from, and how quotations become orders.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link to="/" className="text-sm font-semibold text-[#064276] hover:underline">
              ← PharmaFlow website
            </Link>
            <Link to="/demo" className="text-sm font-semibold text-[#2A932C] hover:underline">
              ← Back to the demo
            </Link>
          </div>
        </div>

        <nav className="mt-5 flex flex-wrap gap-2" aria-label="Supplier demo sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === t.id
                  ? 'bg-[#064276] text-white'
                  : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="mt-5">
          {tab === 'profile' && <Profile />}
          {tab === 'catalogue' && <Catalogue />}
          {tab === 'enquiries' && <Enquiries />}
          {tab === 'quotation' && (
            <Quotation
              selected={selected}
              onSelect={setSelected}
              items={quoteItems}
              total={quoteTotal}
              onSend={sendQuote}
              notice={sentNotice}
            />
          )}
          {tab === 'orders' && <Orders quotes={quotes} />}
          {tab === 'compare' && <Compare />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
    </div>
  );
}

function Profile() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact person" value={DEMO_SUPPLIER.contactPerson} />
        <Field label="Phone" value={DEMO_SUPPLIER.phone} />
        <Field label="Address" value={DEMO_SUPPLIER.address} />
        <Field label="Typical lead time" value={`${DEMO_SUPPLIER.leadTimeDays} days (sample)`} />
        <Field label="Demo rating" value={`${DEMO_SUPPLIER.rating} / 5`} />
        <Field label="Compliance" value={DEMO_SUPPLIER.licences.join(' · ')} />
      </dl>
      <p className="mt-4 text-xs text-slate-500">
        This profile is fictional and labelled as a demo. It is not a registered
        company profile.
      </p>
    </section>
  );
}

function Catalogue() {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th className="px-4 py-2">Medicine</th>
            <th className="px-4 py-2">Pack</th>
            <th className="px-4 py-2">Indicative trade price</th>
            <th className="px-4 py-2">Sample stock on hand</th>
          </tr>
        </thead>
        <tbody>
          {DEMO_WHOLESALE.map((item) => (
            <tr key={item.medicineId} className="border-t border-slate-100">
              <td className="px-4 py-2 font-medium text-slate-800">{item.name}</td>
              <td className="px-4 py-2">{item.packLabel}</td>
              <td className="px-4 py-2">{demoNaira(item.wholesalePrice)}</td>
              <td className="px-4 py-2">
                {item.stockOnHand} units <span className="text-xs text-slate-400">(fictional)</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Enquiries() {
  return (
    <section className="space-y-3">
      {DEMO_ENQUIRIES.map((enquiry) => (
        <article
          key={enquiry.id}
          className="rounded-xl border border-slate-200 bg-white p-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-slate-800">{enquiry.from}</p>
            <p className="text-xs text-slate-500">{enquiry.at}</p>
          </div>
          <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
            {enquiry.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            <span
              className={`rounded-full px-2 py-0.5 font-medium ${
                enquiry.urgency === 'restock'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {enquiry.urgency === 'restock' ? 'Restock request' : 'Routine enquiry'}
            </span>
            <span className="ml-2 text-slate-500">
              Sample enquiry - prepare a quotation from the next tab.
            </span>
          </p>
        </article>
      ))}
    </section>
  );
}

function Quotation(props: {
  selected: Record<string, number>;
  onSelect: (items: Record<string, number>) => void;
  items: { name: string; packLabel: string; qty: number; price: number }[];
  total: number;
  onSend: () => void;
  notice: string | null;
}) {
  const toggle = (medicineId: string, up: boolean) => {
    const next = { ...props.selected };
    const current = next[medicineId] ?? 0;
    const value = up ? current + 1 : Math.max(0, current - 1);
    if (value === 0) delete next[medicineId];
    else next[medicineId] = value;
    props.onSelect(next);
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-800">Quoting from the catalogue</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pick quantities, then prepare the sample quotation. Prices are indicative
          fictional trade prices.
        </p>
        <ul className="mt-3 divide-y divide-slate-100">
          {DEMO_WHOLESALE.map((item) => (
            <li key={item.medicineId} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-sm font-medium text-slate-800">{item.name}</p>
                <p className="text-xs text-slate-500">
                  {item.packLabel} · {demoNaira(item.wholesalePrice)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggle(item.medicineId, false)}
                  className="h-8 w-8 rounded-lg bg-slate-100 text-lg leading-none hover:bg-slate-200"
                  aria-label={`Remove one ${item.name}`}
                >
                  −
                </button>
                <span className="w-8 text-center text-sm font-semibold">
                  {props.selected[item.medicineId] ?? 0}
                </span>
                <button
                  type="button"
                  onClick={() => toggle(item.medicineId, true)}
                  className="h-8 w-8 rounded-lg bg-[#2A932C]/10 text-lg leading-none text-[#2A932C] hover:bg-[#2A932C]/20"
                  aria-label={`Add one ${item.name}`}
                >
                  +
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-[#064276]/20 bg-[#064276]/5 p-5">
        <h2 className="font-semibold text-[#064276]">Sample quotation</h2>
        {props.items.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            Nothing selected yet - add quantities above.
          </p>
        ) : (
          <>
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1">Item</th>
                  <th className="py-1">Qty</th>
                  <th className="py-1">Price</th>
                  <th className="py-1">Line</th>
                </tr>
              </thead>
              <tbody>
                {props.items.map((line) => (
                  <tr key={line.name} className="border-t border-slate-200/60">
                    <td className="py-1">{line.name}</td>
                    <td className="py-1">{line.qty}</td>
                    <td className="py-1">{demoNaira(line.price)}</td>
                    <td className="py-1">{demoNaira(line.qty * line.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-right text-sm font-semibold">
              Total: {demoNaira(props.total)}
            </p>
            <button
              type="button"
              onClick={props.onSend}
              className="mt-3 rounded-lg bg-[#2A932C] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4FAE2A]"
            >
              Send quotation to Endline Pharmacy (simulated)
            </button>
          </>
        )}
        {props.notice ? (
          <p className="mt-2 text-xs text-slate-500">{props.notice}</p>
        ) : null}
      </div>
    </section>
  );
}

function Orders({ quotes }: { quotes: SimulatedQuote[] }) {
  return (
    <section className="space-y-3">
      <p className="text-sm text-slate-600">
        Sample fulfilment states, plus any quotation prepared in this session.
      </p>
      {quotes.map((quote) => (
        <article key={quote.number} className="rounded-xl border border-[#4FAE2A]/40 bg-[#4FAE2A]/5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-slate-800">
              {quote.number} · {quote.pharmacy}
            </p>
            <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-[#4FAE2A] ring-1 ring-[#4FAE2A]/40">
              SIMULATED · Quotation sent
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {quote.items.length} line(s) · value {demoNaira(quote.total)} · created
            just now in this browser only.
          </p>
        </article>
      ))}
      {DEMO_SAMPLE_ORDERS.map((order) => (
        <article key={order.id} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-slate-800">
              {order.number} · {order.pharmacy}
            </p>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
              {order.state}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {order.note} · sample value {demoNaira(order.value)}
          </p>
        </article>
      ))}
    </section>
  );
}

function Compare() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="font-semibold text-slate-900">
        How price comparison helps the pharmacy
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Two fictional suppliers quote the same four anchor items, each in the same
        pack the catalogue lists, so the packs line up like for like.
        PharmaFlow&apos;s purchasing view puts them side by side, so the owner buys
        the cheaper pack without waiting for callbacks. Figures are sample
        quotations only - not live market prices.
      </p>
      <table className="mt-4 w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-1">Item</th>
            <th className="py-1">Pack (same for both)</th>
            <th className="py-1">{DEMO_COMPETITOR.name}</th>
            <th className="py-1">{DEMO_SUPPLIER.name}</th>
            <th className="py-1">Better price</th>
          </tr>
        </thead>
        <tbody>
          {DEMO_SUPPLIER_COMPARISON.map((row) => {
            const better = row.abc <= row.medplus ? 'ABC' : 'MedPlus';
            const diff = Math.abs(row.abc - row.medplus);
            return (
              <tr key={row.medicineId} className="border-t border-slate-100">
                <td className="py-2 font-medium text-slate-800">{row.name}</td>
                <td className="py-2 text-slate-600">{row.packLabel}</td>
                <td className="py-2">{demoNaira(row.abc)}</td>
                <td className="py-2">{demoNaira(row.medplus)}</td>
                <td className="py-2">
                  <span className="rounded-full bg-[#2A932C]/10 px-2 py-0.5 text-xs font-semibold text-[#2A932C]">
                    {better} · saves {demoNaira(diff)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-slate-500">
        Each price is per the pack shown, the same pack as the Catalogue &amp;
        prices tab. Fictional sample quotations - not live supplier or market
        prices.
      </p>
    </section>
  );
}

function PrototypeBanner(props: { label: string; detail: string }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
      {props.label}
      <p className="mt-1 text-xs font-normal leading-relaxed text-amber-800">
        {props.detail}
      </p>
    </div>
  );
}
