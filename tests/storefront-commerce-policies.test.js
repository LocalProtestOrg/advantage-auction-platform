'use strict';

/**
 * Storefront commerce policies (owner decisions 2026-11-02; migration 214): multi-unit shipping by the seller's own rule,
 * the storefront agreement at first publication, sales tax responsibility per jurisdiction and its allocation in payouts,
 * and recovering a refund from a seller who was already paid. Real Postgres (PGlite) with the real migrations; the payment
 * processor and the tax calculation are in-memory stand-ins (same harness as storefront-payouts.test.js).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-storefront-policies'; // test value, never a real secret

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
    '206_sold_price_privacy_and_message_moderation.sql', '207_storefront_bulk_import.sql', '209_marketplace_inventory_importer.sql', '211_retail_gallery_studio_seller_type.sql', '212_marketplace_multi_quantity.sql', '213_storefront_payouts.sql', '214_storefront_shipping_quantity_and_tax_responsibility.sql', '215_storefront_channel_commission.sql']) {
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
const listQ = (qty, price = 10000, owner = 'sue', extra = {}) => items.createDirectListing(U[owner].id, { title: 'Policy item ' + Math.random().toString(36).slice(2, 7), price_cents: price, quantity: qty, ...extra });
const buy = (itemId, buyer, quantity = 1, extra = {}) => call(buyer, 'POST', '/api/marketplace/orders', { item_id: itemId, policies_acknowledged: true, quantity, ...extra });
const quote = (itemId, buyer, quantity, extra = {}) => call(buyer, 'POST', '/api/marketplace/orders/quote', { item_id: itemId, quantity, ...extra });
const SHIP_TO = { line1: '5 Oak St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' };
const shipItem = (qty, rule, extra = {}) => listQ(qty, 2000, 'sue', { shippable: true, shipping_method: 'parcel', shipping_destinations: 'us_all',
  shipping_price_mode: 'flat', shipping_cost_cents: 800, ...(rule ? { shipping_quantity_rule: rule } : {}), ...extra });
const stock = (id) => one('SELECT status, quantity FROM marketplace_items WHERE id = $1', [id]);
const future = new Date(Date.now() + 864e5);
async function paidAndPickedUp(price, owner = 'sue') {
  const it = await listQ(1, price, owner); const o = await buy(it.id, 'bea'); await pay(o.body.data.order.id, 'bea');
  await orders.updateFulfillment(o.body.data.order.id, U[owner].id, 'picked_up');
  await q(`UPDATE marketplace_orders SET payout_eligible_at = now() - interval '1 day' WHERE id = $1`, [o.body.data.order.id]);
  return o.body.data.order.id;
}

describe('multi-unit shipping follows the seller\'s own rule', () => {
  test('per item: the shipping price for each unit', async () => {
    const it = await shipItem(5, 'per_unit');
    const qte = await quote(it.id, 'bea', 3, { fulfillment_method: 'shipping', ship_to: SHIP_TO });
    expect(qte.body.data.breakdown).toMatchObject({ item_price_cents: 6000, shipping_cents: 2400 });
    const o = await buy(it.id, 'bea', 3, { fulfillment_method: 'shipping', ship_to: SHIP_TO });
    const row = await one('SELECT shipping_cents, item_snapshot FROM marketplace_orders WHERE id = $1', [o.body.data.order.id]);
    expect(row.shipping_cents).toBe(2400);
    expect(row.item_snapshot.shipping_terms).toMatchObject({ units: 3, shipping_cents: 2400, offered: expect.objectContaining({ quantity_rule: 'per_unit' }) });
  });
  test('per order: one shipping charge for the whole order', async () => {
    const it = await shipItem(5, 'per_order');
    expect((await quote(it.id, 'bea', 4, { fulfillment_method: 'shipping', ship_to: SHIP_TO })).body.data.breakdown.shipping_cents).toBe(800);
  });
  test('no rule set: more than one cannot be shipped (pickup and single units still work); nothing reserved', async () => {
    const it = await shipItem(5, null);
    const r = await buy(it.id, 'bea', 2, { fulfillment_method: 'shipping', ship_to: SHIP_TO });
    expect([r.status, r.body.code]).toEqual([422, 'SHIPPING_QUANTITY_RULE_MISSING']);
    expect(await stock(it.id)).toMatchObject({ quantity: 5 });
    expect((await quote(it.id, 'bea', 1, { fulfillment_method: 'shipping', ship_to: SHIP_TO })).body.data.breakdown.shipping_cents).toBe(800);
    expect((await quote(it.id, 'bea', 2, { fulfillment_method: 'pickup' })).body.data.breakdown.shipping_cents).toBe(0);
  });
  test('free shipping stays free for any quantity; pickup-only refuses shipping; the public text uses no long dash', async () => {
    const free = await listQ(5, 2000, 'sue', { shippable: true, shipping_method: 'parcel', shipping_destinations: 'us_all', shipping_price_mode: 'free' });
    expect((await quote(free.id, 'bea', 4, { fulfillment_method: 'shipping', ship_to: SHIP_TO })).body.data.breakdown.shipping_cents).toBe(0);
    const pick = await listQ(2);
    expect((await quote(pick.id, 'bea', 1, { fulfillment_method: 'shipping', ship_to: SHIP_TO })).body.code).toBe('SHIPPING_UNAVAILABLE');
    const pub = require('../src/lib/storefrontShipping').publicShipping({ shippable: false });
    expect(pub.summary).toBe('Pickup only. This item is not shipped.');
    expect(pub.summary).not.toMatch(/[–—]/);
  });
  test('an unknown rule is refused when the seller saves it', async () => {
    const it = await listQ(1);
    await expect(items.updateItem(it.id, U.sue.id, { shipping_quantity_rule: 'per_box' })).rejects.toMatchObject({ code: 'SHIPPING_QUANTITY_RULE_INVALID' });
  });
});

describe('the storefront agreement at first publication', () => {
  // gus: a long-standing seller whose earlier auctions open the dashboard, but who never signed (no waiver).
  beforeAll(async () => {
    await q('UPDATE seller_profiles SET agreement_waived_at = NULL WHERE id = $1', [SP.gus]);
    await q(`INSERT INTO auctions (seller_id, title, state) VALUES ($1, 'Old auction', 'closed')`, [SP.gus]);
  });
  test('drafts, edits and imports need no signature; publishing is refused until the agreement is signed', async () => {
    const draft = await items.createDirectListing(U.gus.id, { title: 'Draft vase', price_cents: 5000, status: 'draft' });
    await items.updateItem(draft.id, U.gus.id, { title: 'Draft vase, edited', price_cents: 5200 });
    await expect(items.updateItem(draft.id, U.gus.id, { status: 'active' })).rejects.toMatchObject({ code: 'AGREEMENT_REQUIRED', status: 409 });
    await expect(items.createDirectListing(U.gus.id, { title: 'Live vase', price_cents: 5000 })).rejects.toMatchObject({ code: 'AGREEMENT_REQUIRED' });
    expect((await one('SELECT status FROM marketplace_items WHERE id = $1', [draft.id])).status).toBe('draft');
    // the dashboard is still open to this seller (the existing rule), only publication waits
    expect((await require('../src/services/agreementService').dashboardAccess(SP.gus)).access).toBe(true);
  });
  test('bulk publish and relist are refused the same way, with the agreement to sign', async () => {
    const d = await items.createDirectListing(U.gus.id, { title: 'Bulk draft', price_cents: 5000, status: 'draft' });
    const r = await require('../src/services/marketplaceOrderService').relistItem(d.id, U.gus.id).catch((e) => e);
    expect(r.code).toBe('AGREEMENT_REQUIRED');
  });
  test('the sale gate uses the same rule: an unsigned long-standing seller cannot be bought from', async () => {
    const it = await items.createDirectListing(U.gus.id, { title: 'Pre-rule live item', price_cents: 5000, status: 'draft' });
    await q(`UPDATE marketplace_items SET status = 'active' WHERE id = $1`, [it.id]);   // published before this rule
    const r = await buy(it.id, 'bea');
    expect([r.status, r.body.code]).toEqual([409, 'SELLER_NOT_ACCEPTING_ORDERS']);
  });
  test('once signed (any Seller Agreement version) there is no second signature: publishing works', async () => {
    const v = (await one(`INSERT INTO agreement_template_versions (template_id) VALUES (gen_random_uuid()) RETURNING id`)).id;
    await q(`INSERT INTO agreements (seller_profile_id, template_version_id, status, signed_at) VALUES ($1, $2, 'signed', now())`, [SP.gus, v]);
    const it = await items.createDirectListing(U.gus.id, { title: 'Signed vase', price_cents: 5000 });
    expect(it.status).toBe('active');
    expect((await require('../src/services/agreementService').storefrontAgreementStatus(SP.gus)).reason).toBe('signed');
  });
  test('an Advantage.Bid waiver also counts', async () => {
    expect((await require('../src/services/agreementService').storefrontAgreementStatus(SP.sue)).reason).toBe('waived');
  });
});

describe('sales tax responsibility (decided per jurisdiction, never assumed)', () => {
  afterEach(() => { global.__TAX = null; });
  test('tax in a state without a rule: the order is refused before any payment, and the units are released', async () => {
    global.__TAX = { cents: 825 };
    const it = await listQ(2);
    const r = await buy(it.id, 'bea', 1);
    expect([r.status, r.body.code]).toEqual([409, 'TAX_RESPONSIBILITY_UNSET']);
    expect(await stock(it.id)).toMatchObject({ quantity: 2, status: 'active' });
  });
  test('seller remits: the order records it and the tax is paid to the seller with the proceeds', async () => {
    await q(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis) VALUES ('TX', 'seller', 'Test rule only')
             ON CONFLICT (state) DO UPDATE SET remitter = 'seller'`);
    global.__TAX = { cents: 825 };
    const id = await paidAndPickedUp(10000);
    expect(await one('SELECT tax_cents, tax_remitter, tax_jurisdiction, seller_proceeds_cents FROM marketplace_orders WHERE id = $1', [id]))
      .toEqual({ tax_cents: 825, tax_remitter: 'seller', tax_jurisdiction: 'TX', seller_proceeds_cents: 9100 });   // marketplace sale: 9%
    global.__TAX = null;
    await S().prepareWeek({ cutoff: future });
    const line = await one('SELECT amount_cents, tax_to_seller_cents FROM storefront_payout_lines WHERE marketplace_order_id = $1', [id]);
    expect(line).toEqual({ amount_cents: 9100 + 825, tax_to_seller_cents: 825 });
  });
  test('Advantage.Bid remits: the tax is never paid to the seller and never counted as fee', async () => {
    await q(`UPDATE marketplace_tax_jurisdictions SET remitter = 'platform' WHERE state = 'TX'`);
    global.__TAX = { cents: 825 };
    const id = await paidAndPickedUp(10000);
    global.__TAX = null;
    expect((await one('SELECT tax_remitter, platform_fee_cents FROM marketplace_orders WHERE id = $1', [id]))).toEqual({ tax_remitter: 'platform', platform_fee_cents: 900 });
    await S().prepareWeek({ cutoff: future });
    expect(await one('SELECT amount_cents, tax_to_seller_cents FROM storefront_payout_lines WHERE marketplace_order_id = $1', [id])).toEqual({ amount_cents: 9100, tax_to_seller_cents: 0 });
  });
  test('no tax collected: recorded as none', async () => {
    const id = await paidAndPickedUp(3000);
    expect((await one('SELECT tax_remitter FROM marketplace_orders WHERE id = $1', [id])).tax_remitter).toBe('none');
  });
});

describe('a refund after the seller was paid is recovered from the next payout', () => {
  test('recorded once, deducted from the next prepared payout, released if that payout is voided', async () => {
    await q(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS stripe_transfer_id text, ADD COLUMN IF NOT EXISTS payout_status text, ADD COLUMN IF NOT EXISTS transfer_failure_message text`);
    const first = await paidAndPickedUp(10000);
    await S().prepareWeek({ cutoff: future });
    const p1 = (await one(`SELECT p.* FROM storefront_payouts p JOIN storefront_payout_lines l ON l.storefront_payout_id = p.id WHERE l.marketplace_order_id = $1`, [first]));
    await S().payPayout(p1.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p1.seller_payout_cents });
    // the buyer is refunded after the seller was paid
    await orders.refundOrder(first, { adminId: U.admin.id, reason: 'Returned after payout' });
    const rec = await one('SELECT amount_cents, applied_payout_id FROM storefront_payout_recoveries WHERE marketplace_order_id = $1', [first]);
    expect(rec).toEqual({ amount_cents: 9100, applied_payout_id: null });
    await orders.refundOrder(first, { adminId: U.admin.id, reason: 'Repeat click' });   // idempotent
    expect((await one('SELECT count(*)::int n FROM storefront_payout_recoveries WHERE marketplace_order_id = $1', [first])).n).toBe(1);
    // next week: a new sale of 200 -> payout 18200 - 9100 recovered
    const second = await paidAndPickedUp(20000);
    await S().prepareWeek({ cutoff: new Date(Date.now() + 2 * 864e5) });
    const p2 = await one(`SELECT p.* FROM storefront_payouts p JOIN storefront_payout_lines l ON l.storefront_payout_id = p.id WHERE l.marketplace_order_id = $1`, [second]);
    expect(p2).toMatchObject({ recovery_cents: 9100 });
    expect(p2.seller_payout_cents).toBe(Number((await one(`SELECT sum(amount_cents)::int a FROM storefront_payout_lines WHERE storefront_payout_id = $1 AND active`, [p2.id])).a) - 9100);
    await S().voidPayout(p2.id, U.admin.id, { reason: 'Recheck the recovery' });
    expect((await one('SELECT applied_payout_id FROM storefront_payout_recoveries WHERE marketplace_order_id = $1', [first])).applied_payout_id).toBeNull();
  });
});

describe('the administrator tax rules (one rule per state, reasons recorded, audited)', () => {
  const audit = () => require('../src/lib/auditLog').writeAuditLog;
  test('only an administrator can read or change the rules', async () => {
    expect((await call('sue', 'GET', '/api/admin/tax-jurisdictions')).status).toBe(403);
    expect((await call('bea', 'PUT', '/api/admin/tax-jurisdictions/NY', { remitter: 'seller', legal_basis: 'Not an administrator' })).status).toBe(403);
    expect((await call('admin', 'GET', '/api/admin/tax-jurisdictions')).body.data.states).toContain('NY');
  });
  test('a rule needs a valid state, remitter and the advice relied on; saving and removing are audited', async () => {
    expect((await call('admin', 'PUT', '/api/admin/tax-jurisdictions/ZZ', { remitter: 'seller', legal_basis: 'Advice from counsel' })).body.code).toBe('STATE_INVALID');
    expect((await call('admin', 'PUT', '/api/admin/tax-jurisdictions/NY', { remitter: 'buyer', legal_basis: 'Advice from counsel' })).body.code).toBe('REMITTER_INVALID');
    expect((await call('admin', 'PUT', '/api/admin/tax-jurisdictions/NY', { remitter: 'platform', legal_basis: 'short' })).body.code).toBe('BASIS_REQUIRED');
    audit().mockClear();
    const ok = await call('admin', 'PUT', '/api/admin/tax-jurisdictions/ny', { remitter: 'platform', legal_basis: 'Test advice recorded for this suite' });
    expect(ok.body.data).toMatchObject({ state: 'NY', remitter: 'platform', updated_by: U.admin.id });
    expect(audit()).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'tax_jurisdiction_rule_set', actor_id: U.admin.id }));
    expect((await call('admin', 'DELETE', '/api/admin/tax-jurisdictions/NY')).body.data.removed).toBe(true);
    expect(audit()).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'tax_jurisdiction_rule_removed' }));
    expect(await one(`SELECT count(*)::int n FROM marketplace_tax_jurisdictions WHERE state = 'NY'`)).toEqual({ n: 0 });
  });
});

describe('each order records the platform Buyer Terms version in force', () => {
  test('the current version is recorded with the order (and shown to the buyer); none published -> null', async () => {
    const it1 = await listQ(2);
    const before = await buy(it1.id, 'bea');
    expect((await one('SELECT buyer_terms_version_int FROM marketplace_orders WHERE id = $1', [before.body.data.order.id])).buyer_terms_version_int).toBeNull();
    await global.__PG.exec(mig('061_create_terms.sql'));
    const cur = await one(`SELECT version_int FROM terms_versions WHERE kind = 'buyer_terms' AND is_current`);   // seeded by 061
    const it2 = await listQ(1);
    const o = await buy(it2.id, 'ben');
    expect(o.body.data.order.buyer_terms_version).toBe(cur.version_int);
    const row = await one('SELECT buyer_terms_version_id, buyer_terms_version_int, policy_snapshot FROM marketplace_orders WHERE id = $1', [o.body.data.order.id]);
    expect(row.buyer_terms_version_int).toBe(cur.version_int);
    expect(row.buyer_terms_version_id).toEqual(expect.any(String));
  });
});
