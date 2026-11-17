'use strict';
/**
 * Central sales tax ledger, reserve guard and reconciliation (owner 2026-11-16; migration 231) against a real Postgres
 * (the isolated PGlite database with EVERY migration applied; never production, no outside call).
 *
 * Proves: sales, partial and full refunds and lost disputes are posted to the cent for auctions, marketplace sales and
 * embedded storefront sales; posting is idempotent and safe when run concurrently; the ledger cannot be updated or
 * deleted; liability counts only tax Advantage.Bid remits; remittances and transfers to the tax account are recorded
 * once; a payout that would spend money held for tax is refused (and waits when the balance cannot be read);
 * reconciliation is clean on consistent records and reports a difference without changing anything.
 */
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

jest.setTimeout(180000);

let dbProc; let pool;
const mockDb = { query: (...a) => pool.query(...a), connect: () => pool.connect(), get pool() { return pool; } };
jest.mock('../src/db', () => mockDb);
jest.mock('../src/db/index', () => mockDb);

const seed = require('./fullstack/seed');
const S = {};
const q = (sql, p) => pool.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];

beforeAll(async () => {
  const port = 56000 + Math.floor(Math.random() * 3000);
  dbProc = spawn(process.execPath, [path.join(__dirname, 'fullstack', 'dbServer.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { let b = ''; dbProc.stdout.on('data', (d) => { b += d; if (/READY/.test(b)) resolve(); });
    dbProc.on('exit', (c) => reject(new Error('db exited ' + c))); setTimeout(() => reject(new Error('db start timeout')), 90000); });
  pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 1 });
  const stack = { query: q };
  S.buyer = await seed.user(stack, { email: 'tax-buyer@fullstack.test', role: 'buyer' });
  S.sellerUser = await seed.user(stack, { email: 'tax-seller@fullstack.test', role: 'seller' });
  S.seller = await seed.sellerProfile(stack, { userId: S.sellerUser, sellerType: 'retail_gallery_studio', displayName: 'Ledger Test Shop' });
  S.auctionNJ = (await one(`INSERT INTO auctions (seller_id, title, description, state, start_time, end_time, city, address_state, zip, marketplace_status)
    VALUES ($1, 'NJ sale', 'd', 'closed', now() - interval '9 days', now() - interval '2 days', 'Jersey City', 'NJ', '07302', 'syndicated') RETURNING id`, [S.seller])).id;
  S.auctionTX = (await one(`INSERT INTO auctions (seller_id, title, description, state, start_time, end_time, city, address_state, zip, marketplace_status)
    VALUES ($1, 'TX sale', 'd', 'closed', now() - interval '9 days', now() - interval '2 days', 'Houston', 'TX', '77002', 'syndicated') RETURNING id`, [S.seller])).id;
  S.auctionDemo = (await one(`INSERT INTO auctions (seller_id, title, description, state, start_time, end_time, city, address_state, zip, marketplace_status, is_demo)
    VALUES ($1, 'Demo', 'd', 'closed', now() - interval '9 days', now() - interval '2 days', 'Newark', 'NJ', '07102', 'syndicated', true) RETURNING id`, [S.seller])).id;
  const pay = async (auction, amount, tax, extra = {}) => (await one(
    `INSERT INTO payments (auction_id, buyer_user_id, amount_cents, status, payment_intent_id, sales_tax_cents, taxable_base_cents, charged_at,
                           tax_remitter, tax_jurisdiction, tax_basis, stripe_tax_transaction_id, refunded_amount_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() - interval '1 day', $8,$9,$10,$11,$12) RETURNING id`,
    [auction, S.buyer, amount, extra.status || 'paid', 'pi_' + Math.random().toString(36).slice(2), tax, amount - tax, extra.remitter || null,
      extra.state || null, extra.basis || null, tax > 0 ? 'tax_txn_' + Math.random().toString(36).slice(2) : null, extra.refunded || 0])).id;
  // NJ auction, platform remits: $118.00 goods (hammer + premium), 6.625% = $7.82 tax.
  S.payNJ = await pay(S.auctionNJ, 12582, 782, { remitter: 'platform', state: 'NJ', basis: 'taxed' });
  // TX auction paid before any rule existed: no tax, recorded as unconfigured (legacy row: no remitter stored).
  S.payTX = await pay(S.auctionTX, 5000, 0);
  // Demo auction: never posted.
  await pay(S.auctionDemo, 9999, 0);
  S.item = (await one(`INSERT INTO marketplace_items (seller_id, title, description, category, condition, price_cents, status, city, state, zip, pickup_location_source)
    VALUES ($1, 'Brass Candlestick Lamp', 'd', 'lighting', 'good', 300, 'active', 'Jersey City', 'NJ', '07302', 'default') RETURNING id`, [S.seller])).id;
  const order = async (num, channel, extra = {}) => {
    // The database requires a new order to start unpaid; it is then paid, as in the real flow.
    const id = (await newOrder(num, channel, extra)).id;
    await q(`UPDATE marketplace_orders SET payment_status = 'paid', paid_at = now() - interval '3 hours' WHERE id = $1`, [id]);
    return id;
  };
  const newOrder = async (num, channel, extra = {}) => (await one(
    `INSERT INTO marketplace_orders (order_number, marketplace_item_id, seller_id, buyer_user_id, item_price_cents, shipping_cents, tax_cents, platform_fee_bps,
        platform_fee_cents, seller_proceeds_cents, total_charge_cents, fulfillment_method, payment_status, paid_at, tax_remitter, tax_jurisdiction, tax_basis,
        sales_channel, stripe_payment_intent_id, stripe_tax_transaction_id, quantity, unit_price_cents, item_snapshot, seller_snapshot)
     VALUES ($1,$2,$3,$4,300,200,$5,$6,$7,$8,$9,'shipping','pending', NULL, $10,$11,$12,$13,$14,$15,1,300,
             $16::jsonb, $17::jsonb) RETURNING id`,
    [num, S.item, S.seller, S.buyer, extra.tax == null ? 33 : extra.tax, channel === 'seller_website' ? 500 : 900, channel === 'seller_website' ? 15 : 27,
      channel === 'seller_website' ? 485 : 473, 500 + (extra.tax == null ? 33 : extra.tax), extra.remitter || 'platform', extra.state || 'NJ', extra.basis || 'taxed',
      channel, 'pi_o_' + num, (extra.tax == null ? 33 : extra.tax) > 0 ? 'tax_txn_o_' + num : null,
      JSON.stringify({ item_id: S.item }), JSON.stringify({ seller_profile_id: S.seller })]));
  S.orderMkt = await order('MO-TAX-1', 'marketplace');                 // the pilot lamp: $3 + $2 + $0.33; fee $0.27; proceeds $4.73
  S.orderWeb = await order('MO-TAX-2', 'seller_website');              // embedded storefront: fee $0.15; proceeds $4.85
  S.orderPA = await order('MO-TAX-3', 'marketplace', { tax: 0, remitter: 'none', state: 'PA', basis: 'seller_direct' });
});
afterAll(async () => { try { await pool.end(); } catch (_) {} try { dbProc.kill(); } catch (_) {} });

