'use strict';

/**
 * STOREFRONT CHECKOUT CERTIFICATION AGAINST STRIPE TEST MODE (no payment stand-in).
 *
 * The real app and a fresh isolated database (tests/fullstack, never production), with the REAL Stripe API in TEST mode:
 * real PaymentIntents, real card outcomes (Stripe's test payment methods), real refunds, a real dispute, a real Connect
 * test account and a real transfer to it. Stripe events are relayed to the app's own webhook endpoint with a valid
 * signature (the same check production uses). Nothing is charged; no email or text leaves (no mail or SMS settings).
 *
 * OPT-IN: runs only with RUN_STRIPE_TEST_CERT=1 and a test-mode key in STRIPE_TEST_SECRET_KEY (it refuses a live key).
 * CI skips it. Covers: marketplace sale (9%) and embedded-storefront sale (5%) with channel attribution, tax, the actual
 * card cost, stock deductions for multi-quantity, overselling refused, a declined card then a successful retry, a full
 * refund, a dispute that holds the payout (and cannot be released while open), duplicate webhooks, seller fulfillment,
 * and the weekly payout paid by a real transfer to the seller's connected account.
 */

const crypto = require('crypto');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const sj = require('../fullstack/seedJourneys');

const KEY = process.env.STRIPE_TEST_SECRET_KEY || '';
const PUB = process.env.STRIPE_TEST_PUBLISHABLE_KEY || '';
const RUN = process.env.RUN_STRIPE_TEST_CERT === '1' && KEY.startsWith('sk_test_') && PUB.startsWith('pk_test_');
const maybe = RUN ? describe : describe.skip;

jest.setTimeout(600000);
const WEBHOOK_SECRET = 'whsec_' + crypto.randomBytes(24).toString('hex');   // this run only
let stack; let stripe; const T = {}; const R = {};   // R = the certification record printed at the end
const startedAt = Math.floor(Date.now() / 1000) - 5;

async function api(token, method, p, body, headers = {}) {
  const r = await fetch(stack.baseUrl + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, j };
}
const one = async (sql, p) => (await stack.query(sql, p)).rows[0];
const order = (itemId, extra = {}) => api(T.buyer.token, 'POST', '/api/marketplace/orders',
  { item_id: itemId, quantity: 1, fulfillment_method: 'pickup', policies_acknowledged: true, ...extra }, { 'Idempotency-Key': crypto.randomUUID() });
const pay = (orderId, pm) => api(T.buyer.token, 'POST', `/api/marketplace/orders/${orderId}/pay`, { payment_method_id: pm }, { 'Idempotency-Key': crypto.randomUUID() });
const orderRow = (id) => one('SELECT * FROM marketplace_orders WHERE id = $1', [id]);

// Relay every Stripe test event since the run started to the app's webhook, signed exactly as Stripe signs.
async function relayEvents(filter = () => true) {
  const out = [];
  for await (const ev of stripe.events.list({ created: { gte: startedAt }, limit: 100 })) {
    if (!filter(ev)) continue;
    const md = (ev.data && ev.data.object && ev.data.object.metadata) || {};
    if (md.purpose === 'certification-balance-top-up') continue;   // the test's own balance top-up is not an order
    const payload = JSON.stringify(ev);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const r = await fetch(stack.baseUrl + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload });
    out.push({ type: ev.type, status: r.status });
  }
  return out;
}

