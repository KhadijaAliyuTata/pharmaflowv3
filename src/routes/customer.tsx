import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  DEMO_CUSTOMER,
  DEMO_MEDICINES,
  DEMO_PHARMACIES,
  DEMO_WAITLIST,
  demoNaira,
  demoPriceFor,
} from '~/lib/demo-ecosystem';

/**
 * The customer prototype: `/customer`.
 *
 * A PUBLIC, self-contained DEMO page. No session, no store import, no server
 * call: search, pharmacy choice, cart and "order" are local component state,
 * so no real pharmacy record, no real order and no payment can ever be
 * involved. Prescription-restricted medicines cannot be ordered here at all -
 * the restriction is part of the demonstration.
 *
 * `~/lib/demo-ecosystem.ts` supplies the fictional catalogue and pharmacies;
 * the first pharmacy is the same Endline Pharmacy the owner/attendant demos run.
 */
export const Route = createFileRoute('/customer')({
  component: CustomerDemo,
});

interface CartLine {
  medicineId: string;
  name: string;
  packLabel: string;
  qty: number;
  price: number;
}

function CustomerDemo() {
  const [pharmacyId, setPharmacyId] = useState(DEMO_PHARMACIES[0]!.id);
  const [query, setQuery] = useState('');
  const [pharmacyQuery, setPharmacyQuery] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [name, setName] = useState(DEMO_CUSTOMER.name);
  const [phone, setPhone] = useState(DEMO_CUSTOMER.phone);
  const [placed, setPlaced] = useState<null | { number: string; total: number; lines: CartLine[] }>(
    null,
  );

  const pharmacy = useMemo(
    () => DEMO_PHARMACIES.find((candidate) => candidate.id === pharmacyId) ?? DEMO_PHARMACIES[0]!,
    [pharmacyId],
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DEMO_MEDICINES;
    return DEMO_MEDICINES.filter(
      (medicine) =>
        medicine.name.toLowerCase().includes(needle) ||
        medicine.genericName.toLowerCase().includes(needle),
    );
  }, [query]);

  const priceAt = (indicativePrice: number) => demoPriceFor(pharmacy.priceFactor, indicativePrice);
  const inStock = (medicineId: string) => !pharmacy.outOfStock.includes(medicineId);

  /** The searchable pharmacy finder: live demo pharmacies + the onboarding wait list. */
  const pharmacyResults = useMemo(() => {
    const needle = pharmacyQuery.trim().toLowerCase();
    const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
    return [
      ...DEMO_PHARMACIES.filter((candidate) => matches(candidate.name)).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        orderable: true as const,
        detail: `${candidate.address} · ★ ${candidate.rating} (${candidate.reviewsCount} reviews) · ${candidate.openNow ? candidate.openingHours : 'Closed now'}`,
      })),
      ...DEMO_WAITLIST.filter((candidate) => matches(candidate.name)).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        orderable: false as const,
        detail: 'Onboarding to PharmaFlow — ordering opens soon',
      })),
    ];
  }, [pharmacyQuery]);

  const cartLines: CartLine[] = DEMO_MEDICINES.filter(
    (medicine) => (cart[medicine.id] ?? 0) > 0 && inStock(medicine.id),
  ).map((medicine) => ({
    medicineId: medicine.id,
    name: medicine.name,
    packLabel: medicine.packs.label,
    qty: cart[medicine.id] ?? 0,
    price: priceAt(medicine.packs.indicativePrice),
  }));
  const cartTotal = cartLines.reduce((total, line) => total + line.qty * line.price, 0);

  const addToCart = (medicineId: string, up: boolean) => {
    const next = { ...cart };
    const value = up ? (next[medicineId] ?? 0) + 1 : Math.max(0, (next[medicineId] ?? 0) - 1);
    if (value === 0) delete next[medicineId];
    else next[medicineId] = value;
    setCart(next);
    setPlaced(null);
  };

  const placeOrder = () => {
    const number = `PF-C-2026-${String(1040 + Math.floor(Math.random() * 900))}`;
    setPlaced({ number, total: cartTotal, lines: cartLines });
    setCart({});
  };

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          DEMO PROTOTYPE — customer experience
          <p className="mt-1 text-xs font-normal leading-relaxed text-amber-800">
            Fictional medicines, pharmacies and prices. Orders placed here are
            simulated: nothing is sent to any pharmacy, no payment is taken, and
            prescription-only medicines cannot be ordered.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#043263]">
              Find medicines near you
            </h1>
            <p className="text-sm text-slate-600">
              {DEMO_CUSTOMER.name} is the sample customer. Pick a pharmacy, add
              items, and place a simulated order.
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

        {placed ? (
          <section className="mt-6 rounded-xl border border-[#2A932C]/40 bg-[#2A932C]/5 p-6">
            <h2 className="text-lg font-bold text-[#2A932C]">Order confirmed (simulated)</h2>
            <p className="mt-2 text-sm text-slate-700">
              Order <strong>{placed.number}</strong> for {pharmacy.name} ·{' '}
              {placed.lines.length} item(s) · total {demoNaira(placed.total)}.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              This confirmation is a demonstration only — no real order was created,
              no pharmacy was contacted, and no payment or delivery exists. In the
              real product the order would appear in the pharmacy&apos;s order queue.
            </p>
            <button
              type="button"
              onClick={() => setPlaced(null)}
              className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:bg-white"
            >
              Browse again
            </button>
          </section>
        ) : null}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-5">
            <section>
              <label htmlFor="pharmacy-search" className="text-sm font-semibold text-slate-800">
                Find a pharmacy
              </label>
              <input
                id="pharmacy-search"
                value={pharmacyQuery}
                onChange={(event) => setPharmacyQuery(event.target.value)}
                placeholder="Search by name — e.g. Sunrise, Greenleaf, Endline…"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-slate-500">
                {DEMO_PHARMACIES.length} demo pharmacies open for sample orders ·{' '}
                {DEMO_WAITLIST.length} pharmacies onboarding soon
              </p>
              <ul className="mt-2 max-h-80 space-y-1.5 overflow-y-auto pr-1">
                {pharmacyResults.map((candidate) => {
                  const isCurrent = candidate.orderable && candidate.id === pharmacyId;
                  return (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        disabled={!candidate.orderable}
                        onClick={() =>
                          candidate.orderable
                            ? (setPharmacyId(candidate.id), setPlaced(null), setCart({}))
                            : undefined
                        }
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                          isCurrent
                            ? 'border-[#064276] bg-[#064276]/5'
                            : candidate.orderable
                              ? 'border-slate-200 bg-white hover:border-[#064276]/50'
                              : 'cursor-default border-slate-100 bg-slate-50'
                        }`}
                      >
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-slate-800">{candidate.name}</span>
                          {candidate.orderable ? (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                isCurrent
                                  ? 'bg-[#064276] text-white'
                                  : 'bg-[#2A932C]/10 text-[#2A932C]'
                              }`}
                            >
                              {isCurrent ? 'Selected' : 'Open for orders'}
                            </span>
                          ) : (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                              Onboarding — coming soon
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                          {candidate.detail}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-xs text-slate-400">
                Prices, addresses and stock for the demo pharmacies are fictional.
                Onboarding pharmacies show no data — they have not joined yet.
              </p>
            </section>

            <section>
              <label htmlFor="search" className="text-sm font-semibold text-slate-800">
                Search medicines
              </label>
              <input
                id="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="e.g. paracetamol"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </section>

            <ul className="space-y-3">
              {results.map((medicine) => {
                const stock = inStock(medicine.id);
                const restricted = medicine.requiresPharmacist;
                const qty = cart[medicine.id] ?? 0;
                return (
                  <li
                    key={medicine.id}
                    className="rounded-xl border border-slate-200 bg-white p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-800">{medicine.name}</p>
                        <p className="text-xs text-slate-500">
                          {medicine.genericName} · {medicine.packs.label}
                        </p>
                        {restricted ? (
                          <p className="mt-1 text-xs font-medium text-amber-700">
                            {medicine.note}
                          </p>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-[#043263]">
                          {demoNaira(priceAt(medicine.packs.indicativePrice))}
                        </p>
                        <p className="text-xs">
                          {stock ? (
                            <span className="text-[#2A932C]">In stock (sample)</span>
                          ) : (
                            <span className="text-slate-500">Out of stock here</span>
                          )}
                        </p>
                      </div>
                    </div>
                    {!restricted && stock ? (
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => addToCart(medicine.id, false)}
                          className="h-8 w-8 rounded-lg bg-slate-100 text-lg leading-none hover:bg-slate-200"
                          aria-label={`Remove one ${medicine.name}`}
                        >
                          −
                        </button>
                        <span className="w-8 text-center text-sm font-semibold">{qty}</span>
                        <button
                          type="button"
                          onClick={() => addToCart(medicine.id, true)}
                          className="h-8 w-8 rounded-lg bg-[#2A932C]/10 text-lg leading-none text-[#2A932C] hover:bg-[#2A932C]/20"
                          aria-label={`Add one ${medicine.name}`}
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-slate-400">
                        {restricted
                          ? 'Not orderable in the demo — ask the pharmacist.'
                          : 'Out of stock at this pharmacy (sample).'}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <aside className="h-fit rounded-xl border border-slate-200 bg-white p-5 lg:sticky lg:top-6">
            <h2 className="font-bold text-slate-900">Your sample order</h2>
            <p className="mt-1 text-xs text-slate-500">
              For {pharmacy.name} · collection in person
            </p>
            {cartLines.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">Nothing added yet.</p>
            ) : (
              <>
                <ul className="mt-3 divide-y divide-slate-100 text-sm">
                  {cartLines.map((line) => (
                    <li key={line.medicineId} className="flex justify-between gap-2 py-2">
                      <span>
                        {line.name} × {line.qty}
                      </span>
                      <span className="font-medium">{demoNaira(line.qty * line.price)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 flex justify-between border-t border-slate-200 pt-3 text-sm font-semibold">
                  <span>Total</span>
                  <span>{demoNaira(cartTotal)}</span>
                </p>
              </>
            )}
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="name" className="text-xs font-semibold text-slate-600">
                  Name
                </label>
                <input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="phone" className="text-xs font-semibold text-slate-600">
                  Phone
                </label>
                <input
                  id="phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <button
                type="button"
                disabled={cartLines.length === 0}
                onClick={placeOrder}
                className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition ${
                  cartLines.length === 0
                    ? 'cursor-not-allowed bg-slate-300'
                    : 'bg-[#2A932C] hover:bg-[#4FAE2A]'
                }`}
              >
                Place sample order
              </button>
              <p className="text-[11px] leading-relaxed text-slate-500">
                No payment, no real order, no message to the pharmacy. The name and
                phone stay in this browser tab only.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
