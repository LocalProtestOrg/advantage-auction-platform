'use strict';

/**
 * Payout destination changes: identity confirmation and seller isolation (owner decisions 2026-11-05).
 * Real Postgres (PGlite) with migration 220, the real payout profile / preferences routes, the real payout safeguards,
 * the real one-time code service and the real audit writer; email and the payment processor are in-memory stand-ins.
 *   • An account with a password confirms with it (wrong passwords throttled).
 *   • An account without a usable password (directory sign-in bridge, or no password hash) must use a one-time code
 *     emailed to the account: never stored, 6 digits, 10 minutes, single use, bound to the account and purpose, attempt-
 *     limited, rate-limited. No unverified bypass.
 *   • Seller isolation: no seller (or another company's staff, or any id-guessing) can read or change another seller's
 *     payout profile, preferences, Direct Deposit onboarding or bank confirmation.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-payout-identity'; // test value, never a real secret
process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_not_a_real_key';                  // test placeholder
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
jest.mock('../src/services/cardService', () => ({ ensureStripeCustomer: jest.fn(async (userId) => 'cus_' + userId) }));
const mockSI = new Map();
jest.mock('stripe', () => () => ({
  setupIntents: { retrieve: async (id) => mockSI.get(id) },
  v2: { core: {
    accounts: { create: async (p) => ({ id: 'acct_for_' + p.metadata.seller_user_id.slice(0, 8) }), retrieve: async (id) => ({ id }) },
    accountLinks: { create: async () => ({ url: 'https://connect.example.test/onboard', expires_at: 0 }) },
  } },
}));

const BASE = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, contact_email text, full_name text, role text DEFAULT 'buyer',
  staff_role text, staff_active boolean DEFAULT true, is_active boolean NOT NULL DEFAULT true, password_hash text, auth_source text NOT NULL DEFAULT 'native',
  is_demo boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text, display_name text);
CREATE TABLE seller_staff_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid, user_id uuid, role text, status text);
CREATE TABLE seller_payout_preferences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_user_id uuid NOT NULL UNIQUE, payout_method text NOT NULL,
  ach_account_last4 text, ach_routing_last4 text, ach_account_name text, check_payee_name text, check_address_line1 text, check_address_line2 text,
  check_city text, check_state text, check_postal_code text, is_verified boolean DEFAULT false, stripe_bank_account_ref text, bank_name text, ach_account_type text,
  stripe_bank_account_livemode boolean, setup_completed_at timestamptz, tax_status text, stripe_account_id text UNIQUE, stripe_account_livemode boolean,
  superseded_stripe_account_id text, connect_status text, connect_details_submitted boolean DEFAULT false, connect_transfers_active boolean DEFAULT false,
  connect_payouts_enabled boolean DEFAULT false, connect_disabled_reason text, connect_bank_name text, connect_bank_last4 text, connect_updated_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  auction_id uuid, lot_id uuid, payment_id uuid, actor_id uuid, metadata jsonb, created_at timestamp NOT NULL DEFAULT now());
`;

const PASSWORD = 'seeded-test-password-2';   // clearly-labeled test password (never a real credential)
let server, base;
const U = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
async function call(user, method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}
const mail = () => require('../src/services/emailService').sendEmail;
const lastCode = () => { const c = mail().mock.calls.filter(([m]) => /verification code/.test(m.subject)).pop(); return c && (c[0].text.match(/code is (\d{6})/) || [])[1]; };
const pref = (name) => one('SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1', [U[name].id]);
const setCheck = (name, payee) => q(`INSERT INTO seller_payout_preferences (seller_user_id, payout_method, check_payee_name, check_address_line1, check_city, check_state, check_postal_code)
  VALUES ($1, 'check', $2, '1 Main St', 'Detroit', 'MI', '48226')
  ON CONFLICT (seller_user_id) DO UPDATE SET payout_method = 'check', check_payee_name = $2, check_address_line1 = '1 Main St'`, [U[name].id, payee]);
const change = (user, extra = {}) => call(user, 'PUT', '/api/payout-profile/me', { payout_method: 'check', payee_name: 'New Payee ' + user, address_line1: '9 New Rd',
  city: 'Austin', state: 'TX', postal_code: '78701', ...extra });

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  await global.__PG.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '220_account_verification_codes.sql'), 'utf8'));
  const hash = await bcrypt.hash(PASSWORD, 4);
  const random = await bcrypt.hash('random-bytes-nobody-holds', 4);
  const rows = [
    // name, role, password hash, auth source, contact email
    ['pam', 'seller', hash, 'native', null],            // has a password
    ['brid', 'seller', random, 'bd_bridge', 'brid.real@test.example'],   // directory sign-in: a password nobody holds
    ['nopw', 'seller', null, 'native', null],           // no password at all
    ['other', 'seller', hash, 'native', null],          // another company
    ['staffer', 'buyer', hash, 'native', null],         // staff of another company (buyer account)
    ['staffsel', 'seller', hash, 'native', null],       // staff of another company who is also a seller
    ['bea', 'buyer', hash, 'native', null],
    ['admin', 'admin', hash, 'native', null],
  ];
  for (const [name, role, h, src, contact] of rows) {
    U[name] = await one(`INSERT INTO users (email, role, password_hash, auth_source, contact_email) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name + (src === 'bd_bridge' ? '@bridge.internal' : '@test.example'), role, h, src, contact]);
  }
  global.__USERS = U;
  for (const name of ['pam', 'brid', 'nopw', 'other', 'staffsel']) await q(`INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1, 'auction_house')`, [U[name].id]);
  const otherSp = await one('SELECT id FROM seller_profiles WHERE user_id = $1', [U.other.id]);
  for (const s of ['staffer', 'staffsel']) await q(`INSERT INTO seller_staff_members (seller_id, user_id, role, status) VALUES ($1, $2, 'finance', 'active')`, [otherSp.id, U[s].id]);
  for (const name of ['pam', 'brid', 'nopw', 'other']) await setCheck(name, 'Original ' + name);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/payout-profile', require('../src/routes/payoutProfile'));
  app.use('/api/payout-preferences', require('../src/routes/payoutPreferences'));
  app.use((err, req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('accounts with a password confirm with it', () => {
  test('the password is required, an emailed code is not a substitute, and the right password works', async () => {
    const r = await change('pam', { verification_code: '123456' });
    expect(r.status).toBe(403); expect(r.body).toMatchObject({ code: 'PASSWORD_REQUIRED', verification: 'password' });
    expect((await change('pam', { current_password: PASSWORD })).status).toBe(200);
  });

  test('repeated wrong passwords lock the change for a while', async () => {
    await setCheck('other', 'Original other');
    for (let i = 0; i < 8; i++) expect((await change('other', { current_password: 'wrong-' + i })).body.code).toBe('PASSWORD_INCORRECT');
    const locked = await change('other', { current_password: PASSWORD });
    expect(locked.status).toBe(429); expect(locked.body.code).toBe('LOCKED');
    expect((await pref('other')).check_payee_name).toBe('Original other');
    require('../src/lib/loginThrottle')._reset();
  });
});

describe('accounts without a usable password use a one-time code emailed to the account (no unverified bypass)', () => {
  test('a directory sign-in account is asked for a code; no password (even the stored one) gets around it', async () => {
    const r = await change('brid');
    expect(r.status).toBe(403); expect(r.body).toMatchObject({ code: 'VERIFICATION_CODE_REQUIRED', verification: 'email_code' });
    expect((await change('brid', { current_password: 'random-bytes-nobody-holds' })).body.code).toBe('VERIFICATION_CODE_REQUIRED');
    expect((await pref('brid')).check_payee_name).toBe('Original brid');
    expect(await q('SELECT 1 FROM audit_log WHERE event_type = $1 AND entity_id = $2', ['seller.payout_details_changed', U.brid.id])).toHaveLength(0);
  });

  test('the code goes to the account\'s own address, is stored only as a hash, and works once', async () => {
    mail().mockClear();
    const s = await call('brid', 'POST', '/api/payout-profile/me/verification-code');
    expect(s.status).toBe(200); expect(s.body.data).toMatchObject({ sent: true, sent_to: 'b***@test.example', expires_in_minutes: 10 });
    expect(mail()).toHaveBeenCalledWith(expect.objectContaining({ to: 'brid.real@test.example' }));
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    const row = await one(`SELECT * FROM account_verification_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [U.brid.id]);
    expect(row).toMatchObject({ purpose: 'payout_destination_change', status: 'sent', sent_to: 'b***@test.example' });
    expect(JSON.stringify(row)).not.toContain(code);
    const wrong = await change('brid', { verification_code: code === '000000' ? '000001' : '000000' });
    expect(wrong.body).toMatchObject({ code: 'VERIFICATION_CODE_INCORRECT', verification: 'email_code' });
    const ok = await change('brid', { verification_code: code });
    expect(ok.status).toBe(200);
    expect((await pref('brid')).check_payee_name).toBe('New Payee brid');
    const audit = await one(`SELECT metadata FROM audit_log WHERE event_type = 'seller.payout_details_changed' AND entity_id = $1`, [U.brid.id]);
    expect(audit.metadata).toMatchObject({ destination_changed: true });
    expect(mail()).toHaveBeenCalledWith(expect.objectContaining({ to: 'brid@bridge.internal', subject: expect.stringMatching(/payout details were changed/) }));
    // single use: the same code cannot authorize another change
    const again = await change('brid', { payee_name: 'Third Payee', verification_code: code });
    expect(again.status).toBe(403); expect(again.body.code).toBe('VERIFICATION_CODE_REQUIRED');
  });

  test('an account with no password hash at all also needs the code', async () => {
    const r = await change('nopw');
    expect(r.body.code).toBe('VERIFICATION_CODE_REQUIRED');
    await call('nopw', 'POST', '/api/payout-profile/me/verification-code');
    expect((await change('nopw', { verification_code: lastCode() })).status).toBe(200);
  });

  test('a code is bound to its account: another seller cannot use it', async () => {
    await call('brid', 'POST', '/api/payout-profile/me/verification-code');
    const code = lastCode();
    await setCheck('nopw', 'Original nopw');
    expect((await change('nopw', { verification_code: code })).body.code).toMatch(/VERIFICATION_CODE_(REQUIRED|INCORRECT)/);
    expect((await pref('nopw')).check_payee_name).toBe('Original nopw');
  });

  test('an expired code is refused', async () => {
    await q(`UPDATE account_verification_codes SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND status = 'sent'`, [U.brid.id]);
    const code = lastCode();
    expect((await change('brid', { payee_name: 'Late Payee', verification_code: code })).body.code).toBe('VERIFICATION_CODE_EXPIRED');
  });

  test('five wrong attempts use up a code; the right code then fails too', async () => {
    await q(`DELETE FROM account_verification_codes WHERE user_id = $1`, [U.nopw.id]);
    await call('nopw', 'POST', '/api/payout-profile/me/verification-code');
    const code = lastCode(); const bad = code === '111111' ? '222222' : '111111';
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await change('nopw', { verification_code: bad })).body.code);
    expect(results.slice(0, 4)).toEqual(Array(4).fill('VERIFICATION_CODE_INCORRECT'));
    expect(results[4]).toBe('TOO_MANY_ATTEMPTS');
    expect((await change('nopw', { verification_code: code })).body.code).toBe('VERIFICATION_CODE_REQUIRED');
    expect((await pref('nopw')).check_payee_name).toBe('Original nopw');
  });

  test('sending is rate-limited (3 codes per 30 minutes)', async () => {
    await q(`DELETE FROM account_verification_codes WHERE user_id = $1`, [U.brid.id]);
    for (let i = 0; i < 3; i++) expect((await call('brid', 'POST', '/api/payout-profile/me/verification-code')).status).toBe(200);
    const r = await call('brid', 'POST', '/api/payout-profile/me/verification-code');
    expect(r.status).toBe(429); expect(r.body.code).toBe('RATE_LIMITED');
    // a new code supersedes the old one
    expect((await q(`SELECT status FROM account_verification_codes WHERE user_id = $1 ORDER BY created_at`, [U.brid.id])).map((x) => x.status))
      .toEqual(['superseded', 'superseded', 'sent']);
  });

  test('before migration 220 is applied the change is refused clearly, never let through', async () => {
    await q('ALTER TABLE account_verification_codes RENAME TO account_verification_codes_off');
    try {
      expect((await call('nopw', 'POST', '/api/payout-profile/me/verification-code')).body.code).toBe('NOT_AVAILABLE');
      const r = await change('nopw', { verification_code: '123456' });
      expect(r.status).toBe(503); expect(r.body.code).toBe('NOT_AVAILABLE');
      expect((await pref('nopw')).check_payee_name).toBe('Original nopw');
    } finally { await q('ALTER TABLE account_verification_codes_off RENAME TO account_verification_codes'); }
  });

  test('the legacy preferences route and Direct Deposit onboarding ask for the code too', async () => {
    await q(`DELETE FROM account_verification_codes WHERE user_id = $1`, [U.nopw.id]);
    const p = await call('nopw', 'PUT', '/api/payout-preferences/me', { payout_method: 'check', check_payee_name: 'Elsewhere', check_address_line1: '5 Far Rd' });
    expect(p.status).toBe(403); expect(p.body.verification).toBe('email_code');
    const o = await call('nopw', 'POST', '/api/payout-profile/me/connect/onboard', {});
    expect(o.status).toBe(403); expect(o.body.verification).toBe('email_code');
    await call('nopw', 'POST', '/api/payout-profile/me/verification-code');
    expect((await call('nopw', 'POST', '/api/payout-profile/me/connect/onboard', { verification_code: lastCode() })).status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('seller isolation on payout details', () => {
  test('a seller cannot read another seller\'s payout details by id (admin only)', async () => {
    for (const url of ['/api/payout-profile/seller/' + U.other.id, '/api/payout-preferences/seller/' + U.other.id]) {
      expect((await call('pam', 'GET', url)).status).toBe(403);
      expect((await call('staffsel', 'GET', url)).status).toBe(403);
    }
    expect((await call('admin', 'GET', '/api/payout-profile/seller/' + U.other.id)).status).toBe(200);
  });

  test('a seller\'s own routes never reach another seller, whatever ids the request carries', async () => {
    const before = await pref('other');
    const r = await call('pam', 'PUT', '/api/payout-preferences/me', { payout_method: 'check', seller_user_id: U.other.id, check_payee_name: 'Hijack',
      check_address_line1: '1 Evil St', current_password: PASSWORD });
    expect(r.status).toBe(200);
    expect((await pref('other')).check_payee_name).toBe(before.check_payee_name);
    expect((await pref('pam')).check_payee_name).toBe('Hijack');
    const g = await call('pam', 'GET', '/api/payout-profile/me?seller_user_id=' + U.other.id);
    expect(g.body.data.profile.payee_name).toBe('Hijack');
  });

  test('staff of another company cannot touch that company\'s payout details', async () => {
    const before = await pref('other');
    // a staff member whose account is not a seller account has no payout routes at all
    expect((await call('staffer', 'PUT', '/api/payout-profile/me', { payout_method: 'check', payee_name: 'X', address_line1: 'Y', city: 'Z', state: 'TX', postal_code: '1' })).status).toBe(403);
    expect((await call('staffer', 'POST', '/api/payout-profile/me/connect/onboard', {})).status).toBe(403);
    expect((await call('staffer', 'POST', '/api/payout-profile/me/verification-code')).status).toBe(403);
    // a staff member who is also a seller only ever changes their OWN record
    expect((await call('staffsel', 'PUT', '/api/payout-profile/me', { payout_method: 'check', payee_name: 'Staff Self', address_line1: '3 Own Rd',
      city: 'Austin', state: 'TX', postal_code: '78701', seller_user_id: U.other.id })).status).toBe(200);
    expect(await pref('other')).toMatchObject({ check_payee_name: before.check_payee_name, check_address_line1: before.check_address_line1 });
    expect((await pref('staffsel')).check_payee_name).toBe('Staff Self');
  });

  test('Direct Deposit onboarding creates or uses only the signed-in seller\'s own account', async () => {
    const r = await call('other', 'POST', '/api/payout-profile/me/connect/onboard', { current_password: PASSWORD, seller_user_id: U.pam.id, stripe_account_id: 'acct_victim' });
    expect(r.status).toBe(200);
    expect((await pref('other')).stripe_account_id).toBe('acct_for_' + U.other.id.slice(0, 8));
    expect((await pref('pam')).stripe_account_id).toBeNull();
  });

  test('bank confirmation refuses a setup that belongs to another seller', async () => {
    mockSI.set('seti_other', { id: 'seti_other', customer: 'cus_' + U.other.id, status: 'succeeded',
      payment_method: { id: 'pm_x', type: 'us_bank_account', us_bank_account: { bank_name: 'Bank', last4: '6789', account_type: 'checking' } } });
    const before = await pref('pam');
    const r = await call('pam', 'POST', '/api/payout-profile/me/ach/confirm', { setup_intent_id: 'seti_other', current_password: PASSWORD });
    expect(r.status).toBe(422); expect(r.body.message).toMatch(/does not belong/);
    expect(await pref('pam')).toMatchObject({ payout_method: before.payout_method, stripe_bank_account_ref: null });
  });

  test('buyers and administrators cannot use the seller payout write routes', async () => {
    expect((await call('bea', 'PUT', '/api/payout-profile/me', { payout_method: 'check' })).status).toBe(403);
    expect((await call('admin', 'PUT', '/api/payout-profile/me', { payout_method: 'check' })).status).toBe(403);
    expect((await call('bea', 'POST', '/api/payout-profile/me/ach/confirm', { setup_intent_id: 'seti_other' })).status).toBe(403);
    expect((await call(null, 'POST', '/api/payout-profile/me/verification-code')).status).toBe(401);
  });
});
