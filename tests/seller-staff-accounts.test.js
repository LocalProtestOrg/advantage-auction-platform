'use strict';

/**
 * Professional Seller STAFF ACCOUNTS — adversarial tests (migration 199; owner-approved defaults 2026-10-16:
 * the four roles as designed, one company per person, Finance sees order numbers only, password + phone code step-up).
 *
 * Real Postgres (PGlite) running the real storefront migrations plus 199, the real services and the real
 * /api/seller-staff, /api/seller-storefront and /api/marketplace routes. Two companies (Nora, Sue), Nora's staff
 * (Ivy = Inventory Manager, Fred = Fulfillment, Fina = Finance), an outsider (Otto) and buyers. Every prohibited
 * action must fail and leave nothing changed.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const bcrypt = require('bcrypt');

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
  req.session = { sid: req.get('x-test-sid') || ('sid-' + req.get('x-test-user')), sv: 0 };   // one sign-in session per user unless named
  return next();
});
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
// Phone codes: a local sender that records the last code sent to each number (the real Twilio Verify path is not used).
const mockCodes = {};
jest.mock('../src/services/accountPhoneService', () => ({ ...jest.requireActual('../src/services/accountPhoneService'),
  sender: async () => ({ local: true, deliver: async (e164, code) => { mockCodes[e164] = code; } }) }));

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
  stripe_customer_id text, is_active boolean DEFAULT true, password_hash text, phone text, phone_verified_at timestamptz, phone_verified_e164 text,
  created_at timestamptz DEFAULT now());
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

let orders, items, staffSvc, server, base;
const U = {}; const SP = {};
const PW = 'Correct-Horse-Test-1';
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const rejects = async (sql, p) => { try { await global.__PG.query(sql, p || []); } catch (e) { return e; } throw new Error('expected the database to reject: ' + sql); };
const PHONE = { nora: '+17135550101', sue: '+17135550102' };

async function call(user, method, url, body, sid) {
  const headers = { 'content-type': 'application/json', 'x-test-user': user };
  if (sid) headers['x-test-sid'] = sid;
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}

beforeAll(async () => {
  process.env.SELLER_STAFF_ENABLED = 'true';
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  for (const f of ['119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql']) {
    await global.__PG.exec(mig(f));
  }
  await global.__PG.exec(mig('199_seller_staff_accounts.sql'));   // idempotent
  const hash = await bcrypt.hash(PW, 4);
  for (const [name, role] of [['nora', 'seller'], ['sue', 'seller'], ['bea', 'buyer'], ['ivy', 'buyer'], ['fred', 'buyer'], ['fina', 'buyer'],
    ['otto', 'buyer'], ['admin', 'admin']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role, password_hash, phone, phone_verified_e164, phone_verified_at)
      VALUES ($1, $2, $3, $4, $5, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END) RETURNING *`,
      [name + '@test.example', name.toUpperCase() + ' Person', role, hash, PHONE[name] || null]);
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
  staffSvc = require('../src/services/sellerStaffService');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  app.use('/api/seller-storefront', require('../src/routes/sellerStorefront'));
  app.use('/api/seller-staff', require('../src/routes/sellerStaff'));
  app.use('/api/admin/storefront', require('../src/routes/adminStorefrontModeration'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); delete process.env.SELLER_STAFF_ENABLED; });

// The owner confirms it's them (password + code to their verified phone) in the given session.
async function stepUp(owner, sid) {
  // Earlier codes in this test run are treated as more than an hour old, so the per-30-minute code limit is not hit.
  await q(`UPDATE seller_step_up_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = $1`, [U[owner].id]);
  const s = await call(owner, 'POST', '/api/seller-staff/step-up/start', { password: PW }, sid);
  expect(s.status).toBe(200);
  const c = await call(owner, 'POST', '/api/seller-staff/step-up/confirm', { code: mockCodes[PHONE[owner]] }, sid);
  expect(c.status).toBe(200);
}
// Nora invites `who` with `role` and `who` accepts; returns the membership row.
async function join(owner, who, role) {
  await stepUp(owner);
  const inv = await staffSvc.invite({ sellerId: SP[owner], userId: U[owner].id, role: 'owner', staff: false }, { email: U[who].email, role }, { returnToken: true });
  const a = await call(who, 'POST', '/api/seller-staff/invitations/accept', { token: inv._token });
  expect(a.status).toBe(200);
  return one('SELECT * FROM seller_staff_members WHERE id = $1', [inv.id]);
}
async function noraItem(extra = {}) {
  return items.createDirectListing(U.nora.id, { title: 'Walnut sideboard', price_cents: 10000, shippable: true, shipping_cost_cents: 1500,
    shipping_method: 'parcel', shipping_destinations: 'us_all', ...extra });
}
async function sueItem() { return items.createDirectListing(U.sue.id, { title: 'Brass lamp', price_cents: 5000 }); }
async function beaBuys(item) {
  const created = await orders.createOrder(item.id, U.bea.id, {});
  const paid = await orders.payOrder(created.order.id, U.bea.id, { paymentMethodId: 'pm_bea' });
  expect(paid.status).toBe('succeeded');
  return one('SELECT * FROM marketplace_orders WHERE id = $1', [created.order.id]);
}
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 25)); } };

let ivy; let fred; let fina;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('1. switched off, staff accounts do nothing', () => {
  test('with SELLER_STAFF_ENABLED off: no invitation routes, and even an active membership grants no seller access', async () => {
    const m = await join('nora', 'otto', 'fulfillment');
    process.env.SELLER_STAFF_ENABLED = 'false';
    try {
      expect((await call('nora', 'GET', '/api/seller-staff/team')).body.code).toBe('STAFF_NOT_AVAILABLE');
      expect((await call('nora', 'POST', '/api/seller-staff/invitations', { email: 'x@test.example', role: 'finance' })).status).toBe(404);
      const r = await call('otto', 'GET', '/api/marketplace/seller/orders');
      expect(r.status).toBe(403); expect(r.body.code).toBe('NOT_A_SELLER');
      expect((await call('otto', 'GET', '/api/seller-staff/me')).body.data).toMatchObject({ enabled: false, role: null, membership: null });
    } finally { process.env.SELLER_STAFF_ENABLED = 'true'; }
    // tidy: Otto leaves Nora's team so later tests can use him as an outsider
    await stepUp('nora');
    expect((await call('nora', 'POST', `/api/seller-staff/members/${m.id}/remove`)).status).toBe(200);
  });
});

describe('2. only the owner, after confirming with password + phone code, can change the team', () => {
  test('without the step-up, every team change is refused', async () => {
    const r = await call('nora', 'POST', '/api/seller-staff/invitations', { email: 'new@test.example', role: 'finance' }, 'fresh-session');
    expect(r.status).toBe(403); expect(r.body.code).toBe('STEP_UP_REQUIRED');
    expect(await one(`SELECT count(*)::int n FROM seller_staff_members WHERE invited_email = 'new@test.example'`)).toEqual({ n: 0 });
  });
  test('a wrong password sends no code; a wrong code is refused; a code works once', async () => {
    const bad = await call('nora', 'POST', '/api/seller-staff/step-up/start', { password: 'wrong' }, 's-pw');
    expect(bad.body.code).toBe('PASSWORD_INCORRECT');
    expect(await one(`SELECT count(*)::int n FROM seller_step_up_challenges WHERE session_sid = 's-pw' AND status <> 'password_failed'`)).toEqual({ n: 0 });
    await call('nora', 'POST', '/api/seller-staff/step-up/start', { password: PW }, 's-code');
    const code = mockCodes[PHONE.nora];
    const wrong = await call('nora', 'POST', '/api/seller-staff/step-up/confirm', { code: code === '0000' ? '1111' : '0000' }, 's-code');
    expect(wrong.body.code).toBe('WRONG_CODE');
    expect((await call('nora', 'POST', '/api/seller-staff/step-up/confirm', { code }, 's-code')).status).toBe(200);
    expect((await call('nora', 'POST', '/api/seller-staff/step-up/confirm', { code }, 's-code')).body.code).toBe('NO_CODE');
  });
  test('the step-up belongs to one sign-in session and expires', async () => {
    await stepUp('nora', 's-A');
    const other = await call('nora', 'POST', '/api/seller-staff/invitations', { email: 'sessB@test.example', role: 'finance' }, 's-B');
    expect(other.body.code).toBe('STEP_UP_REQUIRED');
    await q(`UPDATE seller_step_up_challenges SET granted_until = now() - interval '1 second' WHERE session_sid = 's-A'`);
    const expired = await call('nora', 'POST', '/api/seller-staff/invitations', { email: 'sessA@test.example', role: 'finance' }, 's-A');
    expect(expired.body.code).toBe('STEP_UP_REQUIRED');
  });
  test('codes are limited: 3 per 30 minutes, and 6 wrong entries lock the step-up for an hour', async () => {
    await q(`UPDATE seller_step_up_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = $1`, [U.sue.id]);
    for (let i = 0; i < 3; i++) expect((await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW }, 's-lim')).status).toBe(200);
    expect((await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW }, 's-lim')).body.code).toBe('RATE_LIMITED');
    await q(`UPDATE seller_step_up_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = $1`, [U.sue.id]);
    for (let i = 0; i < 2; i++) {
      await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW }, 's-lock');
      const wrong = mockCodes[PHONE.sue] === '0000' ? '1111' : '0000';
      for (let j = 0; j < 3; j++) await call('sue', 'POST', '/api/seller-staff/step-up/confirm', { code: wrong }, 's-lock');
    }
    expect((await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW }, 's-lock')).body.code).toBe('LOCKED');
    await q(`UPDATE seller_step_up_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = $1`, [U.sue.id]);
  });
  test('five wrong passwords lock the step-up for an hour', async () => {
    for (let i = 0; i < 5; i++) expect((await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: 'nope' }, 's-pwlock')).body.code).toBe('PASSWORD_INCORRECT');
    expect((await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW }, 's-pwlock')).body.code).toBe('LOCKED');
    await q(`UPDATE seller_step_up_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = $1`, [U.sue.id]);
  });
  test('parallel guesses cannot exceed three attempts for one code', async () => {
    await q(`UPDATE seller_step_up_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = $1`, [U.sue.id]);
    await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW }, 's-par');
    const wrong = mockCodes[PHONE.sue] === '0000' ? '1111' : '0000';
    await Promise.all(Array.from({ length: 8 }, () => call('sue', 'POST', '/api/seller-staff/step-up/confirm', { code: wrong }, 's-par')));
    const c = await one(`SELECT attempts, status FROM seller_step_up_challenges WHERE session_sid = 's-par' ORDER BY created_at DESC LIMIT 1`);
    expect(c.attempts).toBeLessThanOrEqual(3); expect(c.status).toBe('failed');
    expect((await call('sue', 'POST', '/api/seller-staff/step-up/confirm', { code: mockCodes[PHONE.sue] }, 's-par')).status).not.toBe(200);
    await q(`UPDATE seller_step_up_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = $1`, [U.sue.id]);
  });
  test('without a verified phone the step-up fails closed', async () => {
    await q('UPDATE users SET phone_verified_at = NULL WHERE id = $1', [U.sue.id]);
    try {
      const r = await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW });
      expect(r.status).toBe(409); expect(r.body.code).toBe('PHONE_NOT_VERIFIED');
    } finally { await q('UPDATE users SET phone_verified_at = now() WHERE id = $1', [U.sue.id]); }
  });
  test('buyers and staff cannot see or change any team, and cannot use the step-up', async () => {
    ivy = await join('nora', 'ivy', 'inventory_manager');
    fred = await join('nora', 'fred', 'fulfillment');
    fina = await join('nora', 'fina', 'finance');
    for (const who of ['bea', 'ivy', 'fred', 'fina']) {
      expect((await call(who, 'GET', '/api/seller-staff/team')).status).toBe(403);
      expect((await call(who, 'POST', '/api/seller-staff/step-up/start', { password: PW })).status).toBe(403);
      expect((await call(who, 'POST', '/api/seller-staff/invitations', { email: 'z@test.example', role: 'finance' })).status).toBe(403);
      expect((await call(who, 'POST', `/api/seller-staff/members/${fred.id}/remove`)).status).toBe(403);
    }
    expect((await one('SELECT status FROM seller_staff_members WHERE id = $1', [fred.id])).status).toBe('active');
  });
  test("Sue cannot see, change or remove Nora's staff (indistinguishable from not found)", async () => {
    await stepUp('sue');
    const team = await call('sue', 'GET', '/api/seller-staff/team');
    expect(JSON.stringify(team.body.data)).not.toMatch(/ivy@|fred@|fina@/);
    for (const [a, b] of [['remove'], ['suspend'], ['role', { role: 'finance' }], ['revoke']]) {
      const r = await call('sue', 'POST', `/api/seller-staff/members/${fred.id}/${a}`, b);
      expect(r.status).toBe(404);
    }
    expect(await one('SELECT seller_id, role, status FROM seller_staff_members WHERE id = $1', [fred.id])).toEqual({ seller_id: SP.nora, role: 'fulfillment', status: 'active' });
  });
});

describe('3. invitations: single use, the invited email only, one company per person', () => {
  const owner = () => ({ sellerId: SP.nora, userId: U.nora.id, role: 'owner', staff: false });
  test('an invitation can only be accepted by the account with the invited email, once', async () => {
    const inv = await staffSvc.invite(owner(), { email: 'Otto@Test.Example', role: 'finance' }, { returnToken: true });
    expect(inv.email).toBe('otto@test.example');
    const wrong = await call('bea', 'POST', '/api/seller-staff/invitations/accept', { token: inv._token });
    expect(wrong.body.code).toBe('EMAIL_MISMATCH');
    expect((await call('bea', 'POST', '/api/seller-staff/invitations/preview', { token: inv._token })).body.data.email_matches).toBe(false);
    expect((await call('otto', 'POST', '/api/seller-staff/invitations/accept', { token: inv._token })).status).toBe(200);
    expect((await call('otto', 'POST', '/api/seller-staff/invitations/accept', { token: inv._token })).body.code).toBe('INVITE_NOT_FOUND');
    expect((await call('otto', 'POST', '/api/seller-staff/invitations/accept', { token: 'x'.repeat(43) })).body.code).toBe('INVITE_NOT_FOUND');
  });
  test('a person already on one company cannot join another; a company owner cannot become staff; inviting reveals neither', async () => {
    const sueOwner = { sellerId: SP.sue, userId: U.sue.id, role: 'owner', staff: false };
    // Sending the invitation tells Sue nothing about Fred or Nora (same answer as for anyone); acceptance is what refuses.
    const toFred = await staffSvc.invite(sueOwner, { email: U.fred.email, role: 'fulfillment' }, { returnToken: true });
    const toNora = await staffSvc.invite(sueOwner, { email: U.nora.email, role: 'finance' }, { returnToken: true });
    expect(Object.keys(toFred).sort()).toEqual(Object.keys(toNora).sort());
    expect(toFred.status).toBe('invited'); expect(toNora.status).toBe('invited');
    expect((await call('fred', 'POST', '/api/seller-staff/invitations/accept', { token: toFred._token })).body.code).toBe('ALREADY_STAFF');
    expect((await call('nora', 'POST', '/api/seller-staff/invitations/accept', { token: toNora._token })).body.code).toBe('INVITEE_IS_OWNER');
    // the database also refuses making an active staff account a company owner
    const e = await rejects(`INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1, 'auction_house')`, [U.fred.id]);
    expect(e.message).toMatch(/staff of a seller company/);
    // invited before joining elsewhere → refused at acceptance
    const early = await staffSvc.invite(sueOwner, { email: 'late@test.example', role: 'finance' }, { returnToken: true });
    U.late = await one(`INSERT INTO users (email, role) VALUES ('late@test.example', 'buyer') RETURNING *`);
    const lateToNora = await staffSvc.invite(owner(), { email: 'late@test.example', role: 'finance' }, { returnToken: true });
    expect((await call('late', 'POST', '/api/seller-staff/invitations/accept', { token: lateToNora._token })).status).toBe(200);
    expect((await call('late', 'POST', '/api/seller-staff/invitations/accept', { token: early._token })).body.code).toBe('ALREADY_STAFF');
  });
  test('an expired invitation cannot be accepted; a revoked one neither', async () => {
    const inv = await staffSvc.invite(owner(), { email: 'exp@test.example', role: 'finance' }, { returnToken: true });
    U.exp = await one(`INSERT INTO users (email, role) VALUES ('exp@test.example', 'buyer') RETURNING *`);
    await q(`UPDATE seller_staff_members SET invite_expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.id]);
    expect((await call('exp', 'POST', '/api/seller-staff/invitations/accept', { token: inv._token })).status).toBe(410);
    expect((await one('SELECT status FROM seller_staff_members WHERE id = $1', [inv.id])).status).toBe('expired');
    const inv2 = await staffSvc.invite(owner(), { email: 'exp@test.example', role: 'finance' }, { returnToken: true });
    await stepUp('nora');
    expect((await call('nora', 'POST', `/api/seller-staff/members/${inv2.id}/revoke`)).status).toBe(200);
    expect((await call('exp', 'POST', '/api/seller-staff/invitations/accept', { token: inv2._token })).body.code).toBe('INVITE_NOT_FOUND');
  });
  test('invitations store only a hash of the link and cannot be invited as "owner"', async () => {
    const inv = await staffSvc.invite(owner(), { email: 'hash@test.example', role: 'finance' }, { returnToken: true });
    const row = await one('SELECT invite_token_hash FROM seller_staff_members WHERE id = $1', [inv.id]);
    expect(row.invite_token_hash).not.toContain(inv._token);
    expect(row.invite_token_hash).toBe(staffSvc._hashToken(inv._token));
    await expect(staffSvc.invite(owner(), { email: 'own@test.example', role: 'owner' })).rejects.toMatchObject({ code: 'ROLE_INVALID' });
  });
});

describe('4. staff act for their own company only, within their role', () => {
  test('Inventory Manager: lists items as Nora even when the request names Sue; cannot touch Sue\'s items', async () => {
    const r = await call('ivy', 'POST', '/api/seller-storefront/items', { title: 'Oak chair', price_cents: 3000, seller_id: SP.sue });
    expect(r.status).toBe(201); expect(r.body.data.seller_id).toBe(SP.nora);
    const sue = await sueItem();
    const e = await call('ivy', 'PATCH', '/api/seller-storefront/items/' + sue.id, { price_cents: 1 });
    expect(e.status).toBe(403); expect(e.body.code).toBe('NOT_OWNER');
    expect((await one('SELECT price_cents FROM marketplace_items WHERE id = $1', [sue.id])).price_cents).toBe(5000);
    const list = (await call('ivy', 'GET', '/api/seller-storefront/items')).body.data;
    expect(list.every((x) => x.seller_id === SP.nora)).toBe(true);
    // staff see the pickup city/state, never the private street address
    expect(JSON.stringify(list)).not.toMatch(/1 Nora St|77001/);
    expect(list[0].location.address).toEqual({ city: 'Houston', state: 'TX' });
    expect(JSON.stringify((await call('nora', 'GET', '/api/seller-storefront/items')).body.data)).toMatch(/1 Nora St/);
    // ...including in create and save responses (an empty save must not return the full row)
    expect(JSON.stringify(r.body.data)).not.toMatch(/1 Nora St|77001|converted_by_user_id/);
    const empty = await call('ivy', 'PATCH', '/api/seller-storefront/items/' + r.body.data.id, {});
    expect(empty.status).toBe(200);
    expect(JSON.stringify(empty.body.data)).not.toMatch(/1 Nora St|77001|pickup_address_line1|pickup_postal_code/);
  });
  test('Inventory Manager: no storefront settings, no street address, no inquiries, no fulfilment, no buyer contact or fees', async () => {
    const cfg = (await call('ivy', 'GET', '/api/seller-storefront/config')).body.data;
    expect(cfg).toMatchObject({ staff: true, role: 'inventory_manager', pickup_location: { confirmed: true, address: { city: 'Houston', state: 'TX' } } });
    expect(JSON.stringify(cfg)).not.toMatch(/1 Nora St|77001/);
    expect((await call('ivy', 'PUT', '/api/seller-storefront/config', { published: false })).status).toBe(403);
    expect((await call('ivy', 'PUT', '/api/seller-storefront/pickup-location', { line1: 'x' })).status).toBe(403);
    expect((await call('ivy', 'GET', '/api/seller-storefront/inquiries')).status).toBe(403);
    const o = await beaBuys(await noraItem());
    const f = await call('ivy', 'POST', `/api/marketplace/seller/orders/${o.id}/fulfillment`, { action: 'picked_up' });
    expect(f.status).toBe(403); expect(f.body.code).toBe('SELLER_PERMISSION');
    const seen = (await call('ivy', 'GET', '/api/marketplace/seller/orders')).body.data.find((x) => x.id === o.id);
    expect(seen).toBeDefined();
    expect(seen.buyer_email).toBeNull(); expect(seen.buyer_name).toBeNull(); expect(seen.ship_to).toBeNull();
    expect(seen.seller_proceeds_cents).toBeUndefined(); expect(seen.platform_fee_cents).toBeUndefined();
    expect((await one('SELECT fulfillment_status FROM marketplace_orders WHERE id = $1', [o.id])).fulfillment_status).toBe('unfulfilled');
  });
  test('Fulfillment: sees the buyer contact for Nora\'s paid orders (no fees), records pickup under their own name, cannot touch Sue\'s orders', async () => {
    const o = await beaBuys(await noraItem());
    const seen = (await call('fred', 'GET', '/api/marketplace/seller/orders')).body.data.find((x) => x.id === o.id);
    expect(seen.buyer_email).toBe('bea@test.example');
    expect(seen.seller_proceeds_cents).toBeUndefined();
    const so = await beaBuys(await sueItem());
    expect((await call('fred', 'GET', '/api/marketplace/seller/orders')).body.data.map((x) => x.id)).not.toContain(so.id);
    const theirs = await call('fred', 'POST', `/api/marketplace/seller/orders/${so.id}/fulfillment`, { action: 'picked_up' });
    expect(theirs.status).toBe(403); expect(theirs.body.code).toBe('NOT_OWNER');
    expect((await call('fred', 'GET', `/api/marketplace/seller/orders/${so.id}/history`)).status).toBe(404);
    const ok = await call('fred', 'POST', `/api/marketplace/seller/orders/${o.id}/fulfillment`, { action: 'picked_up' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.seller_proceeds_cents).toBeUndefined();
    const ev = await one(`SELECT seller_id, actor_user_id, actor_role FROM marketplace_order_events WHERE order_id = $1 AND event_type = 'fulfillment'`, [o.id]);
    expect(ev).toEqual({ seller_id: SP.nora, actor_user_id: U.fred.id, actor_role: 'seller' });
    const hist = await waitFor(() => one(`SELECT seller_id, actor_user_id, data FROM seller_staff_events WHERE member_id = $1 AND action = 'sensitive_action'`, [fred.id]));
    expect(hist).toMatchObject({ seller_id: SP.nora, actor_user_id: U.fred.id, data: { permission: 'company.orders.fulfil', role: 'fulfillment' } });
    expect((await call('fred', 'POST', '/api/seller-storefront/items', { title: 'x', price_cents: 100 })).status).toBe(403);
    expect((await one('SELECT fulfillment_status FROM marketplace_orders WHERE id = $1', [so.id])).fulfillment_status).toBe('unfulfilled');
  });
  test('Finance: sees order numbers, fees and proceeds, never buyer names, emails or addresses; cannot fulfil or change anything', async () => {
    const o = await beaBuys(await noraItem());
    const seen = (await call('fina', 'GET', '/api/marketplace/seller/orders')).body.data.find((x) => x.id === o.id);
    expect(seen.order_number).toBeTruthy();
    expect(seen.seller_proceeds_cents).toBe(o.seller_proceeds_cents);
    expect(seen.platform_fee_cents).toBe(o.platform_fee_cents);
    expect(seen.buyer_email).toBeNull(); expect(seen.buyer_name).toBeNull(); expect(seen.ship_to).toBeNull();
    expect(JSON.stringify(seen)).not.toMatch(/bea@test|BEA Person/);
    expect((await call('fina', 'POST', `/api/marketplace/seller/orders/${o.id}/fulfillment`, { action: 'picked_up' })).status).toBe(403);
    expect((await call('fina', 'PATCH', '/api/seller-storefront/items/' + o.marketplace_item_id, { price_cents: 1 })).status).toBe(403);
    // a buyer's issue text can carry their phone or address: Finance sees the issue, not the words
    const issues = require('../src/services/marketplaceOrderIssueService');
    await issues.openIssue(o.id, U.bea.id, { category: 'pickup_problem', message: 'Call me at 713-555-0199, I live at 5 Buyer Rd' });
    const fi = (await call('fina', 'GET', '/api/marketplace/seller/issues')).body.data.find((x) => x.order_id === o.id);
    expect(fi.category).toBe('pickup_problem'); expect(fi.message).toBeNull();
    const ni = (await call('nora', 'GET', '/api/marketplace/seller/issues')).body.data.find((x) => x.order_id === o.id);
    expect(ni.message).toMatch(/5 Buyer Rd/);
  });
  test('only the owner and Fulfillment-free roles are refused buyer-issue responses; staff never reach admin tools', async () => {
    for (const who of ['ivy', 'fred', 'fina']) {
      expect((await call(who, 'POST', '/api/marketplace/seller/issues/00000000-0000-4000-8000-000000000000/respond', { response: 'hi' })).status).toBe(403);
      expect((await call(who, 'GET', '/api/admin/storefront/items')).status).toBe(403);
      expect((await call(who, 'GET', '/api/marketplace/admin/orders')).status).toBe(403);
    }
  });
});

describe('5. removing, pausing or changing a role takes effect on the next request', () => {
  test('pause → no access; restore → access; role change → new limits; remove → gone for good', async () => {
    const o = await beaBuys(await noraItem());
    await stepUp('nora');
    expect((await call('nora', 'POST', `/api/seller-staff/members/${fred.id}/suspend`)).status).toBe(200);
    expect((await call('fred', 'GET', '/api/marketplace/seller/orders')).body.code).toBe('NOT_A_SELLER');
    expect((await call('nora', 'POST', `/api/seller-staff/members/${fred.id}/reinstate`)).status).toBe(200);
    expect((await call('fred', 'GET', '/api/marketplace/seller/orders')).status).toBe(200);
    expect((await call('nora', 'POST', `/api/seller-staff/members/${fred.id}/role`, { role: 'finance' })).status).toBe(200);
    expect((await call('fred', 'POST', `/api/marketplace/seller/orders/${o.id}/fulfillment`, { action: 'picked_up' })).body.code).toBe('SELLER_PERMISSION');
    expect((await call('nora', 'POST', `/api/seller-staff/members/${fred.id}/remove`)).status).toBe(200);
    expect((await call('fred', 'GET', '/api/marketplace/seller/orders')).body.code).toBe('NOT_A_SELLER');
    expect((await call('nora', 'POST', `/api/seller-staff/members/${fred.id}/reinstate`)).body.code).toBe('BAD_TRANSITION');
    const e = await rejects(`UPDATE seller_staff_members SET status = 'active' WHERE id = $1`, [fred.id]);
    expect(e.message).toMatch(/cannot become/);
    const team = (await call('nora', 'GET', '/api/seller-staff/team')).body.data;
    const actions = team.history.filter((h) => h.member_email === 'fred@test.example').map((h) => h.action);
    for (const a of ['invited', 'accepted', 'suspended', 'reinstated', 'role_changed', 'removed']) expect(actions).toContain(a);
  });
  test('a suspended platform account loses staff access too', async () => {
    await q('UPDATE users SET is_active = false WHERE id = $1', [U.fina.id]);
    try { expect((await call('fina', 'GET', '/api/marketplace/seller/orders')).body.code).toBe('NOT_A_SELLER'); }
    finally { await q('UPDATE users SET is_active = true WHERE id = $1', [U.fina.id]); }
  });
});

describe('6. the database keeps memberships attributable', () => {
  test('a membership never moves to another company or person, is never deleted, and its history is append-only', async () => {
    for (const [sql, p] of [
      ['UPDATE seller_staff_members SET seller_id = $2 WHERE id = $1', [ivy.id, SP.sue]],
      ['UPDATE seller_staff_members SET user_id = $2 WHERE id = $1', [ivy.id, U.otto.id]],
      ["UPDATE seller_staff_members SET invited_email = 'x@test.example' WHERE id = $1", [ivy.id]],
      ['DELETE FROM seller_staff_members WHERE id = $1', [ivy.id]],
      ["UPDATE seller_staff_events SET action = 'invited' WHERE member_id = $1", [ivy.id]],
      ['DELETE FROM seller_staff_events WHERE member_id = $1', [ivy.id]],
    ]) {
      const e = await rejects(sql, p);
      expect(e.message).toMatch(/keeps|kept permanently|append-only/);
    }
    expect(await one('SELECT seller_id, user_id FROM seller_staff_members WHERE id = $1', [ivy.id])).toEqual({ seller_id: SP.nora, user_id: U.ivy.id });
  });
  test('history naming another company, a second active company for one person, an owner as staff, and non-owner invitations are refused', async () => {
    const fk = await rejects(`INSERT INTO seller_staff_events (member_id, seller_id, action, actor_role) VALUES ($1, $2, 'removed', 'owner')`, [ivy.id, SP.sue]);
    expect(fk.message).toMatch(/foreign key/i);
    const byStaff = await rejects(`INSERT INTO seller_staff_members (seller_id, invited_email, role, invited_by) VALUES ($1, 'a@test.example', 'finance', $2)`, [SP.nora, U.ivy.id]);
    expect(byStaff.message).toMatch(/only the company owner/);
    await q(`UPDATE seller_staff_members SET status = 'revoked' WHERE seller_id = $1 AND status = 'invited'`, [SP.sue]);   // earlier tests' open invitations
    const m = await one(`INSERT INTO seller_staff_members (seller_id, invited_email, role, invited_by) VALUES ($1, 'ivy@test.example', 'finance', $2) RETURNING id`, [SP.sue, U.sue.id]);
    const two = await rejects(`UPDATE seller_staff_members SET user_id = $2, status = 'active' WHERE id = $1`, [m.id, U.ivy.id]);
    expect(two.message).toMatch(/unique|duplicate/i);
    const m2 = await one(`INSERT INTO seller_staff_members (seller_id, invited_email, role, invited_by) VALUES ($1, 'nora@test.example', 'finance', $2) RETURNING id`, [SP.sue, U.sue.id]);
    const ownerStaff = await rejects(`UPDATE seller_staff_members SET user_id = $2, status = 'active' WHERE id = $1`, [m2.id, U.nora.id]);
    expect(ownerStaff.message).toMatch(/owner cannot be staff/);
    const asOwner = await rejects(`INSERT INTO seller_staff_members (seller_id, invited_email, role, invited_by) VALUES ($1, 'o@test.example', 'owner', $2)`, [SP.nora, U.nora.id]);
    expect(asOwner.message).toMatch(/check/i);
  });
});

describe('7. staff do not change pricing', () => {
  test('a staff-created item is sold with the storefront pricing: no buyer\'s premium, 11% seller fee', async () => {
    const r = await call('ivy', 'POST', '/api/seller-storefront/items', { title: 'Mirror', price_cents: 20000 });
    const o = await beaBuys(r.body.data);
    expect(o.seller_id).toBe(SP.nora);
    expect(o.total_charge_cents).toBe(20000 + (o.shipping_cents || 0) + (o.tax_cents || 0));
    expect(o.platform_fee_bps).toBe(1100);
  });
});

describe('8. one-company pilot (general switch off, SELLER_STAFF_PILOT_SELLER_IDS = one company)', () => {
  beforeAll(() => { process.env.SELLER_STAFF_ENABLED = 'false'; process.env.SELLER_STAFF_PILOT_SELLER_IDS = SP.nora; });
  afterAll(() => { process.env.SELLER_STAFF_ENABLED = 'true'; delete process.env.SELLER_STAFF_PILOT_SELLER_IDS; });
  test('the pilot company can manage its team and its staff can work; every other company is as if staff accounts were off', async () => {
    expect((await call('nora', 'GET', '/api/seller-staff/team')).status).toBe(200);
    expect((await call('nora', 'GET', '/api/seller-staff/me')).body.data.enabled).toBe(true);
    expect((await call('ivy', 'POST', '/api/seller-storefront/items', { title: 'Pilot chair', price_cents: 1500 })).status).toBe(201);
    const sueTeam = await call('sue', 'GET', '/api/seller-staff/team');
    expect(sueTeam.status).toBe(404); expect(sueTeam.body.code).toBe('STAFF_NOT_AVAILABLE');
    expect((await call('sue', 'POST', '/api/seller-staff/step-up/start', { password: PW })).body.code).toBe('STAFF_NOT_AVAILABLE');
    expect((await call('sue', 'GET', '/api/seller-staff/me')).body.data.enabled).toBe(false);
  });
  test("an active member of a non-pilot company has no access, and that company's invitations cannot be opened or accepted", async () => {
    const m = await one(`INSERT INTO seller_staff_members (seller_id, invited_email, role, invited_by) VALUES ($1, 'exp@test.example', 'fulfillment', $2) RETURNING id`, [SP.sue, U.sue.id]);
    await q(`UPDATE seller_staff_members SET user_id = $2, status = 'active', accepted_at = now() WHERE id = $1`, [m.id, U.exp.id]);
    const r = await call('exp', 'GET', '/api/marketplace/seller/orders');
    expect(r.status).toBe(403); expect(r.body.code).toBe('NOT_A_SELLER');
    expect((await call('exp', 'GET', '/api/seller-staff/me')).body.data.membership).toBeNull();
    const token = 'pilot-test-token-' + 'x'.repeat(30);
    U.inv = await one(`INSERT INTO users (email, role) VALUES ('inv@test.example', 'buyer') RETURNING *`);
    await q(`INSERT INTO seller_staff_members (seller_id, invited_email, role, invited_by, invite_token_hash, invite_expires_at)
      VALUES ($1, 'inv@test.example', 'finance', $2, $3, now() + interval '1 day')`, [SP.sue, U.sue.id, staffSvc._hashToken(token)]);
    expect((await call('inv', 'POST', '/api/seller-staff/invitations/preview', { token })).body.code).toBe('INVITE_NOT_FOUND');
    expect((await call('inv', 'POST', '/api/seller-staff/invitations/accept', { token })).body.code).toBe('INVITE_NOT_FOUND');
    expect((await one(`SELECT status FROM seller_staff_members WHERE invited_email = 'inv@test.example'`)).status).toBe('invited');
  });
  test('the pilot list accepts only company ids; with no pilot and the switch off, nothing is available', () => {
    const g = require('../src/lib/launchGuards');
    expect(g.sellerStaffPilotIds({ SELLER_STAFF_PILOT_SELLER_IDS: ` ${SP.nora}, not-an-id ,` })).toEqual([SP.nora.toLowerCase()]);
    expect(g.sellerStaffEnabledFor(SP.sue, { SELLER_STAFF_PILOT_SELLER_IDS: SP.nora })).toBe(false);
    expect(g.sellerStaffEnabledFor(SP.nora, { SELLER_STAFF_PILOT_SELLER_IDS: SP.nora })).toBe(true);
    expect(g.sellerStaffAvailableAnywhere({})).toBe(false);
    expect(g.sellerStaffEnabledFor(SP.nora, {})).toBe(false);
  });
});
