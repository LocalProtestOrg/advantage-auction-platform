'use strict';

/**
 * Storefront checkout seller eligibility (roadmap 13.A): only an active, verified Professional Seller can receive a
 * storefront order. Real Postgres (PGlite) with the real migrations (incl. 071 verification), order service and routes;
 * the payment processor is an in-memory stand-in (same harness as storefront-sold-price-privacy.test.js).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-checkout-eligibility'; // test value, never a real secret

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
  for (const f of ['071_verification_documents.sql', '119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql',
    '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql',
    '206_sold_price_privacy_and_message_moderation.sql']) {
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

describe('an unverified Professional Seller cannot receive a storefront order', () => {
  test('quote and order are refused on the server; the item is not held and no order exists', async () => {
    const it = await listing('nora');
    const quote = await call('bea', 'POST', '/api/marketplace/orders/quote', { item_id: it.id });
    expect(quote.status).toBe(409); expect(quote.body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
    const r = await order(it.id);
    expect(r.status).toBe(409); expect(r.body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
    expect(await itemRow(it.id)).toMatchObject({ status: 'active', pending_order_id: null });
    expect(await orderCount(it.id)).toBe(0);
    // the item can still be listed and edited while verification is pending (setup before approval is allowed)
    await items.updateItem(it.id, U.nora.id, { title: 'Still editable while pending' });
  });

  test('cross-seller: another company\'s approval never unlocks this seller; a seller id in the request is ignored', async () => {
    const noraItem = await listing('nora'); const sueItem = await listing('sue');
    const forged = await call('bea', 'POST', '/api/marketplace/orders', { item_id: noraItem.id, policies_acknowledged: true, seller_id: SP.sue, seller_profile_id: SP.sue });
    expect(forged.body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
    expect(await orderCount(noraItem.id)).toBe(0);
    const ok = await order(sueItem.id);   // the verified seller sells normally
    expect(ok.status).toBe(200);
    expect((await one('SELECT seller_id FROM marketplace_orders WHERE marketplace_item_id = $1', [sueItem.id])).seller_id).toBe(SP.sue);
  });

  test('a grandfathered Professional (verification never required) can sell', async () => {
    const it = await listing('gus');
    expect((await order(it.id)).status).toBe(200);
  });
});

describe('verification-state changes take effect at once', () => {
  test('approval opens checkout; revocation closes it again, including for an order already started (no charge)', async () => {
    const it = await listing('nora');
    expect((await order(it.id)).body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
    await approve('nora');
    const started = await order(it.id);
    expect(started.status).toBe(200);
    const orderId = started.body.data.order.id;
    // verification withdrawn after the buyer started checkout: the payment is refused before any charge
    await revoke('nora');
    const paid = await pay(orderId);
    expect(paid.status).toBe(409); expect(paid.body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
    const o = await one('SELECT payment_status, stripe_payment_intent_id FROM marketplace_orders WHERE id = $1', [orderId]);
    expect(o.payment_status).toBe('pending');
    expect(mockStripe.intents.get(o.stripe_payment_intent_id).status).not.toBe('succeeded');   // never confirmed
    // a new checkout is refused too
    const it2 = await listing('nora');
    expect((await order(it2.id)).body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
  });

  test('re-approval restores selling', async () => {
    await approve('nora');
    const it = await listing('nora');
    const r = await order(it.id);
    expect(r.status).toBe(200);
    expect((await pay(r.body.data.order.id)).body.data.status).toBe('succeeded');
  });
});

describe('a suspended or no-longer-Professional seller cannot sell', () => {
  test('suspended owner: new orders refused; an order already started is not charged; reactivation restores', async () => {
    const it = await listing('sue'); const started = await order(it.id);
    expect(started.status).toBe(200);
    await setActive('sue', false);
    const it2 = await listing('sue');
    const refused = await order(it2.id);
    expect(refused.status).toBe(409); expect(refused.body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
    expect(await orderCount(it2.id)).toBe(0);
    const paid = await pay(started.body.data.order.id);
    expect(paid.status).toBe(409); expect(paid.body.code).toBe('SELLER_NOT_ACCEPTING_ORDERS');
    expect((await one('SELECT payment_status FROM marketplace_orders WHERE id = $1', [started.body.data.order.id])).payment_status).toBe('pending');
    await setActive('sue', true);
    expect((await order(it2.id)).status).toBe(200);
  });

  test('a seller changed to an Individual type cannot receive a storefront order (even with a started order)', async () => {
    const it = await listing('gus'); const started = await order(it.id);
    expect(started.status).toBe(200);
    await q(`UPDATE seller_profiles SET seller_type = 'private' WHERE id = $1`, [SP.gus]);
    expect((await pay(started.body.data.order.id)).body.code).toBe('NOT_PROFESSIONAL');
    await q(`UPDATE seller_profiles SET seller_type = 'professional_liquidator' WHERE id = $1`, [SP.gus]);
  });

  test('a suspended BUYER account is not what this gate checks (the seller is): an active buyer is unaffected by another seller\'s suspension', async () => {
    await setActive('sue', false);
    const it = await listing('gus');
    expect((await order(it.id, 'ben')).status).toBe(200);
    await setActive('sue', true);
  });
});

describe('the admin verification page can actually approve and reject', () => {
  test('its buttons send the exact statuses the server accepts, and a refusal is shown, not hidden', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'admin', 'verification.html'), 'utf8');
    const acts = [...html.matchAll(/data-act="([a-z_]+)" data-req=/g)].map((m) => m[1]).sort();
    expect(acts).toEqual(['approved', 'more_info', 'rejected']);
    const svc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'verificationService.js'), 'utf8');
    const allowed = svc.match(/\['approved', 'rejected', 'more_info', 'cancelled'\]\.includes\(status\)/);
    expect(allowed).toBeTruthy();
    expect(html).toMatch(/if\(!res\.ok\)\{[^}]*Not saved/);
  });
});

describe('enforced on the server for every path (source guard)', () => {
  test('quote, createOrder (before and under the item lock) and payOrder all call the eligibility check', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    const load = src.slice(src.indexOf('async function loadItemForPurchase'), src.indexOf('function purchaseSnapshot'));
    expect(load).toMatch(/await assertSellerCanSell\(row\.seller_id, runner\)/);
    expect((src.match(/loadItemForPurchase\(itemId/g) || []).length).toBeGreaterThanOrEqual(3);   // quote + createOrder pre + locked
    const payFn = src.slice(src.indexOf('async function payOrder'), src.indexOf('const stripe = getStripe();', src.indexOf('async function payOrder')));
    expect(payFn).toMatch(/await assertSellerCanSell\(o\.seller_id\)/);
    const elig = fs.readFileSync(path.join(ROOT, 'src', 'services', 'sellerSaleEligibility.js'), 'utf8');
    expect(elig).toMatch(/require\('\.\/verificationService'\)\.publicationGate\(sp\.id\)/);
  });
});