const ledger = require('../src/services/tax/taxLedgerService');
const reserve = require('../src/services/tax/taxReserveService');
const recon = require('../src/services/tax/taxReconciliationService');

const entries = async (where = 'true', p = []) => (await q(`SELECT * FROM tax_ledger_entries WHERE ${where} ORDER BY id`, p)).rows;
const n = (v) => Number(v);

test('sales from all three channels are posted once, to the cent; demo records are not', async () => {
  const [a, b, c] = await Promise.all([ledger.sync(), ledger.sync(), ledger.sync()]);   // concurrent posting is safe
  expect(a.posted + b.posted + c.posted).toBe(5);
  expect((await ledger.sync()).posted).toBe(0);                                          // idempotent
  const all = await entries();
  expect(all).toHaveLength(5);
  expect(all.find((e) => e.auction_id === S.auctionDemo)).toBeUndefined();

  const nj = (await entries(`idempotency_key = $1`, ['sale:payment:' + S.payNJ]))[0];
  expect(nj).toMatchObject({ entry_type: 'sale', channel: 'auction', state: 'NJ', remitter: 'platform', tax_basis: 'taxed' });
  expect([n(nj.gross_cents), n(nj.taxable_cents), n(nj.tax_collected_cents), n(nj.exempt_cents)]).toEqual([12582, 11800, 782, 0]);

  const tx = (await entries(`idempotency_key = $1`, ['sale:payment:' + S.payTX]))[0];
  expect(tx).toMatchObject({ state: 'TX', remitter: 'unconfigured', tax_basis: 'unconfigured' });
  expect([n(tx.gross_cents), n(tx.taxable_cents), n(tx.tax_collected_cents), n(tx.exempt_cents)]).toEqual([5000, 0, 0, 5000]);

  const lamp = (await entries(`idempotency_key = $1`, ['sale:order:' + S.orderMkt]))[0];
  expect(lamp).toMatchObject({ channel: 'marketplace', state: 'NJ', remitter: 'platform' });
  expect([n(lamp.gross_cents), n(lamp.merchandise_cents), n(lamp.shipping_cents), n(lamp.tax_collected_cents), n(lamp.platform_fee_cents), n(lamp.seller_proceeds_cents)])
    .toEqual([533, 300, 200, 33, 27, 473]);
  const web = (await entries(`idempotency_key = $1`, ['sale:order:' + S.orderWeb]))[0];
  expect(web.channel).toBe('seller_website');
  expect([n(web.platform_fee_cents), n(web.seller_proceeds_cents)]).toEqual([15, 485]);
  const pa = (await entries(`idempotency_key = $1`, ['sale:order:' + S.orderPA]))[0];
  expect(pa).toMatchObject({ state: 'PA', remitter: 'seller_direct', tax_basis: 'seller_direct' });
  expect(n(pa.tax_collected_cents)).toBe(0);
  // Every entry carries its reporting period (first of the month).
  expect(all.every((e) => new Date(e.tax_period).getUTCDate() === 1 || new Date(e.tax_period).getDate() === 1)).toBe(true);
});

