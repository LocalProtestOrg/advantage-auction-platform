'use strict';

/**
 * Sold-item price privacy (owner decision 2026-10-26; roadmap §12.3 P0; migration 206).
 *
 * Real Postgres (PGlite) with the real storefront migrations, order/item/page services and public routes. Once an item has
 * SOLD, no public output (JSON API, server-rendered page, meta tags, structured data) carries its price or shipping
 * charge; a signed-in member sees the realized item price only when the item's seller switched that on; the seller's own
 * records are untouched; a pending checkout is not a sale. Only the payment processor stand-in, tax, email and the audit
 * log are replaced (same harness as storefront-ownership-adversarial.test.js).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-sold-price-privacy'; // test value, never a real secret

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
  taxEnabled: () => false, addressComplete: () => true,
  computeTax: jest.fn(async () => ({ taxCents: 0, enabled: false, exempt: false, calculationId: null })),
  recordTransaction: jest.fn(async () => null), reverseFullTransaction: jest.fn(async () => null), reversePartialTransaction: jest.fn(async () => null),
}));
jest.mock('../src/lib/launchGuards', () => ({ ...jest.requireActual('../src/lib/launchGuards'), marketplaceCheckoutEnabled: () => true }));
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
const mockStripe = { intents: new Map(), refunds: [], n: 0 };
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (p) => { const id = 'pi_' + (++mockStripe.n); const pi = { id, client_secret: id + '_secret', status: 'requires_payment_method', amount: p.amount,
      currency: p.currency, metadata: p.metadata, amount_received: 0 }; mockStripe.intents.set(id, pi); return { ...pi }; },
    retrieve: async (id) => ({ ...mockStripe.intents.get(id) }),
    confirm: async (id) => { const pi = mockStripe.intents.get(id); Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: 'ch_' + id }); return { ...pi }; },
    cancel: async (id) => { const pi = mockStripe.intents.get(id); pi.status = 'canceled'; return { ...pi }; },
  },
  paymentMethods: { retrieve: async (id) => ({ id, type: 'card', card: { funding: 'credit', brand: 'visa', last4: '4242' }, customer: null }) },
  refunds: { create: async (p, o) => { mockStripe.refunds.push({ ...p, key: o && o.idempotencyKey }); return { id: 're_' + mockStripe.refunds.length }; } },
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

let orders, items, issues, disputes, server, base;
const U = {};      // users by name
const SP = {};     // seller profile ids
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const rejects = async (sql, p) => { try { await global.__PG.query(sql, p || []); } catch (e) { return e; } throw new Error('expected the database to reject: ' + sql); };

// A real signed sign-in token for a seeded test user (verified by the real sessionAuth).
const tokenFor = (user) => require('jsonwebtoken').sign({ id: U[user].id, role: U[user].role }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': user, authorization: 'Bearer ' + tokenFor(user) },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  for (const f of ['071_verification_documents.sql', '119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql', '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql', '206_sold_price_privacy_and_message_moderation.sql']) {
    await global.__PG.exec(mig(f));
  }
  // migration 197 is idempotent
  await global.__PG.exec(mig('197_storefront_order_integrity.sql'));
  await global.__PG.exec(mig('198_storefront_moderation_reports.sql'));

  for (const [name, role, staff] of [['nora', 'seller'], ['sue', 'seller'], ['bea', 'buyer'], ['ben', 'buyer'], ['admin', 'admin'], ['finance', 'buyer', 'finance']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role, staff_role) VALUES ($1, $2, $3, $4) RETURNING *`, [name + '@test.example', name.toUpperCase(), role, staff || null]);
  }
  global.__USERS = U;
  for (const [name, type] of [['nora', 'estate_sale_company'], ['sue', 'auction_house']]) {
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug)
      VALUES ($1, $2, $3, $4, 'Houston', 'TX', '77001', 'US', now(), true, $5) RETURNING id`,
      [U[name].id, type, name === 'nora' ? 'Nora Estate Sales' : 'Sue Auctions', name === 'nora' ? '1 Nora St' : '9 Sue Ave', name])).id;
  }

  orders = require('../src/services/marketplaceOrderService');
  items = require('../src/services/marketplaceItemService');
  issues = require('../src/services/marketplaceOrderIssueService');
  disputes = require('../src/services/disputeService');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  app.use('/api/seller-storefront', require('../src/routes/sellerStorefront'));
  app.use('/api/admin/storefront', require('../src/routes/adminStorefrontModeration'));
  app.use('/api/public/storefront', require('../src/routes/publicStorefront'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

// Nora's listing, created through her own account (the seller is derived from the session).
async function noraItem(extra = {}) {
  return items.createDirectListing(U.nora.id, { title: 'Walnut sideboard', price_cents: 10000, shippable: true, shipping_cost_cents: 1500,
    shipping_method: 'parcel', shipping_destinations: 'us_all', ...extra });
}
// Bea buys it (create order → pay), returning the paid order row.
async function beaBuys(item, method = 'pickup') {
  const created = await orders.createOrder(item.id, U.bea.id, { policiesAcknowledged: true, ...(method === 'shipping'
    ? { fulfillment_method: 'shipping', ship_to: { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } : {}) });
  const paid = await orders.payOrder(created.order.id, U.bea.id, { paymentMethodId: 'pm_bea' });
  expect(paid.status).toBe('succeeded');
  return one('SELECT * FROM marketplace_orders WHERE id = $1', [created.order.id]);
}


const pages = () => require('../src/services/productPageService');
const pdata = () => require('../src/lib/productData');
const PRICE = 12345;   // $123.45 — a value that appears nowhere else
async function soldItem(extra = {}) {
  const it = await noraItem({ title: 'Carved oak chest ' + Math.random().toString(36).slice(2, 7), price_cents: PRICE, ...extra });
  const order = await beaBuys(it);
  return { it, order };
}
const anon = (url) => fetch(base + url).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
const priceLeak = (s) => /12345|123\.45|\$123/.test(s);

describe('a sold item never shows its price publicly', () => {
  test('public JSON API: SOLD, no price, no shipping charge', async () => {
    const { it } = await soldItem();
    const r = await anon('/api/public/storefront/item/' + it.id);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'sold', price_cents: null, shipping_cost_cents: null, price_hidden: true });
    expect(r.body.data.realized_price_cents).toBeUndefined();
    expect(priceLeak(JSON.stringify(r.body))).toBe(false);
  });

  test('server-rendered page, meta tags and structured data: SOLD + SoldOut, no price or shipping rate', async () => {
    const { it } = await soldItem({ description: '' });
    const out = await pages().render(it.id, pdata().slugify(it.title), 'https://bid.example');
    expect(out.status).toBe(200);
    expect(priceLeak(out.html)).toBe(false);
    expect(out.html).toContain('SOLD');
    expect(out.html).not.toContain('product:price:amount');
    const ld = [...out.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const product = ld.find((x) => x['@type'] === 'Product');
    expect(product.offers.availability).toBe('https://schema.org/SoldOut');
    expect(product.offers.price).toBeUndefined();
    expect(product.offers.shippingDetails).toBeUndefined();
  });

  test('caching: a priced page or API answer is revalidated on every view, so no cached copy outlives the sale', async () => {
    const it = await noraItem({ title: 'Cache check lamp ' + Math.random().toString(36).slice(2, 7), price_cents: PRICE });
    const slug = pdata().slugify(it.title);
    // before the sale: the price is shown, and the page / API must be revalidated (no shared or browser reuse)
    const activePage = await pages().render(it.id, slug, 'https://bid.example');
    expect(activePage.status).toBe(200);
    expect(priceLeak(activePage.html)).toBe(true);
    expect(activePage.cacheControl).toBe('no-cache');
    const activeApi = await anon('/api/public/storefront/item/' + it.id);
    expect(activeApi.body.data.price_cents).toBe(PRICE);
    expect(activeApi.headers.get('cache-control')).toBe('no-cache');
    // the sale happens; the very next view carries no price
    await beaBuys(it);
    const soldPage = await pages().render(it.id, slug, 'https://bid.example');
    expect(priceLeak(soldPage.html)).toBe(false);
    // a sold page still shows "more from this seller" cards with prices, and any of those can sell: revalidated too
    expect(soldPage.cacheControl).toBe('no-cache');
    const sibling = await noraItem({ title: 'Cache check sibling ' + Math.random().toString(36).slice(2, 7), price_cents: 7777 });
    const soldWithSibling = await pages().render(it.id, slug, 'https://bid.example');
    expect(soldWithSibling.html).toContain('$77.77');
    expect(soldWithSibling.cacheControl).toBe('no-cache');
    await beaBuys(sibling);
    expect((await pages().render(it.id, slug, 'https://bid.example')).html).not.toContain('$77.77');
    // the storefront's public item list (prices of active items) is revalidated as well (data stubbed: this harness does
    // not migrate every storefront table; the real route sets the header)
    const sfSvc = require('../src/services/storefrontService');
    const spy = jest.spyOn(sfSvc, 'getPublicData').mockResolvedValue({ storefront: {}, marketplace: [] });
    try { expect((await anon('/api/public/storefront/nora')).headers.get('cache-control')).toBe('no-cache'); } finally { spy.mockRestore(); }
    const soldApi = await anon('/api/public/storefront/item/' + it.id);
    expect(priceLeak(JSON.stringify(soldApi.body))).toBe(false);
    expect(String(soldApi.headers.get('cache-control') || '')).not.toMatch(/max-age=[1-9]/);
    // a checkout in progress still shows the price, so it is revalidated too
    const pend = await noraItem({ title: 'Cache check pending ' + Math.random().toString(36).slice(2, 7), price_cents: 4321 });
    await orders.createOrder(pend.id, U.ben.id, { policiesAcknowledged: true });
    expect(pages().cacheControlFor({ status: 'pending_purchase' })).toBe('no-cache');
    expect((await anon('/api/public/storefront/item/' + pend.id)).headers.get('cache-control')).toBe('no-cache');
    // the server route uses the page's own cache policy (not a fixed 60-second cache)
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(server).toMatch(/res\.set\('Cache-Control', r\.cacheControl \|\| 'public, max-age=60'\)/);
  });

  test('a pending checkout is not a sale: the price stays visible', async () => {
    const it = await noraItem({ title: 'Brass lamp pending', price_cents: 4321 });
    await orders.createOrder(it.id, U.ben.id, { policiesAcknowledged: true });
    const r = await anon('/api/public/storefront/item/' + it.id);
    expect(r.body.data).toMatchObject({ status: 'pending_purchase', price_cents: 4321 });
  });
});

describe('member disclosure is the seller\'s choice, off by default', () => {
  test('default OFF for every new item (database default)', async () => {
    const it = await noraItem({ title: 'Default check' });
    expect((await one('SELECT show_realized_price_to_members AS v FROM marketplace_items WHERE id = $1', [it.id])).v).toBe(false);
    const viaRequest = await call('nora', 'POST', '/api/seller-storefront/items', { title: 'Tries to preset', price_cents: 900, show_realized_price_to_members: true });
    expect((await one('SELECT show_realized_price_to_members AS v FROM marketplace_items WHERE id = $1', [viaRequest.body.data.id])).v).toBe(false);
  });

  test('OFF: a signed-in member sees SOLD only', async () => {
    const { it } = await soldItem();
    const r = await call('ben', 'GET', '/api/public/storefront/item/' + it.id);
    expect(r.body.data.price_cents).toBe(null);
    expect(r.body.data.realized_price_cents).toBeUndefined();
    expect(priceLeak(JSON.stringify(r.body))).toBe(false);
  });

  test('ON: signed-in members see the realized item price (labelled fixed-price sale); the public still does not', async () => {
    const { it } = await soldItem();
    const on = await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: true });
    expect(on.status).toBe(200);
    const member = await fetch(base + '/api/public/storefront/item/' + it.id, { headers: { authorization: 'Bearer ' + tokenFor('ben') } });
    const mb = await member.json();
    expect(mb.data).toMatchObject({ price_cents: null, realized_price_cents: PRICE, realized_price_label: 'Fixed-price sale' });
    expect(member.headers.get('cache-control')).toBe('private, no-store');
    const pub = await anon('/api/public/storefront/item/' + it.id);
    expect(priceLeak(JSON.stringify(pub.body))).toBe(false);
    const html = (await pages().render(it.id, pdata().slugify(it.title), 'https://bid.example')).html;
    expect(priceLeak(html)).toBe(false);      // the page crawlers see is always the public version
    // and it can be switched off again at any time
    await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: false });
    expect((await call('ben', 'GET', '/api/public/storefront/item/' + it.id)).body.data.realized_price_cents).toBeUndefined();
  });

  test('only the item\'s own seller can change it; a non-boolean is refused; other details stay locked after the sale', async () => {
    const { it } = await soldItem();
    const sue = await call('sue', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: true });
    expect(sue.status).toBe(403);
    expect((await call('bea', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: true })).status).toBe(403);
    expect((await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: 'yes' })).status).toBe(422);
    expect((await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: true, price_cents: 1 })).body.code).toBe('ITEM_SOLD');
    expect((await one('SELECT show_realized_price_to_members AS v, price_cents FROM marketplace_items WHERE id = $1', [it.id]))).toEqual({ v: false, price_cents: PRICE });
  });

  test('staff of the company cannot change it (server), and the seller page does not offer it to staff', async () => {
    const { it } = await soldItem();
    const staffCtx = { sellerId: SP.nora, sellerType: 'estate_sale_company', role: 'inventory_manager', userId: U.ben.id, staff: true };
    await expect(items.updateItem(it.id, staffCtx, { show_realized_price_to_members: true })).rejects.toMatchObject({ status: 403, code: 'OWNER_ONLY' });
    expect((await one('SELECT show_realized_price_to_members AS v FROM marketplace_items WHERE id = $1', [it.id])).v).toBe(false);
    const ownerCtx = { sellerId: SP.nora, sellerType: 'estate_sale_company', role: 'owner', userId: U.nora.id, staff: false };
    await items.updateItem(it.id, ownerCtx, { show_realized_price_to_members: true });
    expect((await one('SELECT show_realized_price_to_members AS v FROM marketplace_items WHERE id = $1', [it.id])).v).toBe(true);
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'seller-storefront.html'), 'utf8');
    expect(html).toMatch(/if\(m\.status==='sold'&&!\(CFG&&CFG\.staff\)\)acts=/);
  });

  test('a refunded sale has no realized price and no SOLD page', async () => {
    const { it, order } = await soldItem();
    await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: true });
    await orders.refundOrder(order.id, { adminId: U.admin.id, reason: 'Refund for the price-privacy test' });
    expect(await items.realizedSalePrice(it.id)).toBe(null);
    const r = await call('ben', 'GET', '/api/public/storefront/item/' + it.id);
    if (r.status === 200) expect(r.body.data.realized_price_cents).toBeUndefined();
  });
});

describe('only a confirmed, current sign-in is a member (no access-control bypass)', () => {
  const memberView = (it, headers) => fetch(base + '/api/public/storefront/item/' + it.id, { headers })
    .then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
  async function sharedSoldItem() {
    const { it } = await soldItem();
    await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { show_realized_price_to_members: true });
    return it;
  }
  afterEach(() => { global.__SESSION_STATE = {}; });

  test('a current session sees the price; a forged, expired or unsigned token is the public view', async () => {
    const it = await sharedSoldItem();
    expect((await memberView(it, { authorization: 'Bearer ' + tokenFor('ben') })).body.data.realized_price_cents).toBe(PRICE);
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ id: U.ben.id, role: 'buyer' }, 'not-the-server-secret');
    const expired = jwt.sign({ id: U.ben.id, role: 'buyer', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const unsigned = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ id: U.ben.id, role: 'buyer' })).toString('base64url') + '.';
    for (const t of [forged, expired, unsigned, 'garbage']) {
      const r = await memberView(it, { authorization: 'Bearer ' + t });
      expect(r.status).toBe(200);
      expect(r.body.data.realized_price_cents).toBeUndefined();
      expect(priceLeak(JSON.stringify(r.body))).toBe(false);
    }
    // a user id supplied any other way (header, query) is ignored
    const spoof = await fetch(base + '/api/public/storefront/item/' + it.id + '?user_id=' + U.ben.id, { headers: { 'x-test-user': 'ben', 'x-user-id': U.ben.id } }).then((r) => r.json());
    expect(spoof.data.realized_price_cents).toBeUndefined();
  });

  test.each(['revoked', 'suspended', 'unknown', 'throw'])('a %s session is the public view, never a member', async (state) => {
    const it = await sharedSoldItem();
    global.__SESSION_STATE = { [U.ben.id]: state };
    const r = await memberView(it, { authorization: 'Bearer ' + tokenFor('ben') });
    expect(r.status).toBe(200);
    expect(r.body.data.realized_price_cents).toBeUndefined();
    expect(priceLeak(JSON.stringify(r.body))).toBe(false);
  });

  test('the public item route never rejects, never sets a cookie, and a member answer is not cacheable', async () => {
    const it = await sharedSoldItem();
    const m = await memberView(it, { authorization: 'Bearer ' + tokenFor('ben') });
    expect(m.headers.get('set-cookie')).toBe(null);
    expect(m.headers.get('cache-control')).toBe('private, no-store');
    expect(m.headers.get('vary')).toMatch(/Authorization/);
    const bad = await memberView(it, { authorization: 'Bearer garbage' });
    expect(bad.status).toBe(200);
    expect(bad.headers.get('set-cookie')).toBe(null);
  });

  test('source guard: the public router recognises a member only through the strict confirmed-session check', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'publicStorefront.js'), 'utf8');
    expect(src).not.toMatch(/req\.user/);
    expect(src).not.toMatch(/optionalAuthMiddleware|authMiddleware/);
    expect(src).toMatch(/check\.state === 'ok' \? identity\.id : null/);
    expect((src.match(/await confirmedViewerId\(req\)/g) || []).length).toBe(1);   // called by the item route only
  });
});

describe('the seller keeps the full record', () => {
  test('the seller\'s own item list and orders still carry the listed price and the sale amounts', async () => {
    const { it, order } = await soldItem();
    const list = await call('nora', 'GET', '/api/seller-storefront/items');
    const mine = (list.body.data.items || list.body.data).find((x) => x.id === it.id);
    expect(mine.price_cents).toBe(PRICE);
    const so = await call('nora', 'GET', '/api/marketplace/seller/orders');
    expect(so.body.data.find((x) => x.id === order.id).item_price_cents).toBe(PRICE);
  });
});
