'use strict';

/**
 * Professional Storefront — adversarial ownership / attribution tests (owner security standard, 2026-10-16).
 *
 * Real Postgres (PGlite, in memory) running the REAL storefront migrations (119, 121, 174, 177, 178, 197), the real order,
 * item, issue and dispute services, and the real /api/marketplace routes. Two Professional Sellers — Nora and Sue — two
 * buyers — Bea and Ben — an administrator and a Finance staff member. Every prohibited action must fail, and nothing it
 * touched may change.
 *
 * Only the payment processor (an in-memory stand-in), tax (off), email and the generic audit log are replaced.
 */

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
// Auth: the test names the signed-in user with a header (the real middleware is covered by the session tests).
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

async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  for (const f of ['119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql', '203_seller_store_policies.sql']) {
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('1. listing ownership comes from the signed-in seller, never the browser', () => {
  test('a seller_id in the request body is ignored: Sue creating a listing "for Nora" creates Sue\'s listing', async () => {
    const r = await call('sue', 'POST', '/api/seller-storefront/items', { title: 'Lamp', price_cents: 2000, seller_id: SP.nora });
    expect(r.status).toBe(201);
    expect(r.body.data.seller_id).toBe(SP.sue);
  });
  test('Sue cannot edit, hide or relist Nora\'s listing; the listing is unchanged', async () => {
    const it = await noraItem();
    for (const patch of [{ price_cents: 1 }, { title: 'mine now' }, { status: 'removed' }]) {
      const r = await call('sue', 'PATCH', '/api/seller-storefront/items/' + it.id, patch);
      expect(r.status).toBe(403); expect(r.body.code).toBe('NOT_OWNER');
    }
    await q(`UPDATE marketplace_items SET status = 'removed' WHERE id = $1`, [it.id]);
    const rl = await call('sue', 'POST', '/api/marketplace/seller/items/' + it.id + '/relist');
    expect(rl.status).toBe(403);
    const after = await one('SELECT seller_id, price_cents, title, status FROM marketplace_items WHERE id = $1', [it.id]);
    expect(after).toEqual({ seller_id: SP.nora, price_cents: 10000, title: 'Walnut sideboard', status: 'removed' });
  });
  test('Sue naming Nora\'s already-converted auction lot learns nothing about Nora\'s listing (was: returned Nora\'s full row)', async () => {
    const a = await one(`INSERT INTO auctions (seller_id, title, city, address_state, street_address, zip, state) VALUES ($1,'Nora sale','Houston','TX','1 Nora St','77001','closed') RETURNING id`, [SP.nora]);
    const lot = await one(`INSERT INTO lots (auction_id, title, state, starting_bid_cents) VALUES ($1, 'Chair', 'closed', 500) RETURNING id`, [a.id]);
    const mine = await call('nora', 'POST', '/api/seller-storefront/unsold-lots/' + lot.id + '/convert', {});
    expect(mine.status).toBe(201);
    const theirs = await call('sue', 'POST', '/api/seller-storefront/unsold-lots/' + lot.id + '/convert', {});
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body)).not.toMatch(/1 Nora St|pickup_address|Chair/);
    const batch = await call('sue', 'POST', '/api/seller-storefront/unsold-lots/convert-batch', { lot_ids: [lot.id] });
    expect(batch.body.data).toEqual({ converted: 0, skipped: 0, errors: [{ lot_id: lot.id, code: 'LOT_NOT_FOUND' }] });
  });
  test('a listing\'s seller cannot be changed once anyone has ordered it (database)', async () => {
    const it = await noraItem();
    await beaBuys(it);
    const e = await rejects('UPDATE marketplace_items SET seller_id = $2 WHERE id = $1', [it.id, SP.sue]);
    expect(e.message).toMatch(/foreign key|violates/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('2. orders: tied to the purchased item and its verified seller, with a fixed snapshot', () => {
  test('a manipulated checkout request (seller, price, fee, buyer in the body) cannot change who sold, who bought or what it cost', async () => {
    const it = await noraItem();
    const r = await call('bea', 'POST', '/api/marketplace/orders', { policies_acknowledged: true, item_id: it.id, seller_id: SP.sue, price_cents: 1, item_price_cents: 1,
      platform_fee_bps: 0, total_charge_cents: 1, buyer_user_id: U.ben.id, shipping_cents: 0, fulfillment_method: 'shipping',
      ship_to: { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701' } });
    expect(r.status).toBe(200);
    const o = await one('SELECT * FROM marketplace_orders WHERE id = $1', [r.body.data.order.id]);
    expect(o.seller_id).toBe(SP.nora);
    expect(o.buyer_user_id).toBe(U.bea.id);
    expect(o.item_price_cents).toBe(10000);
    expect(o.shipping_cents).toBe(1500);
    expect(o.total_charge_cents).toBe(11500);
    expect(o.platform_fee_bps).toBe(1100);
    expect(mockStripe.intents.get(o.stripe_payment_intent_id).amount).toBe(11500);
    // the snapshot names the real item and seller
    expect(o.item_snapshot.item_id).toBe(it.id);
    expect(o.item_snapshot.title).toBe('Walnut sideboard');
    expect(o.seller_snapshot).toMatchObject({ seller_profile_id: SP.nora, seller_user_id: U.nora.id, display_name: 'Nora Estate Sales' });
    expect(o.pickup_snapshot).toMatchObject({ line1: '1 Nora St', city: 'Houston', state: 'TX' });
    // the buyer's response never carries the seller's fee or proceeds
    expect(r.body.data.order.seller_proceeds_cents).toBeUndefined();
    expect(r.body.data.breakdown.platform_fee_cents).toBeUndefined();
  });
  test('a seller cannot buy their own listing (service and database)', async () => {
    const it = await noraItem();
    await expect(orders.createOrder(it.id, U.nora.id, { policiesAcknowledged: true, })).rejects.toMatchObject({ code: 'CANNOT_BUY_OWN' });
    const e = await rejects(`INSERT INTO marketplace_orders (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, fulfillment_method,
      item_snapshot, seller_snapshot) VALUES ($1, $2, $3, 1, 1, 'pickup', $4, $5)`,
      [it.id, SP.nora, U.nora.id, JSON.stringify({ item_id: it.id }), JSON.stringify({ seller_profile_id: SP.nora })]);
    expect(e.message).toMatch(/cannot buy their own/);
  });
  test('an order naming Sue for Nora\'s item is rejected by the database, as is a snapshot naming another seller', async () => {
    const it = await noraItem();
    const e1 = await rejects(`INSERT INTO marketplace_orders (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, fulfillment_method,
      item_snapshot, seller_snapshot) VALUES ($1, $2, $3, 1, 1, 'pickup', $4, $5)`,
      [it.id, SP.sue, U.bea.id, JSON.stringify({ item_id: it.id }), JSON.stringify({ seller_profile_id: SP.sue })]);
    expect(e1.message).toMatch(/foreign key|violates/i);
    const e2 = await rejects(`INSERT INTO marketplace_orders (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, fulfillment_method,
      item_snapshot, seller_snapshot) VALUES ($1, $2, $3, 1, 1, 'pickup', $4, $5)`,
      [it.id, SP.nora, U.bea.id, JSON.stringify({ item_id: it.id }), JSON.stringify({ seller_profile_id: SP.sue })]);
    expect(e2.message).toMatch(/snapshot does not match/);
    const e3 = await rejects(`INSERT INTO marketplace_orders (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, fulfillment_method,
      payment_status, item_snapshot, seller_snapshot) VALUES ($1, $2, $3, 1, 1, 'pickup', 'paid', $4, $5)`,
      [it.id, SP.nora, U.bea.id, JSON.stringify({ item_id: it.id }), JSON.stringify({ seller_profile_id: SP.nora })]);
    expect(e3.message).toMatch(/must start unpaid/);
  });
  test('after payment, the seller, buyer, item, price, fee, proceeds, totals and snapshot can never change (database)', async () => {
    const o = await beaBuys(await noraItem());
    for (const [col, val] of [['seller_id', SP.sue], ['buyer_user_id', U.ben.id], ['item_price_cents', 1], ['platform_fee_cents', 0],
      ['seller_proceeds_cents', 999999], ['total_charge_cents', 1], ['tax_cents', 5], ['stripe_payment_intent_id', 'pi_other'],
      ['stripe_charge_id', 'ch_other'], ['currency', 'eur']]) {
      const e = await rejects(`UPDATE marketplace_orders SET ${col} = $2 WHERE id = $1`, [o.id, val]);
      expect(e.message).toMatch(/fixed|cannot/);
    }
    await rejects(`UPDATE marketplace_orders SET item_snapshot = '{}'::jsonb WHERE id = $1`, [o.id]);
    await rejects(`UPDATE marketplace_orders SET seller_snapshot = jsonb_set(seller_snapshot, '{seller_profile_id}', to_jsonb($2::text)) WHERE id = $1`, [o.id, SP.sue]);
    await rejects('DELETE FROM marketplace_orders WHERE id = $1', [o.id]);
    const after = await one('SELECT seller_id, buyer_user_id, item_price_cents, total_charge_cents FROM marketplace_orders WHERE id = $1', [o.id]);
    expect(after).toEqual({ seller_id: SP.nora, buyer_user_id: U.bea.id, item_price_cents: 10000, total_charge_cents: 10000 });
  });
  test('payment states only move forward (a paid order cannot become pending; a refund cannot be undone)', async () => {
    const o = await beaBuys(await noraItem());
    await rejects(`UPDATE marketplace_orders SET payment_status = 'pending' WHERE id = $1`, [o.id]);
    await rejects(`UPDATE marketplace_orders SET payment_status = 'failed' WHERE id = $1`, [o.id]);
  });
  test('the sold listing keeps its details; the order snapshot keeps what was bought even if the item row is later altered', async () => {
    const it = await noraItem();
    const o = await beaBuys(it);
    const r = await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { title: 'Different', price_cents: 5 });
    expect(r.status).toBe(409); expect(r.body.code).toBe('ITEM_SOLD');
    expect((await one('SELECT item_snapshot FROM marketplace_orders WHERE id = $1', [o.id])).item_snapshot.title).toBe('Walnut sideboard');
  });
  test('a sold item hidden from view cannot be relisted through the relist endpoint (was: double-sale bypass)', async () => {
    const it = await noraItem();
    await beaBuys(it);
    const hide = await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { status: 'removed' });
    expect(hide.status).toBe(200);
    const rl = await call('nora', 'POST', '/api/marketplace/seller/items/' + it.id + '/relist');
    expect(rl.status).toBe(409); expect(rl.body.code).toBe('ITEM_SOLD');
    expect((await one('SELECT status FROM marketplace_items WHERE id = $1', [it.id])).status).toBe('removed');
  });
  test('a payment that does not match its order (other seller in metadata, or wrong amount) is never marked paid', async () => {
    for (const tamper of [{ metadata_seller: SP.sue }, { amount: 1 }]) {
      const it = await noraItem();
      const c = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true, });
      const o = await one('SELECT * FROM marketplace_orders WHERE id = $1', [c.order.id]);
      const pi = mockStripe.intents.get(o.stripe_payment_intent_id);
      const forged = { ...pi, status: 'succeeded', amount_received: tamper.amount || pi.amount,
        metadata: { ...pi.metadata, ...(tamper.metadata_seller ? { seller_id: tamper.metadata_seller } : {}) } };
      await orders.markOrderPaid(forged);
      const after = await one('SELECT payment_status, review_required FROM marketplace_orders WHERE id = $1', [o.id]);
      expect(after).toEqual({ payment_status: 'pending', review_required: true });
      expect((await one(`SELECT count(*)::int n FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'payment_mismatch'`, [o.id])).n).toBe(1);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('3–6. who can see and act on an order', () => {
  test('Ben cannot read, pay, see the history of, or complain about Bea\'s order (indistinguishable from "not found")', async () => {
    const it = await noraItem();
    const c = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true, });
    const id = c.order.id;
    expect((await call('ben', 'GET', '/api/marketplace/orders/' + id)).status).toBe(404);
    expect((await call('ben', 'POST', '/api/marketplace/orders/' + id + '/pay', { payment_method_id: 'pm_ben' })).status).toBe(404);
    expect((await call('ben', 'GET', '/api/marketplace/orders/' + id + '/history')).status).toBe(404);
    expect((await call('ben', 'POST', '/api/marketplace/orders/' + id + '/issues', { category: 'other', message: 'This is not mine' })).status).toBe(404);
    expect((await call('ben', 'GET', '/api/marketplace/orders/not-a-uuid')).status).toBe(404);
    expect((await one('SELECT payment_status FROM marketplace_orders WHERE id = $1', [id])).payment_status).toBe('pending');
  });
  test('Sue sees none of Nora\'s orders, buyer contact or history, and cannot fulfil them', async () => {
    const o = await beaBuys(await noraItem());
    const list = await call('sue', 'GET', '/api/marketplace/seller/orders');
    expect(list.body.data.map((x) => x.id)).not.toContain(o.id);
    expect(JSON.stringify(list.body.data)).not.toMatch(/bea@test/);
    expect((await call('sue', 'GET', '/api/marketplace/seller/orders/' + o.id + '/history')).status).toBe(404);
    for (const action of ['ready_for_pickup', 'picked_up']) {
      const r = await call('sue', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action });
      expect(r.status).toBe(403); expect(r.body.code).toBe('NOT_OWNER');
    }
    const asBuyer = await call('bea', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action: 'picked_up' });
    expect(asBuyer.status).toBe(403);
    const after = await one('SELECT fulfillment_status, payout_eligible FROM marketplace_orders WHERE id = $1', [o.id]);
    expect(after).toEqual({ fulfillment_status: 'unfulfilled', payout_eligible: false });
  });
  test('Nora sees Bea\'s contact for a paid order only; Bea never sees Nora\'s fee or proceeds', async () => {
    const o = await beaBuys(await noraItem());
    const mine = (await call('nora', 'GET', '/api/marketplace/seller/orders')).body.data.find((x) => x.id === o.id);
    expect(mine.buyer_email).toBe('bea@test.example');
    const buyerView = (await call('bea', 'GET', '/api/marketplace/orders/' + o.id)).body.data;
    expect(buyerView.platform_fee_cents).toBeUndefined();
    expect(buyerView.seller_proceeds_cents).toBeUndefined();
    await orders.refundOrder(o.id, { adminId: U.admin.id, reason: 'Buyer changed mind (test)' });
    const refunded = (await call('nora', 'GET', '/api/marketplace/seller/orders')).body.data.find((x) => x.id === o.id);
    expect(refunded.buyer_email).toBeNull();
    expect(refunded.ship_to).toBeNull();
  });
  test('staff without the administrator role (Finance) and sellers cannot use any admin order action', async () => {
    const o = await beaBuys(await noraItem());
    for (const who of ['finance', 'nora', 'bea']) {
      expect((await call(who, 'GET', '/api/marketplace/admin/orders')).status).toBe(403);
      expect((await call(who, 'GET', '/api/marketplace/admin/issues')).status).toBe(403);
      expect((await call(who, 'GET', '/api/marketplace/admin/orders/' + o.id + '/history')).status).toBe(403);
      expect((await call(who, 'POST', '/api/marketplace/admin/orders/' + o.id + '/refund', { reason: 'please refund me' })).status).toBe(403);
      expect((await call(who, 'POST', '/api/marketplace/admin/orders/' + o.id + '/payout-hold', { hold: false, reason: 'release it' })).status).toBe(403);
    }
    expect(mockStripe.refunds.filter((r) => r.payment_intent === o.stripe_payment_intent_id)).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('7. buyer issues are tied to the order\'s real seller', () => {
  test('an issue naming Sue in the request is still an issue against Nora (the order\'s seller)', async () => {
    const o = await beaBuys(await noraItem());
    const r = await call('bea', 'POST', '/api/marketplace/orders/' + o.id + '/issues',
      { category: 'damaged', message: 'Arrived with a cracked leg', seller_id: SP.sue, seller_name: 'Sue Auctions' });
    expect(r.status).toBe(201);
    const row = await one('SELECT seller_id, buyer_user_id, order_id FROM marketplace_order_issues WHERE id = $1', [r.body.data.id]);
    expect(row).toEqual({ seller_id: SP.nora, buyer_user_id: U.bea.id, order_id: o.id });
    expect((await call('sue', 'GET', '/api/marketplace/seller/issues')).body.data).toHaveLength(0);
    const sueTry = await call('sue', 'POST', '/api/marketplace/seller/issues/' + r.body.data.id + '/respond', { response: 'Not my problem' });
    expect(sueTry.status).toBe(404);
    const nora = await call('nora', 'POST', '/api/marketplace/seller/issues/' + r.body.data.id + '/respond', { response: 'Sorry - we will make it right.' });
    expect(nora.status).toBe(200);
    const again = await call('nora', 'POST', '/api/marketplace/seller/issues/' + r.body.data.id + '/respond', { response: 'Changing my answer' });
    expect(again.status).toBe(409);
  });
  test('the database refuses an issue pointing at another seller or buyer, and an issue\'s parties and words never change', async () => {
    const o = await beaBuys(await noraItem());
    await rejects(`INSERT INTO marketplace_order_issues (order_id, seller_id, buyer_user_id, category, message) VALUES ($1,$2,$3,'other','x')`, [o.id, SP.sue, U.bea.id]);
    await rejects(`INSERT INTO marketplace_order_issues (order_id, seller_id, buyer_user_id, category, message) VALUES ($1,$2,$3,'other','x')`, [o.id, SP.nora, U.ben.id]);
    const i = await issues.openIssue(o.id, U.bea.id, { category: 'other', message: 'Question about pickup' });
    await rejects('UPDATE marketplace_order_issues SET seller_id = $2 WHERE id = $1', [i.id, SP.sue]);
    await rejects(`UPDATE marketplace_order_issues SET message = 'edited' WHERE id = $1`, [i.id]);
    await rejects('DELETE FROM marketplace_order_issues WHERE id = $1', [i.id]);
  });
  test('an issue needs a paid order; resolving one needs an administrator and a note', async () => {
    const it = await noraItem();
    const c = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true, });
    await expect(issues.openIssue(c.order.id, U.bea.id, { category: 'other', message: 'Unpaid order issue' })).rejects.toMatchObject({ code: 'ORDER_NOT_PURCHASED' });
    const o = await beaBuys(await noraItem());
    const i = await issues.openIssue(o.id, U.bea.id, { category: 'not_received', message: 'Never got it' });
    expect((await call('nora', 'POST', '/api/marketplace/admin/issues/' + i.id + '/resolve', { resolution_note: 'resolved by me' })).status).toBe(403);
    await expect(issues.resolve(i.id, U.admin.id, { resolution_note: '' })).rejects.toMatchObject({ code: 'NOTE_REQUIRED' });
    const ok = await call('admin', 'POST', '/api/marketplace/admin/issues/' + i.id + '/resolve', { resolution_note: 'Seller confirmed delivery photo' });
    expect(ok.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('8. fulfillment is attributable and its history is kept', () => {
  test('shipping needs a carrier and tracking number; once recorded, tracking cannot be rewritten and steps cannot go back', async () => {
    const o = await beaBuys(await noraItem(), 'shipping');
    const none = await call('nora', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action: 'shipped' });
    expect(none.status).toBe(422); expect(none.body.code).toBe('TRACKING_REQUIRED');
    const ok = await call('nora', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action: 'shipped', tracking_carrier: 'UPS', tracking_number: '1Z999' });
    expect(ok.status).toBe(200);
    const twice = await call('nora', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action: 'shipped', tracking_carrier: 'FedEx', tracking_number: 'NEW' });
    expect(twice.status).toBe(409);
    await rejects(`UPDATE marketplace_orders SET tracking_number = 'NEW' WHERE id = $1`, [o.id]);
    await rejects(`UPDATE marketplace_orders SET fulfillment_status = 'unfulfilled' WHERE id = $1`, [o.id]);
    const row = await one('SELECT tracking_carrier, tracking_number, fulfillment_status FROM marketplace_orders WHERE id = $1', [o.id]);
    expect(row).toEqual({ tracking_carrier: 'UPS', tracking_number: '1Z999', fulfillment_status: 'shipped' });
    const ev = await one(`SELECT * FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'fulfillment'`, [o.id]);
    expect(ev).toMatchObject({ seller_id: SP.nora, buyer_user_id: U.bea.id, actor_user_id: U.nora.id, actor_role: 'seller' });
    expect(ev.data).toMatchObject({ action: 'shipped', tracking_carrier: 'UPS', tracking_number: '1Z999' });
  });
  test('order history is append-only and can never name a different seller or buyer', async () => {
    const o = await beaBuys(await noraItem());
    const ev = await one('SELECT id FROM marketplace_order_events WHERE order_id = $1 LIMIT 1', [o.id]);
    await rejects(`UPDATE marketplace_order_events SET actor_role = 'admin' WHERE id = $1`, [ev.id]);
    await rejects('DELETE FROM marketplace_order_events WHERE id = $1', [ev.id]);
    await rejects(`INSERT INTO marketplace_order_events (order_id, seller_id, buyer_user_id, event_type, actor_role) VALUES ($1,$2,$3,'fulfillment','seller')`, [o.id, SP.sue, U.bea.id]);
    const hist = (await call('bea', 'GET', '/api/marketplace/orders/' + o.id + '/history')).body.data;
    expect(hist.map((h) => h.event)).toEqual(['created', 'paid']);
    expect(JSON.stringify(hist)).not.toMatch(/pi_|ch_/);   // no internal payment references for buyers
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('9. refunds, chargebacks and payouts use the original verified transaction', () => {
  test('a refund needs an administrator and a reason, refunds the order\'s own payment once, and cannot be reversed', async () => {
    const o = await beaBuys(await noraItem());
    await expect(orders.refundOrder(o.id, {})).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect((await call('admin', 'POST', '/api/marketplace/admin/orders/' + o.id + '/refund', {})).body.code).toBe('REASON_REQUIRED');
    const before = mockStripe.refunds.length;
    expect((await call('admin', 'POST', '/api/marketplace/admin/orders/' + o.id + '/refund', { reason: 'Item damaged in storage' })).status).toBe(200);
    expect((await call('admin', 'POST', '/api/marketplace/admin/orders/' + o.id + '/refund', { reason: 'Item damaged in storage' })).status).toBe(200);
    const made = mockStripe.refunds.slice(before);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ payment_intent: o.stripe_payment_intent_id, amount: o.total_charge_cents });
    await rejects('UPDATE marketplace_orders SET refunded_amount_cents = 0 WHERE id = $1', [o.id]);
    await rejects(`UPDATE marketplace_orders SET refund_status = 'none' WHERE id = $1`, [o.id]);
    await rejects(`UPDATE marketplace_orders SET payment_status = 'paid' WHERE id = $1`, [o.id]);
    await rejects('UPDATE marketplace_orders SET refunded_amount_cents = total_charge_cents + 1 WHERE id = $1', [o.id]);
    const ev = await one(`SELECT actor_user_id, actor_role, data FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'refund'`, [o.id]);
    expect(ev).toMatchObject({ actor_user_id: U.admin.id, actor_role: 'admin', data: { kind: 'full', note: 'Item damaged in storage' } });
  });
  test('payout eligibility cannot be forced before fulfillment, and payouts cannot be redirected to another seller', async () => {
    const o = await beaBuys(await noraItem());
    await rejects('UPDATE marketplace_orders SET payout_eligible = true WHERE id = $1', [o.id]);
    await rejects('UPDATE marketplace_orders SET seller_id = $2 WHERE id = $1', [o.id, SP.sue]);
    await rejects('UPDATE marketplace_orders SET seller_proceeds_cents = 0 WHERE id = $1', [o.id]);
  });
  test('a chargeback is recorded against the order\'s real seller and holds the payout; fulfillment then cannot make it payable', async () => {
    const o = await beaBuys(await noraItem());
    const out = await disputes.handleDisputeEvent({ id: 'evt_1', type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_x', payment_intent: o.stripe_payment_intent_id, amount: o.total_charge_cents, currency: 'usd',
        reason: 'product_not_received', status: 'needs_response' } } });
    expect(out.recorded).toBe(true);
    const d = await one(`SELECT marketplace_order_id, marketplace_seller_id, buyer_user_id, payout_hold_applied FROM payment_disputes WHERE stripe_dispute_id = 'dp_1'`);
    expect(d).toEqual({ marketplace_order_id: o.id, marketplace_seller_id: SP.nora, buyer_user_id: U.bea.id, payout_hold_applied: true });
    const done = await call('nora', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action: 'picked_up' });
    expect(done.status).toBe(200);
    const after = await one('SELECT payout_hold, payout_eligible, review_required FROM marketplace_orders WHERE id = $1', [o.id]);
    expect(after).toEqual({ payout_hold: true, payout_eligible: false, review_required: true });
    await rejects(`UPDATE payment_disputes SET marketplace_seller_id = $2 WHERE stripe_dispute_id = 'dp_1'`, [SP.sue]);
    // replay is harmless
    await disputes.handleDisputeEvent({ id: 'evt_1', type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: o.stripe_payment_intent_id, amount: o.total_charge_cents, currency: 'usd', reason: 'product_not_received', status: 'needs_response' } } });
    expect((await one(`SELECT count(*)::int n FROM payment_disputes WHERE stripe_dispute_id = 'dp_1'`)).n).toBe(1);
  });
  test('only an administrator, with a reason, can release a payout hold; then a fulfilled order becomes eligible', async () => {
    const o = await beaBuys(await noraItem());
    await orders.setPayoutHold(o.id, U.admin.id, { hold: true, reason: 'Checking pickup dispute' });
    await call('nora', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action: 'picked_up' });
    expect((await one('SELECT payout_eligible FROM marketplace_orders WHERE id = $1', [o.id])).payout_eligible).toBe(false);
    await expect(orders.setPayoutHold(o.id, U.admin.id, { hold: false, reason: '' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const rel = await call('admin', 'POST', '/api/marketplace/admin/orders/' + o.id + '/payout-hold', { hold: false, reason: 'Buyer confirmed pickup' });
    expect(rel.status).toBe(200);
    // eligibility after release is set by a person in settlement (M3); the database still allows it only for a fulfilled paid order
    await q('UPDATE marketplace_orders SET payout_eligible = true WHERE id = $1', [o.id]);
    expect((await one('SELECT payout_eligible FROM marketplace_orders WHERE id = $1', [o.id])).payout_eligible).toBe(true);
  });
});

test('migration 197 leaves demo orders removable for test cleanup, but never real ones', async () => {
  const it = await noraItem();
  await q('UPDATE marketplace_items SET is_demo = true WHERE id = $1', [it.id]);
  const c = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true, });
  await q('UPDATE marketplace_items SET status = $2, pending_order_id = NULL WHERE id = $1', [it.id, 'active']);
  await q('DELETE FROM marketplace_orders WHERE id = $1', [c.order.id]);
  expect(await one('SELECT id FROM marketplace_orders WHERE id = $1', [c.order.id])).toBeUndefined();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('storefront Buy Now never has a buyer\'s premium (separate from auction pricing)', () => {
  const setAuctionPricing = async ({ pct, auctionBps, platformBps }) => {
    await q('UPDATE seller_terms SET superseded_at = now() WHERE seller_profile_id = $1 AND superseded_at IS NULL', [SP.nora]);
    if (pct != null) await q('INSERT INTO seller_terms (seller_profile_id, buyer_premium_pct) VALUES ($1, $2)', [SP.nora, pct]);
    await q('UPDATE auctions SET buyer_premium_bps = $2 WHERE seller_id = $1', [SP.nora, auctionBps]);
    await q('UPDATE seller_profiles SET platform_fee_bps = $2 WHERE id = $1', [SP.nora, platformBps]);
  };
  test('whatever the seller\'s auction premium, default terms or auction fee, the Buy Now total is item + shipping + tax and the fee is 11% of the item', async () => {
    await q(`INSERT INTO auctions (seller_id, title, state, buyer_premium_bps) VALUES ($1, 'Nora auction', 'draft', 1800)`, [SP.nora]);
    const totals = [];
    for (const cfg of [{ pct: null, auctionBps: null, platformBps: null }, { pct: 18, auctionBps: 1800, platformBps: 400 },
      { pct: 35, auctionBps: 5000, platformBps: 0 }, { pct: 100, auctionBps: 10000, platformBps: 2500 }, { pct: 0, auctionBps: 0, platformBps: 9000 }]) {
      await setAuctionPricing(cfg);
      const it = await noraItem();   // $100.00 item, $15.00 shipping
      const quote = await orders.quote(it.id, U.bea.id, { fulfillment_method: 'shipping', ship_to: { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701' } });
      expect(quote.breakdown).toEqual({ item_price_cents: 10000, shipping_cents: 1500, tax_cents: 0, total_charge_cents: 11500 });
      const c = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true,  fulfillment_method: 'shipping', ship_to: { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701' } });
      const o = await one('SELECT * FROM marketplace_orders WHERE id = $1', [c.order.id]);
      expect(o).toMatchObject({ item_price_cents: 10000, shipping_cents: 1500, tax_cents: 0, total_charge_cents: 11500,
        platform_fee_bps: 1100, platform_fee_cents: 1100, seller_proceeds_cents: 10400 });
      expect(mockStripe.intents.get(o.stripe_payment_intent_id).amount).toBe(11500);
      totals.push(o.total_charge_cents);
    }
    expect(new Set(totals).size).toBe(1);
  });
  test('changing the seller\'s auction premium after a Buy Now order is placed changes nothing about that order or its refund', async () => {
    await setAuctionPricing({ pct: 18, auctionBps: 1800, platformBps: 400 });
    const o = await beaBuys(await noraItem());
    await setAuctionPricing({ pct: 60, auctionBps: 6000, platformBps: 0 });
    const after = await one('SELECT item_price_cents, total_charge_cents, platform_fee_cents, seller_proceeds_cents FROM marketplace_orders WHERE id = $1', [o.id]);
    expect(after).toEqual({ item_price_cents: 10000, total_charge_cents: 10000, platform_fee_cents: 1100, seller_proceeds_cents: 8900 });
    const before = mockStripe.refunds.length;
    await orders.refundOrder(o.id, { adminId: U.admin.id, reason: 'Separation regression test' });
    expect(mockStripe.refunds.slice(before)).toEqual([expect.objectContaining({ payment_intent: o.stripe_payment_intent_id, amount: 10000 })]);
  });
  test('the storefront order, item, issue and notice code never loads auction pricing or mentions a buyer\'s premium to buyers', () => {
    const files = ['marketplaceOrderService', 'marketplaceItemService', 'marketplaceOrderIssueService', 'marketplaceOrderNotifier'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'services', f + '.js'), 'utf8');
      expect(src).not.toMatch(/require\(['"]\.\/(billingTermsService|sellerTermsService|pricingConfigService|auctionService|sellerPricingAgreementService)['"]\)/);
      expect(src).not.toMatch(/buyer_premium_bps|buyer_premium_pct|effectiveBuyerPremiumBps|lotBuyerPremiumCents/);
    }
    expect(orders.STOREFRONT_BUYER_PREMIUM_BPS).toBe(0);
    expect(fs.readFileSync(path.join(ROOT, 'src', 'services', 'marketplaceOrderNotifier.js'), 'utf8')).not.toMatch(/premium/i);
    expect(fs.readFileSync(path.join(ROOT, 'public', 'item.html'), 'utf8')).not.toMatch(/buyer'?s premium/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
const moderation = () => require('../src/services/marketplaceModerationService');

describe('milestone 2: listing moderation', () => {
  test('only an administrator (with a reason) can take a listing down; Sue, buyers and Finance staff cannot', async () => {
    const it = await noraItem();
    for (const who of ['sue', 'nora', 'bea', 'finance']) {
      expect((await call(who, 'POST', '/api/admin/storefront/items/' + it.id + '/takedown', { reason: 'I do not like it' })).status).toBe(403);
      expect((await call(who, 'GET', '/api/admin/storefront/items')).status).toBe(403);
    }
    expect((await call('admin', 'POST', '/api/admin/storefront/items/' + it.id + '/takedown', {})).body.code).toBe('REASON_REQUIRED');
    expect(await one('SELECT status, moderation_status FROM marketplace_items WHERE id = $1', [it.id])).toEqual({ status: 'active', moderation_status: 'none' });
    const ok = await call('admin', 'POST', '/api/admin/storefront/items/' + it.id + '/takedown', { reason: 'Prohibited item (test)' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'removed', moderation_status: 'taken_down' });
  });
  test('a taken-down listing cannot be put back on sale by its seller (service, relist and database), and is not public', async () => {
    const it = await noraItem();
    await call('admin', 'POST', '/api/admin/storefront/items/' + it.id + '/takedown', { reason: 'Counterfeit (test)' });
    const p = await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { status: 'active' });
    expect(p.status).toBe(409); expect(p.body.code).toBe('TAKEN_DOWN');
    const rl = await call('nora', 'POST', '/api/marketplace/seller/items/' + it.id + '/relist');
    expect(rl.status).toBe(409); expect(rl.body.code).toBe('TAKEN_DOWN');
    await rejects(`UPDATE marketplace_items SET status = 'active' WHERE id = $1`, [it.id]);
    expect(await items.getPublicItem(it.id)).toBeNull();
    await expect(orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true, })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  });
  test('restore returns the listing to its previous status; the history is permanent and names the real seller', async () => {
    const it = await noraItem();
    await call('admin', 'POST', '/api/admin/storefront/items/' + it.id + '/takedown', { reason: 'Checking provenance' });
    const r = await call('admin', 'POST', '/api/admin/storefront/items/' + it.id + '/restore', { reason: 'Provenance confirmed' });
    expect(r.body.data).toMatchObject({ status: 'active', moderation_status: 'none' });
    const h = await q('SELECT action, seller_id, actor_user_id, prior_status FROM marketplace_item_moderation_events WHERE item_id = $1 ORDER BY created_at', [it.id]);
    expect(h).toEqual([{ action: 'takedown', seller_id: SP.nora, actor_user_id: U.admin.id, prior_status: 'active' },
      { action: 'restore', seller_id: SP.nora, actor_user_id: U.admin.id, prior_status: 'removed' }]);
    await rejects(`UPDATE marketplace_item_moderation_events SET reason = 'edited' WHERE item_id = $1`, [it.id]);
    await rejects('DELETE FROM marketplace_item_moderation_events WHERE item_id = $1', [it.id]);
    await rejects(`INSERT INTO marketplace_item_moderation_events (item_id, seller_id, action, actor_user_id, reason) VALUES ($1,$2,'takedown',$3,'wrong seller')`, [it.id, SP.sue, U.admin.id]);
    expect((await call('admin', 'POST', '/api/admin/storefront/items/' + it.id + '/restore', { reason: 'again please' })).body.code).toBe('NOT_TAKEN_DOWN');
  });
  test('a sold listing taken down and restored stays sold, and one in checkout cannot be taken down', async () => {
    const sold = await noraItem(); await beaBuys(sold);
    await moderation().takedown(sold.id, U.admin.id, { reason: 'Review after sale' });
    expect((await moderation().restore(sold.id, U.admin.id, { reason: 'Fine after review' })).status).toBe('sold');
    const held = await noraItem(); await orders.createOrder(held.id, U.ben.id, { policiesAcknowledged: true, });
    await expect(moderation().takedown(held.id, U.admin.id, { reason: 'Mid checkout' })).rejects.toMatchObject({ code: 'ITEM_RESERVED' });
  });
});

describe('milestone 2: buyer reports about a listing', () => {
  test("a report naming Sue is still a report about Nora's listing; repeat reports are harmless; owners cannot report their own", async () => {
    const it = await noraItem();
    const r = await call('bea', 'POST', '/api/marketplace/items/' + it.id + '/report', { category: 'misleading', message: 'Photos are of a different piece', seller_id: SP.sue });
    expect(r.status).toBe(201);
    expect(await one('SELECT seller_id, reporter_user_id FROM marketplace_item_reports WHERE id = $1', [r.body.data.id])).toEqual({ seller_id: SP.nora, reporter_user_id: U.bea.id });
    expect((await call('bea', 'POST', '/api/marketplace/items/' + it.id + '/report', { category: 'other', message: 'Again, same thing' })).body.data.already_reported).toBe(true);
    expect((await call('nora', 'POST', '/api/marketplace/items/' + it.id + '/report', { category: 'other', message: 'Reporting myself' })).body.code).toBe('OWN_LISTING');
    const draft = await noraItem({ status: 'draft' });
    expect((await call('bea', 'POST', '/api/marketplace/items/' + draft.id + '/report', { category: 'other', message: 'Hidden listing' })).status).toBe(404);
    const oa = require('../src/services/ownerAlertService');
    const alert = oa.notifyAdminActionRequired.mock.calls.find((c) => c[0].actionType === 'storefront_item_report' && c[0].entityId === it.id);
    expect(alert).toBeTruthy();
    expect(JSON.stringify(alert[0])).not.toMatch(/bea@|Photos are of/);   // no reporter identity or words in the SMS
  });
  test("the database refuses a report pointing at another seller and keeps a report's words unchanged", async () => {
    const it = await noraItem();
    await rejects(`INSERT INTO marketplace_item_reports (item_id, seller_id, reporter_user_id, category, message) VALUES ($1,$2,$3,'other','wrong seller')`, [it.id, SP.sue, U.ben.id]);
    const r = await moderation().reportItem(it.id, U.ben.id, { category: 'offensive', message: 'Offensive wording' });
    await rejects(`UPDATE marketplace_item_reports SET message = 'changed' WHERE id = $1`, [r.id]);
    await rejects('UPDATE marketplace_item_reports SET seller_id = $2 WHERE id = $1', [r.id, SP.sue]);
    await rejects('DELETE FROM marketplace_item_reports WHERE id = $1', [r.id]);
  });
  test('an administrator acts on a report (takes the listing down) once; a reviewed report cannot be reopened', async () => {
    const it = await noraItem();
    const r = await moderation().reportItem(it.id, U.ben.id, { category: 'prohibited_item', message: 'Not allowed to sell this' });
    expect((await call('sue', 'POST', '/api/admin/storefront/reports/' + r.id + '/review', { action: 'dismiss', note: 'Dismissing a rival' })).status).toBe(403);
    const ok = await call('admin', 'POST', '/api/admin/storefront/reports/' + r.id + '/review', { action: 'takedown', note: 'Confirmed prohibited item' });
    expect(ok.body.data.status).toBe('actioned');
    expect((await one('SELECT moderation_status FROM marketplace_items WHERE id = $1', [it.id])).moderation_status).toBe('taken_down');
    expect((await call('admin', 'POST', '/api/admin/storefront/reports/' + r.id + '/review', { action: 'dismiss', note: 'Changing my mind' })).body.code).toBe('ALREADY_REVIEWED');
    await rejects(`UPDATE marketplace_item_reports SET status = 'open' WHERE id = $1`, [r.id]);
  });
});

describe('milestone 2: buyer issues hold the payout for review without deciding fault', () => {
  test('an issue about receiving the item holds the payout; fulfilment cannot make it payable; staff and seller are told without customer details', async () => {
    const email = require('../src/services/emailService');
    email.sendEmail.mockClear();
    const o = await beaBuys(await noraItem());
    const i = await issues.openIssue(o.id, U.bea.id, { category: 'damaged', message: 'Leg snapped in transit, photos available' });
    expect(i.payout_held).toBe(true);
    await call('nora', 'POST', '/api/marketplace/seller/orders/' + o.id + '/fulfillment', { action: 'picked_up' });
    expect(await one('SELECT payout_hold, payout_eligible FROM marketplace_orders WHERE id = $1', [o.id])).toEqual({ payout_hold: true, payout_eligible: false });
    const oa = require('../src/services/ownerAlertService');
    const alert = oa.notifyAdminActionRequired.mock.calls.find((c) => c[0].actionType === 'storefront_order_issue' && c[0].entityId === i.id);
    expect(alert).toBeTruthy();
    expect(JSON.stringify(alert[0])).not.toMatch(/bea@test|BEA|Leg snapped/);
    const mail = email.sendEmail.mock.calls.find((c) => c[0].to === 'nora@test.example');
    expect(mail).toBeTruthy();
    expect(mail[0].text).toMatch(/not a finding about your business/);
    expect(JSON.stringify(mail[0])).not.toMatch(/bea@test|BEA|Leg snapped/);
    expect(email.sendEmail.mock.calls.some((c) => c[0].to === 'sue@test.example')).toBe(false);
  });
  test('a pickup question does not hold the payout', async () => {
    const o = await beaBuys(await noraItem());
    const i = await issues.openIssue(o.id, U.bea.id, { category: 'pickup_problem', message: 'Can I come on Saturday?' });
    expect(i.payout_held).toBe(false);
    expect((await one('SELECT payout_hold FROM marketplace_orders WHERE id = $1', [o.id])).payout_hold).toBe(false);
  });
  test('only an administrator resolving the issue releases the hold, and never while a chargeback or another issue is open', async () => {
    const o = await beaBuys(await noraItem());
    const a = await issues.openIssue(o.id, U.bea.id, { category: 'not_received', message: 'Never arrived' });
    const b = await issues.openIssue(o.id, U.bea.id, { category: 'other', message: 'Also a question' });
    await expect(issues.resolve(a.id, U.admin.id, { resolution_note: 'Delivered per carrier', release_hold: true })).rejects.toMatchObject({ code: 'HOLD_STILL_NEEDED' });
    await issues.resolve(b.id, U.admin.id, { resolution_note: 'Answered the question' });
    const nora = await call('nora', 'POST', '/api/admin/storefront/issues/' + a.id + '/resolve', { resolution_note: 'I resolved it myself', release_hold: true });
    expect(nora.status).toBe(403);
    const ok = await call('admin', 'POST', '/api/admin/storefront/issues/' + a.id + '/resolve', { resolution_note: 'Delivered per carrier photo', release_hold: true });
    expect(ok.body.data.payout_hold_released).toBe(true);
    expect((await one('SELECT payout_hold FROM marketplace_orders WHERE id = $1', [o.id])).payout_hold).toBe(false);
  });
  test('a chargeback keeps the hold even when the issue is resolved', async () => {
    const o = await beaBuys(await noraItem());
    const a = await issues.openIssue(o.id, U.bea.id, { category: 'not_received', message: 'Never arrived at all' });
    await disputes.handleDisputeEvent({ id: 'evt_m2', type: 'charge.dispute.created',
      data: { object: { id: 'dp_m2', payment_intent: o.stripe_payment_intent_id, amount: o.total_charge_cents, currency: 'usd', reason: 'product_not_received', status: 'needs_response' } } });
    await expect(issues.resolve(a.id, U.admin.id, { resolution_note: 'Resolved with buyer', release_hold: true })).rejects.toMatchObject({ code: 'HOLD_STILL_NEEDED' });
  });
});

describe('milestone 2: seller permission architecture', () => {
  const sellerRbac = require('../src/lib/sellerRbac');
  const platformRbac = require('../src/lib/rbac');
  test('no seller role can produce a platform permission or Super Admin', () => {
    for (const role of Object.keys(sellerRbac.SELLER_ROLES)) {
      for (const perm of sellerRbac.permissionsForRole(role)) expect(platformRbac.PERMISSIONS).not.toContain(perm);
    }
    expect(sellerRbac.SELLER_PERMISSIONS.some((p) => platformRbac.PERMISSIONS.includes(p))).toBe(false);
    expect(platformRbac.isSuperAdmin({ role: 'seller', staff_role: 'owner' })).toBe(false);
  });
  test('roles grant only their job: fulfilment cannot edit listings or see finances; inventory cannot fulfil; only the owner manages staff or payouts', () => {
    const can = (role, p) => sellerRbac.hasSellerPermission({ sellerId: 'x', role }, p);
    expect(can('fulfillment', 'company.inventory.edit')).toBe(false); expect(can('fulfillment', 'company.finance.view')).toBe(false); expect(can('fulfillment', 'company.orders.fulfil')).toBe(true);
    expect(can('inventory_manager', 'company.orders.fulfil')).toBe(false); expect(can('inventory_manager', 'company.inventory.edit')).toBe(true);
    expect(can('finance', 'company.payout.manage')).toBe(false); expect(can('finance', 'company.finance.view')).toBe(true);
    for (const r of ['inventory_manager', 'fulfillment', 'finance']) { expect(can(r, 'company.staff.manage')).toBe(false); expect(can(r, 'company.payout.manage')).toBe(false); }
    expect(sellerRbac.STEP_UP_REQUIRED.has('company.payout.manage')).toBe(true);
    expect(sellerRbac.hasSellerPermission({ role: 'owner' }, 'company.orders.view')).toBe(false);   // no seller company → nothing
  });
  test('the seller checkpoint resolves the company from the session: non-sellers are refused before any seller route runs', async () => {
    for (const [m, url] of [['GET', '/api/marketplace/seller/orders'], ['GET', '/api/marketplace/seller/issues'], ['POST', '/api/seller-storefront/items']]) {
      const r = await call('bea', m, url, m === 'POST' ? { title: 'x', price_cents: 100, seller_id: SP.nora } : undefined);
      expect(r.status).toBe(403); expect(r.body.code).toBe('NOT_A_SELLER');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
// Shipping controls (migration 201; owner requirements 2026-10-16; src/lib/storefrontShipping.js)
describe('shipping: defaults to NO everywhere', () => {
  const SHIP = { shippable: true, shipping_method: 'parcel', shipping_destinations: 'us_all', shipping_cost_cents: 2500 };
  test('a new listing is pickup only unless the seller turns shipping on; every seller\'s store default starts off', async () => {
    const it = await items.createDirectListing(U.nora.id, { title: 'Plain listing', price_cents: 5000 });
    expect(it).toMatchObject({ shippable: false, shipping_method: null, shipping_price_mode: null, shipping_cost_cents: null });
    const sp = await one('SELECT shipping_defaults FROM seller_profiles WHERE id = $1', [SP.sue]);
    expect(sp.shipping_defaults).toEqual({ enabled: false });
    const pub = items.publicItem({ ...it, seller_type: 'estate_sale_company' });
    expect(pub.shippable).toBe(false);
    expect(pub.shipping).toMatchObject({ pickup_only: true, shipping: null, summary: 'Pickup only — this item is not shipped' });
  });
  test('a converted auction lot starts pickup only, whatever its auction shipping settings (even if the request asks to ship)', async () => {
    const a = await one(`INSERT INTO auctions (seller_id, title, city, address_state, street_address, zip, state) VALUES ($1,'Ship sale','Houston','TX','1 Nora St','77001','closed') RETURNING id`, [SP.nora]);
    const lot = await one(`INSERT INTO lots (auction_id, title, state, starting_bid_cents, shippable, shipping_cost_cents, shipping_notes)
      VALUES ($1, 'Shippable lamp', 'closed', 500, true, 1800, 'Ships UPS') RETURNING id`, [a.id]);
    const r = await call('nora', 'POST', '/api/seller-storefront/unsold-lots/' + lot.id + '/convert', { edits: { shippable: true } });
    expect(r.status).toBe(201);
    const row = await one('SELECT shippable, shipping_cost_cents, shipping_notes, shipping_method FROM marketplace_items WHERE id = $1', [r.body.data.id]);
    expect(row).toEqual({ shippable: false, shipping_cost_cents: null, shipping_notes: null, shipping_method: null });
  });
});

describe('shipping: never free by accident', () => {
  test('turning shipping on needs a method, destinations and a price — a blank or $0 price is refused, never treated as free', async () => {
    for (const [body, code] of [
      [{ shippable: true, shipping_method: 'parcel', shipping_destinations: 'us_all' }, 'SHIPPING_PRICE_REQUIRED'],
      [{ shippable: true, shipping_method: 'parcel', shipping_destinations: 'us_all', shipping_cost_cents: '' }, 'SHIPPING_PRICE_REQUIRED'],
      [{ shippable: true, shipping_method: 'parcel', shipping_destinations: 'us_all', shipping_cost_cents: 0, shipping_price_mode: 'flat' }, 'SHIPPING_PRICE_REQUIRED'],
      [{ shippable: true, shipping_destinations: 'us_all', shipping_cost_cents: 900 }, 'SHIPPING_METHOD_REQUIRED'],
      [{ shippable: true, shipping_method: 'parcel', shipping_cost_cents: 900 }, 'SHIPPING_DESTINATIONS_REQUIRED'],
      [{ shippable: true, shipping_method: 'parcel', shipping_destinations: 'listed_states', shipping_cost_cents: 900 }, 'SHIPPING_STATES_REQUIRED'],
      [{ shippable: true, shipping_method: 'drone', shipping_destinations: 'us_all', shipping_cost_cents: 900 }, 'SHIPPING_METHOD_INVALID'],
    ]) {
      const r = await call('nora', 'POST', '/api/seller-storefront/items', { title: 'Ship test', price_cents: 4000, ...body });
      expect(r.status).toBe(422); expect(r.body.code).toBe(code);
    }
  });
  test('free shipping is a deliberate choice and carries no price', async () => {
    const r = await call('nora', 'POST', '/api/seller-storefront/items', { title: 'Free ship', price_cents: 4000, shippable: true,
      shipping_method: 'parcel', shipping_destinations: 'us_contiguous', shipping_price_mode: 'free', shipping_cost_cents: 999 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ shippable: true, shipping_price_mode: 'free', shipping_cost_cents: null });
    const { shippingCents } = await orders.loadItemForPurchase(r.body.data.id, U.bea.id, 'shipping', undefined, { shipToState: 'TX' });
    expect(shippingCents).toBe(0);
  });
  test('the database refuses shipping without complete terms, but never blocks status changes on an older listing', async () => {
    const it = await noraItem({ title: 'DB guard' });
    for (const sql of [
      `UPDATE marketplace_items SET shipping_price_mode = NULL, shipping_cost_cents = NULL WHERE id = $1`,
      `UPDATE marketplace_items SET shipping_cost_cents = 0 WHERE id = $1`,
      `UPDATE marketplace_items SET shipping_method = NULL WHERE id = $1`,
      `UPDATE marketplace_items SET shipping_price_mode = 'free' WHERE id = $1`,   // free must not keep a price
    ]) {
      const e = await rejects(sql, [it.id]);
      expect(e.message).toMatch(/shipping needs a method/);
    }
    // an older listing (shippable with only a price, from before migration 201)
    await q('ALTER TABLE marketplace_items DISABLE TRIGGER trg_marketplace_items_shipping_terms');
    const legacy = await one(`INSERT INTO marketplace_items (seller_id, title, price_cents, status, shippable, shipping_cost_cents, city, state,
      pickup_location_source) VALUES ($1, 'Legacy shippable', 3000, 'active', true, 1200, 'Houston', 'TX', 'default') RETURNING *`, [SP.nora]);
    await q('ALTER TABLE marketplace_items ENABLE TRIGGER trg_marketplace_items_shipping_terms');
    await q(`UPDATE marketplace_items SET status = 'removed' WHERE id = $1`, [legacy.id]);   // moderation / sale status changes still work
    await q(`UPDATE marketplace_items SET status = 'active' WHERE id = $1`, [legacy.id]);
    // ...but it cannot be shipped until its seller completes the terms; pickup still works; its page says so
    await expect(orders.loadItemForPurchase(legacy.id, U.bea.id, 'shipping', undefined, { shipToState: 'TX' })).rejects.toMatchObject({ code: 'SHIPPING_DETAILS_INCOMPLETE' });
    expect((await orders.loadItemForPurchase(legacy.id, U.bea.id, 'pickup')).shippingCents).toBe(0);
    const pub = items.publicItem({ ...(await one('SELECT * FROM marketplace_items WHERE id = $1', [legacy.id])), seller_type: 'estate_sale_company' });
    expect(pub.shippable).toBe(false);
    expect(pub.shipping.summary).toBe('Local pickup available · shipping not offered yet');
    // editing an unrelated field is fine; completing the shipping terms makes it shippable
    expect((await call('nora', 'PATCH', '/api/seller-storefront/items/' + legacy.id, { title: 'Legacy, renamed' })).status).toBe(200);
    const fixed = await call('nora', 'PATCH', '/api/seller-storefront/items/' + legacy.id, { shipping_method: 'parcel', shipping_destinations: 'us_all' });
    expect(fixed.status).toBe(200);
    expect((await orders.loadItemForPurchase(legacy.id, U.bea.id, 'shipping', undefined, { shipToState: 'TX' })).shippingCents).toBe(1200);
  });
});

describe('shipping: what the buyer can choose', () => {
  test('a pickup-only item can never be shipped; destinations the seller does not serve are refused', async () => {
    const pick = await items.createDirectListing(U.nora.id, { title: 'Pickup sofa', price_cents: 20000, is_oversized: true });
    await expect(orders.loadItemForPurchase(pick.id, U.bea.id, 'shipping', undefined, { shipToState: 'TX' })).rejects.toMatchObject({ code: 'SHIPPING_UNAVAILABLE' });
    const r = await call('bea', 'POST', '/api/marketplace/orders', { policies_acknowledged: true, item_id: pick.id, fulfillment_method: 'shipping',
      ship_to: { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701' } });
    expect(r.status).toBe(422); expect(r.body.code).toBe('SHIPPING_UNAVAILABLE');
    const lower48 = await noraItem({ title: 'Contiguous only', shipping_destinations: 'us_contiguous' });
    await expect(orders.loadItemForPurchase(lower48.id, U.bea.id, 'shipping', undefined, { shipToState: 'AK' })).rejects.toMatchObject({ code: 'SHIPPING_DESTINATION_NOT_SERVED' });
    const listed = await noraItem({ title: 'Texas only', shipping_destinations: 'listed_states', shipping_states: ['TX', 'ok'] });
    expect(listed.shipping_states).toEqual(['TX', 'OK']);
    await expect(orders.loadItemForPurchase(listed.id, U.bea.id, 'shipping', undefined, { shipToState: 'CA' })).rejects.toMatchObject({ code: 'SHIPPING_DESTINATION_NOT_SERVED' });
    const ok = await call('bea', 'POST', '/api/marketplace/orders', { policies_acknowledged: true, item_id: listed.id, fulfillment_method: 'shipping',
      ship_to: { line1: '5 Buyer Rd', city: 'Tulsa', state: 'OK', postal_code: '74101' } });
    expect(ok.status).toBe(200);
    const bad = await call('ben', 'POST', '/api/marketplace/orders', { policies_acknowledged: true, item_id: lower48.id, fulfillment_method: 'shipping',
      ship_to: { line1: '1 Ice Rd', city: 'Juneau', state: 'AK', postal_code: '99801' } });
    expect(bad.status).toBe(422); expect(bad.body.code).toBe('SHIPPING_DESTINATION_NOT_SERVED');
    expect(await one(`SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1`, [lower48.id])).toEqual({ n: 0 });
  });
  test('the 11% fee is on the item price only; shipping is charged as set and recorded with the terms on the order', async () => {
    const it = await noraItem({ title: 'Fee base', handling_days: 3, is_fragile: true });
    const o = await (async () => {
      const created = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true,  fulfillment_method: 'shipping', ship_to: { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } });
      await orders.payOrder(created.order.id, U.bea.id, { paymentMethodId: 'pm_bea' });
      return one('SELECT * FROM marketplace_orders WHERE id = $1', [created.order.id]);
    })();
    expect(o).toMatchObject({ item_price_cents: 10000, shipping_cents: 1500, total_charge_cents: 11500, platform_fee_bps: 1100, platform_fee_cents: 1100,
      seller_proceeds_cents: 10000 - 1100 + 1500, fulfillment_method: 'shipping' });
    expect(o.item_snapshot.shipping_terms).toEqual({ selected: 'shipping', shipping_cents: 1500,
      offered: { method: 'parcel', price_mode: 'flat', shipping_cents: 1500, destinations: 'us_all', states: [], handling_days: 3 },
      oversized: false, fragile: true, notes: null });
    // the order's record of the terms can never change, and the sold item's shipping can no longer be edited
    const e = await rejects(`UPDATE marketplace_orders SET item_snapshot = jsonb_set(item_snapshot, '{shipping_terms,shipping_cents}', '0') WHERE id = $1`, [o.id]);
    expect(e.message).toMatch(/purchase terms are fixed/);
    const edit = await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { shipping_cost_cents: 100 });
    expect(edit.status).toBe(409);
    expect((await one('SELECT shipping_cost_cents FROM marketplace_items WHERE id = $1', [it.id])).shipping_cost_cents).toBe(1500);
  });
  test('shipping terms cannot change while a buyer is checking out', async () => {
    const it = await noraItem({ title: 'Reserved ship' });
    await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true,  fulfillment_method: 'shipping', ship_to: { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } });
    for (const patch of [{ shipping_cost_cents: 1 }, { shippable: false }, { shipping_price_mode: 'free' }]) {
      const r = await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, patch);
      expect(r.status).toBe(409); expect(r.body.code).toBe('ITEM_RESERVED');
    }
    expect((await one('SELECT shipping_cost_cents, shippable FROM marketplace_items WHERE id = $1', [it.id]))).toEqual({ shipping_cost_cents: 1500, shippable: true });
  });
});

describe('shipping: store default and seller isolation', () => {
  test('the store default is off until set; saving it never changes existing listings; it applies only when chosen', async () => {
    const before = await items.createDirectListing(U.sue.id, { title: 'Sue existing', price_cents: 3000 });
    const snapshotSue = await q(`SELECT id, shippable, shipping_method, shipping_cost_cents FROM marketplace_items WHERE seller_id = $1 ORDER BY id`, [SP.sue]);
    const noDefault = await call('sue', 'POST', '/api/seller-storefront/items', { title: 'x', price_cents: 1000, apply_store_shipping_defaults: true });
    expect(noDefault.body.code).toBe('NO_STORE_SHIPPING_DEFAULT');
    const bad = await call('sue', 'PUT', '/api/seller-storefront/shipping-defaults', { enabled: true, shipping_method: 'freight', shipping_destinations: 'us_all' });
    expect(bad.status).toBe(422); expect(bad.body.code).toBe('SHIPPING_PRICE_REQUIRED');
    const set = await call('sue', 'PUT', '/api/seller-storefront/shipping-defaults', { enabled: true, shipping_method: 'freight',
      shipping_destinations: 'us_contiguous', shipping_cost_cents: 15000, handling_days: 5, is_oversized: true });
    expect(set.status).toBe(200);
    expect(await q(`SELECT id, shippable, shipping_method, shipping_cost_cents FROM marketplace_items WHERE seller_id = $1 ORDER BY id`, [SP.sue])).toEqual(snapshotSue);
    expect((await one('SELECT shippable FROM marketplace_items WHERE id = $1', [before.id])).shippable).toBe(false);
    // a new item does NOT get the default unless the seller chooses it
    const plain = await call('sue', 'POST', '/api/seller-storefront/items', { title: 'Sue plain', price_cents: 2000 });
    expect(plain.body.data.shippable).toBe(false);
    const withDef = await call('sue', 'POST', '/api/seller-storefront/items', { title: 'Sue armoire', price_cents: 90000, apply_store_shipping_defaults: true });
    expect(withDef.body.data).toMatchObject({ shippable: true, shipping_method: 'freight', shipping_cost_cents: 15000, shipping_destinations: 'us_contiguous',
      handling_days: 5, is_oversized: true });
    // Nora's store default is untouched by Sue's
    expect((await one('SELECT shipping_defaults FROM seller_profiles WHERE id = $1', [SP.nora])).shipping_defaults).toEqual({ enabled: false });
  });
  test('another seller, a buyer or Finance staff cannot change an item\'s shipping or a store\'s default', async () => {
    const it = await noraItem({ title: 'Isolated shipping' });
    for (const [who, body] of [['sue', { shipping_cost_cents: 1 }], ['sue', { shippable: false }], ['bea', { shipping_price_mode: 'free' }]]) {
      const r = await call(who, 'PATCH', '/api/seller-storefront/items/' + it.id, body);
      expect(r.status).toBe(403);
    }
    expect(await one('SELECT shippable, shipping_cost_cents, shipping_price_mode FROM marketplace_items WHERE id = $1', [it.id]))
      .toEqual({ shippable: true, shipping_cost_cents: 1500, shipping_price_mode: 'flat' });
    const asBuyer = await call('bea', 'PUT', '/api/seller-storefront/shipping-defaults', { enabled: false });
    expect(asBuyer.status).toBe(403);
    // a seller id in the body is ignored: Sue saving "for Nora" saves Sue's own default
    await call('sue', 'PUT', '/api/seller-storefront/shipping-defaults', { enabled: false, seller_id: SP.nora });
    expect((await one('SELECT shipping_defaults FROM seller_profiles WHERE id = $1', [SP.sue])).shipping_defaults).toEqual({ enabled: false });
  });
});

describe('shipping: shown accurately to buyers and search engines', () => {
  test('the item page and its structured data state the real shipping or pickup terms', async () => {
    const pages = require('../src/services/productPageService');
    const pd = require('../src/lib/productData');
    const shipped = await noraItem({ title: 'Shipped Mirror', handling_days: 2 });
    let r = await pages.render(shipped.id, pd.slugify(shipped.title), 'https://bid.advantage.bid');
    expect(r.html).toContain('Shipping $15.00 (Parcel shipping) · ships to anywhere in the United States · ships within 2 business days · Local pickup available');
    const ld = [...r.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((j) => j['@type'] === 'Product');
    expect(ld.offers.shippingDetails).toEqual({ '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: '15.00', currency: 'USD' },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
      deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 2, unitCode: 'DAY' } } });
    expect(ld.offers.price).toBe('100.00');   // item price only
    const pickup = await items.createDirectListing(U.nora.id, { title: 'Pickup Hutch', price_cents: 30000, is_oversized: true });
    r = await pages.render(pickup.id, pd.slugify(pickup.title), 'https://bid.advantage.bid');
    expect(r.html).toContain('Pickup only — this item is not shipped');
    expect(r.html).toContain('Oversized item');
    const ld2 = [...r.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((j) => j['@type'] === 'Product');
    expect(ld2.offers.shippingDetails).toBeUndefined();
    // the storefront grid's "Ships" marker follows what can actually be bought
    const list = await items.listPublicForSeller(SP.nora, 500);
    expect(list.find((x) => x.id === shipped.id).shippable).toBe(true);
    expect(list.find((x) => x.id === pickup.id).shippable).toBe(false);
    expect(Object.keys(list[0])).not.toContain('shipping_cost_cents');
  });
});

describe('shipping: review fixes (US only, quoted price confirmed, consistent public data)', () => {
  test('shipping only to US addresses: a foreign country is refused even with a US state code', async () => {
    const it = await noraItem({ title: 'US only' });
    const r = await call('bea', 'POST', '/api/marketplace/orders', { policies_acknowledged: true, item_id: it.id, fulfillment_method: 'shipping',
      ship_to: { line1: '1 Calle', city: 'Monterrey', state: 'TX', postal_code: '64000', country: 'MX' } });
    expect(r.status).toBe(422); expect(r.body.code).toBe('SHIPPING_DESTINATION_NOT_SERVED');
    await expect(orders.quote(it.id, U.bea.id, { fulfillment_method: 'shipping', ship_to: { line1: 'x', city: 'y', postal_code: '1' } }))
      .rejects.toMatchObject({ code: 'SHIPPING_DESTINATION_NOT_SERVED' });   // an address without a state is not served
  });
  test('if the seller changed the price or shipping after the buyer reviewed it, the order is refused (never charged silently)', async () => {
    const it = await noraItem({ title: 'Changed after review' });
    const ship = { line1: '5 Buyer Rd', city: 'Austin', state: 'TX', postal_code: '78701' };
    const q1 = await orders.quote(it.id, U.bea.id, { fulfillment_method: 'shipping', ship_to: ship });
    expect(q1.breakdown.shipping_cents).toBe(1500);
    await call('nora', 'PATCH', '/api/seller-storefront/items/' + it.id, { shipping_cost_cents: 4000 });
    const r = await call('bea', 'POST', '/api/marketplace/orders', { policies_acknowledged: true, item_id: it.id, fulfillment_method: 'shipping', ship_to: ship,
      expected_item_price_cents: q1.breakdown.item_price_cents, expected_shipping_cents: q1.breakdown.shipping_cents });
    expect(r.status).toBe(409); expect(r.body.code).toBe('PRICE_CHANGED');
    expect(await one('SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1', [it.id])).toEqual({ n: 0 });
    expect((await one('SELECT status FROM marketplace_items WHERE id = $1', [it.id])).status).toBe('active');   // not left reserved
    const ok = await call('bea', 'POST', '/api/marketplace/orders', { policies_acknowledged: true, item_id: it.id, fulfillment_method: 'shipping', ship_to: ship,
      expected_item_price_cents: 10000, expected_shipping_cents: 4000 });
    expect(ok.status).toBe(200);
  });
  test('an older listing never shows a shipping price buyers cannot actually pay', async () => {
    const row = { id: 'x', title: 'Old', price_cents: 100, status: 'active', shippable: true, shipping_cost_cents: 1200, seller_type: 'auction_house' };
    const pub = items.publicItem(row);
    expect(pub).toMatchObject({ shippable: false, shipping_cost_cents: null });
    const full = items.publicItem({ ...row, shipping_method: 'parcel', shipping_destinations: 'us_all', shipping_price_mode: 'flat' });
    expect(full).toMatchObject({ shippable: true, shipping_cost_cents: 1200 });
  });
  test('the demo seed keeps its item pickup only (no invented shipping cost or delivery promise)', () => {
    const seed = fs.readFileSync(path.join(ROOT, 'scripts', 'seed-demo-storefront.js'), 'utf8');
    expect(seed).toMatch(/'Maplewood','OH', false, NULL,/);
    expect(seed).toMatch(/shippable=false, shipping_cost_cents=NULL/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
// Seller Store Terms & Conditions and Shipping & Pickup Policy (migration 203; roadmap §7.2–7.4)
describe('seller policies: each company writes and publishes its own', () => {
  const NORA_TERMS = 'Nora Estate Sales store terms. All items are sold as described. Inspection welcome by appointment.';
  test('the owner saves a draft (not public), publishes it, and a seller id in the request is ignored', async () => {
    const d = await call('nora', 'PUT', '/api/seller-storefront/policies/store_terms', { body: NORA_TERMS, seller_id: SP.sue });
    expect(d.status).toBe(200); expect(d.body.data).toMatchObject({ version: 1, status: 'draft' });
    expect((await one(`SELECT seller_id FROM seller_policy_versions WHERE id = $1`, [d.body.data.id])).seller_id).toBe(SP.nora);
    const pub0 = await call('bea', 'GET', '/api/public/storefront/nora/policies');
    expect(pub0.body.data.store_terms).toBeNull();                       // a draft is never public
    const p = await call('nora', 'POST', '/api/seller-storefront/policies/store_terms/publish');
    expect(p.status).toBe(200); expect(p.body.data).toMatchObject({ version: 1, status: 'published' });
    const pub = await call('bea', 'GET', '/api/public/storefront/nora/policies');
    expect(pub.body.data.store_terms).toMatchObject({ version: 1, body: NORA_TERMS, path: 'terms' });
    expect(pub.body.data.shipping_pickup).toBeNull();
  });
  test("Sue cannot read or change Nora's policies; buyers cannot use the editor", async () => {
    await call('sue', 'PUT', '/api/seller-storefront/policies/store_terms', { body: 'Sue draft terms that are long enough to publish.', seller_id: SP.nora });
    const sueView = await call('sue', 'GET', '/api/seller-storefront/policies');
    expect(JSON.stringify(sueView.body.data)).not.toContain('Nora Estate Sales store terms');
    expect((await call('sue', 'POST', '/api/seller-storefront/policies/store_terms/publish')).status).toBe(200);
    expect((await call('bea', 'PUT', '/api/seller-storefront/policies/store_terms', { body: 'hijack hijack hijack hijack' })).status).toBe(403);
    expect((await call('bea', 'GET', '/api/seller-storefront/policies')).status).toBe(403);
    expect((await call('nora', 'PUT', '/api/seller-storefront/policies/refunds', { body: 'x'.repeat(30) })).status).toBe(404);
    expect((await call('bea', 'GET', '/api/public/storefront/nora/policies')).body.data.store_terms.body).toBe(NORA_TERMS);
  });
  test('published words can never change, versions are never deleted, and a new version supersedes the old', async () => {
    const v1 = await one(`SELECT id FROM seller_policy_versions WHERE seller_id = $1 AND kind = 'store_terms' AND status = 'published'`, [SP.nora]);
    for (const sql of [`UPDATE seller_policy_versions SET body = 'rewritten' WHERE id = $1`, `DELETE FROM seller_policy_versions WHERE id = $1`,
      `UPDATE seller_policy_versions SET status = 'draft' WHERE id = $1`, `UPDATE seller_policy_versions SET seller_id = '${SP.sue}' WHERE id = $1`]) {
      const e = await rejects(sql, [v1.id]);
      expect(e.message).toMatch(/never be rewritten|kept permanently|cannot become|keeps its seller/);
    }
    const ins = await rejects(`INSERT INTO seller_policy_versions (seller_id, kind, version, status, body, content_hash, created_by) VALUES ($1,'store_terms',99,'published','x','h',$2)`, [SP.nora, U.nora.id]);
    expect(ins.message).toMatch(/starts as a draft/);
    expect((await call('nora', 'POST', '/api/seller-storefront/policies/store_terms/publish')).body.code).toBe('NO_DRAFT');
    await call('nora', 'PUT', '/api/seller-storefront/policies/store_terms', { body: 'Nora store terms, version two. Returns within 3 days.' });
    expect((await call('nora', 'POST', '/api/seller-storefront/policies/store_terms/publish')).body.data.version).toBe(2);
    expect(await one(`SELECT status FROM seller_policy_versions WHERE id = $1`, [v1.id])).toEqual({ status: 'superseded' });
    const owner = (await call('nora', 'GET', '/api/seller-storefront/policies')).body.data.store_terms;
    expect(owner.history.map((h) => [h.version, h.status])).toEqual([[2, 'published'], [1, 'superseded']]);
  });
  test('the public policy pages show the right seller, escape seller text, and 404 when nothing is published', async () => {
    await call('nora', 'PUT', '/api/seller-storefront/policies/shipping_pickup', { body: 'Pickup within 7 days.\n\n<script>alert(1)</script> We ship freight.' });
    await call('nora', 'POST', '/api/seller-storefront/policies/shipping_pickup/publish');
    const pages = require('../src/services/policyPageService');
    const r = await pages.render('nora', 'shipping-pickup', 'https://bid.advantage.bid');
    expect(r.status).toBe(200);
    expect(r.html).toContain('<h1>Shipping &amp; Pickup Policy</h1>');
    expect(r.html).toContain('Nora Estate Sales');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('<link rel="canonical" href="https://bid.advantage.bid/pro/nora/shipping-pickup">');
    expect(r.html).toContain('Buyer Terms');
    expect(r.html).not.toMatch(/Sue Auctions|Sue draft terms/);
    expect((await pages.render('sue', 'shipping-pickup', 'https://bid.advantage.bid')).status).toBe(404);
    expect((await pages.render('nora', 'refunds', 'https://bid.advantage.bid')).status).toBe(404);
    const sm = await require('../src/services/productPageService').sitemapEntries();
    expect(sm.policies.map((p) => p.path)).toEqual(expect.arrayContaining(['/pro/nora/terms', '/pro/nora/shipping-pickup', '/pro/sue/terms']));
  });
  test("every item links to its own seller's policies, never another seller's", async () => {
    const it = await noraItem({ title: 'Policy-linked chest' });
    const pub = await items.getPublicItem(it.id);
    expect(pub.policies).toEqual({ store_terms: true, shipping_pickup: true });
    const pd = require('../src/lib/productData');
    const html = (await require('../src/services/productPageService').render(it.id, pd.slugify(it.title), 'https://bid.advantage.bid')).html;
    expect(html).toContain('href="/pro/nora/terms"'); expect(html).toContain('href="/pro/nora/shipping-pickup"');
    expect(html).not.toContain('/pro/sue/');
    const sueItem = await items.createDirectListing(U.sue.id, { title: 'Sue vase', price_cents: 2000 });
    expect((await items.getPublicItem(sueItem.id)).policies).toEqual({ store_terms: true, shipping_pickup: false });
  });
});

describe('seller policies at checkout: acknowledged and recorded permanently', () => {
  test('an order needs the acknowledgment and records the exact policy versions; later edits never change it', async () => {
    const it = await noraItem({ title: 'Acknowledged sideboard' });
    const noAck = await call('bea', 'POST', '/api/marketplace/orders', { item_id: it.id, fulfillment_method: 'pickup' });
    expect(noAck.status).toBe(422); expect(noAck.body.code).toBe('POLICIES_ACK_REQUIRED');
    expect(await one('SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1', [it.id])).toEqual({ n: 0 });
    const r = await call('bea', 'POST', '/api/marketplace/orders', { item_id: it.id, fulfillment_method: 'pickup', policies_acknowledged: true });
    expect(r.status).toBe(200);
    const o = await one('SELECT policy_snapshot, policies_acknowledged_at FROM marketplace_orders WHERE id = $1', [r.body.data.order.id]);
    const terms = await one(`SELECT id, version, content_hash FROM seller_policy_versions WHERE seller_id = $1 AND kind = 'store_terms' AND status = 'published'`, [SP.nora]);
    expect(o.policy_snapshot.store_terms).toMatchObject({ version_id: terms.id, version: terms.version, content_hash: terms.content_hash });
    expect(o.policy_snapshot.shipping_pickup).toBeTruthy();
    expect(o.policies_acknowledged_at).toBeTruthy();
    // Nora publishes a new version: the order still records the one that applied
    await call('nora', 'PUT', '/api/seller-storefront/policies/store_terms', { body: 'Nora store terms, version three, published after the order.' });
    await call('nora', 'POST', '/api/seller-storefront/policies/store_terms/publish');
    const again = await one('SELECT policy_snapshot FROM marketplace_orders WHERE id = $1', [r.body.data.order.id]);
    expect(again.policy_snapshot.store_terms.version_id).toBe(terms.id);
    const e = await rejects(`UPDATE marketplace_orders SET policy_snapshot = '{}'::jsonb WHERE id = $1`, [r.body.data.order.id]);
    expect(e.message).toMatch(/can never change/);
    const e2 = await rejects(`UPDATE marketplace_orders SET policies_acknowledged_at = now() - interval '1 day' WHERE id = $1`, [r.body.data.order.id]);
    expect(e2.message).toMatch(/can never change/);
  });
  test('a seller without published policies still requires the platform terms acknowledgment and records nulls', async () => {
    const pat = await one(`INSERT INTO users (email, full_name, role) VALUES ('pat2@test.example', 'PAT2', 'seller') RETURNING *`);
    U.pat2 = pat;
    const sp = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city, default_pickup_state,
      default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at) VALUES ($1,'auction_house','Pat Co','3 Pat Rd','Houston','TX','77001','US', now()) RETURNING id`, [pat.id])).id;
    const it = await items.createDirectListing(pat.id, { title: 'No-policy item', price_cents: 1500 });
    const c = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true });
    const o = await one('SELECT seller_id, policy_snapshot FROM marketplace_orders WHERE id = $1', [c.order.id]);
    expect(o.seller_id).toBe(sp);
    expect(o.policy_snapshot).toMatchObject({ store_terms: null, shipping_pickup: null });
  });
});

describe('seller policies: review fixes (changed after review, hidden branding, admin withdrawal)', () => {
  test('if the seller publishes a new version after the buyer reviewed the policies, the order is refused', async () => {
    const it = await noraItem({ title: 'Changed policy item' });
    const seen = (await items.getPublicItem(it.id)).policy_versions;
    expect(seen.store_terms).toBeGreaterThan(0);
    await call('nora', 'PUT', '/api/seller-storefront/policies/store_terms', { body: 'Nora store terms, a newer version published mid-checkout.' });
    await call('nora', 'POST', '/api/seller-storefront/policies/store_terms/publish');
    const r = await call('bea', 'POST', '/api/marketplace/orders', { item_id: it.id, policies_acknowledged: true, expected_policy_versions: seen });
    expect(r.status).toBe(409); expect(r.body.code).toBe('POLICIES_CHANGED');
    expect(await one('SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1', [it.id])).toEqual({ n: 0 });
    const fresh = (await items.getPublicItem(it.id)).policy_versions;
    expect((await call('bea', 'POST', '/api/marketplace/orders', { item_id: it.id, policies_acknowledged: true, expected_policy_versions: fresh })).status).toBe(200);
  });
  test('a seller whose branding is hidden: its policies are not shown, not required and not recorded (no seller leak)', async () => {
    await q('UPDATE seller_profiles SET show_branding_to_buyers = false WHERE id = $1', [SP.sue]);
    try {
      const it = await items.createDirectListing(U.sue.id, { title: 'Hidden-brand lamp', price_cents: 3000 });
      const pub = await items.getPublicItem(it.id);
      expect(pub.policies).toEqual({ store_terms: false, shipping_pickup: false });
      expect(pub.policy_versions).toEqual({ store_terms: null, shipping_pickup: null });
      expect(JSON.stringify(pub)).not.toMatch(/\/pro\/sue|Sue Auctions/);
      const c = await orders.createOrder(it.id, U.bea.id, { policiesAcknowledged: true, expectedPolicyVersions: pub.policy_versions });
      const o = await one('SELECT policy_snapshot FROM marketplace_orders WHERE id = $1', [c.order.id]);
      expect(o.policy_snapshot).toMatchObject({ store_terms: null, shipping_pickup: null, seller_policies_shown: false });
    } finally { await q('UPDATE seller_profiles SET show_branding_to_buyers = true WHERE id = $1', [SP.sue]); }
  });
  test('Advantage.Bid can withdraw a published policy with a reason; the text stays on record; sellers and buyers cannot', async () => {
    const v = await one(`SELECT id FROM seller_policy_versions WHERE seller_id = $1 AND kind = 'shipping_pickup' AND status = 'published'`, [SP.nora]);
    for (const who of ['nora', 'sue', 'bea']) expect((await call(who, 'POST', `/api/admin/storefront/policies/${v.id}/withdraw`, { reason: 'Misleading terms' })).status).toBe(403);
    expect((await call('admin', 'POST', `/api/admin/storefront/policies/${v.id}/withdraw`, { reason: 'x' })).body.code).toBe('REASON_REQUIRED');
    const w = await call('admin', 'POST', `/api/admin/storefront/policies/${v.id}/withdraw`, { reason: 'Contradicts the Buyer Terms on refunds' });
    expect(w.status).toBe(200); expect(w.body.data.status).toBe('withdrawn');
    expect((await call('bea', 'GET', '/api/public/storefront/nora/policies')).body.data.shipping_pickup).toBeNull();
    expect((await require('../src/services/policyPageService').render('nora', 'shipping-pickup', 'https://bid.advantage.bid')).status).toBe(404);
    const kept = await one('SELECT body, withdrawn_reason FROM seller_policy_versions WHERE id = $1', [v.id]);
    expect(kept.body).toMatch(/Pickup within 7 days/); expect(kept.withdrawn_reason).toMatch(/Buyer Terms/);
    const e = await rejects(`UPDATE seller_policy_versions SET status = 'published' WHERE id = $1`, [v.id]);
    expect(e.message).toMatch(/cannot become/);
    // the seller can publish a corrected version
    await call('nora', 'PUT', '/api/seller-storefront/policies/shipping_pickup', { body: 'Corrected shipping and pickup policy for our store.' });
    expect((await call('nora', 'POST', '/api/seller-storefront/policies/shipping_pickup/publish')).status).toBe(200);
  });
});