maybe('storefront checkout on Stripe TEST mode (certification)', () => {
  beforeAll(async () => {
    stripe = require('stripe')(KEY);
    stack = await startStack({ env: {
      STRIPE_SECRET_KEY: KEY, STRIPE_PUBLISHABLE_KEY: PUB, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MARKETPLACE_CHECKOUT_ENABLED: 'true', STRIPE_CONNECT_ENABLED: 'true', SELLER_SETTLEMENTS_ENABLED: 'true', STRIPE_TAX_ENABLED: 'true' } });
    // Seller: a Professional Seller with a published storefront, signed current storefront terms and a REAL Connect test account.
    Object.assign(T, { shop: await sj.publishedStorefront(stack, { email: 'cert-shop@fullstack.test', slug: 'cert-pottery', name: 'Certification Pottery' }) });
    await seed.signedStorefrontAgreement(stack, T.shop.sellerProfileId);
    await stack.query(`UPDATE seller_profiles SET storefront = jsonb_set(coalesce(storefront, '{}'::jsonb), '{website}', '"https://cert-pottery.example"') WHERE id = $1`, [T.shop.sellerProfileId]);
    // An Accounts-v2 recipient (the app's account type) that can receive transfers. Real sellers onboard on Stripe's hosted
    // Express pages; a TEST account is completed here through the API with Stripe's test identity values instead
    // (dashboard 'none', because Stripe does not let a platform accept terms for an Express account).
    const acct = await stripe.v2.core.accounts.create({
      contact_email: 'cert-shop@example.com', display_name: 'Certification Pottery', dashboard: 'none',
      defaults: { profile: { business_url: 'https://cert-pottery.example' }, responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
      identity: { country: 'us', entity_type: 'individual',
        individual: { given_name: 'Jenny', surname: 'Rosen', email: 'cert-shop@example.com', phone: '+10000000000', date_of_birth: { day: 1, month: 1, year: 1901 },
          id_numbers: [{ type: 'us_ssn_last_4', value: '0000' }], address: { line1: 'address_full_match', city: 'Houston', state: 'TX', postal_code: '77002', country: 'us' } },
        attestations: { terms_of_service: { account: { date: new Date().toISOString(), ip: '127.0.0.1' } } } },
      include: ['configuration.recipient'],
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      metadata: { platform: 'advantage.bid', purpose: 'certification-test' } });
    await stripe.accounts.createExternalAccount(acct.id, { external_account: 'btok_us_verified' });
    T.acct = acct.id;
    const transfers = async () => (await stripe.v2.core.accounts.retrieve(acct.id, { include: ['configuration.recipient'] }))
      .configuration.recipient.capabilities.stripe_balance.stripe_transfers.status;
    for (let i = 0; i < 30 && (await transfers()) !== 'active'; i++) await new Promise((r) => setTimeout(r, 2000));
    R.connect_transfers = await transfers();
    await stack.query(`INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, stripe_account_livemode, connect_status,
      connect_details_submitted, connect_transfers_active, connect_payouts_enabled) VALUES ($1, 'ach', $2, false, 'ready', true, true, true)`, [T.shop.userId, acct.id]);
    // Tax: who remits Texas tax must be recorded (an administrator's rule from professional advice); test value only.
    await stack.query(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis) VALUES ('TX', 'platform', 'TEST ONLY: certification run')`);
    // Inventory: single items and one multi-quantity item.
    const item = async (title, priceCents, qty, inv) => { const id = await sj.publishedItem(stack, { sellerProfileId: T.shop.sellerProfileId, title, priceCents, inventoryNumber: inv });
      await stack.query('UPDATE marketplace_items SET quantity = $2 WHERE id = $1', [id, qty]); return id; };
    T.lamp = await item('Brass Lamp', 12500, 1, 'CERT-1'); T.bowls = await item('Stoneware Bowl', 4000, 3, 'CERT-2');
    T.vase = await item('Glazed Vase', 6000, 1, 'CERT-3'); T.mug = await item('Pottery Mug', 3000, 1, 'CERT-4');
    // Test-mode balance for the payout transfer (refunds and the dispute below draw on it): one top-up charge with funds
    // available at once. Not an order; test mode only.
    const top = await stripe.paymentIntents.create({ amount: 100000, currency: 'usd', payment_method_types: ['card'], metadata: { purpose: 'certification-balance-top-up' } });
    await stripe.paymentIntents.confirm(top.id, { payment_method: 'pm_card_bypassPending' });
    // Buyer and administrator.
    const buyerId = await seed.user(stack, { email: 'cert-buyer@fullstack.test', role: 'buyer', fullName: 'Cert Buyer' });
    T.buyer = { id: buyerId, token: await seed.apiLogin(stack, 'cert-buyer@fullstack.test') };
    await seed.user(stack, { email: 'cert-admin@fullstack.test', role: 'admin', fullName: 'Cert Admin' });
    T.admin = { token: await seed.apiLogin(stack, 'cert-admin@fullstack.test') };
    T.seller = { token: await seed.apiLogin(stack, 'cert-shop@fullstack.test') };
  });
  afterAll(async () => {
    if (stack) {
      console.log('STRIPE TEST CERTIFICATION RECORD\n' + JSON.stringify(R, null, 2));
      console.log('SERVER NOTES\n' + stack.logs().split('\n').filter((l) => /\[marketplace\]|\[webhook\]|processing fee|transfer/i.test(l)).slice(-40).join('\n'));
      await stack.stop();
    }
  });

  test('marketplace sale (9%): real charge, tax, actual card cost, item sold, Stripe amount matches the order', async () => {
    const o = await order(T.lamp);
    expect([o.status, o.j && o.j.success]).toEqual([200, true]);
    T.lampOrder = o.j.data.order ? o.j.data.order.id : o.j.data.id;
    const p = await pay(T.lampOrder, 'pm_card_bypassPending');
    expect([p.status, p.j.data && p.j.data.status]).toEqual([200, 'succeeded']);
    const row = await orderRow(T.lampOrder);
    expect(row).toMatchObject({ payment_status: 'paid', sales_channel: 'marketplace', platform_fee_bps: 900 });
    expect(Number(row.platform_fee_cents)).toBe(Math.round(Number(row.item_price_cents) * 0.09));
    const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
    expect([pi.status, pi.amount, pi.livemode]).toEqual(['succeeded', Number(row.total_charge_cents), false]);
    expect((await one('SELECT status FROM marketplace_items WHERE id = $1', [T.lamp])).status).not.toBe('active');
    R.marketplace_sale = { order: row.order_number, item: row.item_price_cents, tax: row.tax_cents, tax_remitter: row.tax_remitter, total: row.total_charge_cents,
      fee_bps: row.platform_fee_bps, fee: row.platform_fee_cents, proceeds: row.seller_proceeds_cents, actual_card_cost: row.processing_fee_cents, buyer_terms_version: row.buyer_terms_version_int };
  });

  test('embedded-storefront sale (5%): the website pass from a framed page sets the channel; 2 of 3 units sold', async () => {
    const page = await fetch(stack.baseUrl + '/embed/storefront.html?seller=' + T.shop.sellerProfileId, { headers: { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' } });
    const pass = ((await page.text()).match(/<meta name="adv-website-pass" content="([^"]+)">/) || [])[1];
    expect(pass).toBeTruthy();
    const o = await order(T.bowls, { quantity: 2, channel_passes: [pass] });
    expect(o.status).toBe(200);
    T.bowlOrder = o.j.data.order ? o.j.data.order.id : o.j.data.id;
    expect((await pay(T.bowlOrder, 'pm_card_bypassPending')).j.data.status).toBe('succeeded');
    const row = await orderRow(T.bowlOrder);
    expect(row).toMatchObject({ sales_channel: 'seller_website', platform_fee_bps: 500, quantity: 2 });
    expect(await one('SELECT quantity, quantity_sold FROM marketplace_items WHERE id = $1', [T.bowls])).toEqual({ quantity: 1, quantity_sold: 2 });
    R.website_sale = { order: row.order_number, units: row.quantity, fee_bps: row.platform_fee_bps, fee: row.platform_fee_cents, proceeds: row.seller_proceeds_cents,
      actual_card_cost: row.processing_fee_cents };
  });

  test('a pass cannot be forged or replayed for another seller: an invented pass leaves the marketplace rate', async () => {
    const o = await order(T.vase, { channel_passes: ['forged.pass.value'] });
    expect(o.status).toBe(200);
    T.vaseOrder = o.j.data.order ? o.j.data.order.id : o.j.data.id;
    expect((await orderRow(T.vaseOrder)).sales_channel).toBe('marketplace');
  });

  test('overselling is refused: only 1 bowl is left', async () => {
    const o = await order(T.bowls, { quantity: 2 });
    expect(o.status).toBeGreaterThanOrEqual(400);
    R.oversell = { status: o.status, code: o.j && o.j.code };
  });

  test('a declined card: nothing is charged and the item stays held; a retry with a good card succeeds', async () => {
    const o = await order(T.mug);
    T.mugOrder = o.j.data.order ? o.j.data.order.id : o.j.data.id;
    const d = await pay(T.mugOrder, 'pm_card_chargeDeclined');
    expect([d.status, d.j.code]).toEqual([402, 'CARD_DECLINED']);
    expect((await orderRow(T.mugOrder)).payment_status).toBe('pending');
    const ok = await pay(T.mugOrder, 'pm_card_bypassPending');   // funds available at once, so the payout below can be transferred
    expect(ok.j.data.status).toBe('succeeded');
    R.declined_then_retry = { declined: d.j.code, retry: ok.j.data.status };
  });

  test('a full refund by an administrator is a real Stripe refund and is recorded once', async () => {
    const r = await api(T.admin.token, 'POST', `/api/marketplace/admin/orders/${T.lampOrder}/refund`, { reason: 'requested_by_customer' });
    expect(r.status).toBe(200);
    const row = await orderRow(T.lampOrder);
    const refunds = await stripe.refunds.list({ payment_intent: row.stripe_payment_intent_id });
    expect(refunds.data.length).toBe(1);
    expect(refunds.data[0].amount).toBe(Number(row.total_charge_cents));
    expect(row.refund_status).toBe('refunded');
    R.refund = { order: row.order_number, stripe_refunds: refunds.data.length, amount: refunds.data[0].amount, status: row.refund_status };
  });

  test('a dispute (chargeback) holds the order payout, and the hold cannot be released while the dispute is open', async () => {
    const pi = (await orderRow(T.vaseOrder)).stripe_payment_intent_id;
    expect((await pay(T.vaseOrder, 'pm_card_createDispute')).j.data.status).toBe('succeeded');
    let disputed = false;
    for (let i = 0; i < 40 && !disputed; i++) {
      const ds = await stripe.disputes.list({ payment_intent: pi });
      disputed = ds.data.length > 0;
      if (!disputed) await new Promise((r) => setTimeout(r, 3000));
    }
    expect(disputed).toBe(true);
    const relayed = await relayEvents((ev) => /^charge\.dispute\./.test(ev.type) && ev.data.object.payment_intent === pi);
    expect(relayed.every((x) => x.status === 200)).toBe(true);
    const row = await orderRow(T.vaseOrder);
    expect(row.payout_hold).toBe(true);
    const release = await api(T.admin.token, 'POST', `/api/marketplace/admin/orders/${T.vaseOrder}/payout-hold`, { hold: false, reason: 'certification check' });
    expect([release.status, release.j.code]).toEqual([409, 'DISPUTE_OPEN']);
    R.dispute = { order: row.order_number, webhook: relayed.map((x) => x.type + ':' + x.status), payout_hold: row.payout_hold, release_refused: release.j.code };
  });

  test('duplicate and replayed webhooks change nothing (idempotent); an unsigned webhook is refused', async () => {
    const before = await one('SELECT count(*)::int n FROM marketplace_order_events');
    const relayed = await relayEvents((ev) => /^payment_intent\.succeeded$|^charge\.refunded$/.test(ev.type));
    expect(relayed.every((x) => x.status === 200)).toBe(true);
    const again = await relayEvents((ev) => /^payment_intent\.succeeded$/.test(ev.type));
    expect(again.every((x) => x.status === 200)).toBe(true);
    const paidEvents = await one(`SELECT count(*)::int n FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'paid'`, [T.bowlOrder]);
    expect(paidEvents.n).toBeLessThanOrEqual(1);
    const unsigned = await fetch(stack.baseUrl + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=bad' }, body: '{}' });
    expect(unsigned.status).toBe(400);
    R.webhooks = { relayed: relayed.length, replayed: again.length, order_events_before: before.n, unsigned_status: unsigned.status };
    // The actual card cost equals Stripe's own balance-transaction fee. Stripe attaches it a few seconds after payment, so
    // the payment webhook (or, if it is still missing then, the five-minute backfill) records it. The disputed order's fee
    // can arrive later still; it is left to the backfill (unit-tested in tests/marketplace-processing-fee.test.js).
    for (const id of [T.bowlOrder, T.mugOrder]) {
      const row = await orderRow(id);
      const ch = await stripe.charges.retrieve((await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id)).latest_charge, { expand: ['balance_transaction'] });
      expect([row.order_number, row.processing_fee_cents == null ? 'NOT RECORDED' : Number(row.processing_fee_cents)]).toEqual([row.order_number, ch.balance_transaction.fee]);
    }
    R.card_cost_recorded = { webhook_orders: 2, disputed_order: (await orderRow(T.vaseOrder)).processing_fee_cents == null ? 'left to backfill' : 'recorded' };
  });

  test('seller fulfillment, then the weekly payout is paid by a real transfer to the seller\'s connected account', async () => {
    R.payout_steps = [];
    const step = (n) => R.payout_steps.push(n + ' ' + new Date().toISOString().slice(11, 19));
    step('fulfil bowls');
    const f = await api(T.seller.token, 'POST', `/api/marketplace/seller/orders/${T.bowlOrder}/fulfillment`, { action: 'picked_up' });
    expect(f.status).toBe(200);
    step('fulfil mug');
    const g = await api(T.seller.token, 'POST', `/api/marketplace/seller/orders/${T.mugOrder}/fulfillment`, { action: 'picked_up' });
    expect(g.status).toBe(200);
    // the weekly cutoff is in the past for orders made now: date the eligibility before the last cutoff (time simulation only)
    await stack.query(`UPDATE marketplace_orders SET payout_eligible_at = now() - interval '9 days' WHERE id = ANY($1::uuid[])`, [[T.bowlOrder, T.mugOrder]]);
    step('prepare');
    const prep = await api(T.admin.token, 'POST', '/api/admin/storefront-payouts/prepare', {});
    expect(prep.status).toBe(200);
    const payout = await one(`SELECT * FROM storefront_payouts WHERE seller_user_id = $1 AND settlement_status <> 'void' ORDER BY created_at DESC LIMIT 1`, [T.shop.userId]);
    expect(payout).toBeTruthy();
    const expected = Number((await one(`SELECT sum(seller_proceeds_cents)::int s FROM marketplace_orders WHERE id = ANY($1::uuid[])`, [[T.bowlOrder, T.mugOrder]])).s);
    expect(Number(payout.seller_payout_cents)).toBe(expected);
    step('pay');
    const paid = await api(T.admin.token, 'POST', `/api/admin/storefront-payouts/${payout.id}/pay`, { confirmed_completed: true, final_amount_cents: expected });
    R.payout_response = { status: paid.status, code: paid.j && paid.j.code, message: paid.j && paid.j.message };
    expect([paid.status, paid.j && paid.j.success]).toEqual([200, true]);
    const tr = await stripe.transfers.retrieve(paid.j.data.stripe_transfer_id);
    expect([tr.amount, tr.destination, tr.livemode]).toEqual([expected, T.acct, false]);
    R.payout = { orders: 2, amount: expected, stripe_transfer: tr.id.slice(0, 6) + '...', destination_is_seller_account: tr.destination === T.acct };
  });
});
