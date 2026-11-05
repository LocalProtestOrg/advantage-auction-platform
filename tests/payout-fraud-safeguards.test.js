'use strict';

/**
 * Seller payout and fraud safeguards (owner-approved 2026-11-05; docs/projects/seller-fraud-protections-assessment.md).
 * Real Postgres (PGlite) with migrations 218 and 219, the real routes (admin settlements, payout profile, payout
 * preferences, auction shipping), the real settlement engine and the real audit writer. The payment processor and email
 * are in-memory stand-ins. Covers:
 *   • administrator hold / release on auction settlements: admin only, reason required, audited, idempotent, one release
 *     when two run at once, never released while a payment dispute is open (including a dispute-webhook hold);
 *   • suspended sellers are not paid by Mark Paid or Direct Deposit unless an administrator gives an audited reason;
 *   • payout-detail changes are audited (masked values only), the seller is emailed, replacing a destination needs the
 *     current password, and a payout within 7 days of a change waits for an audited administrator review reason;
 *   • Connect status and account changes are audited;
 *   • auction shipments (Phase 3 scaffolding, AUCTION_SHIPPING_ENABLED): seller isolation, tracking required and kept as
 *     recorded (database trigger), signature above $500 unless an audited override, per-shipment limit, delivery +
 *     3 business days payout hold in the settlement pay paths.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-payout-safeguards'; // test value, never a real secret
process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_not_a_real_key';                    // test placeholder
process.env.SELLER_SETTLEMENTS_ENABLED = 'true';
process.env.STRIPE_CONNECT_ENABLED = 'true';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const bcrypt = require('bcrypt');

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
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*(select|with)/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: u.id, role: u.role };
  return next();
});
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/ownerAlertService', () => ({ notifyAdminActionRequired: jest.fn(async () => {}), ALERT_TYPES: { SETTLEMENT_EXCEPTION: 'x' } }));
const mockStripe = { transfers: [], accounts: new Map(), n: 0 };
jest.mock('stripe', () => () => ({
  transfers: { create: async (p, o) => {
    const key = o && o.idempotencyKey; const prior = mockStripe.transfers.find((t) => t.key === key);
    if (prior) return { id: prior.id };
    const t = { id: 'tr_' + (mockStripe.transfers.length + 1), ...p, key }; mockStripe.transfers.push(t); return { id: t.id }; } },
  paymentIntents: { retrieve: async () => ({}) },
  v2: { core: {
    accounts: {
      create: async () => { const id = 'acct_new_' + (++mockStripe.n); return { id }; },
      retrieve: async (id) => mockStripe.accounts.get(id) || { id },
    },
    accountLinks: { create: async () => ({ url: 'https://connect.example.test/onboard', expires_at: 0 }) },
  } },
}));

const BASE = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, full_name text, role text DEFAULT 'buyer', staff_role text,
  staff_active boolean DEFAULT true, is_active boolean NOT NULL DEFAULT true, password_hash text, is_demo boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text, display_name text,
  platform_fee_bps int, capabilities jsonb DEFAULT '{}'::jsonb, verification_required_before_publication boolean DEFAULT false, metadata jsonb DEFAULT '{}'::jsonb,
  is_demo boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid REFERENCES seller_profiles(id), title text, end_time timestamptz DEFAULT now(),
  state text DEFAULT 'closed', platform_fee_bps int, processing_fee_bps int, pricing_model text DEFAULT 'legacy', processing_fee_basis text, is_demo boolean DEFAULT false);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid REFERENCES auctions(id), lot_number int, title text, state text DEFAULT 'closed',
  is_withdrawn boolean DEFAULT false, winning_amount_cents int, winning_buyer_user_id uuid, shippable boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE buyer_auction_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, buyer_user_id uuid, total_cents int DEFAULT 0,
  hammer_cents int DEFAULT 0, buyer_premium_cents int DEFAULT 0, sales_tax_cents int DEFAULT 0, shipping_cents int DEFAULT 0, status text DEFAULT 'issued');
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, lot_id uuid, buyer_user_id uuid, status text, payment_intent_id text,
  refunded_amount_cents int DEFAULT 0, stripe_fee_cents int, stripe_refund_fee_cents int, stripe_refund_fee_refunded_cents int, created_at timestamptz DEFAULT now());
CREATE TABLE settlement_adjustments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, adjustment_type text, amount_cents int, voided_at timestamptz,
  created_at timestamptz DEFAULT now());
CREATE TABLE marketing_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, package_price_cents int, created_at timestamptz DEFAULT now());
CREATE TABLE settlement_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid NOT NULL, seller_user_id uuid NOT NULL, version int NOT NULL,
  snapshot jsonb NOT NULL, is_final boolean NOT NULL DEFAULT false, computed_at timestamptz DEFAULT now(), created_by_user_id uuid, UNIQUE (auction_id, version));
CREATE UNIQUE INDEX uq_settlement_snapshot_final ON settlement_snapshots(auction_id) WHERE is_final;
CREATE TABLE seller_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid NOT NULL UNIQUE, seller_user_id uuid NOT NULL,
  gross_revenue_cents int DEFAULT 0, platform_fee_cents int DEFAULT 0, seller_payout_cents int DEFAULT 0, payout_method text, payout_status text DEFAULT 'pending',
  payout_reference text, settlement_status text NOT NULL DEFAULT 'pending_review', settlement_version int NOT NULL DEFAULT 1, on_hold_reason text,
  paid_at timestamptz, paid_by_user_id uuid, payment_method_used text, final_amount_paid_cents int, payment_note text, stripe_transfer_id text UNIQUE,
  transfer_initiated_at timestamptz, transfer_failure_message text, platform_fee_bps int, processing_fee_bps int, processing_fee_cents int DEFAULT 0,
  void_reason text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT chk_seller_payouts_settlement_status CHECK (settlement_status IN ('pending_review','approved','ready_for_payment','paid','on_hold','void')));
CREATE TABLE seller_payout_preferences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_user_id uuid NOT NULL UNIQUE, payout_method text NOT NULL,
  ach_account_last4 text, ach_routing_last4 text, ach_account_name text, check_payee_name text, check_address_line1 text, check_address_line2 text,
  check_city text, check_state text, check_postal_code text, is_verified boolean DEFAULT false, stripe_bank_account_ref text, bank_name text, ach_account_type text,
  stripe_bank_account_livemode boolean, setup_completed_at timestamptz, tax_status text, stripe_account_id text UNIQUE, stripe_account_livemode boolean,
  superseded_stripe_account_id text, connect_status text, connect_details_submitted boolean DEFAULT false, connect_transfers_active boolean DEFAULT false,
  connect_payouts_enabled boolean DEFAULT false, connect_disabled_reason text, connect_bank_name text, connect_bank_last4 text, connect_updated_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE payment_disputes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stripe_dispute_id text NOT NULL UNIQUE, stripe_charge_id text, payment_intent_id text,
  payment_id uuid, auction_id uuid, buyer_user_id uuid, seller_payout_id uuid, amount_cents int, currency text, reason text, status text NOT NULL,
  livemode boolean NOT NULL DEFAULT false, evidence_due_by timestamptz, payout_hold_applied boolean NOT NULL DEFAULT false, payout_hold_note text,
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, last_event_id text, last_event_type text, marketplace_order_id uuid, marketplace_seller_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  auction_id uuid, lot_id uuid, payment_id uuid, actor_id uuid, metadata jsonb, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE marketplace_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text, fulfillment_method text);
CREATE TABLE verification_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, status text, reviewed_by uuid, reviewed_at timestamptz,
  created_at timestamptz DEFAULT now());
`;

const PASSWORD = 'seeded-test-password-1';   // clearly-labeled test password (never a real credential)
let server, base;
const U = {}; const SP = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
async function call(user, method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}
const audits = (type, entityId) => q('SELECT * FROM audit_log WHERE event_type = $1 AND entity_id = $2 ORDER BY created_at', [type, entityId]);
const sendEmail = () => require('../src/services/emailService').sendEmail;

// A closed auction for `seller` with one paid invoice of `cents` and a settlement awaiting review.
async function settledAuction(seller, cents = 10000) {
  const a = await one(`INSERT INTO auctions (seller_id, title) VALUES ($1, 'Safeguard auction') RETURNING id`, [SP[seller]]);
  await q(`INSERT INTO lots (auction_id, lot_number, title, winning_amount_cents, winning_buyer_user_id) VALUES ($1, 1, 'Lot', $2, $3)`, [a.id, cents, U.bea.id]);
  await q(`INSERT INTO buyer_auction_invoices (auction_id, buyer_user_id, total_cents, hammer_cents, status) VALUES ($1, $2, $3, $3, 'paid')`, [a.id, U.bea.id, cents]);
  const sp = await one(`INSERT INTO seller_payouts (auction_id, seller_user_id, seller_payout_cents) VALUES ($1, $2, $3) RETURNING id`, [a.id, U[seller].id, cents]);
  // the payable amount (a Professional Seller pays the platform fee on the hammer)
  const net = (await require('../src/services/settlementEngine').computeSettlement(a.id)).net_seller_proceeds_cents;
  return { auctionId: a.id, payoutId: sp.id, cents: net };
}
const checkPref = (seller, payee = 'Pat Seller', line1 = '1 Main St') => q(
  `INSERT INTO seller_payout_preferences (seller_user_id, payout_method, check_payee_name, check_address_line1, check_city, check_state, check_postal_code)
   VALUES ($1, 'check', $2, $3, 'Detroit', 'MI', '48226')
   ON CONFLICT (seller_user_id) DO UPDATE SET payout_method = 'check', check_payee_name = $2, check_address_line1 = $3`, [U[seller].id, payee, line1]);
const achPref = (seller, acct) => q(
  `INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, stripe_account_livemode, connect_status, connect_details_submitted,
     connect_transfers_active, connect_payouts_enabled) VALUES ($1, 'ach', $2, false, 'ready', true, true, true)
   ON CONFLICT (seller_user_id) DO UPDATE SET payout_method = 'ach', stripe_account_id = $2, connect_transfers_active = true, connect_payouts_enabled = true`, [U[seller].id, acct]);
const markPaid = (auctionId, cents, extra = {}) => call('admin', 'POST', '/api/admin/settlements/' + auctionId + '/mark-paid',
  { payment_method: 'check', payment_reference: 'CHK-' + Math.random().toString(36).slice(2, 8), paid_at: '2026-11-05', final_amount_cents: cents, confirmed_completed: true, ...extra });
const paySeller = (auctionId, cents, extra = {}) => call('admin', 'POST', '/api/admin/settlements/' + auctionId + '/pay-seller',
  { final_amount_cents: cents, confirmed_completed: true, ...extra });

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  for (const f of ['218_auction_shipping_phase1.sql', '219_shipment_fulfillment_and_delivery.sql']) {
    await global.__PG.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const [name, role] of [['cara', 'seller'], ['dan', 'seller'], ['eve', 'seller'], ['fay', 'seller'], ['gil', 'seller'], ['hal', 'seller'],
    ['bea', 'buyer'], ['ben', 'buyer'], ['admin', 'admin']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`, [name + '@test.example', name.toUpperCase(), role, hash]);
  }
  global.__USERS = U;
  for (const name of ['cara', 'dan', 'eve', 'fay', 'gil', 'hal']) {
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, $2, $3) RETURNING id`,
      [U[name].id, name === 'hal' || name === 'gil' ? 'auction_house' : 'private', name.toUpperCase() + ' Co'])).id;
  }
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/settlements', require('../src/routes/adminSettlements'));
  app.use('/api/payout-profile', require('../src/routes/payoutProfile'));
  app.use('/api/payout-preferences', require('../src/routes/payoutPreferences'));
  app.use('/api/auction-shipping', require('../src/routes/auctionShipping'));
  app.use((err, req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);
afterAll(async () => { delete process.env.AUCTION_SHIPPING_ENABLED; if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('administrator hold and release on auction settlements', () => {
  let s;
  beforeAll(async () => { await checkPref('cara'); s = await settledAuction('cara'); });

  test('only an administrator can hold or release; a seller cannot touch even their own settlement', async () => {
    expect((await call('cara', 'POST', '/api/admin/settlements/' + s.auctionId + '/hold', { reason: 'seller wants a hold' })).status).toBe(403);
    expect((await call('bea', 'POST', '/api/admin/settlements/' + s.auctionId + '/release', { reason: 'buyer tries release' })).status).toBe(403);
    expect((await call(null, 'POST', '/api/admin/settlements/' + s.auctionId + '/hold', { reason: 'anonymous' })).status).toBe(401);
    expect((await one('SELECT settlement_status FROM seller_payouts WHERE id = $1', [s.payoutId])).settlement_status).toBe('pending_review');
  });

  test('a hold needs a reason, is audited once, and holding again changes nothing', async () => {
    const none = await call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/hold', { reason: ' ' });
    expect(none.status).toBe(422); expect(none.body.code).toBe('REASON_REQUIRED');
    const r = await call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/hold', { reason: 'Buyer reported a problem' });
    expect(r.status).toBe(200); expect(r.body.data).toMatchObject({ settlement_status: 'on_hold', on_hold_reason: 'Buyer reported a problem', changed: true });
    const again = await call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/hold', { reason: 'A second reason' });
    expect(again.body.data).toMatchObject({ settlement_status: 'on_hold', on_hold_reason: 'Buyer reported a problem', changed: false });
    const rows = await audits('settlement.on_hold', s.payoutId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: U.admin.id, auction_id: s.auctionId });
    expect(rows[0].metadata).toMatchObject({ source: 'admin', reason: 'Buyer reported a problem', previous_status: 'pending_review' });
  });

  test('a held settlement cannot be paid', async () => {
    const r = await markPaid(s.auctionId, s.cents);
    expect(r.status).toBe(422); expect(r.body.message).toMatch(/on hold/i);
  });

  test('two releases at the same time: one release, one audit row, and the settlement is reviewable again', async () => {
    const [a, b] = await Promise.all([
      call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/release', { reason: 'Problem resolved with buyer' }),
      call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/release', { reason: 'Problem resolved with buyer' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.data.changed, b.body.data.changed].sort()).toEqual([false, true]);
    expect(await audits('settlement.hold_released', s.payoutId)).toHaveLength(1);
    expect(await one('SELECT settlement_status, on_hold_reason FROM seller_payouts WHERE id = $1', [s.payoutId])).toEqual({ settlement_status: 'pending_review', on_hold_reason: null });
    const rel = (await audits('settlement.hold_released', s.payoutId))[0];
    expect(rel.metadata).toMatchObject({ reason: 'Problem resolved with buyer', previous_hold_reason: 'Buyer reported a problem' });
  });

  test('a paid settlement cannot be held or released', async () => {
    expect((await markPaid(s.auctionId, s.cents)).status).toBe(200);
    const r = await call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/hold', { reason: 'too late now' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_CHANGEABLE');
  });

  test('a settlement that does not exist is not found; the settlements switch still governs changes', async () => {
    expect((await call('admin', 'POST', '/api/admin/settlements/00000000-0000-4000-8000-000000000099/hold', { reason: 'no such thing' })).status).toBe(404);
    process.env.SELLER_SETTLEMENTS_ENABLED = 'false';
    try { expect((await call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/release', { reason: 'switch off' })).status).toBe(409); }
    finally { process.env.SELLER_SETTLEMENTS_ENABLED = 'true'; }
  });
});

describe('a dispute hold is never released while the dispute is open', () => {
  let s;
  beforeAll(async () => {
    await checkPref('dan'); s = await settledAuction('dan');
    await q(`INSERT INTO payments (auction_id, buyer_user_id, status, payment_intent_id, stripe_fee_cents) VALUES ($1, $2, 'paid', 'pi_disputed_1', 0)`, [s.auctionId, U.bea.id]);
  });
  const dispute = (type, status) => require('../src/services/disputeService').handleDisputeEvent({ id: 'evt_' + type + status, type,
    data: { object: { id: 'dp_1', payment_intent: 'pi_disputed_1', charge: 'ch_1', amount: 10000, currency: 'usd', reason: 'fraudulent', status } } });

  test('the dispute webhook holds the payout; a release is refused while it is open and allowed once it closes', async () => {
    await dispute('charge.dispute.created', 'needs_response');
    expect((await one('SELECT settlement_status FROM seller_payouts WHERE id = $1', [s.payoutId])).settlement_status).toBe('on_hold');
    const refused = await call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/release', { reason: 'Trying to release early' });
    expect(refused.status).toBe(409); expect(refused.body.code).toBe('DISPUTE_OPEN');
    expect((await one('SELECT settlement_status FROM seller_payouts WHERE id = $1', [s.payoutId])).settlement_status).toBe('on_hold');
    expect(await audits('settlement.hold_released', s.payoutId)).toHaveLength(0);
    await dispute('charge.dispute.closed', 'won');
    expect((await one('SELECT settlement_status FROM seller_payouts WHERE id = $1', [s.payoutId])).settlement_status).toBe('on_hold');   // closing never auto-releases
    const ok = await call('admin', 'POST', '/api/admin/settlements/' + s.auctionId + '/release', { reason: 'Dispute won; evidence accepted' });
    expect(ok.status).toBe(200); expect(ok.body.data.changed).toBe(true);
    expect(await audits('settlement.hold_released', s.payoutId)).toHaveLength(1);
  });

  test('the open-dispute check fails closed', async () => {
    const engine = require('../src/services/settlementEngine');
    expect(await engine.countOpenDisputes({ query: async () => { throw new Error('connection lost'); } }, s.auctionId)).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('suspended sellers are not paid (both auction pay paths)', () => {
  let check, dd;
  beforeAll(async () => {
    await checkPref('eve'); check = await settledAuction('eve', 5000);
    await achPref('hal', 'acct_hal_1'); dd = await settledAuction('hal', 7000);
    await q('UPDATE users SET is_active = false WHERE id = ANY($1)', [[U.eve.id, U.hal.id]]);
  });

  test('Mark Paid is refused and names the override; a short reason is not enough', async () => {
    const r = await markPaid(check.auctionId, check.cents);
    expect(r.status).toBe(422); expect(r.body).toMatchObject({ code: 'SELLER_SUSPENDED', override: 'suspended_seller' });
    const short = await markPaid(check.auctionId, check.cents, { override_reasons: { suspended_seller: 'ok' } });
    expect(short.body.code).toBe('SELLER_SUSPENDED');
    expect((await one('SELECT settlement_status FROM seller_payouts WHERE id = $1', [check.payoutId])).settlement_status).toBe('pending_review');
  });

  test('an administrator may pay with a written reason, which is audited with the payment', async () => {
    const r = await markPaid(check.auctionId, check.cents, { override_reasons: { suspended_seller: 'Suspension was for a listing issue, sale is legitimate' } });
    expect(r.status).toBe(200);
    const rows = await audits('settlement.suspended_seller_override', check.payoutId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: U.admin.id, auction_id: check.auctionId });
    expect(rows[0].metadata).toMatchObject({ override: 'suspended_seller', path: 'mark_paid', seller_user_id: U.eve.id });
  });

  test('Direct Deposit is refused with no transfer created, and works only with the audited override', async () => {
    const before = mockStripe.transfers.length;
    const r = await paySeller(dd.auctionId, dd.cents);
    expect(r.status).toBe(422); expect(r.body.code).toBe('SELLER_SUSPENDED');
    expect(mockStripe.transfers.length).toBe(before);
    const ok = await paySeller(dd.auctionId, dd.cents, { override_reasons: { suspended_seller: 'Owner approved paying this completed sale' } });
    expect(ok.status).toBe(200);
    expect(mockStripe.transfers.length).toBe(before + 1);
    expect(await audits('settlement.suspended_seller_override', dd.payoutId)).toHaveLength(1);
  });

  test('an unknown account state is treated as suspended (fail closed)', async () => {
    const sg = require('../src/services/payoutSafeguards');
    expect(await sg.sellerAccountActive(U.cara.id, { query: async () => { throw new Error('db down'); } })).toBe(false);
    expect(await sg.sellerAccountActive('00000000-0000-4000-8000-000000000123')).toBe(false);
    expect(await sg.sellerAccountActive(U.cara.id)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('payout-detail changes: audited, notified, password for a new destination, 7-day review', () => {
  let s;
  beforeAll(async () => { await checkPref('fay', 'Fay Original', '10 Old Rd'); s = await settledAuction('fay', 8000); sendEmail().mockClear(); });

  const save = (body) => call('fay', 'PUT', '/api/payout-profile/me', { payout_method: 'check', payee_name: 'Fay New Payee', address_line1: '99 New St',
    city: 'Chicago', state: 'IL', postal_code: '60601', ...body });

  test('replacing an existing destination needs the current password; nothing changes without it', async () => {
    const r = await save({});
    expect(r.status).toBe(403); expect(r.body.code).toBe('PASSWORD_REQUIRED');
    const wrong = await save({ current_password: 'not-the-password' });
    expect(wrong.status).toBe(403); expect(wrong.body.code).toBe('PASSWORD_INCORRECT');
    expect((await one('SELECT check_payee_name FROM seller_payout_preferences WHERE seller_user_id = $1', [U.fay.id])).check_payee_name).toBe('Fay Original');
    expect(await audits('seller.payout_details_changed', U.fay.id)).toHaveLength(0);
  });

  test('with the password: saved, audited with field names and masked values only, and the seller is emailed', async () => {
    const r = await save({ current_password: PASSWORD });
    expect(r.status).toBe(200);
    const rows = await audits('seller.payout_details_changed', U.fay.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ source: 'payout_profile_check', destination_changed: true, first_setup: false });
    expect(rows[0].metadata.changed_fields).toEqual(expect.arrayContaining(['check_payee_name', 'check_address_line1', 'check_city', 'check_state', 'check_postal_code']));
    const json = JSON.stringify(rows[0].metadata);
    for (const secret of ['Fay New Payee', 'Fay Original', '99 New St', '10 Old Rd', '60601', '48226', 'Chicago']) expect(json).not.toContain(secret);
    expect(rows[0].metadata.after).toMatchObject({ payout_method: 'check', check_state: 'IL' });
    expect(sendEmail()).toHaveBeenCalledWith(expect.objectContaining({ to: 'fay@test.example', subject: expect.stringMatching(/payout details were changed/) }));
    expect(sendEmail().mock.calls[0][0].text).not.toContain('99 New St');
  });

  test('a payout within 7 days of the change waits for an administrator review reason, which is audited', async () => {
    const r = await markPaid(s.auctionId, s.cents);
    expect(r.status).toBe(422); expect(r.body).toMatchObject({ code: 'RECENT_PAYOUT_CHANGE', override: 'recent_payout_change' });
    const ok = await markPaid(s.auctionId, s.cents, { override_reasons: { recent_payout_change: 'Called seller at number on file; change confirmed' } });
    expect(ok.status).toBe(200);
    const rows = await audits('settlement.payout_change_review_override', s.payoutId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ override: 'recent_payout_change', reason: 'Called seller at number on file; change confirmed' });
  });

  test('a change older than 7 days no longer holds a payout', async () => {
    const s2 = await settledAuction('fay', 3000);
    await q(`UPDATE audit_log SET created_at = created_at - interval '8 days' WHERE event_type = 'seller.payout_details_changed' AND entity_id = $1`, [U.fay.id]);
    expect((await markPaid(s2.auctionId, s2.cents)).status).toBe(200);
  });

  test('saving the same destination again needs no password and is not a change', async () => {
    const before = (await audits('seller.payout_details_changed', U.fay.id)).length;
    const r = await save({});
    expect(r.status).toBe(200);
    expect((await audits('seller.payout_details_changed', U.fay.id)).length).toBe(before);
  });

  test('first-time setup: no password, audited and emailed, but no review hold', async () => {
    sendEmail().mockClear();
    const r = await call('gil', 'PUT', '/api/payout-profile/me', { payout_method: 'check', payee_name: 'Gil Co', address_line1: '2 Elm St', city: 'Austin', state: 'TX', postal_code: '78701' });
    expect(r.status).toBe(200);
    const rows = await audits('seller.payout_details_changed', U.gil.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ destination_changed: false, first_setup: true });
    expect(sendEmail()).toHaveBeenCalledWith(expect.objectContaining({ to: 'gil@test.example', subject: expect.stringMatching(/set up/) }));
    const s3 = await settledAuction('gil', 2500);
    expect((await markPaid(s3.auctionId, s3.cents)).status).toBe(200);
  });

  test('the legacy payout-preferences route is audited and password-protected the same way', async () => {
    const r = await call('gil', 'PUT', '/api/payout-preferences/me', { payout_method: 'check', check_payee_name: 'Someone Else', check_address_line1: '7 Far Rd' });
    expect(r.status).toBe(403); expect(r.body.code).toBe('PASSWORD_REQUIRED');
    const ok = await call('gil', 'PUT', '/api/payout-preferences/me', { payout_method: 'check', check_payee_name: 'Someone Else', check_address_line1: '7 Far Rd', current_password: PASSWORD });
    expect(ok.status).toBe(200);
    const rows = await audits('seller.payout_details_changed', U.gil.id);
    expect(rows[rows.length - 1].metadata).toMatchObject({ source: 'payout_preferences', destination_changed: true });
  });

  test('the recent-change check fails closed when it cannot run', async () => {
    const sg = require('../src/services/payoutSafeguards');
    expect(await sg.recentPayoutDestinationChange(U.gil.id, { query: async () => { throw new Error('db down'); } })).toEqual({ at: null, unknown: true });
    expect(() => sg.assertPayoutSafeguards({ sellerActive: true, recentChange: { at: null, unknown: true } }, {})).toThrow(/could not be checked/);
  });
});

describe('Direct Deposit account changes are audited', () => {
  test('switching a check destination to a new connected account needs the password and is a destination change', async () => {
    const denied = await call('gil', 'POST', '/api/payout-profile/me/connect/onboard', {});
    expect(denied.status).toBe(403); expect(denied.body.code).toBe('PASSWORD_REQUIRED');
    const ok = await call('gil', 'POST', '/api/payout-profile/me/connect/onboard', { current_password: PASSWORD });
    expect(ok.status).toBe(200);
    const rows = await audits('seller.payout_details_changed', U.gil.id);
    const last = rows[rows.length - 1];
    expect(last.metadata).toMatchObject({ source: 'connect_account', destination_changed: true });
    expect(last.metadata.after.connected_account).toMatch(/^\.\.\..{4}$/);   // masked, never the full id
    expect(JSON.stringify(last.metadata)).not.toMatch(/acct_new_\d+"/);
  });

  test('a status change from the payment processor is audited as a status change and never triggers the payout review', async () => {
    const pref = await one('SELECT stripe_account_id FROM seller_payout_preferences WHERE seller_user_id = $1', [U.gil.id]);
    await q(`UPDATE audit_log SET created_at = created_at - interval '8 days' WHERE entity_id = $1`, [U.gil.id]);
    mockStripe.accounts.set(pref.stripe_account_id, { id: pref.stripe_account_id, configuration: { recipient: { capabilities: { stripe_balance: {
      stripe_transfers: { status: 'active' }, payouts: { status: 'active' } } } } }, requirements: { summary: { minimum_deadline: { status: 'up_to_date' } } } });
    await require('../src/services/stripeConnectService').syncAccountById(pref.stripe_account_id);
    const rows = await audits('seller.connect_status_changed', U.gil.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ source: 'connect_status_sync', destination_changed: false });
    expect(rows[0].metadata.changed_fields).toEqual(expect.arrayContaining(['connect_status', 'connect_transfers_active', 'connect_payouts_enabled']));
    expect(await require('../src/services/payoutSafeguards').recentPayoutDestinationChange(U.gil.id)).toBeNull();
    // the same status again: nothing new is recorded
    await require('../src/services/stripeConnectService').syncAccountById(pref.stripe_account_id);
    expect(await audits('seller.connect_status_changed', U.gil.id)).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('auction shipments (Phase 3 scaffolding, AUCTION_SHIPPING_ENABLED)', () => {
  let auctionId, profileId, lowLot, highLot, payoutId;
  beforeAll(async () => {
    profileId = (await one(`INSERT INTO seller_shipping_profiles (seller_profile_id, name) VALUES ($1, 'Std') RETURNING id`, [SP.hal])).id;
    const a = await one(`INSERT INTO auctions (seller_id, title) VALUES ($1, 'Shipping auction') RETURNING id`, [SP.hal]);
    auctionId = a.id;
    lowLot = (await one(`INSERT INTO lots (auction_id, lot_number, title, winning_amount_cents, winning_buyer_user_id, shipping_eligible, shipping_profile_id)
      VALUES ($1, 1, 'Vase', 20000, $2, true, $3) RETURNING id`, [auctionId, U.bea.id, profileId])).id;
    highLot = (await one(`INSERT INTO lots (auction_id, lot_number, title, winning_amount_cents, winning_buyer_user_id, shipping_eligible, shipping_profile_id)
      VALUES ($1, 2, 'Clock', 40000, $2, true, $3) RETURNING id`, [auctionId, U.ben.id, profileId])).id;
    await q(`INSERT INTO lots (auction_id, lot_number, title, winning_amount_cents, winning_buyer_user_id) VALUES ($1, 3, 'Pickup only', 5000, $2)`, [auctionId, U.bea.id]);
    await q(`INSERT INTO buyer_auction_invoices (auction_id, buyer_user_id, total_cents, hammer_cents, status) VALUES ($1, $2, 25000, 25000, 'paid'), ($1, $3, 40000, 40000, 'issued')`,
      [auctionId, U.bea.id, U.ben.id]);
    payoutId = (await one(`INSERT INTO seller_payouts (auction_id, seller_user_id) VALUES ($1, $2) RETURNING id`, [auctionId, U.hal.id])).id;
    await q('UPDATE users SET is_active = true WHERE id = $1', [U.hal.id]);
  });
  afterEach(() => { delete process.env.AUCTION_SHIPPING_ENABLED; });
  const on = () => { process.env.AUCTION_SHIPPING_ENABLED = 'true'; };

  test('flag off: the shipment routes are not found', async () => {
    expect((await call('hal', 'POST', '/api/auction-shipping/shipments', { auction_id: auctionId, buyer_user_id: U.bea.id })).status).toBe(404);
  });

  test('seller isolation: another seller cannot create, read or ship a shipment for this auction', async () => {
    on();
    expect((await call('gil', 'POST', '/api/auction-shipping/shipments', { auction_id: auctionId, buyer_user_id: U.bea.id })).status).toBe(404);
    const r = await call('hal', 'POST', '/api/auction-shipping/shipments', { auction_id: auctionId, buyer_user_id: U.bea.id });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ created: true, status: 'pending', total_item_value_cents: 20000, signature_required: false });
    expect(r.body.data.lots.map((l) => l.lot_id)).toEqual([lowLot]);   // the pickup-only lot is never shipped
    const id = r.body.data.id;
    expect((await call('gil', 'GET', '/api/auction-shipping/shipments/' + id)).status).toBe(404);
    expect((await call('ben', 'GET', '/api/auction-shipping/shipments/' + id)).status).toBe(404);
    expect((await call('bea', 'GET', '/api/auction-shipping/shipments/' + id)).status).toBe(200);
    expect((await call('gil', 'POST', '/api/auction-shipping/shipments/' + id + '/ship', { carrier: 'UPS', tracking_number: '1Z1' })).status).toBe(404);
    const again = await call('hal', 'POST', '/api/auction-shipping/shipments', { auction_id: auctionId, buyer_user_id: U.bea.id });
    expect(again.body.data).toMatchObject({ id, created: false });   // one per buyer per auction
  });

  test('tracking is required to ship and is kept as recorded (service and database)', async () => {
    on();
    const s = (await one('SELECT id FROM auction_shipments WHERE auction_id = $1 AND buyer_user_id = $2', [auctionId, U.bea.id])).id;
    const none = await call('hal', 'POST', '/api/auction-shipping/shipments/' + s + '/ship', { carrier: 'UPS' });
    expect(none.status).toBe(422); expect(none.body.violations).toContain('tracking_required');
    await expect(q(`UPDATE auction_shipments SET status = 'shipped', shipped_at = now() WHERE id = $1`, [s])).rejects.toThrow(/carrier and tracking/);
    const ok = await call('hal', 'POST', '/api/auction-shipping/shipments/' + s + '/ship', { carrier: 'UPS', tracking_number: '1Z999AA1' });
    expect(ok.status).toBe(200); expect(ok.body.data).toMatchObject({ status: 'shipped', carrier: 'UPS', tracking_number: '1Z999AA1' });
    await expect(q(`UPDATE auction_shipments SET tracking_number = 'CHANGED' WHERE id = $1`, [s])).rejects.toThrow(/kept as recorded/);
    await expect(q(`UPDATE auction_shipments SET status = 'pending' WHERE id = $1`, [s])).rejects.toThrow(/cannot move/);
    await expect(q(`DELETE FROM auction_shipments WHERE id = $1`, [s])).rejects.toThrow(/cannot be deleted/);
    await expect(q(`DELETE FROM auction_shipment_lots WHERE shipment_id = $1`, [s])).rejects.toThrow(/kept as recorded/);
    expect(await audits('auction_shipment.shipped', s)).toHaveLength(1);
  });

  test('signature above $500 unless an administrator override with a reason (audited); the limit applies too', async () => {
    on();
    await q('UPDATE seller_profiles SET shipping_per_shipment_limit_cents = 30000 WHERE id = $1', [SP.hal]);
    const over = await call('hal', 'POST', '/api/auction-shipping/shipments', { auction_id: auctionId, buyer_user_id: U.ben.id });
    expect(over.status).toBe(409); expect(over.body.code).toBe('OVER_PER_SHIPMENT_LIMIT');
    await q('UPDATE seller_profiles SET shipping_per_shipment_limit_cents = 100000 WHERE id = $1', [SP.hal]);
    await q(`UPDATE lots SET winning_amount_cents = 60000 WHERE id = $1`, [highLot]);
    const c = await call('hal', 'POST', '/api/auction-shipping/shipments', { auction_id: auctionId, buyer_user_id: U.ben.id });
    expect(c.body.data).toMatchObject({ total_item_value_cents: 60000, signature_required: true });
    const id = c.body.data.id;
    await q(`UPDATE buyer_auction_invoices SET status = 'paid' WHERE auction_id = $1 AND buyer_user_id = $2`, [auctionId, U.ben.id]);
    const noSig = await call('hal', 'POST', '/api/auction-shipping/shipments/' + id + '/ship', { carrier: 'FedEx', tracking_number: 'FX1' });
    expect(noSig.status).toBe(422); expect(noSig.body.violations).toEqual(['signature_required']);
    await expect(q(`UPDATE auction_shipments SET status = 'shipped', carrier = 'FedEx', tracking_number = 'FX1', shipped_at = now() WHERE id = $1`, [id]))
      .rejects.toThrow(/signature confirmation/);
    expect((await call('hal', 'POST', '/api/auction-shipping/admin/shipments/' + id + '/override', { kind: 'signature', reason: 'seller wants it' })).status).toBe(403);
    expect((await call('admin', 'POST', '/api/auction-shipping/admin/shipments/' + id + '/override', { kind: 'signature', reason: '' })).body.code).toBe('REASON_REQUIRED');
    const ov = await call('admin', 'POST', '/api/auction-shipping/admin/shipments/' + id + '/override', { kind: 'signature', reason: 'Buyer is a known dealer; insured' });
    expect(ov.status).toBe(200); expect(ov.body.data.signature_override).toMatchObject({ reason: 'Buyer is a known dealer; insured' });
    expect(await audits('auction_shipping_admin_override', id)).toHaveLength(1);
    await expect(q(`UPDATE auction_shipments SET signature_override_reason = 'rewritten' WHERE id = $1`, [id])).rejects.toThrow(/overrides are kept/);
    expect((await call('hal', 'POST', '/api/auction-shipping/shipments/' + id + '/ship', { carrier: 'FedEx', tracking_number: 'FX1' })).status).toBe(200);
    // the buyer never sees the administrator's override note
    expect((await call('ben', 'GET', '/api/auction-shipping/shipments/' + id)).body.data.signature_override).toBeUndefined();
  });

  test('cannot ship before the buyer has paid', async () => {
    on();
    const a2 = await one(`INSERT INTO auctions (seller_id, title) VALUES ($1, 'Unpaid') RETURNING id`, [SP.hal]);
    await q(`INSERT INTO lots (auction_id, lot_number, title, winning_amount_cents, winning_buyer_user_id, shipping_eligible, shipping_profile_id) VALUES ($1, 1, 'X', 1000, $2, true, $3)`,
      [a2.id, U.bea.id, profileId]);
    const c = await call('hal', 'POST', '/api/auction-shipping/shipments', { auction_id: a2.id, buyer_user_id: U.bea.id });
    const r = await call('hal', 'POST', '/api/auction-shipping/shipments/' + c.body.data.id + '/ship', { carrier: 'UPS', tracking_number: '1Z2' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_PAID');
  });

  test('settlement payout waits for confirmed delivery plus 3 business days (only with the flag on)', async () => {
    await achPref('hal', 'acct_hal_1');
    await q(`UPDATE audit_log SET created_at = created_at - interval '30 days' WHERE entity_id = $1`, [U.hal.id]);
    const engine = require('../src/services/settlementEngine');
    const net = (await engine.computeSettlement(auctionId)).net_seller_proceeds_cents;
    on();
    const held = await paySeller(auctionId, net);
    expect(held.status).toBe(422); expect(held.body).toMatchObject({ code: 'SHIPPING_DELIVERY_HOLD', override: 'shipping_delivery_hold' });
    const [bea, ben] = [await one('SELECT id FROM auction_shipments WHERE auction_id = $1 AND buyer_user_id = $2', [auctionId, U.bea.id]),
      await one('SELECT id FROM auction_shipments WHERE auction_id = $1 AND buyer_user_id = $2', [auctionId, U.ben.id])];
    // the seller cannot confirm delivery; the buyer confirms their own; an administrator needs a note
    expect((await call('hal', 'POST', '/api/auction-shipping/shipments/' + bea.id + '/confirm-delivery', {})).status).toBe(404);
    expect((await call('ben', 'POST', '/api/auction-shipping/shipments/' + bea.id + '/confirm-delivery', {})).status).toBe(404);
    const d1 = await call('bea', 'POST', '/api/auction-shipping/shipments/' + bea.id + '/confirm-delivery', {});
    expect(d1.status).toBe(200); expect(d1.body.data.status).toBe('delivered');
    const policy = require('../src/lib/auctionShippingPolicy');
    expect(new Date(d1.body.data.payout_release_at).getTime()).toBe(policy.payoutReleaseAt(new Date(d1.body.data.delivered_at)).getTime());
    expect((await call('admin', 'POST', '/api/auction-shipping/shipments/' + ben.id + '/confirm-delivery', {})).body.code).toBe('REASON_REQUIRED');
    const early = await call('admin', 'POST', '/api/auction-shipping/shipments/' + ben.id + '/confirm-delivery', { delivered_at: new Date(Date.now() - 10 * 864e5).toISOString(), note: 'Carrier tracking shows delivered' });
    expect(early.status).toBe(422); expect(early.body.code).toBe('BAD_DATE');   // before it shipped
    const d2 = await call('admin', 'POST', '/api/auction-shipping/shipments/' + ben.id + '/confirm-delivery', { note: 'Carrier tracking shows delivered' });
    expect(d2.status).toBe(200); expect(d2.body.data.delivery_confirmation_source).toBe('admin');
    await expect(q(`UPDATE auction_shipments SET delivered_at = now() WHERE id = $1`, [ben.id])).rejects.toThrow(/delivery is kept/);
    // bea's delivery was just now: still inside the 3 business day hold
    const still = await paySeller(auctionId, net);
    expect(still.body.code).toBe('SHIPPING_DELIVERY_HOLD'); expect(still.body.message).toMatch(/held until/);
    // flag off: the shipping hold is not consulted at all (today's behavior)
    delete process.env.AUCTION_SHIPPING_ENABLED;
    expect((await engine.payoutSafeguardFacts({ seller_user_id: U.hal.id }, auctionId)).shippingHold).toBeNull();
    on();
    // after the release date passes the payout proceeds
    await q(`UPDATE auction_shipments SET payout_release_at = payout_release_at WHERE id = $1`, [bea.id]);   // no-op (release date is kept as recorded)
    const hold = await require('../src/services/auctionShipmentService').payoutHoldForAuction(auctionId, new Date(Date.now() + 8 * 864e5));
    expect(hold.blocked).toBe(false);
    const ok = await paySeller(auctionId, net, { override_reasons: { shipping_delivery_hold: 'Buyer confirmed receipt by phone; release early' } });
    expect(ok.status).toBe(200);
    expect(await audits('settlement.shipping_delivery_hold_override', payoutId)).toHaveLength(1);
  });

  test('the shipment hold check fails closed', async () => {
    const hold = await require('../src/services/auctionShipmentService').payoutHoldForAuction('x', new Date(), { query: async () => { throw new Error('gone'); } });
    expect(hold.blocked).toBe(true);
  });
});