test('the ledger is append-only: an update or a delete is refused by the database', async () => {
  await expect(q(`UPDATE tax_ledger_entries SET tax_collected_cents = 0 WHERE idempotency_key = $1`, ['sale:payment:' + S.payNJ])).rejects.toThrow(/append-only/);
  await expect(q(`DELETE FROM tax_ledger_entries WHERE idempotency_key = $1`, ['sale:payment:' + S.payNJ])).rejects.toThrow(/append-only/);
  expect(n((await entries(`idempotency_key = $1`, ['sale:payment:' + S.payNJ]))[0].tax_collected_cents)).toBe(782);
});

test('liability counts only sales tax Advantage.Bid remits', async () => {
  const pos = await reserve.position();
  expect(pos).toMatchObject({ collected: 782 + 33 + 33, remitted: 0, outstanding: 848, heldOutside: 0, requiredOnHand: 848 });
});

test('a partial refund, then the rest: each posted once, tax reversed in proportion, summing exactly to the sale', async () => {
  await q(`UPDATE payments SET refunded_amount_cents = 5000, status = 'partially_refunded', refunded_at = now() WHERE id = $1`, [S.payNJ]);
  expect((await ledger.sync()).posted).toBe(1);
  expect((await ledger.sync()).posted).toBe(0);
  const r1 = (await entries(`source_id = $1 AND entry_type = 'refund'`, [S.payNJ]))[0];
  expect([n(r1.gross_cents), n(r1.tax_collected_cents)]).toEqual([-5000, -311]);          // 782 * 5000 / 12582 = 310.76 -> 311
  await q(`UPDATE payments SET refunded_amount_cents = 12582, status = 'refunded' WHERE id = $1`, [S.payNJ]);
  expect((await ledger.sync()).posted).toBe(1);
  const refunds = await entries(`source_id = $1 AND entry_type = 'refund'`, [S.payNJ]);
  expect(refunds).toHaveLength(2);
  expect(refunds.reduce((s, e) => s + n(e.gross_cents), 0)).toBe(-12582);
  expect(refunds.reduce((s, e) => s + n(e.tax_collected_cents), 0)).toBe(-782);
  expect(refunds.reduce((s, e) => s + n(e.taxable_cents), 0)).toBe(-11800);
});

test('a full storefront refund undoes the sale, the commission and the proceeds (the pilot procedure)', async () => {
  await q(`UPDATE marketplace_orders SET refunded_amount_cents = 533, refund_status = 'refunded', payment_status = 'refunded', refunded_at = now(),
             stripe_tax_reversal_id = 'tax_rev_1' WHERE id = $1`, [S.orderMkt]);
  expect((await ledger.sync()).posted).toBe(1);
  const r = (await entries(`source_id = $1 AND entry_type = 'refund'`, [S.orderMkt]))[0];
  expect([n(r.gross_cents), n(r.merchandise_cents), n(r.shipping_cents), n(r.tax_collected_cents), n(r.platform_fee_cents), n(r.seller_proceeds_cents)])
    .toEqual([-533, -300, -200, -33, -27, -473]);
  expect(r.tax_reversal_id).toBe('tax_rev_1');
  const net = await one(`SELECT SUM(gross_cents)::int g, SUM(tax_collected_cents)::int t, SUM(seller_proceeds_cents)::int p FROM tax_ledger_entries WHERE source_id = $1`, [S.orderMkt]);
  expect(net).toEqual({ g: 0, t: 0, p: 0 });
  expect((await reserve.position()).outstanding).toBe(33);   // only the embedded storefront order's tax remains
});

