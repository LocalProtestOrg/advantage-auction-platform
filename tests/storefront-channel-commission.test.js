'use strict';

/**
 * Storefront commission by sales channel (owner decision 2026-11-03; migration 215): 5% of the item price for a sale that
 * began in the seller's embedded storefront on the seller's own website, 9% for every other sale. The channel is proven
 * on the server (a signed website pass issued only when the browser frames the widget on another site; bound to the
 * first buyer), never by a URL, cookie or request field. Real Postgres (PGlite) with the real migrations; the payment
 * processor is an in-memory stand-in (same harness as storefront-commerce-policies.test.js).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-storefront-channels'; // test value, never a real secret

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

// ── Real Postgres in a worker; transactions pass straight through (tests run strictly one statement at a time) ──
function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
function mockAdapter() {
  const query = async (sql, params) => {
    const r = await global.__PG.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*select/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}

jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../src/services/marketplaceOrderNotifier', () => ({ sendPaid: jest.fn(async () => {}), sendRefunded: jest.fn(async () => {}),
  sendConflictRefunded: jest.fn(async () => {}) }));
jest.mock('../src/services/ownerAlertService', () => ({ notifyAdminActionRequired: jest.fn(async () => {}),
  ALERT_TYPES: { SETTLEMENT_EXCEPTION: 'x', STOREFRONT_ITEM_REPORT: 'storefront_item_report', STOREFRONT_ORDER_ISSUE: 'storefront_order_issue' } }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/taxCalculationService', () => ({
  // Switchable per test: global.__TAX = { cents } turns tax on with that amount.
  taxEnabled: () => !!global.__TAX, addressComplete: () => true,
  computeTax: jest.fn(async () => (global.__TAX ? { taxCents: global.__TAX.cents, enabled: true, exempt: false, calculationId: 'calc_t' }
    : { taxCents: 0, enabled: false, exempt: false, calculationId: null })),
  recordTransaction: jest.fn(async () => null), reverseFullTransaction: jest.fn(async () => null), reversePartialTransaction: jest.fn(async () => null),
}));
jest.mock('../src/lib/launchGuards', () => ({ ...jest.requireActual('../src/lib/launchGuards'), marketplaceCheckoutEnabled: () => true }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));   // admin review history is not under test here
// Public item page viewer: the REAL token verification (sessionAuth) runs on a real signed token; only the server-side
// session-state lookup is replaced, so each state can be tested (default 'ok'; global.__SESSION_STATE[userId] overrides).
jest.mock('../src/lib/sessionTokens', () => ({
  ...jest.requireActual('../src/lib/sessionTokens'),
  checkSession: jest.fn(async (decoded) => {
    const s = (global.__SESSION_STATE || {})[decoded && decoded.id];
    if (s === 'throw') throw new Error('session lookup failed');
    return { state: s || 'ok', role: decoded && decoded.role };
  }),
}));
// Management routes: the test names the signed-in user with a header (the real middleware is covered by the session tests).
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: u.id, role: u.role, staff_role: u.staff_role || null };
  return next();
});

// ── Payment processor stand-in (in memory) ──────────────────────────────────────────────────────────────
const mockStripe = { intents: new Map(), refunds: [], transfers: [], n: 0, failTransfer: false };
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (p) => { const id = 'pi_' + (++mockStripe.n); const pi = { id, client_secret: id + '_secret', status: 'requires_payment_method', amount: p.amount,
      currency: p.currency, metadata: p.metadata, amount_received: 0 }; mockStripe.intents.set(id, pi); return { ...pi }; },
    retrieve: async (id) => ({ ...mockStripe.intents.get(id) }),
    confirm: async (id) => { const pi = mockStripe.intents.get(id); Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: 'ch_' + id }); return { ...pi }; },
    cancel: async (id) => { const pi = mockStripe.intents.get(id); pi.status = 'canceled'; return { ...pi }; },
  },
  paymentMethods: { retrieve: async (id) => ({ id, type: 'card', card: { funding: 'credit', brand: 'visa', last4: '4242' }, customer: null }) },
  // the charge's balance transaction: the processor's actual fee (2.9% + 30c here) for the processing-cost record
  charges: { retrieve: async (id) => { const pi = [...mockStripe.intents.values()].find((x) => x.latest_charge === id);
    return { id, balance_transaction: { id: 'txn_' + id, fee: pi ? Math.round(pi.amount * 0.029) + 30 : 0 } }; } },
  refunds: { create: async (p, o) => { mockStripe.refunds.push({ ...p, key: o && o.idempotencyKey }); return { id: 're_' + mockStripe.refunds.length }; } },
  transfers: { create: async (p, o) => {
    if (mockStripe.failTransfer) throw new Error('transfer refused');
    const key = o && o.idempotencyKey; const prior = mockStripe.transfers.find((t) => t.key === key);
    if (prior) return { id: prior.id };
    const t = { id: 'tr_' + (mockStripe.transfers.length + 1), ...p, key }; mockStripe.transfers.push(t); return { id: t.id }; } },
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_not_a_real_key';

const ROOT = path.join(__dirname, '..');
const mig = (f) => fs.readFileSync(path.join(ROOT, 'db', 'migrations', f), 'utf8');
const BASE = `
CREATE TABLE staff_permission_overrides (user_id uuid, permission text, effect text);
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, full_name text, role text DEFAULT 'buyer', staff_role text, staff_active boolean DEFAULT true,
  stripe_customer_id text, is_active boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text, display_name text,
  platform_fee_bps int, metadata jsonb DEFAULT '{}'::jsonb, is_demo boolean DEFAULT false, show_branding_to_buyers boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid REFERENCES seller_profiles(id), title text, city text, address_state text,
  street_address text, zip text, state text, end_time timestamptz, is_demo boolean DEFAULT false, buyer_premium_bps int);
CREATE TABLE seller_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, buyer_premium_pct numeric, superseded_at timestamptz);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid REFERENCES auctions(id), lot_number int, lot_number_display text, title text,
  description text, category text, condition text, thumbnail_url text, state text, is_withdrawn boolean DEFAULT false, winning_buyer_user_id uuid,
  reserve_cents int, reserve_not_met boolean DEFAULT false, starting_bid_cents int, current_bid_cents int, bid_count int DEFAULT 0, shippable boolean DEFAULT false,
  shipping_cost_cents int, shipping_notes text, pickup_group text);
CREATE TABLE lot_images (lot_id uuid, image_url text, sort_order int DEFAULT 0, created_at timestamptz DEFAULT now());
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, auction_id uuid, buyer_user_id uuid, status text, payment_intent_id text, created_at timestamptz DEFAULT now());
CREATE TABLE seller_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, settlement_status text, on_hold_reason text, updated_at timestamptz);
CREATE TABLE payment_disputes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stripe_dispute_id text NOT NULL, stripe_charge_id text, payment_intent_id text,
  payment_id uuid, auction_id uuid, buyer_user_id uuid, seller_payout_id uuid, amount_cents int, currency text, reason text, status text NOT NULL,
  livemode boolean NOT NULL DEFAULT false, evidence_due_by timestamptz, payout_hold_applied boolean NOT NULL DEFAULT false, payout_hold_note text,
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, last_event_id text, last_event_type text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uq_payment_disputes_stripe_dispute ON payment_disputes (stripe_dispute_id);
`;

let orders, items, server, base;
const U = {};
const SP = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];

async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  await global.__PG.exec(require('./helpers/saleReadySchema').SALE_READY_SQL);   // sellers start sale-ready (agreement + payouts)
  for (const f of ['071_verification_documents.sql', '119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql',
    '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql',
    '206_sold_price_privacy_and_message_moderation.sql', '207_storefront_bulk_import.sql', '209_marketplace_inventory_importer.sql', '211_retail_gallery_studio_seller_type.sql', '212_marketplace_multi_quantity.sql', '213_storefront_payouts.sql', '214_storefront_shipping_quantity_and_tax_responsibility.sql', '215_storefront_channel_commission.sql', '216_storefront_agreement_terms_and_refund_fault.sql', '217_storefront_commission_adjustments.sql']) {
    await global.__PG.exec(mig(f));
  }
  await global.__PG.exec(mig('197_storefront_order_integrity.sql'));
  await global.__PG.exec(mig('198_storefront_moderation_reports.sql'));

  for (const [name, role] of [['nora', 'seller'], ['sue', 'seller'], ['gus', 'seller'], ['bea', 'buyer'], ['ben', 'buyer'], ['admin', 'admin']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3) RETURNING *`, [name + '@test.example', name.toUpperCase(), role]);
  }
  global.__USERS = U;
  // nora: newly enrolled Professional, verification REQUIRED (not yet approved)
  // sue:  Professional, verification required AND approved
  // gus:  long-standing Professional, never flagged (grandfathered: not required)
  for (const [name, type, required] of [['nora', 'estate_sale_company', true], ['sue', 'auction_house', true], ['gus', 'professional_liquidator', false]]) {
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug,
      verification_required_before_publication)
      VALUES ($1, $2, $3, '1 Main St', 'Houston', 'TX', '77001', 'US', now(), true, $4, $5) RETURNING id`,
      [U[name].id, type, name.toUpperCase() + ' Co', name, required])).id;
  }
  await q(`INSERT INTO verification_requests (seller_profile_id, status, reviewed_by, reviewed_at) VALUES ($1, 'approved', $2, now())`, [SP.sue, U.admin.id]);

  orders = require('../src/services/marketplaceOrderService');
  items = require('../src/services/marketplaceItemService');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  app.use('/api/admin/tax-jurisdictions', require('../src/routes/adminTaxJurisdictions'));
  app.get('/embed/storefront.html', require('../src/routes/embedStorefrontPage'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

const listing = (owner, extra = {}) => items.createDirectListing(U[owner].id, { title: 'Eligibility item ' + Math.random().toString(36).slice(2, 7), price_cents: 5000, ...extra });
const order = (itemId, buyer = 'bea') => call(buyer, 'POST', '/api/marketplace/orders', { item_id: itemId, policies_acknowledged: true });
const pay = (orderId, buyer = 'bea') => call(buyer, 'POST', '/api/marketplace/orders/' + orderId + '/pay', { payment_method_id: 'pm_' + buyer });
const itemRow = (id) => one('SELECT status, pending_order_id FROM marketplace_items WHERE id = $1', [id]);
const orderCount = async (itemId) => (await one('SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1', [itemId])).n;
// Approve / reject through the REAL admin review service (the same call the admin verification page makes).
const LAST_REQ = {};
async function approve(seller) {
  LAST_REQ[seller] = (await one(`INSERT INTO verification_requests (seller_profile_id, status) VALUES ($1, 'submitted') RETURNING id`, [SP[seller]])).id;
  await require('../src/services/verificationService').reviewRequest(LAST_REQ[seller], U.admin.id, { status: 'approved' });
}
const revoke = (seller) => require('../src/services/verificationService').reviewRequest(LAST_REQ[seller], U.admin.id, { status: 'rejected' });
const setActive = (user, on) => q('UPDATE users SET is_active = $2 WHERE id = $1', [U[user].id, on]);




const CH = () => require('../src/services/storefrontChannelService');
const listQ = (qty, price = 10000, owner = 'sue', extra = {}) => items.createDirectListing(U[owner].id, { title: 'Channel item ' + Math.random().toString(36).slice(2, 7), price_cents: price, quantity: qty, ...extra });
const buy = (itemId, buyer, extra = {}) => call(buyer, 'POST', '/api/marketplace/orders', { item_id: itemId, policies_acknowledged: true, quantity: 1, ...extra });
const row = (id) => one('SELECT * FROM marketplace_orders WHERE id = $1', [id]);
// What the browser sends when it loads the widget inside a frame on the seller's website.
const FRAMED = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site', Referer: 'https://www.sues-gallery.example/shop' };
async function widgetPage(sellerId, headers = {}) {
  const r = await fetch(base + '/embed/storefront.html?seller=' + sellerId, { headers });
  const html = await r.text();
  const m = /<meta name="adv-website-pass" content="([^"]+)">/.exec(html);
  return { status: r.status, html, pass: m ? m[1] : null, cache: r.headers.get('cache-control') };
}
async function paidAndPickedUp(itemId, buyer, extra = {}) {
  const o = await buy(itemId, buyer, extra); const id = o.body.data.order.id;
  await pay(id, buyer);
  await orders.updateFulfillment(id, U.sue.id, 'picked_up');
  await q(`UPDATE marketplace_orders SET payout_eligible_at = now() - interval '1 day' WHERE id = $1`, [id]);
  return id;
}

describe('the rates', () => {
  test('5% website, 9% marketplace, both on the item price only (shipping and tax excluded)', () => {
    expect(CH().FEE_BPS).toEqual({ seller_website: 500, marketplace: 900 });
    const web = orders.computeBreakdown({ itemPriceCents: 20000, shippingCents: 1500, taxCents: 1650, feeBps: CH().FEE_BPS.seller_website });
    const mkt = orders.computeBreakdown({ itemPriceCents: 20000, shippingCents: 1500, taxCents: 1650, feeBps: CH().FEE_BPS.marketplace });
    expect([web.platform_fee_cents, web.seller_proceeds_cents, web.total_charge_cents]).toEqual([1000, 20500, 23150]);
    expect([mkt.platform_fee_cents, mkt.seller_proceeds_cents, mkt.total_charge_cents]).toEqual([1800, 19700, 23150]);
    // the buyer pays the same either way; no auction premium or processing percentage is ever added
    expect(orders.STOREFRONT_BUYER_PREMIUM_BPS).toBe(0);
    expect(orders.feeBpsForSeller({ platform_fee_bps: 0 })).toBe(900);
    expect(orders.feeBpsForSeller({ platform_fee_bps: 400 })).toBe(900);
  });
});

describe('the website pass is issued only when the browser frames the widget on another site', () => {
  test('framed cross-site: a pass for that seller, never cached', async () => {
    const w = await widgetPage(SP.sue, FRAMED);
    expect(w.status).toBe(200);
    expect(w.pass).toEqual(expect.any(String));
    expect(w.cache).toBe('no-store');
    const v = CH().verifyPass(w.pass);
    expect(v.ok).toBe(true);
    expect(v.payload).toMatchObject({ s: SP.sue, o: 'www.sues-gallery.example' });
  });
  test('opened directly, on an Advantage.Bid page, same-site, or with headers missing: no pass', async () => {
    expect((await widgetPage(SP.sue)).pass).toBeNull();                                                         // a browser tab, a script
    expect((await widgetPage(SP.sue, { ...FRAMED, 'Sec-Fetch-Site': 'same-site' })).pass).toBeNull();          // www.advantage.bid
    expect((await widgetPage(SP.sue, { ...FRAMED, 'Sec-Fetch-Site': 'same-origin' })).pass).toBeNull();        // the dashboard preview
    expect((await widgetPage(SP.sue, { ...FRAMED, 'Sec-Fetch-Dest': 'document' })).pass).toBeNull();           // a top-level visit
    expect((await widgetPage(SP.sue, { ...FRAMED, Referer: 'https://www.advantage.bid/city/houston' })).pass).toBeNull();
    expect((await widgetPage('not-a-seller', FRAMED)).pass).toBeNull();
    // the page itself is still served (shoppers browse either way)
    expect((await widgetPage(SP.sue)).html).toMatch(/sw-root/);
  });
  test('a forged, altered or expired pass is refused by the verifier', () => {
    const good = CH().issuePass(SP.sue, 'site.example');
    const [v, p, s] = good.split('.');
    const altered = JSON.parse(Buffer.from(p, 'base64url').toString()); altered.s = SP.gus;
    expect(CH().verifyPass(v + '.' + Buffer.from(JSON.stringify(altered)).toString('base64url') + '.' + s).reason).toBe('pass_invalid');
    expect(CH().verifyPass(good.slice(0, -2) + 'xx').reason).toBe('pass_invalid');
    expect(CH().verifyPass('v1.e30.' + s).reason).toBe('pass_invalid');
    expect(CH().verifyPass('website').reason).toBe('pass_invalid');
    expect(CH().verifyPass(CH().issuePass(SP.sue, 'x', Date.now() - CH().PASS_TTL_MS - 1000)).reason).toBe('pass_expired');
  });
});

describe('the order records its channel and rate on the server', () => {
  test('no pass (direct link, search, shared link, the marketplace): 9%', async () => {
    const it = await listQ(3);
    const o = await buy(it.id, 'bea');
    expect(await row(o.body.data.order.id)).toMatchObject({ sales_channel: 'marketplace', sales_channel_basis: 'no_pass',
      platform_fee_bps: 900, platform_fee_cents: 900, seller_proceeds_cents: 9100, fee_schedule: 'storefront-2026-11' });
  });
  test('Buy Now from the seller\'s embedded storefront: 5%, with the website recorded', async () => {
    const it = await listQ(3);
    const { pass } = await widgetPage(SP.sue, FRAMED);
    const o = await buy(it.id, 'bea', { channel_passes: [pass] });
    expect(await row(o.body.data.order.id)).toMatchObject({ sales_channel: 'seller_website', sales_channel_basis: 'website_pass',
      platform_fee_bps: 500, platform_fee_cents: 500, seller_proceeds_cents: 9500, channel_embedding_site: 'www.sues-gallery.example' });
    // the buyer's view never shows the channel or the seller's commission
    expect(o.body.data.order.sales_channel).toBeUndefined();
    expect(o.body.data.order.platform_fee_cents).toBeUndefined();
  });
  test('the request cannot choose the rate: made-up fields, a URL parameter or another seller\'s pass give 9%', async () => {
    const it = await listQ(5);
    const gusPass = (await widgetPage(SP.gus, FRAMED)).pass;   // a real pass, but for another seller
    const a = await buy(it.id, 'bea', { channel_passes: [gusPass], sales_channel: 'seller_website', platform_fee_bps: 0, ref: 'widget' });
    expect(await row(a.body.data.order.id)).toMatchObject({ sales_channel: 'marketplace', sales_channel_basis: 'pass_other_seller', platform_fee_bps: 900 });
    const it2 = await listQ(1);
    const b = await call('ben', 'POST', '/api/marketplace/orders?ref=widget&channel=seller_website', { item_id: it2.id, policies_acknowledged: true, channel_passes: ['v1.forged.sig'] });
    expect(await row(b.body.data.order.id)).toMatchObject({ sales_channel: 'marketplace', sales_channel_basis: 'pass_invalid', platform_fee_bps: 900 });
    // a pass that fails its signature is kept for review
    expect(require('../src/services/auditService').logEvent).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ eventType: 'marketplace_order.channel_pass_rejected', entityId: b.body.data.order.id }));
  });
  test('a browser holding passes for several sellers: only this seller\'s counts', async () => {
    const it = await listQ(2);
    const passes = [(await widgetPage(SP.gus, FRAMED)).pass, (await widgetPage(SP.sue, FRAMED)).pass];
    const o = await buy(it.id, 'ben', { channel_passes: passes });
    expect((await row(o.body.data.order.id)).sales_channel).toBe('seller_website');
  });
  test('a pass copied to another buyer gives that buyer\'s order the marketplace rate; the first buyer keeps it (returning shopper)', async () => {
    const { pass } = await widgetPage(SP.sue, FRAMED);
    const first = await buy((await listQ(1)).id, 'bea', { channel_passes: [pass] });
    const copied = await buy((await listQ(1)).id, 'ben', { channel_passes: [pass] });
    const again = await buy((await listQ(1)).id, 'bea', { channel_passes: [pass] });   // the same shopper, another item, same visit
    expect((await row(first.body.data.order.id)).sales_channel).toBe('seller_website');
    expect(await row(copied.body.data.order.id)).toMatchObject({ sales_channel: 'marketplace', sales_channel_basis: 'pass_other_buyer' });
    expect((await row(again.body.data.order.id)).sales_channel).toBe('seller_website');
    expect(await one('SELECT count(*)::int n FROM storefront_channel_passes WHERE pass_id = $1', [CH().verifyPass(pass).payload.n])).toEqual({ n: 1 });
  });
  test('checkout recovery: "Try again" reuses the order, so its channel and rate stay as they were', async () => {
    const it = await listQ(2);
    const { pass } = await widgetPage(SP.sue, FRAMED);
    const o1 = await buy(it.id, 'bea', { channel_passes: [pass] });
    const o2 = await buy(it.id, 'bea', {});   // retried without the pass (for example from another tab)
    expect(o2.body.data.order.id).toBe(o1.body.data.order.id);
    expect((await row(o1.body.data.order.id)).platform_fee_bps).toBe(500);
  });
  test('the channel and rate can never be changed afterwards (database rule)', async () => {
    const o = await buy((await listQ(1)).id, 'bea');
    await expect(q(`UPDATE marketplace_orders SET sales_channel = 'seller_website' WHERE id = $1`, [o.body.data.order.id])).rejects.toThrow(/fixed when the order is created/);
    await expect(q(`UPDATE marketplace_orders SET platform_fee_bps = 500, platform_fee_cents = 500 WHERE id = $1`, [o.body.data.order.id])).rejects.toThrow();
  });
});

describe('payment, payouts and refunds use the order\'s own rate', () => {
  test('the actual processing fee is recorded after payment (Advantage.Bid\'s cost, never charged to the seller)', async () => {
    const { pass } = await widgetPage(SP.sue, FRAMED);
    const id = await paidAndPickedUp((await listQ(1)).id, 'bea', { channel_passes: [pass] });
    expect(await row(id)).toMatchObject({ platform_fee_cents: 500, seller_proceeds_cents: 9500, processing_fee_cents: 320 });   // 2.9% of $100 + 30c
  });
  test('a weekly payout pays each order at its own rate; the lines show the channel', async () => {
    const S = require('../src/services/storefrontSettlementService');
    const { pass } = await widgetPage(SP.sue, FRAMED);
    const web = await paidAndPickedUp((await listQ(1, 20000)).id, 'bea', { channel_passes: [pass] });
    const mkt = await paidAndPickedUp((await listQ(1, 20000)).id, 'ben');
    await S.prepareWeek({ cutoff: new Date(Date.now() + 3 * 864e5) });
    const lines = await q(`SELECT l.marketplace_order_id AS id, l.platform_fee_cents, l.amount_cents FROM storefront_payout_lines l WHERE l.marketplace_order_id = ANY($1::uuid[])`, [[web, mkt]]);
    const by = Object.fromEntries(lines.map((l) => [l.id, l]));
    expect(by[web]).toMatchObject({ platform_fee_cents: 1000, amount_cents: 19000 });
    expect(by[mkt]).toMatchObject({ platform_fee_cents: 1800, amount_cents: 18200 });
    const pid = (await one('SELECT storefront_payout_id AS p FROM storefront_payout_lines WHERE marketplace_order_id = $1', [web])).p;
    const view = await S.getForAdmin(pid);
    expect(view.lines.find((l) => l.order_id === web)).toMatchObject({ sales_channel: 'seller_website', platform_fee_bps: 500 });
    expect(view.lines.find((l) => l.order_id === mkt)).toMatchObject({ sales_channel: 'marketplace', platform_fee_bps: 900 });
  });
  test('a refund after payout recovers what the seller received at the order\'s rate (5%: $95 of a $100 sale)', async () => {
    const S = require('../src/services/storefrontSettlementService');
    await q(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS stripe_transfer_id text, ADD COLUMN IF NOT EXISTS payout_status text, ADD COLUMN IF NOT EXISTS transfer_failure_message text`);
    const { pass } = await widgetPage(SP.sue, FRAMED);
    const id = await paidAndPickedUp((await listQ(1)).id, 'bea', { channel_passes: [pass] });
    await S.prepareWeek({ cutoff: new Date(Date.now() + 4 * 864e5) });
    const p = await one(`SELECT p.* FROM storefront_payouts p JOIN storefront_payout_lines l ON l.storefront_payout_id = p.id WHERE l.marketplace_order_id = $1`, [id]);
    await S.payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents });
    await orders.refundOrder(id, { adminId: U.admin.id, reason: 'Returned' });
    expect(await one('SELECT amount_cents FROM storefront_payout_recoveries WHERE marketplace_order_id = $1', [id])).toEqual({ amount_cents: 9500 });
  });
});

describe('seller isolation', () => {
  test('a seller sees the channel on their own orders only; the admin list shows how it was decided and the processing cost', async () => {
    const { pass } = await widgetPage(SP.sue, FRAMED);
    const o = await buy((await listQ(1)).id, 'bea', { channel_passes: [pass] });
    await pay(o.body.data.order.id, 'bea');   // sellers see paid orders
    const mine = await orders.listForSeller(U.sue.id);
    expect(mine.find((x) => x.id === o.body.data.order.id)).toMatchObject({ sales_channel: 'seller_website', platform_fee_bps: 500 });
    const other = await orders.listForSeller(U.gus.id);
    expect(other.find((x) => x.id === o.body.data.order.id)).toBeUndefined();
    const adm = (await orders.listForAdmin({})).find((x) => x.id === o.body.data.order.id);
    expect(adm).toMatchObject({ sales_channel: 'seller_website', sales_channel_basis: 'website_pass', fee_schedule: 'storefront-2026-11' });
  });
});

describe('seller-caused refunds: recorded and reviewable; the card cost is recovered only when the owner turns it on', () => {
  const S = () => require('../src/services/storefrontSettlementService');
  afterEach(() => { delete process.env.STOREFRONT_SELLER_FAULT_RECOVERY_ENABLED; });
  test('switch off (as shipped): the reason and who caused it are recorded; the eligible card cost is shown, nothing is deducted', async () => {
    const id = await paidAndPickedUp((await listQ(1)).id, 'bea');
    await orders.refundOrder(id, { adminId: U.admin.id, reason: 'Item was not available', fault: 'seller', faultNote: 'Seller sold it elsewhere' });
    expect(await row(id)).toMatchObject({ refund_fault: 'seller', refund_fault_note: 'Seller sold it elsewhere', refund_fault_set_by: U.admin.id, processing_fee_cents: 320 });
    expect(await one(`SELECT count(*)::int n FROM storefront_payout_recoveries WHERE marketplace_order_id = $1`, [id])).toEqual({ n: 0 });
    const adm = (await orders.listForAdmin({})).find((x) => x.id === id);
    expect(adm).toMatchObject({ refund_fault: 'seller', seller_fault_eligible_cents: 320 });
    expect(require('../src/services/auditService').logEvent).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ eventType: 'marketplace_order.refund_fault_recorded', entityId: id }));
  });
  test('switch on: exactly the recorded card cost, once, deducted from the next payout; never for a buyer- or platform-caused refund', async () => {
    process.env.STOREFRONT_SELLER_FAULT_RECOVERY_ENABLED = 'true';
    const seller = await paidAndPickedUp((await listQ(1)).id, 'bea');
    const buyer = await paidAndPickedUp((await listQ(1)).id, 'ben');
    await orders.refundOrder(seller, { adminId: U.admin.id, reason: 'Materially misdescribed', fault: 'seller' });
    await orders.refundOrder(seller, { adminId: U.admin.id, reason: 'Repeat click', fault: 'seller' });   // idempotent
    await orders.refundOrder(buyer, { adminId: U.admin.id, reason: 'Buyer changed their mind', fault: 'buyer' });
    expect(await q(`SELECT kind, amount_cents FROM storefront_payout_recoveries WHERE marketplace_order_id = $1`, [seller])).toEqual([{ kind: 'processing_fee', amount_cents: 320 }]);
    expect(await one(`SELECT count(*)::int n FROM storefront_payout_recoveries WHERE marketplace_order_id = $1`, [buyer])).toEqual({ n: 0 });
    // applied by the next prepared payout like any other recovery
    const next = await paidAndPickedUp((await listQ(1, 20000)).id, 'bea');
    await S().prepareWeek({ cutoff: new Date(Date.now() + 5 * 864e5) });
    const p = await one(`SELECT p.* FROM storefront_payouts p JOIN storefront_payout_lines l ON l.storefront_payout_id = p.id WHERE l.marketplace_order_id = $1`, [next]);
    expect(Number(p.recovery_cents)).toBeGreaterThanOrEqual(320);
  });
  test('who caused it must be one of the listed answers', async () => {
    const id = await paidAndPickedUp((await listQ(1)).id, 'bea');
    await expect(orders.refundOrder(id, { adminId: U.admin.id, reason: 'Something happened', fault: 'everyone' })).rejects.toMatchObject({ code: 'FAULT_INVALID' });
    expect((await row(id)).refund_status).not.toBe('refunded');
  });
});
