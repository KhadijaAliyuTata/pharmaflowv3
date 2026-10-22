/**
 * Offline sale timestamps — M1 `p_sold_at` on `pf_complete_sale`.
 *
 * The offline POS records a sale the moment it happens, on the device's own
 * clock. Before this migration `sold_at` was stamped by the column default at
 * the time the RPC *ran* — the reconciliation time, not the sale time. The new
 * optional `p_sold_at` carries the occurrence time through the EXISTING
 * authoritative checkout path; this suite proves:
 *
 *   BACK COMPAT — a caller that omits `p_sold_at` (the online POS, and every
 *                pre-existing SQL caller) still works and still gets the
 *                column-default `now()`.
 *   OFFLINE    — a device timestamp inside the acceptance window (future ≤
 *                5 minutes, past ≤ 30 days) is stored verbatim and is
 *                independent of when the sale actually syncs.
 *   REJECTED   — beyond either edge is refused with nothing left behind.
 *   REPLAY     — an idempotent replay is unaffected by whatever timestamp the
 *                retry sends: the original sale, the original `sold_at`, stock
 *                deducted exactly once.
 *   AUTHORITY  — the timestamp does not open any financial hole: the same
 *                line-shape refusals as before still apply.
 *
 * Status: PGlite-verified only. The migration itself is NOT applied to any
 * real database.
 */

import {
  asActor,
  asAuthenticated,
  createReporter,
  freshDatabase,
  query,
  seedTenants,
} from './harness.mjs';

const { check, note, section, finish } = createReporter('verify-offline-sale-timestamps');

const database = await freshDatabase();
const ids = await seedTenants(database);

/* ------------------------------------------------------------------ fixtures */

const MULTI_UNITS = JSON.stringify([
  { key: 'tablet', name: 'Tablet', multiplier: 1, sellingPrice: 5 },
  { key: 'strip', name: 'Strip', multiplier: 10, sellingPrice: 45 },
  { key: 'box', name: 'Box', multiplier: 100, sellingPrice: 400 },
]);

const [medicine] = await query(
  database,
  `insert into medicines (branch_id, name, generic_name, units, cost_per_base_unit, price_per_base_unit, expiry_date)
   values ($1, 'Stamp Drug', 'stampgen', $2::jsonb, 2, 5, current_date + 365)
   returning id`,
  [ids.BRANCH_A, MULTI_UNITS],
);
const med = medicine.id;

await query(
  database,
  `insert into medicine_batches (branch_id, medicine_id, batch_number, expiry_date, quantity, cost_per_base_unit)
   values ($1, $2, 'S-LOT', current_date + 200, 900, 20)`,
  [ids.BRANCH_A, med],
);

const ACTOR = ids.ASSISTANT_A;

/**
 * The RPC exactly as the offline sync handler sends it: named arguments.
 * `soldAt` is optional and, when absent, is OMITTED ENTIRELY — a nine-argument
 * named call must keep resolving against the new signature, because that is
 * precisely what PostgREST does for the online POS and what every existing
 * caller sends.
 */
async function sell(opts = {}) {
  const params = [
    JSON.stringify(
      (opts.lines ?? [{ medicine_id: opts.medicineId ?? med, unit_key: opts.unitKey ?? 'tablet', quantity: opts.quantity ?? 1 }]),
    ),
    opts.paymentMethod ?? 'cash',
    opts.paid ?? 0,
    opts.discount ?? 0,
    opts.discountReason ?? null,
    opts.customerId ?? null,
    opts.creditAccountId ?? null,
    opts.prescription ?? false,
    opts.idempotencyKey ?? null,
  ];
  const soldParam = opts.soldAt === undefined ? '' : `, p_sold_at => $10::timestamptz`;
  if (opts.soldAt !== undefined) params.push(opts.soldAt);

  const call = await asAuthenticated(database, () =>
    asActor(database, ACTOR, async () => {
      const { rows } = await database.query(
        `select * from public.pf_complete_sale(
           p_lines => $1::jsonb,
           p_payment_method => $2::public.payment_kind,
           p_amount_paid => $3,
           p_discount => $4,
           p_discount_reason => $5,
           p_customer_id => $6,
           p_credit_account_id => $7,
           p_dispensed_against_prescription => $8,
           p_idempotency_key => $9${soldParam}
         )`,
        params,
      );
      return rows[0];
    }),
  );
  return call;
}

/**
 * The sale row for an idempotency key, with `sold_at` as a server-side epoch so
 * the comparison never depends on how PGlite renders JS dates or timezones.
 */
async function saleByKey(key) {
  const rows = await query(
    database,
    `select id, receipt_number, extract(epoch from sold_at) as sold_epoch from sales
      where branch_id = $1 and idempotency_key = $2`,
    [ids.BRANCH_A, key],
  );
  return rows[0] ?? null;
}

async function stockOf() {
  const rows = await query(
    database,
    `select sum(quantity)::int as qty from medicine_batches where medicine_id = $1`,
    [med],
  );
  return rows[0].qty;
}

/* ------------------------------------------------- 1. back-compat: no stamp */

section('an online caller that omits p_sold_at keeps the column-default now()');

const onlineSell = await sell({ medicineId: med, quantity: 2, paid: 10, idempotencyKey: 'ts-online-1' });
check(
  'the nine-argument named call is accepted after the signature change',
  onlineSell.ok === true && onlineSell.value?.sale_id !== undefined,
  onlineSell.ok ? '' : JSON.stringify(onlineSell.value ?? onlineSell.err),
);

const onlineRow = await saleByKey('ts-online-1');
const driftOnlineSec = Math.abs(Date.now() / 1000 - Number(onlineRow.sold_epoch));
check(
  "sold_at matches now() (column default), not the sync-request time of this test",
  driftOnlineSec < 30,
  `drift ${driftOnlineSec.toFixed(1)}s`,
);