test('a remittance and a transfer to the tax account are recorded once each and reduce what must stay on hand', async () => {
  const moved = await ledger.recordReserveTransfer({ amountCents: 20, reference: 'BANK-REF-1' }, S.sellerUser);
  expect(n(moved.tax_reserved_cents)).toBe(20);
  expect(await ledger.recordReserveTransfer({ amountCents: 20, reference: 'BANK-REF-1' }, S.sellerUser)).toBeNull();   // same reference: not twice
  expect(await reserve.position()).toMatchObject({ outstanding: 33, heldOutside: 20, requiredOnHand: 13 });
  await expect(ledger.recordRemittance({ state: 'NJ', amountCents: 0, reference: 'X' }, S.sellerUser)).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
  const paid = await ledger.recordRemittance({ state: 'NJ', amountCents: 20, reference: 'NJ-CONF-123' }, S.sellerUser);
  expect(paid).toMatchObject({ entry_type: 'remittance', state: 'NJ' });
  expect(await ledger.recordRemittance({ state: 'NJ', amountCents: 20, reference: 'NJ-CONF-123' }, S.sellerUser)).toBeNull();
  expect(await reserve.position()).toMatchObject({ remitted: 20, outstanding: 13, heldOutside: 0, requiredOnHand: 13 });
});

describe('payout reserve guard', () => {
  const stripeWith = (available) => ({ balance: { retrieve: jest.fn(async () => ({ available: [{ currency: 'usd', amount: available }], pending: [{ currency: 'usd', amount: 99999 }] })) } });

  test('a payout that leaves the tax money covered goes ahead; pending settlements are not counted', async () => {
    const stripe = stripeWith(1013);
    await expect(reserve.assertTransferLeavesReserve({ transferCents: 1000, stripe })).resolves.toMatchObject({ checked: true, requiredOnHand: 13 });
  });
  test('a payout that would spend money held for sales tax is refused', async () => {
    const stripe = stripeWith(1012);
    await expect(reserve.assertTransferLeavesReserve({ transferCents: 1000, stripe })).rejects.toMatchObject({ name: 'TaxReserveError', code: 'TAX_RESERVE_SHORTFALL', status: 409 });
  });
  test('when the balance cannot be read while tax is owed, the payout waits', async () => {
    const stripe = { balance: { retrieve: jest.fn(async () => { throw new Error('network'); }) } };
    await expect(reserve.assertTransferLeavesReserve({ transferCents: 1, stripe })).rejects.toMatchObject({ code: 'TAX_RESERVE_UNVERIFIED' });
  });
  test('the owner switch turns the guard off, and with nothing owed no outside call is made', async () => {
    await q(`UPDATE platform_config SET value = 'false'::jsonb WHERE key = 'tax.reserve_guard'`);
    const stripe = stripeWith(0);
    await expect(reserve.assertTransferLeavesReserve({ transferCents: 1000, stripe })).resolves.toMatchObject({ checked: false });
    expect(stripe.balance.retrieve).not.toHaveBeenCalled();
    await q(`UPDATE platform_config SET value = 'true'::jsonb WHERE key = 'tax.reserve_guard'`);
    await ledger.recordRemittance({ state: 'NJ', amountCents: 13, reference: 'NJ-CONF-124' }, S.sellerUser);
    await expect(reserve.assertTransferLeavesReserve({ transferCents: 1000, stripe })).resolves.toMatchObject({ checked: true, requiredOnHand: 0 });
    expect(stripe.balance.retrieve).not.toHaveBeenCalled();
  });
});

test('a lost chargeback is recorded once and leaves the tax figures for the accountant', async () => {
  await q(`INSERT INTO payment_disputes (stripe_dispute_id, payment_intent_id, payment_id, auction_id, buyer_user_id, amount_cents, status, livemode, closed_at)
           VALUES ('dp_lost_1', 'pi_x', $1, $2, $3, 5000, 'lost', true, now())`, [S.payTX, S.auctionTX, S.buyer]);
  expect((await ledger.sync()).posted).toBe(1);
  expect((await ledger.sync()).posted).toBe(0);
  const d = (await entries(`entry_type = 'dispute'`))[0];
  expect(d).toMatchObject({ state: 'TX', channel: 'auction' });
  expect([n(d.gross_cents), n(d.tax_collected_cents)]).toEqual([-5000, 0]);
});

