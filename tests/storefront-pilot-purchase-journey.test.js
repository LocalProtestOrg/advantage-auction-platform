'use strict';

/**
 * Storefront pilot purchase journey (owner 2026-11-12): a retail_gallery_studio seller in New Jersey sells a $3.00 item
 * with $2.00 flat shipping to a buyer shipping to New Jersey, with an approved NJ tax rule and sales tax calculated.
 * Real Postgres (PGlite) with the real migrations, the REAL order, tax-calculation, channel, notification and payout
 * code; only the payment processor is an in-memory stand-in (no network, no keys, nothing is charged).
 *
 * Asserted here: the tax request carries goods (300) and shipping (shipping_cost 200) separately; shipping is charged
 * once; buyer total = 300 + 200 + tax; commission 9% of 300 = 27 (marketplace) or 5% = 15 (seller's website), never on
 * shipping or tax; seller proceeds = 300 + 200 - commission; inventory 1 -> 0 on payment; buyer receipt sent, seller and
 * admin sale notices queued; "shipped" without carrier and tracking refused (TRACKING_REQUIRED); the order becomes payable
 * to the seller 7 days after the recorded delivery, not before.
 * Already covered elsewhere (not repeated): the website pass rules (storefront-channel-commission.test.js), declined and
 * prepaid cards (storefront-checkout.browser.test.js), the tax rule branches (storefront-tax-safeguard.test.js).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-pilot-journey'; // test value, never a real secret
process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_not_a_real_key';
process.env.STRIPE_TAX_ENABLED = 'true';

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
jest.mock('../src/services/ownerAlertService', () => ({ notifyAdminActionRequired: jest.fn(async () => {}),
  ALERT_TYPES: { SETTLEMENT_EXCEPTION: 'x', STOREFRONT_ITEM_REPORT: 'storefront_item_report', STOREFRONT_ORDER_ISSUE: 'storefront_order_issue' } }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/taxExemptionService', () => ({ effectiveExemptionForSale: jest.fn(async () => null) }));   // no exemption
jest.mock('../src/lib/launchGuards', () => ({ ...jest.requireActual('../src/lib/launchGuards'), marketplaceCheckoutEnabled: () => true }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: u.id, role: u.role, staff_role: u.staff_role || null };
  return next();
});

// ── Payment processor stand-in (in memory), including the tax calculation API ──────────────────────────────
const mockStripe = { intents: new Map(), taxCalcs: [], taxTx: [], n: 0 };
const TAX_CENTS = 33;   // what the stand-in tax calculation returns (it includes any tax on shipping)
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (p) => { const id = 'pi_' + (++mockStripe.n); const pi = { id, client_secret: id + '_secret', status: 'requires_payment_method', amount: p.amount,
      currency: p.currency, metadata: p.metadata, amount_received: 0 }; mockStripe.intents.set(id, pi); return { ...pi }; },
    retrieve: async (id) => ({ ...mockStripe.intents.get(id) }),
    confirm: async (id) => { const pi = mockStripe.intents.get(id); Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: 'ch_' + id }); return { ...pi }; },
    cancel: async (id) => { const pi = mockStripe.intents.get(id); pi.status = 'canceled'; return { ...pi }; },
  },
  paymentMethods: { retrieve: async (id) => ({ id, type: 'card', card: { funding: 'credit', brand: 'visa', last4: '4242' }, customer: null }) },
  refunds: { create: async () => ({ id: 're_1' }) },
  tax: {
    calculations: { create: async (p) => { mockStripe.taxCalcs.push(JSON.parse(JSON.stringify(p)));
      return { id: 'taxcalc_' + mockStripe.taxCalcs.length, tax_amount_exclusive: TAX_CENTS, tax_breakdown: [{ taxability_reason: 'standard_rated' }] }; } },
    transactions: { createFromCalculation: async (p) => { mockStripe.taxTx.push(p); return { id: 'taxtxn_' + mockStripe.taxTx.length }; } },
  },
}));

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
`;

let orders, items, server, base;
const U = {};
let SELLER;
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}

const SHIP_TO_NJ = { line1: '10 Broad St', city: 'Newark', state: 'NJ', postal_code: '07102', country: 'US' };

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  await global.__PG.exec(require('./helpers/saleReadySchema').SALE_READY_SQL);
  for (const f of ['071_verification_documents.sql', '119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql',
    '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql',
    '206_sold_price_privacy_and_message_moderation.sql', '207_storefront_bulk_import.sql', '209_marketplace_inventory_importer.sql', '211_retail_gallery_studio_seller_type.sql',
    '212_marketplace_multi_quantity.sql', '213_storefront_payouts.sql', '214_storefront_shipping_quantity_and_tax_responsibility.sql', '227_storefront_tax_rule_seller_direct.sql',
    '215_storefront_channel_commission.sql', '216_storefront_agreement_terms_and_refund_fault.sql', '217_storefront_commission_adjustments.sql']) {
    await global.__PG.exec(mig(f));
  }
  for (const [name, role] of [['gallery', 'seller'], ['bea', 'buyer'], ['ben', 'buyer'], ['admin', 'admin']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role, email_verified) VALUES ($1, $2, $3, true) RETURNING *`, [name + '@test.example', name.toUpperCase(), role]);
  }
  global.__USERS = U;
  // The pilot seller: a retail gallery / studio (Professional) located in New Jersey.
  SELLER = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug,
      verification_required_before_publication)
    VALUES ($1, 'retail_gallery_studio', 'Pilot Gallery', '1 Nassau St', 'Princeton', 'NJ', '08542', 'US', now(), true, 'pilot-gallery', false) RETURNING id`,
    [U.gallery.id])).id;
  // The approved New Jersey tax rule (TEST ONLY): tax is collected at checkout and remitted by Advantage.Bid.
  await q(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from) VALUES ('NJ', 'platform', 'TEST ONLY: pilot journey test', DATE '2020-01-01')
    ON CONFLICT (state) DO UPDATE SET remitter = 'platform', effective_from = DATE '2020-01-01'`);

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

// The pilot item: $3.00, one in stock, flat $2.00 shipping anywhere in the US.
const pilotItem = (title) => items.createDirectListing(U.gallery.id, { title, price_cents: 300, quantity: 1, shippable: true, shipping_method: 'parcel',
  shipping_destinations: 'us_all', shipping_price_mode: 'flat', shipping_cost_cents: 200 });
const stock = (id) => one('SELECT status, quantity, quantity_sold FROM marketplace_items WHERE id = $1', [id]);
const orderRow = (id) => one(`SELECT item_price_cents, shipping_cents, tax_cents, platform_fee_bps, platform_fee_cents, seller_proceeds_cents, total_charge_cents,
  sales_channel, tax_remitter, tax_jurisdiction, payment_status, fulfillment_status FROM marketplace_orders WHERE id = $1`, [id]);

async function buyAndPay(buyer, itemId, extra = {}) {
  const qte = await call(buyer, 'POST', '/api/marketplace/orders/quote', { item_id: itemId, fulfillment_method: 'shipping', ship_to: SHIP_TO_NJ });
  expect(qte.status).toBe(200);
  mockStripe.taxCalcs.length = 0;
  const o = await call(buyer, 'POST', '/api/marketplace/orders', { item_id: itemId, policies_acknowledged: true, fulfillment_method: 'shipping',
    ship_to: SHIP_TO_NJ, ...extra });
  expect(o.status).toBe(200);
  const orderTaxRequest = mockStripe.taxCalcs[0];
  const p = await call(buyer, 'POST', '/api/marketplace/orders/' + o.body.data.order.id + '/pay', { payment_method_id: 'pm_' + buyer });
  expect(p.body.data.status).toBe('succeeded');
  return { quote: qte.body.data, order: o.body.data, orderId: o.body.data.order.id, orderTaxRequest };
}

describe('pilot purchase: NJ gallery, $3.00 item, $2.00 shipping, NJ buyer, tax calculated', () => {
  let mkt;
  test('marketplace order: totals, 9% commission on the item only, tax request with goods and shipping separate', async () => {
    const it = await pilotItem('Small glazed bowl');
    expect(await stock(it.id)).toMatchObject({ quantity: 1, quantity_sold: 0, status: 'active' });
    mkt = await buyAndPay('bea', it.id);
    mkt.itemId = it.id;
    // what the buyer was shown, and charged
    expect(mkt.quote.breakdown).toEqual({ item_price_cents: 300, shipping_cents: 200, tax_cents: TAX_CENTS, total_charge_cents: 300 + 200 + TAX_CENTS });
    expect(mkt.order.breakdown).toEqual({ item_price_cents: 300, shipping_cents: 200, tax_cents: TAX_CENTS, total_charge_cents: 533 });
    expect(mockStripe.intents.get((await one('SELECT stripe_payment_intent_id i FROM marketplace_orders WHERE id = $1', [mkt.orderId])).i).amount).toBe(533);
    expect(await orderRow(mkt.orderId)).toEqual({ item_price_cents: 300, shipping_cents: 200, tax_cents: TAX_CENTS, platform_fee_bps: 900,
      platform_fee_cents: 27, seller_proceeds_cents: 300 + 200 - 27, total_charge_cents: 533, sales_channel: 'marketplace',
      tax_remitter: 'platform', tax_jurisdiction: 'NJ', payment_status: 'paid', fulfillment_status: 'unfulfilled' });
    // the tax request: goods as the line item, shipping once as the shipping cost, buyer's NJ address, NJ origin
    const t = mkt.orderTaxRequest;
    expect(t.line_items).toHaveLength(1);
    expect(t.line_items[0]).toMatchObject({ amount: 300, tax_behavior: 'exclusive' });
    expect(t.shipping_cost).toEqual({ amount: 200, tax_behavior: 'exclusive' });
    expect(t.customer_details.address).toMatchObject({ city: 'Newark', state: 'NJ', postal_code: '07102' });
    expect(t.ship_from_details.address).toMatchObject({ city: 'Princeton', state: 'NJ' });
    // the tax transaction is recorded from that calculation on payment
    expect(mockStripe.taxTx).toEqual([expect.objectContaining({ reference: expect.stringMatching(/^marketplace-order:/) })]);
  });

  test('inventory goes 1 -> 0 and the item is sold on payment success', async () => {
    expect(await stock(mkt.itemId)).toMatchObject({ quantity: 0, quantity_sold: 1, status: 'sold' });
  });

  test('buyer receipt sent; seller and admin sale notices queued', async () => {
    const { sendEmail } = require('../src/services/emailService');
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: U.bea.email, subject: expect.stringMatching(/^Order confirmed/) }));
    const queued = await q('SELECT event, recipient_email FROM storefront_notifications WHERE order_id = $1 ORDER BY event', [mkt.orderId]);
    expect(queued).toEqual([{ event: 'sale_paid', recipient_email: U.gallery.email }, { event: 'sale_paid_admin', recipient_email: U.admin.email }]);
  });

  test('"shipped" without a carrier and tracking number is refused; with them it is recorded', async () => {
    await expect(orders.updateFulfillment(mkt.orderId, U.gallery.id, 'shipped', {})).rejects.toMatchObject({ code: 'TRACKING_REQUIRED', status: 422 });
    await expect(orders.updateFulfillment(mkt.orderId, U.gallery.id, 'shipped', { tracking_carrier: 'USPS' })).rejects.toMatchObject({ code: 'TRACKING_REQUIRED' });
    expect((await orderRow(mkt.orderId)).fulfillment_status).toBe('unfulfilled');
    const s = await orders.updateFulfillment(mkt.orderId, U.gallery.id, 'shipped', { tracking_carrier: 'USPS', tracking_number: '9400100000000000000000' });
    expect(s).toMatchObject({ fulfillment_status: 'shipped', payout_eligible: false });
  });

  test('payable to the seller 7 days after the recorded delivery, not before', async () => {
    await orders.updateFulfillment(mkt.orderId, U.gallery.id, 'complete');
    const delivered = new Date((await one(`SELECT created_at FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'fulfillment' AND data->>'to' = 'completed'`,
      [mkt.orderId])).created_at);
    const S = require('../src/services/storefrontSettlementService');
    const line = () => one('SELECT goods_cents, platform_fee_cents, amount_cents FROM storefront_payout_lines WHERE marketplace_order_id = $1 AND active', [mkt.orderId]);
    await S.prepareWeek({ cutoff: new Date(delivered.getTime() + 7 * 864e5 - 60e3) });   // one minute short of 7 days
    expect(await line()).toBeUndefined();
    await S.prepareWeek({ cutoff: new Date(delivered.getTime() + 7 * 864e5 + 60e3) });
    // goods + shipping, less the 9% commission on the item; the sales tax Advantage.Bid remits is never paid to the seller
    expect(await line()).toEqual({ goods_cents: 500, platform_fee_cents: 27, amount_cents: 473 });
  });

  test('seller-website order (signed website pass): 5% of the item = 15, never on shipping or tax', async () => {
    const it = await pilotItem('Small glazed cup');
    const pass = require('../src/services/storefrontChannelService').issuePass(SELLER, 'https://pilot-gallery.example');
    const web = await buyAndPay('ben', it.id, { channel_passes: [pass] });
    expect(await orderRow(web.orderId)).toMatchObject({ item_price_cents: 300, shipping_cents: 200, tax_cents: TAX_CENTS, total_charge_cents: 533,
      sales_channel: 'seller_website', platform_fee_bps: 500, platform_fee_cents: 15, seller_proceeds_cents: 300 + 200 - 15 });
    expect(web.orderTaxRequest.line_items[0].amount).toBe(300);
    expect(web.orderTaxRequest.shipping_cost).toEqual({ amount: 200, tax_behavior: 'exclusive' });
    expect(await stock(it.id)).toMatchObject({ quantity: 0, quantity_sold: 1, status: 'sold' });
  });
});