/* ------------------------------------------- 2. offline occurrence time wins */

section('an offline sale keeps its own occurrence time');

const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const offlineSell = await sell({
  medicineId: med,
  quantity: 3,
  paid: 15,
  idempotencyKey: 'ts-offline-1',
  soldAt: threeHoursAgo,
});
check(
  'a timestamp three hours in the past is accepted',
  offlineSell.ok === true && offlineSell.value?.sale_id !== undefined,
  offlineSell.ok ? '' : JSON.stringify(offlineSell.value ?? offlineSell.err),
);

const offlineRow = await saleByKey('ts-offline-1');
const expectedOfflineEpoch = new Date(threeHoursAgo).getTime() / 1000;
const offlineDrift = Math.abs(Number(offlineRow.sold_epoch) - expectedOfflineEpoch);
check(
  'sold_at stores the device occurrence time verbatim (not the sync time)',
  offlineDrift < 2,
  `stored epoch ${offlineRow.sold_epoch}, expected ${expectedOfflineEpoch} (drift ${offlineDrift.toFixed(1)}s)`,
);

const twoMinutesAhead = new Date(Date.now() + 2 * 60 * 1000).toISOString();
const skewSell = await sell({
  medicineId: med,
  quantity: 1,
  paid: 5,
  idempotencyKey: 'ts-skew-1',
  soldAt: twoMinutesAhead,
});
check(
  'a timestamp within the 5-minute clock-skew allowance is accepted',
  skewSell.ok === true && skewSell.value?.sale_id !== undefined,
  skewSell.ok ? '' : JSON.stringify(skewSell.value ?? skewSell.err),
);

/* ------------------------------------------------------------ 3. rejects */

section('timestamps outside the window are refused, and leave nothing behind');

const stockBeforeReject = await stockOf();

const futureSell = await sell({
  medicineId: med,
  quantity: 1,
  paid: 5,
  idempotencyKey: 'ts-future-1',
  soldAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
check(
  'more than five minutes in the future is refused',
  futureSell.ok === false && /sale time/i.test(futureSell.err ?? ''),
  futureSell.ok ? 'accepted (should be refused)' : futureSell.err,
);

const ancientSell = await sell({
  medicineId: med,
  quantity: 1,
  paid: 5,
  idempotencyKey: 'ts-ancient-1',
  soldAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
});
check(
  'more than thirty days in the past is refused',
  ancientSell.ok === false && /30 days/i.test(ancientSell.err ?? ''),
  ancientSell.ok ? 'accepted (should be refused)' : ancientSell.err,
);

const stockAfterReject = await stockOf();
const salesAfterReject = (
  await query(
    database,
    `select count(*)::int as n from sales where idempotency_key in ('ts-future-1', 'ts-ancient-1')`,
  )
)[0].n;
check(
  'refused timestamps leave no sale row and deduct no stock',
  salesAfterReject === 0 && stockAfterReject === stockBeforeReject,
  `sales ${salesAfterReject}, stock ${stockBeforeReject} → ${stockAfterReject}`,
);

/* ------------------------------------------------- 4. idempotent replay */

section('replays ignore the timestamp argument entirely');

const stockBeforeReplay = await stockOf();
const originalRow = await saleByKey('ts-offline-1');
const replaySell = await sell({
  medicineId: med,
  quantity: 1,
  paid: 5,
  idempotencyKey: 'ts-offline-1',
  // A retry that lost the response sends the SAME key; even a DIFFERENT or
  // missing timestamp must not change or re-ring the original sale.
});
check(
  'replay with the same key returns the original sale',
  replaySell.ok === true &&
    replaySell.value?.already_completed === true &&
    String(replaySell.value?.sale_id) === String(originalRow.id),
  replaySell.ok
    ? `already_completed=${replaySell.value?.already_completed}, same id=${String(replaySell.value?.sale_id) === String(originalRow.id)}`
    : replaySell.err,
);

const replayRow = await saleByKey('ts-offline-1');
const stampDrift = Math.abs(Number(replayRow.sold_epoch) - expectedOfflineEpoch);
check(
  'the original occurrence time survives the replay',
  stampDrift < 2,
  `stored epoch ${replayRow.sold_epoch}, expected ${expectedOfflineEpoch} (drift ${stampDrift.toFixed(1)}s)`,
);

const stockAfterReplay = await stockOf();
check(
  'the replay deducted no additional stock',
  stockAfterReplay === stockBeforeReplay,
  `stock ${stockBeforeReplay} → ${stockAfterReplay}`,
);

/* ------------------------------------------------- 5. authority unchanged */

section('the timestamp does not weaken existing server validation');

const garbageUnit = await sell({
  medicineId: med,
  quantity: 1,
  paid: 5,
  idempotencyKey: 'ts-badunit-1',
  unitKey: 'pallet',
  soldAt: threeHoursAgo,
});
check(
  'a bad unit is still refused even with a valid timestamp',
  garbageUnit.ok === false,
  garbageUnit.ok ? 'accepted (should be refused)' : garbageUnit.err,
);

const oversell = await sell({
  medicineId: med,
  quantity: 10_000,
  paid: 50000,
  idempotencyKey: 'ts-oversell-1',
  soldAt: threeHoursAgo,
});
check(
  'overselling is still refused even with a valid timestamp',
  oversell.ok === false && /only/i.test(oversell.err ?? ''),
  oversell.ok ? 'accepted (should be refused)' : oversell.err,
);

note(
  'sale-time edge cases are server-owned',
  'the server re-checks both edges of p_sold_at; a device may only NARRATE when the sale happened, never decide the ledger ordering',
);

process.exit(await finish(database));