test('a correction is a new adjustment entry with a reason, never an edit', async () => {
  await expect(ledger.recordAdjustment({ state: 'NJ', taxCollectedCents: -5, reason: 'short' }, S.sellerUser)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  const before = (await entries()).length;
  const adj = await ledger.recordAdjustment({ state: 'NJ', channel: 'auction', taxCollectedCents: -5, reason: 'Accountant correction for a rounding difference on the October return.' }, S.sellerUser);
  expect(adj).toMatchObject({ entry_type: 'adjustment', state: 'NJ' });
  expect((await entries()).length).toBe(before + 1);
  await ledger.recordAdjustment({ state: 'NJ', channel: 'auction', taxCollectedCents: 5, reason: 'Reverses the previous correction entered in error.', reversesEntryId: adj.id }, S.sellerUser);
});

describe('reconciliation', () => {
  const noProvider = { taxService: { taxEnabled: () => false } };
  test('tax collected for Advantage.Bid to remit in a state with no recorded registration is reported', async () => {
    const run = await recon.run({}, noProvider);
    expect(run.summary.checks.find((c) => c.name === 'platform_tax_has_registration')).toMatchObject({ ok: false });
    await q(`INSERT INTO tax_registrations (state, status, effective_from, filing_frequency) VALUES ('NJ', 'active', CURRENT_DATE - 30, 'quarterly')`);
  });
  test('consistent records reconcile clean', async () => {
    const run = await recon.run({}, noProvider);
    expect(run.status).toBe('clean');
    expect(run.summary.checks.every((c) => c.ok)).toBe(true);
    expect((await q(`SELECT 1 FROM tax_alerts WHERE alert_type = 'reconciliation' AND resolved_at IS NULL`)).rowCount).toBe(0);
  });
  test('a charge that no longer matches its ledger entry is reported, nothing is changed, and the alert clears when fixed', async () => {
    // (A paid storefront order's totals cannot be edited at all: the database refuses it.)
    await expect(q(`UPDATE marketplace_orders SET tax_cents = 40 WHERE id = $1`, [S.orderWeb])).rejects.toThrow(/fixed after payment/);
    await q(`UPDATE payments SET amount_cents = 5100 WHERE id = $1`, [S.payTX]);
    const run = await recon.run({}, noProvider);
    expect(run.status).toBe('mismatches');
    const bad = run.summary.checks.find((c) => c.name === 'auction_payments_posted');
    expect(bad).toMatchObject({ ok: false, count: 1 });
    expect(n((await entries(`idempotency_key = $1`, ['sale:payment:' + S.payTX]))[0].gross_cents)).toBe(5000);   // ledger untouched
    expect((await q(`SELECT 1 FROM tax_alerts WHERE alert_key = 'recon:auction_payments_posted' AND resolved_at IS NULL`)).rowCount).toBe(1);
    await q(`UPDATE payments SET amount_cents = 5000 WHERE id = $1`, [S.payTX]);
    expect((await recon.run({}, noProvider)).status).toBe('clean');
    expect((await q(`SELECT 1 FROM tax_alerts WHERE alert_key = 'recon:auction_payments_posted' AND resolved_at IS NULL`)).rowCount).toBe(0);
  });
  test('the provider record of a tax transaction is compared when it can be reached', async () => {
    const stripe = { tax: { transactions: {
      listLineItems: jest.fn(async () => ({ data: [{ amount_tax: 20 }] })), retrieve: jest.fn(async () => ({ shipping_cost: { amount_tax: 10 } })) } } };
    const r = await recon.providerCheck({ taxService: { taxEnabled: () => true }, stripe });
    expect(r.ok).toBe(false);            // the ledger says 33, the provider says 30
    expect(r.count).toBeGreaterThan(0);
  });
  test('a payout line that carried tax Advantage.Bid remits is caught', async () => {
    const payout = (await one(`INSERT INTO storefront_payouts (seller_profile_id, seller_user_id, period_cutoff_at) VALUES ($1,$2, now()) RETURNING id`, [S.seller, S.sellerUser])).id;
    await q(`INSERT INTO storefront_payout_lines (storefront_payout_id, marketplace_order_id, order_number, goods_cents, platform_fee_cents, amount_cents, tax_to_seller_cents)
             VALUES ($1,$2,'MO-TAX-2',500,15,518,33)`, [payout, S.orderWeb]);
    const run = await recon.run({}, noProvider);
    expect(run.summary.checks.find((c) => c.name === 'storefront_payouts_exclude_platform_tax')).toMatchObject({ ok: false, count: 1 });
  });
});
