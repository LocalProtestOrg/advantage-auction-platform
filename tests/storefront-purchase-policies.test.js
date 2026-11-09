'use strict';

/**
 * Professional Storefront purchase policies (owner decisions 2026-11-09; src/lib/storefrontPurchasePolicy.js):
 *   1. sales are final after payment (no buyer cancellation; Advantage.Bid refunds and card disputes remain);
 *   2. uncollected purchases follow the seller's Shipping & Pickup Policy; nothing becomes payable because time passes;
 *   3. returns follow the seller's Store Terms, but a "not as described" report is always accepted, held and reviewed;
 *   4. problems are reported within 48 hours after pickup or 7 days after delivery, counted from the RECORDED pickup or
 *      delivery; the period never refuses a report, and the weekly payout waits for it to end;
 *   5. no refund fee: a refund returns everything the buyer paid.
 * Plus: both seller policies are required before payment and recorded on the order; a released payout hold makes the order
 * payable again (fix: before 2026-11-09 a hold left the order unpayable for good); cross-seller isolation.
 * Real Postgres (PGlite) with the real migrations; the payment processor is an in-memory stand-in (storefront-payouts harness).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-storefront-purchase-policies'; // test value, never a real secret

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

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
jest.mock('../src/services/ownerAlertService', () => ({ notifyAdminActionRequired: jest.fn(async () => {}), sendOwnerAlertOnce: jest.fn(async () => {}),
  ALERT_TYPES: { SETTLEMENT_EXCEPTION: 'x', STOREFRONT_ITEM_REPORT: 'storefront_item_report', STOREFRONT_ORDER_ISSUE: 'storefront_order_issue', STOREFRONT_SALE_PAID: 'p' } }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/taxCalculationService', () => ({
  taxEnabled: () => false, addressComplete: () => true,
  computeTax: jest.fn(async () => ({ taxCents: 0, enabled: false, exempt: false, calculationId: null })),
  recordTransaction: jest.fn(async () => null), reverseFullTransaction: jest.fn(async () => null), reversePartialTransaction: jest.fn(async () => null),
}));
jest.mock('../src/lib/launchGuards', () => ({ ...jest.requireActual('../src/lib/launchGuards'), marketplaceCheckoutEnabled: () => true }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: u.id, role: u.role, staff_role: u.staff_role || null };
  return next();
});

const mockStripe = { intents: new Map(), refunds: [], transfers: [], n: 0 };
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (p) => { const id = 'pi_' + (++mockStripe.n); const pi = { id, client_secret: id + '_secret', status: 'requires_payment_method', amount: p.amount,
      currency: p.currency, metadata: p.metadata, amount_received: 0 }; mockStripe.intents.set(id, pi); return { ...pi }; },
    retrieve: async (id) => ({ ...mockStripe.intents.get(id) }),
    confirm: async (id) => { const pi = mockStripe.intents.get(id); Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: 'ch_' + id }); return { ...pi }; },
    cancel: async (id) => { const pi = mockStripe.intents.get(id); pi.status = 'canceled'; return { ...pi }; },
  },
  paymentMethods: { retrieve: async (id) => ({ id, type: 'card', card: { funding: 'credit', brand: 'visa', last4: '4242' }, customer: null }) },
  charges: { retrieve: async (id) => ({ id, balance_transaction: null }) },
  refunds: { create: async (p, o) => { mockStripe.refunds.push({ ...p, key: o && o.idempotencyKey }); return { id: 're_' + mockStripe.refunds.length }; } },
  transfers: { create: async (p, o) => { const t = { id: 'tr_' + (mockStripe.transfers.length + 1), ...p, key: o && o.idempotencyKey }; mockStripe.transfers.push(t); return { id: t.id }; } },
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

let orders, items, issues, server, base;
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
  await global.__PG.exec(require('./helpers/saleReadySchema').SALE_READY_SQL);   // agreement, payouts and both store policies
  for (const f of ['071_verification_documents.sql', '119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql',
    '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql',
    '206_sold_price_privacy_and_message_moderation.sql', '207_storefront_bulk_import.sql', '209_marketplace_inventory_importer.sql', '211_retail_gallery_studio_seller_type.sql',
    '212_marketplace_multi_quantity.sql', '213_storefront_payouts.sql', '214_storefront_shipping_quantity_and_tax_responsibility.sql', '215_storefront_channel_commission.sql',
    '216_storefront_agreement_terms_and_refund_fault.sql', '217_storefront_commission_adjustments.sql']) {
    await global.__PG.exec(mig(f));
  }
  for (const [name, role] of [['sue', 'seller'], ['gus', 'seller'], ['bea', 'buyer'], ['ben', 'buyer'], ['admin', 'admin']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3) RETURNING *`, [name + '@test.example', name.toUpperCase(), role]);
  }
  global.__USERS = U;
  for (const [name, type] of [['sue', 'auction_house'], ['gus', 'professional_liquidator']]) {
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug)
      VALUES ($1, $2, $3, '1 Main St', 'Houston', 'TX', '77001', 'US', now(), true, $4) RETURNING id`, [U[name].id, type, name.toUpperCase() + ' Co', name])).id;
  }
  orders = require('../src/services/marketplaceOrderService');
  items = require('../src/services/marketplaceItemService');
  issues = require('../src/services/marketplaceOrderIssueService');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

const S = () => require('../src/services/storefrontSettlementService');
const policy = require('../src/lib/storefrontPurchasePolicy');
const DAY = 864e5;
let cutoffSeq = 0;
// A distinct cutoff `days` ahead (one live payout record per seller per cutoff): prepare, then report where `orderId` landed.
async function preparedAt(days, orderId) {
  const cutoff = new Date(Date.now() + days * DAY + (++cutoffSeq) * 1000);
  await S().prepareWeek({ cutoff });
  return (await one('SELECT storefront_payout_id FROM marketplace_orders WHERE id = $1', [orderId])).storefront_payout_id;
}
const listing = (owner, extra = {}) => items.createDirectListing(U[owner].id, { title: 'Policy item ' + Math.random().toString(36).slice(2, 7), price_cents: 10000, ...extra });
// A paid order (pickup unless shipping options are given).
async function paidOrder(owner = 'sue', buyer = 'bea', { shipping = false } = {}) {
  const it = await listing(owner, shipping ? { shippable: true, shipping_cost_cents: 1500, shipping_method: 'parcel', shipping_destinations: 'us_all' } : {});
  const body = { item_id: it.id, policies_acknowledged: true };
  if (shipping) Object.assign(body, { fulfillment_method: 'shipping', ship_to: { name: 'B', line1: '5 Elm St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } });
  const o = await call(buyer, 'POST', '/api/marketplace/orders', body);
  expect(o.status).toBe(200);
  const id = o.body.data.order.id;
  expect((await call(buyer, 'POST', `/api/marketplace/orders/${id}/pay`, { payment_method_id: 'pm_' + buyer })).status).toBe(200);
  return id;
}
const fulfil = (owner, id, action, extra = {}) => call(owner, 'POST', `/api/marketplace/seller/orders/${id}/fulfillment`, { action, ...extra });
const orderRow = (id) => one('SELECT * FROM marketplace_orders WHERE id = $1', [id]);

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('purchase needs both seller policies, shown and recorded (both sales channels use this one checkout)', () => {
  test('the order records the exact Store Terms and Shipping & Pickup versions; the public item says it is ready', async () => {
    const it = await listing('sue');
    expect((await items.getPublicItem(it.id)).purchase_policies_ready).toBe(true);
    const id = await paidOrder('sue');
    const o = await orderRow(id);
    const pub = await q(`SELECT id, kind, version FROM seller_policy_versions WHERE seller_id = $1 AND status = 'published'`, [SP.sue]);
    for (const k of ['store_terms', 'shipping_pickup']) expect(o.policy_snapshot[k].version_id).toBe(pub.find((p) => p.kind === k).id);
    expect(o.policies_acknowledged_at).toBeTruthy();
  });
  test('the quote refuses too when a policy is withdrawn by Advantage.Bid; nothing is reserved', async () => {
    const it = await listing('gus');
    const sp = await one(`SELECT id FROM seller_policy_versions WHERE seller_id = $1 AND kind = 'shipping_pickup' AND status = 'published'`, [SP.gus]);
    await require('../src/services/sellerPolicyService').withdraw(sp.id, U.admin.id, { reason: 'Unclear forfeiture terms (test)' });
    try {
      const qr = await call('bea', 'POST', '/api/marketplace/orders/quote', { item_id: it.id });
      expect(qr.status).toBe(409); expect(qr.body.code).toBe('SELLER_POLICIES_REQUIRED');
      const r = await call('bea', 'POST', '/api/marketplace/orders', { item_id: it.id, policies_acknowledged: true });
      expect(r.status).toBe(409); expect(r.body.code).toBe('SELLER_POLICIES_REQUIRED');
      expect(r.body.message).not.toMatch(/\bAI\b|Stripe|—/);
      expect(await one('SELECT count(*)::int n FROM marketplace_orders WHERE marketplace_item_id = $1', [it.id])).toEqual({ n: 0 });
      expect((await items.getPublicItem(it.id)).purchase_policies_ready).toBe(false);
    } finally {
      // Gus publishes a corrected Shipping & Pickup Policy (the other tests use Gus as a ready seller).
      const ctx = { sellerId: SP.gus, userId: U.gus.id, role: 'owner' };
      const pol = require('../src/services/sellerPolicyService');
      await pol.saveDraft(ctx, 'shipping_pickup', 'Pickup by appointment within 7 days of purchase. Items not collected are handled as stated here.');
      await pol.publish(ctx, 'shipping_pickup');
    }
  });
  test("the seller's readiness list shows the policies step", async () => {
    const r = await require('../src/services/storefrontReadinessService').forSeller(U.sue.id);
    const step = r.company.find((s) => s.key === 'policies');
    expect(step).toMatchObject({ done: true, label: 'Store Terms and Shipping & Pickup Policy published' });
  });
});

describe('1. sales are final after payment', () => {
  test('a buyer has no way to cancel a paid order; only an administrator refunds (with a reason)', async () => {
    const id = await paidOrder('sue');
    for (const [m, u] of [['POST', `/api/marketplace/orders/${id}/cancel`], ['DELETE', `/api/marketplace/orders/${id}`], ['POST', `/api/marketplace/orders/${id}/refund`]]) {
      expect((await call('bea', m, u)).status).toBe(404);
    }
    expect((await call('bea', 'POST', `/api/marketplace/admin/orders/${id}/refund`, { reason: 'changed my mind' })).status).toBe(403);
    expect((await orderRow(id)).payment_status).toBe('paid');
    const routes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'marketplaceOrders.js'), 'utf8');
    expect(routes).not.toMatch(/router\.(post|delete|patch)\('\/orders\/:id\/(cancel|refund)/);
  });
});

describe('2. uncollected purchases: nothing becomes payable because time passes', () => {
  test('a paid order that is never picked up (or only ready for pickup) is never in a payout, however late the cutoff', async () => {
    const waiting = await paidOrder('sue');
    const ready = await paidOrder('sue');
    expect((await fulfil('sue', ready, 'ready_for_pickup')).status).toBe(200);
    for (const id of [waiting, ready]) {
      expect(await preparedAt(90, id)).toBeNull();
      expect((await orderRow(id)).payout_eligible).toBe(false);
    }
    const src = fs.readFileSync(path.join(ROOT, 'src', 'workers', 'notificationWorker.js'), 'utf8');
    expect(src).not.toMatch(/fulfillment_status\s*=\s*'(picked_up|completed)'/);   // no sweeper completes an order
  });
});

describe('4. reporting period: from the recorded pickup or delivery, never the payment date', () => {
  test('pickup: the buyer and seller see the 48-hour period; the payout waits until it ends', async () => {
    const id = await paidOrder('sue');
    const before = (await call('bea', 'GET', `/api/marketplace/orders/${id}`)).body.data;
    expect(before.reporting_period).toMatchObject({ basis: 'pickup', hours: 48, starts_at: null, ends_at: null });
    expect((await fulfil('sue', id, 'picked_up')).status).toBe(200);
    const ev = await one(`SELECT created_at FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'fulfillment'`, [id]);
    const mine = (await call('bea', 'GET', '/api/marketplace/orders/mine')).body.data.find((o) => o.id === id);
    expect(new Date(mine.reporting_period.starts_at).getTime()).toBe(new Date(ev.created_at).getTime());
    expect(new Date(mine.reporting_period.ends_at).getTime() - new Date(mine.reporting_period.starts_at).getTime()).toBe(48 * 3600e3);
    expect(new Date(mine.reporting_period.starts_at).getTime()).toBeGreaterThan(new Date((await orderRow(id)).paid_at).getTime());   // the pickup, after payment
    const sellerView = (await call('sue', 'GET', '/api/marketplace/seller/orders')).body.data.find((o) => o.id === id);
    expect(sellerView.reporting_period.ends_at).toBe(mine.reporting_period.ends_at);
    expect(await preparedAt(1, id)).toBeNull();               // a cutoff inside the 48 hours: not yet
    expect(await preparedAt(3, id)).not.toBeNull();           // after it: included
  });
  test('shipping: 7 days after the recorded delivery (shipping alone never starts it)', async () => {
    const id = await paidOrder('gus', 'bea', { shipping: true });
    expect((await fulfil('gus', id, 'shipped', { tracking_carrier: 'UPS', tracking_number: '1Z999' })).status).toBe(200);
    expect(await preparedAt(30, id)).toBeNull();              // shipped but delivery not recorded: never payable
    expect((await fulfil('gus', id, 'complete')).status).toBe(200);
    const mine = (await call('bea', 'GET', `/api/marketplace/orders/${id}`)).body.data;
    expect(mine.reporting_period).toMatchObject({ basis: 'delivery', hours: 168 });
    expect(await preparedAt(3, id)).toBeNull();               // inside the 7 days
    expect(await preparedAt(8, id)).not.toBeNull();
  });
  test('the recorded pickup/delivery time cannot be rewritten (append-only order history)', async () => {
    const id = await paidOrder('sue');
    await fulfil('sue', id, 'picked_up');
    const ev = await one(`SELECT id FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'fulfillment'`, [id]);
    await expect(global.__PG.query(`UPDATE marketplace_order_events SET created_at = now() - interval '9 days' WHERE id = $1`, [ev.id])).rejects.toThrow(/append-only/);
    await expect(global.__PG.query(`DELETE FROM marketplace_order_events WHERE id = $1`, [ev.id])).rejects.toThrow(/kept permanently/);
  });
  test('a report is never refused for timing: before pickup is recorded, within, or after the period (reviewer sees which)', async () => {
    const early = await paidOrder('sue');
    const r1 = await call('bea', 'POST', `/api/marketplace/orders/${early}/issues`, { category: 'pickup_problem', message: 'The pickup address was closed when I arrived.' });
    expect(r1.status).toBe(201);
    const within = await paidOrder('sue');
    await fulfil('sue', within, 'picked_up');
    const r2 = await call('bea', 'POST', `/api/marketplace/orders/${within}/issues`, { category: 'damaged', message: 'The table leg was cracked when I got it home.' });
    expect(r2.status).toBe(201); expect(r2.body.data.payout_held).toBe(true);
    const list = await issues.listForAdmin({});
    expect(list.find((i) => i.order_id === early)).toMatchObject({ reported: 'before_fulfillment', reporting_basis: 'pickup' });
    expect(list.find((i) => i.order_id === within)).toMatchObject({ reported: 'within', reporting_basis: 'pickup' });
    expect((await one(`SELECT data FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'issue_opened'`, [within])).data.reporting).toBe('within');
    // the buyer and seller never see the reviewer's timing note
    const hist = (await call('bea', 'GET', `/api/marketplace/orders/${within}/history`)).body.data;
    expect(JSON.stringify(hist)).not.toContain('reporting');
    // after the period: the classification says so, and nothing in the issue service refuses on time
    const w = policy.reportingWindow('pickup', new Date(Date.now() - 5 * DAY));
    expect(policy.reportTiming(w, new Date())).toBe('after');
    expect(policy.reportTiming(policy.reportingWindow('shipping', null), new Date())).toBe('before_fulfillment');
    expect(policy.reportTiming(w, 'not a date')).toBe('unknown');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'marketplaceOrderIssueService.js'), 'utf8');
    const open = src.slice(src.indexOf('async function openIssue'), src.indexOf('async function notifyIssueOpened'));
    expect(open).not.toMatch(/reporting[^;]*throw|throw[^;]*(REPORT|WINDOW|LATE|EXPIRED)/i);
  });
});

describe('3. "not as described" is always reviewable, whatever the seller\'s Store Terms say', () => {
  test('an "all sales final, as is" seller still gets the report; the payout is held; resolved for the buyer -> full refund', async () => {
    const ctx = { sellerId: SP.sue, userId: U.sue.id, role: 'owner' };
    const pol = require('../src/services/sellerPolicyService');
    await pol.saveDraft(ctx, 'store_terms', 'ALL SALES FINAL. Everything is sold as is, where is. No returns or refunds for any reason.');
    await pol.publish(ctx, 'store_terms');
    const id = await paidOrder('sue');
    await fulfil('sue', id, 'picked_up');
    const r = await call('bea', 'POST', `/api/marketplace/orders/${id}/issues`, { category: 'not_as_described', message: 'Listed as solid walnut; it is laminate over particleboard.' });
    expect(r.status).toBe(201); expect(r.body.data.payout_held).toBe(true);
    expect(await preparedAt(5, id)).toBeNull();
    // refund (policy 5): everything the buyer paid, no fee
    const o = await orderRow(id);
    const before = mockStripe.refunds.length;
    const ref = await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/refund`, { reason: 'Materially not as described (verified photos)', fault: 'seller' });
    expect(ref.status).toBe(200);
    expect(mockStripe.refunds.slice(before)).toEqual([expect.objectContaining({ amount: o.total_charge_cents })]);
    expect(await orderRow(id)).toMatchObject({ refund_status: 'refunded', refunded_amount_cents: o.total_charge_cents });
    // the card cost of a seller-caused refund is NOT charged to anyone while the owner's switch is off (as shipped)
    expect(await one('SELECT count(*)::int n FROM storefront_payout_recoveries WHERE marketplace_order_id = $1', [id])).toEqual({ n: 0 });
  });
});

describe('5. no refund fee', () => {
  test('a shipped order refunds item, shipping and tax in full; the refund code has no fee deduction', async () => {
    const id = await paidOrder('gus', 'ben', { shipping: true });
    const o = await orderRow(id);
    expect(o.shipping_cents).toBe(1500);
    const before = mockStripe.refunds.length;
    expect((await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/refund`, { reason: 'Seller cannot ship after all' })).status).toBe(200);
    expect(mockStripe.refunds[before].amount).toBe(o.total_charge_cents);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    const refund = src.slice(src.indexOf('async function refundOrder'), src.indexOf('async function applyRefundState'));
    expect(refund).toMatch(/amount: remaining/);
    expect(refund).not.toMatch(/restocking|cancellation_fee|refund_fee|processing_fee_cents\s*[-+]/i);
  });
});

describe('payout holds: never released early, and a release makes the order payable again', () => {
  test('an issue hold: release refused while the report is open; resolving it with release restores the payout', async () => {
    const id = await paidOrder('gus');
    await fulfil('gus', id, 'picked_up');
    const r = await call('bea', 'POST', `/api/marketplace/orders/${id}/issues`, { category: 'not_received', message: 'The seller marked it picked up but I never collected it.' });
    expect((await orderRow(id))).toMatchObject({ payout_hold: true, review_required: true, payout_eligible: false });
    const early = await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: false, reason: 'Trying to release early' });
    expect(early.status).toBe(409); expect(early.body.code).toBe('ISSUE_OPEN');
    expect(await preparedAt(10, id)).toBeNull();
    const res = await issues.resolve(r.body.data.id, U.admin.id, { resolution_note: 'Seller showed signed pickup receipt; buyer confirmed.', release_hold: true });
    expect(res.payout_hold_released).toBe(true);
    expect(await orderRow(id)).toMatchObject({ payout_hold: false, review_required: false, payout_eligible: true });
    expect(await preparedAt(11, id)).not.toBeNull();
  });
  test('a chargeback hold: release refused while open; after the dispute closes the admin release restores the payout', async () => {
    const id = await paidOrder('sue', 'ben');
    await fulfil('sue', id, 'picked_up');
    const pi = (await orderRow(id)).stripe_payment_intent_id;
    await q(`INSERT INTO payment_disputes (stripe_dispute_id, payment_intent_id, status, marketplace_order_id, marketplace_seller_id) VALUES ('dp_pol_1', $1, 'needs_response', $2, $3)`, [pi, id, SP.sue]);
    await orders.holdForDispute(require('../src/db'), id, { disputeId: 'dp_pol_1', reason: 'fraudulent' });
    expect(await orderRow(id)).toMatchObject({ payout_hold: true, review_required: true, payout_eligible: false });
    const early = await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: false, reason: 'Release please' });
    expect(early.body.code).toBe('DISPUTE_OPEN');
    await q(`UPDATE payment_disputes SET status = 'won', closed_at = now() WHERE stripe_dispute_id = 'dp_pol_1'`);
    const ok = await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: false, reason: 'Dispute won by the seller' });
    expect(ok.status).toBe(200);
    expect(await orderRow(id)).toMatchObject({ payout_hold: false, review_required: false, payout_eligible: true });
    expect(await preparedAt(12, id)).not.toBeNull();
  });
  test('releasing a hold never clears an unrelated review reason (a payment mismatch stays for an administrator)', async () => {
    const id = await paidOrder('sue', 'ben');
    await fulfil('sue', id, 'picked_up');
    await q(`UPDATE marketplace_orders SET review_required = true, review_note = 'Payment does not match this order (amount); review required.' WHERE id = $1`, [id]);
    await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: true, reason: 'Checking the payment' });
    expect((await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: false, reason: 'Checked' })).status).toBe(200);
    expect(await orderRow(id)).toMatchObject({ payout_hold: false, review_required: true, payout_eligible: true });
    expect(await preparedAt(13, id)).toBeNull();               // still under review: not paid
  });
  test('a hold released before pickup: payable only after pickup is recorded and the period ends', async () => {
    const id = await paidOrder('gus', 'ben');
    await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: true, reason: 'Routine check' });
    await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: false, reason: 'Routine check done' });
    expect((await orderRow(id)).payout_eligible).toBe(false);
    expect(await preparedAt(14, id)).toBeNull();
    await fulfil('gus', id, 'picked_up');
    expect((await orderRow(id)).payout_eligible).toBe(true);
    expect(await preparedAt(15, id)).not.toBeNull();
  });
});

describe('cross-seller and cross-buyer isolation', () => {
  test("a seller cannot fulfil or read another seller's order; a buyer cannot report on another buyer's order", async () => {
    const id = await paidOrder('sue', 'bea');
    expect((await fulfil('gus', id, 'picked_up')).status).toBe(403);
    expect((await call('gus', 'GET', '/api/marketplace/seller/orders')).body.data.some((o) => o.id === id)).toBe(false);
    const other = await call('ben', 'POST', `/api/marketplace/orders/${id}/issues`, { category: 'not_as_described', message: 'Trying to report on an order that is not mine.' });
    expect(other.status).toBe(404);
    expect((await call('ben', 'GET', `/api/marketplace/orders/${id}`)).status).toBe(404);
    expect((await call('sue', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: false, reason: 'seller trying' })).status).toBe(403);
    expect((await call('bea', 'POST', `/api/marketplace/admin/orders/${id}/payout-hold`, { hold: false, reason: 'buyer trying' })).status).toBe(403);
    expect((await orderRow(id)).fulfillment_status).toBe('unfulfilled');
  });
});
