'use strict';

/**
 * Nationwide storefront sales tax safeguard audit (owner 2026-11-09; deployed at d38a2da with migration 227).
 * The safeguard is jurisdiction-based: the sale's state is the pickup location's state for pickup and the ship-to state
 * for shipping, and an administrator-entered rule for THAT state (recording the CPA's determination) must exist and agree
 * with the tax calculation. Nothing is assumed taxable, and no single remitter is assumed for every state.
 * Real Postgres (PGlite) with the real migrations and the real order, refund and payout code; the payment processor and
 * the tax calculation are in-memory stand-ins.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-storefront-tax-nationwide'; // test value, never a real secret

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
// Tax calculation stand-in, per destination state: global.__TAXBY[STATE] = { rate } means the processor is registered and
// collecting there at that rate ({ rate: 0 } = registered, not taxable); a state missing from the map = no registration
// ($0, not collecting). global.__EXEMPT = an approved buyer exemption. The REAL safeguard and order flow run on top.
jest.mock('../src/services/taxCalculationService', () => ({
  taxEnabled: () => true,
  addressComplete: (a) => !!(a && a.line1 && a.city && a.state && a.postal_code),
  computeTax: jest.fn(async ({ taxableBaseCents, address }) => {
    const st = String((address && address.state) || '').toUpperCase();
    if (global.__EXEMPT) return { enabled: true, taxCents: 0, exempt: true, calculationId: null, collecting: false };
    const c = (global.__TAXBY || {})[st];
    if (!c) return { enabled: true, taxCents: 0, exempt: false, calculationId: 'calc_' + st, collecting: false };
    return { enabled: true, taxCents: Math.round(taxableBaseCents * c.rate), exempt: false, calculationId: 'calc_' + st, collecting: true };
  }),
  recordTransaction: jest.fn(async ({ calculationId }) => (calculationId ? 'taxtx_' + calculationId : null)),
  reverseFullTransaction: jest.fn(async () => 'taxrev_full'), reversePartialTransaction: jest.fn(async () => 'taxrev_part'),
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
    '212_marketplace_multi_quantity.sql', '213_storefront_payouts.sql', '214_storefront_shipping_quantity_and_tax_responsibility.sql', '227_storefront_tax_rule_seller_direct.sql', '215_storefront_channel_commission.sql',
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
  // Start from NO tax rules (the shared fixture gives every state a test rule): each test sets exactly what it needs.
  await q('DELETE FROM marketplace_tax_jurisdictions');
  await q(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS stripe_transfer_id text, ADD COLUMN IF NOT EXISTS payout_status text, ADD COLUMN IF NOT EXISTS transfer_failure_message text`);
  orders = require('../src/services/marketplaceOrderService');
  items = require('../src/services/marketplaceItemService');
  issues = require('../src/services/marketplaceOrderIssueService');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  app.use('/api/admin/tax-jurisdictions', require('../src/routes/adminTaxJurisdictions'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

const S = () => require('../src/services/storefrontSettlementService');
const taxSvc = () => require('../src/services/taxCalculationService');
const DAY = 864e5;
let cutoffSeq = 0;
async function preparedAt(days, orderId) {
  await S().prepareWeek({ cutoff: new Date(Date.now() + days * DAY + (++cutoffSeq) * 1000) });
  return (await one('SELECT storefront_payout_id FROM marketplace_orders WHERE id = $1', [orderId])).storefront_payout_id;
}
// The 50 states and Washington, D.C. (the platform's list also has the US territories).
const JURISDICTIONS = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const ADDR = { NY: { line1: '1 Broadway', city: 'New York', state: 'NY', postal_code: '10004' },
  CA: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105' },
  FL: { line1: '1 Ocean Dr', city: 'Miami Beach', state: 'FL', postal_code: '33139' } };
const setRule = (state, remitter) => call('admin', 'PUT', '/api/admin/tax-jurisdictions/' + state, { remitter, legal_basis: 'TEST ONLY: nationwide safeguard audit', effective_from: '2020-01-01' });
const clearRules = () => q('DELETE FROM marketplace_tax_jurisdictions');
const shippable = { shippable: true, shipping_cost_cents: 1500, shipping_method: 'parcel', shipping_destinations: 'us_all', shipping_price_mode: 'flat' };
const item = (extra = {}) => items.createDirectListing(U.sue.id, { title: 'Tax audit item ' + Math.random().toString(36).slice(2, 7), price_cents: 10000, ...extra });
const ship = (st) => ({ fulfillment_method: 'shipping', ship_to: { name: 'Buyer', country: 'US', ...ADDR[st] } });
const orderFor = (itemId, body = {}, buyer = 'bea') => call(buyer, 'POST', '/api/marketplace/orders', { item_id: itemId, policies_acknowledged: true, ...body });
const quoteFor = (itemId, body = {}, buyer = 'bea') => call(buyer, 'POST', '/api/marketplace/orders/quote', { item_id: itemId, ...body });
const stockOf = (id) => one('SELECT quantity, status FROM marketplace_items WHERE id = $1', [id]);
const orderRow = (id) => one('SELECT * FROM marketplace_orders WHERE id = $1', [id]);
async function paid(itemId, body = {}, buyer = 'bea') {
  const o = await orderFor(itemId, body, buyer);
  expect([o.status, o.body.code]).toEqual([200, undefined]);
  const id = o.body.data.order.id;
  expect((await call(buyer, 'POST', `/api/marketplace/orders/${id}/pay`, { payment_method_id: 'pm_' + buyer })).status).toBe(200);
  return id;
}
const fulfil = (id, action, extra = {}) => call('sue', 'POST', `/api/marketplace/seller/orders/${id}/fulfillment`, { action, ...extra });
beforeEach(async () => { global.__TAXBY = {}; global.__EXEMPT = false; await clearRules(); taxSvc().computeTax.mockClear(); taxSvc().reverseFullTransaction.mockClear(); });

describe('every state and Washington, D.C.: one rule per jurisdiction, nothing assumed', () => {
  test('no rule refuses; each of the three answers can be recorded and is enforced the same way in every jurisdiction', async () => {
    const notRegistered = { enabled: true, taxCents: 0, exempt: false, collecting: false };
    const registered = { enabled: true, taxCents: 700, exempt: false, collecting: true };
    const outcome = (rule, st, tax) => { try { return orders.taxConfiguration(rule, st, tax).remitter; } catch (e) { return e.code; } };
    for (const [i, st] of JURISDICTIONS.entries()) {
      expect(await orders.taxRuleFor(st)).toBeNull();
      expect(outcome(null, st, registered)).toBe('TAX_CONFIGURATION_REQUIRED');
      expect(outcome(null, st, notRegistered)).toBe('TAX_CONFIGURATION_REQUIRED');
      const remitter = ['platform', 'seller', 'seller_direct'][i % 3];   // different answers in different states
      const r = await setRule(st, remitter);
      expect([r.status, r.body.data && r.body.data.state, r.body.data && r.body.data.remitter]).toEqual([200, st, remitter]);
      const rule = await orders.taxRuleFor(st);
      expect(rule).toMatchObject({ state: st, remitter });
      if (remitter === 'seller_direct') {
        expect(outcome(rule, st, notRegistered)).toBe('none');
        expect(outcome(rule, st, registered)).toBe('TAX_CONFIGURATION_CONFLICT');
      } else {
        expect(outcome(rule, st, notRegistered)).toBe('TAX_NOT_COLLECTING');
        expect(outcome(rule, st, registered)).toBe(remitter);
      }
    }
    expect((await one('SELECT count(*)::int n FROM marketplace_tax_jurisdictions')).n).toBe(51);
  }, 60000);
  test('the safeguard has no state written into it (no special case for Texas or any other state)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    const guard = src.slice(src.indexOf('Storefront sales tax safeguard'), src.indexOf('// Load an item joined to its seller'));
    expect(guard.length).toBeGreaterThan(500);
    expect(guard).not.toMatch(/'[A-Z]{2}'/);
  });
});

describe('local pickup (Houston): taxed at the pickup state', () => {
  test('no Texas rule: refused at the quote and the order, nothing reserved, nothing charged', async () => {
    const it = await item();
    const intents = mockStripe.intents.size;
    expect((await quoteFor(it.id)).body.code).toBe('TAX_CONFIGURATION_REQUIRED');
    expect((await orderFor(it.id)).body.code).toBe('TAX_CONFIGURATION_REQUIRED');
    expect(await stockOf(it.id)).toEqual({ quantity: 1, status: 'active' });
    expect(mockStripe.intents.size).toBe(intents);   // no payment was started
  });
  test('Texas collected at checkout but no Texas registration: refused (never an untaxed sale)', async () => {
    await setRule('TX', 'platform');
    const it = await item();
    const r = await orderFor(it.id);
    expect([r.status, r.body.code]).toEqual([409, 'TAX_NOT_COLLECTING']);
    expect(await stockOf(it.id)).toEqual({ quantity: 1, status: 'active' });
  });
  test('Texas collected and registered: the Texas tax is charged and recorded with who remits it', async () => {
    await setRule('TX', 'platform'); global.__TAXBY = { TX: { rate: 0.0825 } };
    const it = await item();
    const id = await paid(it.id);
    expect(await orderRow(id)).toMatchObject({ tax_cents: 825, tax_remitter: 'platform', tax_jurisdiction: 'TX', total_charge_cents: 10825 });
    expect(taxSvc().computeTax.mock.calls.slice(-1)[0][0].address.state).toBe('TX');
  });
  test('Texas "not collected at checkout": the sale proceeds with no tax, recorded as none', async () => {
    await setRule('TX', 'seller_direct');
    const it = await item();
    const id = await paid(it.id);
    expect(await orderRow(id)).toMatchObject({ tax_cents: 0, tax_remitter: 'none', tax_jurisdiction: 'TX' });
  });
});

describe('interstate shipping from Texas: taxed at the destination state', () => {
  test('a Texas rule does not cover a New York delivery: refused until New York has its own rule', async () => {
    await setRule('TX', 'platform'); global.__TAXBY = { TX: { rate: 0.0825 } };
    const it = await item(shippable);
    const r = await orderFor(it.id, ship('NY'));
    expect([r.status, r.body.code]).toEqual([409, 'TAX_CONFIGURATION_REQUIRED']);
    expect(await stockOf(it.id)).toEqual({ quantity: 1, status: 'active' });
  });
  test('Texas to New York, Advantage.Bid remits (registered): New York tax on item + shipping, origin Texas', async () => {
    await setRule('NY', 'platform'); global.__TAXBY = { NY: { rate: 0.08875 } };
    const it = await item(shippable);
    const q1 = await quoteFor(it.id, ship('NY'));
    expect(q1.status).toBe(200); expect(q1.body.data.breakdown.tax_cents).toBe(Math.round(11500 * 0.08875));
    const id = await paid(it.id, ship('NY'));
    expect(await orderRow(id)).toMatchObject({ tax_cents: 1021, tax_remitter: 'platform', tax_jurisdiction: 'NY', total_charge_cents: 11500 + 1021 });
    const c = taxSvc().computeTax.mock.calls.slice(-1)[0][0];
    expect([c.address.state, c.shipFrom && c.shipFrom.state, c.taxableBaseCents]).toEqual(['NY', 'TX', 11500]);
  });
  test('Texas to California, the seller remits: the tax is collected and paid to the seller with the payout', async () => {
    await setRule('CA', 'seller'); global.__TAXBY = { CA: { rate: 0.0725 } };
    const it = await item(shippable);
    const id = await paid(it.id, ship('CA'));
    expect(await orderRow(id)).toMatchObject({ tax_cents: 834, tax_remitter: 'seller', tax_jurisdiction: 'CA' });
    expect((await fulfil(id, 'shipped', { tracking_carrier: 'UPS', tracking_number: '1ZCA' })).status).toBe(200);
    expect((await fulfil(id, 'complete')).status).toBe(200);
    expect(await preparedAt(9, id)).not.toBeNull();
    const line = await one('SELECT amount_cents, tax_to_seller_cents FROM storefront_payout_lines WHERE marketplace_order_id = $1 AND active', [id]);
    const o = await orderRow(id);
    expect(line).toEqual({ amount_cents: Number(o.seller_proceeds_cents) + 834, tax_to_seller_cents: 834 });
  });
  test('Texas to Florida: collected at checkout but not registered is refused; "not collected at checkout" proceeds with no tax', async () => {
    await setRule('FL', 'platform');
    const it = await item(shippable);
    expect((await orderFor(it.id, ship('FL'))).body.code).toBe('TAX_NOT_COLLECTING');
    await setRule('FL', 'seller_direct');
    const id = await paid(it.id, ship('FL'));
    expect(await orderRow(id)).toMatchObject({ tax_cents: 0, tax_remitter: 'none', tax_jurisdiction: 'FL' });
  });
  test('a destination that is registered but where this sale is not taxable: $0 is accepted (not every sale is taxable)', async () => {
    await setRule('NY', 'platform'); global.__TAXBY = { NY: { rate: 0 } };
    const it = await item(shippable);
    const id = await paid(it.id, ship('NY'));
    expect(await orderRow(id)).toMatchObject({ tax_cents: 0, tax_remitter: 'none', tax_jurisdiction: 'NY' });
  });
});

describe('exempt buyers and refunds', () => {
  test('an approved buyer exemption: no tax, the sale proceeds even where tax is collected at checkout', async () => {
    await setRule('NY', 'platform'); global.__TAXBY = { NY: { rate: 0.08875 } }; global.__EXEMPT = true;
    const it = await item(shippable);
    const id = await paid(it.id, ship('NY'));
    expect(await orderRow(id)).toMatchObject({ tax_cents: 0, tax_remitter: 'none', tax_jurisdiction: 'NY' });
  });
  test('refund of a taxed order: the buyer gets everything back including tax; the tax record is reversed', async () => {
    await setRule('NY', 'platform'); global.__TAXBY = { NY: { rate: 0.08875 } };
    const it = await item(shippable);
    const id = await paid(it.id, ship('NY'));
    const o = await orderRow(id);
    expect(o.stripe_tax_transaction_id).toBe('taxtx_calc_NY');
    const before = mockStripe.refunds.length;
    expect((await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/refund`, { reason: 'Tax audit refund' })).status).toBe(200);
    expect(mockStripe.refunds[before].amount).toBe(o.total_charge_cents);
    expect(taxSvc().reverseFullTransaction).toHaveBeenCalledWith(expect.objectContaining({ originalTransactionId: 'taxtx_calc_NY' }));
    expect(await orderRow(id)).toMatchObject({ refund_status: 'refunded', refunded_amount_cents: o.total_charge_cents });
  });
  test('refund after the seller was paid, seller-remitted tax: the recovery includes the tax the seller received', async () => {
    await setRule('CA', 'seller'); global.__TAXBY = { CA: { rate: 0.0725 } };
    const it = await item(shippable);
    const id = await paid(it.id, ship('CA'), 'ben');
    await fulfil(id, 'shipped', { tracking_carrier: 'UPS', tracking_number: '1ZCB' });
    await fulfil(id, 'complete');
    const payoutId = await preparedAt(10, id);
    expect(payoutId).not.toBeNull();
    const p = await one('SELECT * FROM storefront_payouts WHERE id = $1', [payoutId]);
    await S().payPayout(p.id, { actorId: U.admin.id, confirmedCompleted: true, finalAmountCents: p.seller_payout_cents });
    const line = await one('SELECT amount_cents, tax_to_seller_cents FROM storefront_payout_lines WHERE marketplace_order_id = $1 AND active', [id]);
    expect(line.tax_to_seller_cents).toBe(834);
    expect((await call('admin', 'POST', `/api/marketplace/admin/orders/${id}/refund`, { reason: 'Returned after payout (audit)' })).status).toBe(200);
    expect(await one(`SELECT amount_cents FROM storefront_payout_recoveries WHERE marketplace_order_id = $1 AND kind = 'refund'`, [id])).toEqual({ amount_cents: line.amount_cents });
  });
});

describe('no silent path', () => {
  test('a rule removed during checkout is caught by the second check (after the calculation); the units are released', async () => {
    await setRule('TX', 'seller_direct');
    const it = await item();
    const orig = taxSvc().computeTax.getMockImplementation();
    taxSvc().computeTax.mockImplementationOnce(async (a) => { await clearRules(); return orig(a); });
    const r = await orderFor(it.id);
    expect([r.status, r.body.code]).toEqual([409, 'TAX_CONFIGURATION_REQUIRED']);
    expect(await stockOf(it.id)).toEqual({ quantity: 1, status: 'active' });
  });
});
