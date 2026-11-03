'use strict';

/**
 * Storefront payouts (migration 213; storefrontSettlementService): weekly per-seller records of paid, fulfilled,
 * unrefunded, undisputed orders; prepared automatically, paid only by an administrator's Pay Seller (one transfer to the
 * seller's connected account). Real Postgres (PGlite) with the real migrations; the payment processor is an in-memory
 * stand-in (same harness as storefront-multi-quantity.test.js).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-storefront-payouts'; // test value, never a real secret

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
    '206_sold_price_privacy_and_message_moderation.sql', '207_storefront_bulk_import.sql', '209_marketplace_inventory_importer.sql', '211_retail_gallery_studio_seller_type.sql', '212_marketplace_multi_quantity.sql', '213_storefront_payouts.sql']) {
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



const S = () => require('../src/services/storefrontSettlementService');
const listQ = (qty, price = 10000, owner = 'sue') => items.createDirectListing(U[owner].id, { title: 'Payout item ' + Math.random().toString(36).slice(2, 7), price_cents: price, quantity: qty });
const buy = (itemId, buyer, quantity = 1) => call(buyer, 'POST', '/api/marketplace/orders', { item_id: itemId, policies_acknowledged: true, quantity });
// A paid order, picked up (fulfilled) at `when`.
async function sale(price = 10000, { when = new Date(Date.now() - 3 * 864e5), owner = 'sue' } = {}) {
  const it = await listQ(1, price, owner);
  const o = await buy(it.id, 'bea');
  await pay(o.body.data.order.id, 'bea');
  const id = o.body.data.order.id;
  await orders.updateFulfillment(id, U[owner].id, 'picked_up');
  await q('UPDATE marketplace_orders SET payout_eligible_at = $2 WHERE id = $1', [id, when]);
  return id;
}
const payoutsOf = (owner = 'sue') => q(`SELECT * FROM storefront_payouts WHERE seller_profile_id = $1 ORDER BY created_at`, [SP[owner]]);
const future = new Date(Date.now() + 864e5);   // a cutoff after every sale in these tests

describe('the weekly cutoff (Wednesday 11:59 PM Eastern)', () => {
  test.each([
    ['2026-11-05T15:00:00Z', '2026-11-05T04:59:59.999Z'],   // Thursday: the night before (EST, UTC-5)
    ['2026-11-04T20:00:00Z', '2026-10-29T03:59:59.999Z'],   // Wednesday afternoon: last week (EDT, UTC-4)
    ['2026-11-05T05:30:00Z', '2026-11-05T04:59:59.999Z'],   // just after midnight Thursday Eastern
    ['2026-07-09T12:00:00Z', '2026-07-09T03:59:59.999Z'],   // summer (EDT)
  ])('at %s the cutoff is %s', (now, cutoff) => {
    expect(S().cutoffFor(new Date(now)).toISOString()).toBe(cutoff);
  });
});

describe('preparing payouts', () => {
  test('only paid, fulfilled, unrefunded, undisputed, unheld orders completed before the cutoff; the amount is the seller proceeds', async () => {
    const good = await sale(10000);
    const notFulfilled = await (async () => { const it = await listQ(1); const o = await buy(it.id, 'bea'); await pay(o.body.data.order.id, 'bea'); return o.body.data.order.id; })();
    const late = await sale(5000, { when: new Date(Date.now() + 2 * 864e5) });
    const held = await sale(7000); await q('UPDATE marketplace_orders SET payout_hold = true WHERE id = $1', [held]);
    const disputed = await sale(8000);
    const dpi = (await one('SELECT stripe_payment_intent_id FROM marketplace_orders WHERE id = $1', [disputed])).stripe_payment_intent_id;
    await q(`INSERT INTO payment_disputes (stripe_dispute_id, payment_intent_id, status) VALUES ('dp_1', $1, 'needs_response')`, [dpi]);
    const out = await S().prepareWeek({ cutoff: future });
    expect(out.prepared).toBe(1);
    const [p] = await payoutsOf();
    const ls = await q('SELECT marketplace_order_id, goods_cents, platform_fee_cents, amount_cents FROM storefront_payout_lines WHERE storefront_payout_id = $1', [p.id]);
    expect(ls.map((l) => l.marketplace_order_id)).toEqual([good]);
    expect(ls[0]).toMatchObject({ goods_cents: 10000, platform_fee_cents: 1100, amount_cents: 8900 });
    expect(p).toMatchObject({ order_count: 1, goods_cents: 10000, platform_fee_cents: 1100, seller_payout_cents: 8900, settlement_status: 'pending_review', payout_status: 'pending' });
    for (const id of [notFulfilled, late, held, disputed]) expect((await one('SELECT storefront_payout_id FROM marketplace_orders WHERE id = $1', [id])).storefront_payout_id).toBeNull();
  });

  test('preparing again adds new orders to the same record and never includes an order twice', async () => {
    await S().prepareWeek({ cutoff: future });
    const before = (await payoutsOf())[0];
    const extra = await sale(2000);
    await S().prepareWeek({ cutoff: future });
    await S().prepareWeek({ cutoff: future });
    const after = await payoutsOf();
    expect(after).toHaveLength(1);
    expect(after[0].order_count).toBe(before.order_count + 1);
    expect(after[0].seller_payout_cents).toBe(before.seller_payout_cents + 1780);
    expect((await one('SELECT count(*)::int n FROM storefront_payout_lines WHERE marketplace_order_id = $1', [extra])).n).toBe(1);
  });

  test('each seller gets their own record; the seller sees only their own', async () => {
    await sale(3000, { owner: 'gus' });
    await S().prepareWeek({ cutoff: future });
    const gus = await S().listForSeller(SP.gus);
    expect(gus).toHaveLength(1);
    expect(gus[0].lines.every((l) => l.title.startsWith('Payout item'))).toBe(true);
    expect(gus[0].seller_payout_cents).toBe(2670);
    expect(gus[0]).not.toHaveProperty('stripe_transfer_id');
    const sue = await S().listForSeller(SP.sue);
    expect(sue.every((p) => p.seller_profile_id === SP.sue)).toBe(true);
  });
});

describe('paying (administrator only, one transfer)', () => {
  test('refused: no confirmation, wrong amount, payout account not ready, on hold', async () => {
    const [p] = await payoutsOf();
    await expect(S().payPayout(p.id, { actorId: U.admin.id, finalAmountCents: p.seller_payout_cents })).rejects.toMatchObject({ code: 'NOT_PAYABLE' });
    await expect(S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents - 1 })).rejects.toMatchObject({ code: 'NOT_PAYABLE' });
    await q('UPDATE seller_payout_preferences SET connect_payouts_enabled = false WHERE seller_user_id = $1', [U.sue.id]);
    await expect(S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents })).rejects.toThrow(/not ready/);
    await q('UPDATE seller_payout_preferences SET connect_payouts_enabled = true WHERE seller_user_id = $1', [U.sue.id]);
    await S().setHold(p.id, U.admin.id, { hold: true, reason: 'Checking a return' });
    await expect(S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents })).rejects.toThrow(/on hold/);
    await S().setHold(p.id, U.admin.id, { hold: false });
    expect(mockStripe.transfers).toHaveLength(0);
  });

  test('an order refunded after the record was prepared blocks payment until it is voided and prepared again', async () => {
    const extra = await sale(4000);
    await S().prepareWeek({ cutoff: future });
    const [p] = await payoutsOf();
    await orders.refundOrder(extra, { adminId: U.admin.id, reason: 'Customer returned it' });
    await expect(S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents })).rejects.toThrow(/changed since this payout was prepared/);
    await S().voidPayout(p.id, U.admin.id, { reason: 'Refund after preparation' });
    await S().prepareWeek({ cutoff: future });
    const live = (await payoutsOf()).filter((x) => x.settlement_status !== 'void');
    expect(live).toHaveLength(1);
    expect((await one('SELECT count(*)::int n FROM storefront_payout_lines WHERE marketplace_order_id = $1 AND active', [extra])).n).toBe(0);
  });

  test('paid once: one transfer to the seller\'s connected account for exactly the record; a repeat is refused', async () => {
    const p = (await payoutsOf()).find((x) => x.settlement_status === 'pending_review');
    const out = await S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents });
    expect(out).toMatchObject({ paid: true, amount_cents: p.seller_payout_cents, payout_status: 'processing' });
    expect(mockStripe.transfers).toHaveLength(1);
    expect(mockStripe.transfers[0]).toMatchObject({ amount: p.seller_payout_cents, currency: 'usd', key: 'storefront-transfer:' + p.id });
    expect(mockStripe.transfers[0].destination).toMatch(/^acct_test_/);
    await expect(S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents })).rejects.toThrow(/already paid/);
    expect(mockStripe.transfers).toHaveLength(1);
    const settled = await q('SELECT settled_at FROM marketplace_orders WHERE storefront_payout_id = $1', [p.id]);
    expect(settled.every((r) => r.settled_at)).toBe(true);
    // the transfer webhooks update the record (the same handler as auction payouts)
    const engine = require('../src/services/settlementEngine');
    // (this harness's minimal auction payout table gets the columns the shared transfer webhook also updates)
    await q(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS stripe_transfer_id text, ADD COLUMN IF NOT EXISTS payout_status text,
             ADD COLUMN IF NOT EXISTS transfer_failure_message text`);
    await engine.applyTransferEvent('transfer.created', { id: out.stripe_transfer_id });
    expect((await one('SELECT payout_status FROM storefront_payouts WHERE id = $1', [p.id])).payout_status).toBe('released');
    // a paid record never changes: later sales go to a new week
    await sale(1000);
    await S().prepareWeek({ cutoff: future });
    expect((await one('SELECT seller_payout_cents FROM storefront_payouts WHERE id = $1', [p.id])).seller_payout_cents).toBe(p.seller_payout_cents);
  });

  test('a transfer that fails marks nothing paid (safe to try again)', async () => {
    await sale(1500, { owner: 'gus' });
    await S().prepareWeek({ cutoff: future });
    const p = (await payoutsOf('gus')).find((x) => x.settlement_status === 'pending_review');
    mockStripe.failTransfer = true;
    await expect(S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents })).rejects.toMatchObject({ code: 'TRANSFER_FAILED' });
    mockStripe.failTransfer = false;
    expect((await one('SELECT settlement_status, stripe_transfer_id FROM storefront_payouts WHERE id = $1', [p.id]))).toMatchObject({ settlement_status: 'pending_review', stripe_transfer_id: null });
  });
});

describe('owner and Admin/Finance notice when a storefront order is paid (roadmap 13.G)', () => {
  test('one notice per paid order per verified administrator; none for an unverified one; never for a demo order; no buyer details', async () => {
    await q('UPDATE users SET email_verified = true WHERE id = $1', [U.admin.id]);
    const id = await sale(6400);
    const rows = await q(`SELECT event, recipient_email FROM storefront_notifications WHERE order_id = $1 ORDER BY event`, [id]);
    expect(rows).toEqual([
      { event: 'sale_paid', recipient_email: 'sue@test.example' },
      { event: 'sale_paid_admin', recipient_email: 'admin@test.example' },
    ]);
    // a replayed payment notice queues nothing more
    const o = await one('SELECT stripe_payment_intent_id FROM marketplace_orders WHERE id = $1', [id]);
    await orders.markOrderPaid({ ...mockStripe.intents.get(o.stripe_payment_intent_id) });
    expect((await one(`SELECT count(*)::int n FROM storefront_notifications WHERE order_id = $1`, [id])).n).toBe(2);
    // the content: amounts from the order, labelled estimate, no buyer contact
    const full = await one('SELECT * FROM marketplace_orders WHERE id = $1', [id]);
    const msg = require('../src/services/storefrontNotificationService').renderSaleAdmin(full);
    expect(msg.text).toMatch(/Sale \$64\.00; fee \$7\.04 \(11%\); estimated seller proceeds \$56\.96 \(estimate, not the final deposit\)/);
    expect(msg.html + msg.text).not.toMatch(/bea@|BEA|ship_to|4242|card number/i);
    // a demo order notifies no administrator
    const demo = await listQ(1, 1000);
    await q('UPDATE marketplace_items SET is_demo = true WHERE id = $1', [demo.id]);
    const d = await buy(demo.id, 'bea'); await pay(d.body.data.order.id, 'bea');
    expect((await q(`SELECT event FROM storefront_notifications WHERE order_id = $1`, [d.body.data.order.id])).map((r) => r.event)).toEqual(['sale_paid']);
    // an administrator without a verified email receives nothing
    await q('UPDATE users SET email_verified = false WHERE id = $1', [U.admin.id]);
    const id3 = await sale(1000);
    expect((await q(`SELECT event FROM storefront_notifications WHERE order_id = $1`, [id3])).map((r) => r.event)).toEqual(['sale_paid']);
  });
});
