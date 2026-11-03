'use strict';

/**
 * Multi-quantity fixed-price purchasing (migration 212; owner priority 2026-11-02, roadmap §14). Real Postgres (PGlite) with
 * the real migrations, order service and routes; the payment processor is an in-memory stand-in (same harness as
 * storefront-checkout-seller-eligibility.test.js). Statements run one at a time here; buyers racing for the last units
 * at the same moment are covered over HTTP on the full-stack environment (tests/browser/storefront-checkout-concurrency).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-multi-quantity'; // test value, never a real secret

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
  await global.__PG.exec(require('./helpers/saleReadySchema').SALE_READY_SQL);   // sellers start sale-ready (agreement + payouts)
  for (const f of ['071_verification_documents.sql', '119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql',
    '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql',
    '206_sold_price_privacy_and_message_moderation.sql', '207_storefront_bulk_import.sql', '209_marketplace_inventory_importer.sql', '211_retail_gallery_studio_seller_type.sql', '212_marketplace_multi_quantity.sql', '214_storefront_shipping_quantity_and_tax_responsibility.sql', '215_storefront_channel_commission.sql', '216_storefront_agreement_terms_and_refund_fault.sql']) {
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


const listQ = (qty, price = 2000, owner = 'sue') => items.createDirectListing(U[owner].id, { title: 'Stock item ' + Math.random().toString(36).slice(2, 7), price_cents: price, quantity: qty });
const buy = (itemId, buyer, quantity, extra = {}) => call(buyer, 'POST', '/api/marketplace/orders', { item_id: itemId, policies_acknowledged: true, quantity, ...extra });
const stock = (id) => one('SELECT status, quantity, quantity_sold, pending_order_id FROM marketplace_items WHERE id = $1', [id]);
const events = (id) => q('SELECT reason, delta, sold_delta, available_after, order_id FROM marketplace_stock_events WHERE item_id = $1 ORDER BY created_at, reason', [id]);
const orderRow = (id) => one('SELECT * FROM marketplace_orders WHERE id = $1', [id]);

describe('reserving units', () => {
  test('an order reserves its units at once; the totals are unit price x quantity; the commission (9% marketplace) is on the goods only', async () => {
    const it = await listQ(5, 2000);
    const quote = await call('bea', 'POST', '/api/marketplace/orders/quote', { item_id: it.id, quantity: 3 });
    expect(quote.status).toBe(200);
    expect(quote.body.data.item).toMatchObject({ unit_price_cents: 2000, quantity: 3, available: 5 });
    expect(quote.body.data.breakdown).toMatchObject({ item_price_cents: 6000, total_charge_cents: 6000 });
    const r = await buy(it.id, 'bea', 3);
    expect(r.status).toBe(200);
    const o = await orderRow(r.body.data.order.id);
    expect(o).toMatchObject({ quantity: 3, unit_price_cents: 2000, item_price_cents: 6000, platform_fee_cents: 540, seller_proceeds_cents: 5460, payment_status: 'pending' });
    expect(o.hold_expires_at).toBeTruthy();
    expect(o.item_snapshot.quantity).toBe(3);
    expect(await stock(it.id)).toMatchObject({ status: 'active', quantity: 2, quantity_sold: 0 });
    expect(await events(it.id)).toEqual([expect.objectContaining({ reason: 'reserved', delta: -3, available_after: 2 })]);
    expect(r.body.data.order).toMatchObject({ quantity: 3, unit_price_cents: 2000 });
  });

  test('more than is available is refused with the number left; nothing is reserved', async () => {
    const it = await listQ(4);
    expect((await buy(it.id, 'bea', 3)).status).toBe(200);
    const r = await buy(it.id, 'ben', 2);
    expect([r.status, r.body.code]).toEqual([409, 'NOT_ENOUGH_AVAILABLE']);
    expect(r.body.message).toBe('Only 1 available. Please choose a quantity of 1 or fewer.');
    expect(await stock(it.id)).toMatchObject({ quantity: 1 });
    expect((await one('SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1', [it.id])).n).toBe(1);
  });

  test('a quantity of 0, a negative, a fraction or text is refused', async () => {
    const it = await listQ(3);
    for (const bad of [0, -1, 1.5, 'two', 1001]) {
      const r = await buy(it.id, 'bea', bad);
      expect([bad, r.status, r.body.code]).toEqual([bad, 422, 'QUANTITY_INVALID']);
    }
    expect(await stock(it.id)).toMatchObject({ quantity: 3 });
  });

  test('several buyers each hold units of one item; the last units show "sale in progress", not sold', async () => {
    const it = await listQ(3);
    expect((await buy(it.id, 'bea', 2)).status).toBe(200);
    const last = await buy(it.id, 'ben', 1);
    expect(last.status).toBe(200);
    expect(await stock(it.id)).toMatchObject({ status: 'pending_purchase', quantity: 0, pending_order_id: last.body.data.order.id });
    const third = await buy(it.id, 'admin', 1);
    expect(third.body.code).toBe('NOT_AVAILABLE');
  });

  test('the same buyer trying again with the same choices reuses the checkout; a different quantity replaces it (units returned first)', async () => {
    const it = await listQ(5);
    const a = await buy(it.id, 'bea', 2);
    const again = await buy(it.id, 'bea', 2);
    expect(again.body.data.reused).toBe(true);
    expect(again.body.data.order.id).toBe(a.body.data.order.id);
    expect(await stock(it.id)).toMatchObject({ quantity: 3 });
    const changed = await buy(it.id, 'bea', 4);
    expect(changed.status).toBe(200);
    expect(changed.body.data.order.id).not.toBe(a.body.data.order.id);
    expect((await orderRow(a.body.data.order.id))).toMatchObject({ payment_status: 'failed' });
    expect((await orderRow(a.body.data.order.id)).stock_released_at).toBeTruthy();
    expect(await stock(it.id)).toMatchObject({ quantity: 1 });
  });
});

describe('paying', () => {
  test('a paid order turns its held units into sold units; selling the last units marks the item sold', async () => {
    const it = await listQ(3);
    const a = await buy(it.id, 'bea', 2); const b = await buy(it.id, 'ben', 1);
    expect((await pay(a.body.data.order.id, 'bea')).body.data.status).toBe('succeeded');
    expect(await stock(it.id)).toMatchObject({ status: 'pending_purchase', quantity: 0, quantity_sold: 2 });   // ben still holds the last one
    expect((await pay(b.body.data.order.id, 'ben')).body.data.status).toBe('succeeded');
    expect(await stock(it.id)).toMatchObject({ status: 'sold', quantity: 0, quantity_sold: 3, pending_order_id: null });
    expect((await events(it.id)).filter((e) => e.reason === 'sold').map((e) => e.sold_delta).sort()).toEqual([1, 2]);
  });

  test('a repeated payment notice (duplicate webhook) never counts a sale twice', async () => {
    const it = await listQ(4);
    const a = await buy(it.id, 'bea', 2);
    await pay(a.body.data.order.id, 'bea');
    const o = await orderRow(a.body.data.order.id);
    const intent = { ...mockStripe.intents.get(o.stripe_payment_intent_id) };
    await orders.markOrderPaid(intent);
    await orders.markOrderPaid(intent);
    expect(await stock(it.id)).toMatchObject({ quantity: 2, quantity_sold: 2, status: 'active' });
    expect((await events(it.id)).filter((e) => e.reason === 'sold')).toHaveLength(1);
  });

  test('an expired hold that is paid late is refunded automatically; its units were already back on sale', async () => {
    const it = await listQ(2);
    const a = await buy(it.id, 'bea', 2);
    await q(`UPDATE marketplace_orders SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [a.body.data.order.id]);
    await orders.sweepExpiredHolds();
    expect(await stock(it.id)).toMatchObject({ status: 'active', quantity: 2 });
    const o = await orderRow(a.body.data.order.id);
    expect(o.payment_status).toBe('failed'); expect(o.stock_released_at).toBeTruthy();
    // the payment then succeeds anyway (a late webhook): never sold twice, refunded instead
    const pi = mockStripe.intents.get(o.stripe_payment_intent_id); Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: 'ch_late' });
    const before = mockStripe.refunds.length;
    const out = await orders.markOrderPaid({ ...pi });
    expect(out).toMatchObject({ conflict: true });
    expect(mockStripe.refunds.length).toBe(before + 1);
    expect(await stock(it.id)).toMatchObject({ quantity: 2, quantity_sold: 0 });
  });
});

describe('giving units back', () => {
  test('a canceled checkout returns its units exactly once (a second cancel notice changes nothing)', async () => {
    const it = await listQ(5);
    const a = await buy(it.id, 'bea', 3);
    const o = await orderRow(a.body.data.order.id);
    await orders.handleIntentEvent('payment_intent.canceled', { id: o.stripe_payment_intent_id, status: 'canceled' });
    await orders.handleIntentEvent('payment_intent.canceled', { id: o.stripe_payment_intent_id, status: 'canceled' });
    expect(await stock(it.id)).toMatchObject({ quantity: 5, status: 'active' });
    expect((await events(it.id)).filter((e) => e.reason === 'released')).toEqual([expect.objectContaining({ delta: 3, available_after: 5 })]);
  });

  test('a released last unit puts a "sale in progress" item back on sale', async () => {
    const it = await listQ(1);
    const a = await buy(it.id, 'bea', 1);
    expect(await stock(it.id)).toMatchObject({ status: 'pending_purchase', quantity: 0 });
    await orders.releaseOrder(a.body.data.order.id, 'test', { cancelIntent: true });
    expect(await stock(it.id)).toMatchObject({ status: 'active', quantity: 1, pending_order_id: null });
  });

  test('a full refund takes the units off the sold count; they are not put back on sale automatically', async () => {
    const it = await listQ(3);
    const a = await buy(it.id, 'bea', 2);
    await pay(a.body.data.order.id, 'bea');
    await orders.refundOrder(a.body.data.order.id, { adminId: U.admin.id, reason: 'Damaged in transit' });
    expect(await stock(it.id)).toMatchObject({ status: 'active', quantity: 1, quantity_sold: 0 });
    expect((await events(it.id)).filter((e) => e.reason === 'refunded')).toEqual([expect.objectContaining({ sold_delta: -2, delta: 0 })]);
  });

  test('a refunded sold-out item needs an explicit relist (its goods may have left)', async () => {
    const it = await listQ(1);
    const a = await buy(it.id, 'bea', 1);
    await pay(a.body.data.order.id, 'bea');
    expect(await stock(it.id)).toMatchObject({ status: 'sold' });
    await orders.refundOrder(a.body.data.order.id, { adminId: U.admin.id, reason: 'Buyer returned it' });
    expect(await stock(it.id)).toMatchObject({ status: 'removed', quantity: 0, quantity_sold: 0 });
  });
});

describe('the seller after partial sales', () => {
  test('an item with units left stays on sale and editable; restocking is recorded', async () => {
    const it = await listQ(5);
    const a = await buy(it.id, 'bea', 2); await pay(a.body.data.order.id, 'bea');
    await items.updateItem(it.id, U.sue.id, { price_cents: 2500, quantity: 10, title: 'Restocked' });
    expect(await stock(it.id)).toMatchObject({ status: 'active', quantity: 10, quantity_sold: 2 });
    expect((await events(it.id)).filter((e) => e.reason === 'seller_adjusted')).toEqual([expect.objectContaining({ delta: 7, available_after: 10 })]);
    // the earlier order keeps the price it was bought at
    expect(await orderRow(a.body.data.order.id)).toMatchObject({ unit_price_cents: 2000, quantity: 2, item_price_cents: 4000 });
  });

  test('a checkout in progress pauses edits (the hold lasts at most 30 minutes)', async () => {
    const it = await listQ(5);
    await buy(it.id, 'bea', 1);
    await expect(items.updateItem(it.id, U.sue.id, { title: 'x' })).rejects.toMatchObject({ code: 'ITEM_RESERVED' });
  });

  test('a sold-out item keeps its details as they were at the sale', async () => {
    const it = await listQ(2);
    const a = await buy(it.id, 'bea', 2); await pay(a.body.data.order.id, 'bea');
    await expect(items.updateItem(it.id, U.sue.id, { title: 'Changed' })).rejects.toMatchObject({ code: 'ITEM_SOLD' });
  });
});

describe('database guards (migration 212)', () => {
  test('an order\'s quantity and unit price never change; the line total must equal unit x quantity', async () => {
    const it = await listQ(3);
    const a = await buy(it.id, 'bea', 2);
    await expect(q('UPDATE marketplace_orders SET quantity = 1 WHERE id = $1', [a.body.data.order.id])).rejects.toThrow(/fixed at purchase/);
    await expect(q('UPDATE marketplace_orders SET unit_price_cents = 1 WHERE id = $1', [a.body.data.order.id])).rejects.toThrow(/fixed at purchase|immutable|cannot/);
  });
  test('stock history is append-only and available stock can never go below zero', async () => {
    const it = await listQ(1);
    await buy(it.id, 'bea', 1);
    await expect(q('UPDATE marketplace_stock_events SET delta = 0 WHERE item_id = $1', [it.id])).rejects.toThrow(/append-only/);
    await expect(q('DELETE FROM marketplace_stock_events WHERE item_id = $1', [it.id])).rejects.toThrow(/append-only/);
    await expect(q('UPDATE marketplace_items SET quantity = -1 WHERE id = $1', [it.id])).rejects.toThrow(/quantity_check|check constraint/);
  });
});
