'use strict';

/**
 * Admin Member Detail (/admin/member.html, /api/admin/users/:id/...): adversarial tests.
 *
 * Real Postgres (PGlite) with the real verification migration (071) and audit_log migration (013), the real admin
 * users router, role middleware, member service, verification gate and storefront checkout eligibility check. Only the
 * sign-in (a header names the test user), email, agreement, company and payout-status lookups are stand-ins.
 *
 * Proves: only admins reach any of it; a buyer becomes a Professional Seller on the SAME account with buyer history
 * intact and WITHOUT verification or payout approval (checkout stays closed); Admin access cannot be granted here;
 * edits touch only the addressed account; self-lockout and last-Super-Admin protection; sessions end on suspension and
 * on request; password reset only emails the member's own address and never exposes a password or token; every
 * sensitive change is audited with actor, field, previous and new value and reason.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-admin-member'; // test value, never a real secret

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
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/passwordResetService', () => ({ requestReset: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/agreementService', () => ({
  autoSendAgreement: jest.fn(async () => ({ status: 'sent', agreement_id: 'a1' })),
  dashboardAccess: jest.fn(async () => ({ access: false, reason: 'agreement_required', agreement_id: null })),
}));
jest.mock('../src/services/organizationsService', () => ({
  getPrimaryOrgForUser: jest.fn(async () => null),
  onboardOrganization: jest.fn(async () => null),
}));
jest.mock('../src/services/stripeConnectService', () => ({
  getPref: jest.fn(async () => ({ stripe_account_id: 'acct_secret_should_not_leak', connect_status: 'onboarding', connect_details_submitted: false,
    connect_transfers_active: false, connect_payouts_enabled: false, connect_bank_last4: '6789' })),
  isConnectReady: (m) => !!(m && m.connect_transfers_active && m.connect_payouts_enabled),
}));
// The test names the signed-in user with a header; the real role middleware then decides.
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: u.id, role: u.role };
  return next();
});

const ROOT = path.join(__dirname, '..');
const mig = (f) => fs.readFileSync(path.join(ROOT, 'db', 'migrations', f), 'utf8');
const BASE = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, password_hash text, full_name text, phone text,
  role text DEFAULT 'buyer', is_active boolean DEFAULT true, staff_role text, staff_active boolean DEFAULT true, auth_source text NOT NULL DEFAULT 'native',
  is_demo boolean NOT NULL DEFAULT false, email_verified boolean NOT NULL DEFAULT false, phone_verified_at timestamptz, phone_verified_e164 text,
  tax_address_line1 text, tax_address_line2 text, tax_city text, tax_state text, tax_postal_code text, tax_country text,
  session_version integer NOT NULL DEFAULT 0, last_login_at timestamptz, stripe_customer_id text, created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX uq_users_email_ci ON users (lower(btrim(email)));
CREATE TABLE staff_permission_overrides (user_id uuid, permission text, effect text);
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text,
  display_name text, storefront_slug text, storefront_published boolean NOT NULL DEFAULT false, is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now());
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid REFERENCES seller_profiles(id), title text, state text, created_at timestamptz DEFAULT now());
CREATE TABLE bids (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bidder_user_id uuid REFERENCES users(id), amount_cents int);
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_user_id uuid REFERENCES users(id), amount_cents int, status text);
CREATE TABLE marketplace_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text, seller_id uuid, buyer_user_id uuid REFERENCES users(id),
  payment_status text, fulfillment_status text, total_charge_cents int, created_at timestamptz DEFAULT now());
CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), linked_seller_profile_id uuid, linked_seller_at timestamptz);
`;

let server, base;
const U = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
async function call(user, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch (_) { /* empty */ }
  return { status: r.status, body: json, raw };
}
const audits = (entityId, type) => q(`SELECT * FROM audit_log WHERE entity_id = $1 ${type ? 'AND event_type = $2' : ''} ORDER BY created_at`, type ? [entityId, type] : [entityId]);
const CONVERT = { seller_type: 'estate_sale_company', company_name: 'Lone Star Estates', reason: 'Owner-approved onboarding test', confirm: true };

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  await global.__PG.exec(mig('013_create_audit_log.sql'));
  await global.__PG.exec(mig('071_verification_documents.sql'));
  const mk = async (name, extra = {}) => {
    const row = { email: name + '@test.example', full_name: name.toUpperCase(), role: 'buyer', password_hash: '$2b$10$hash-' + name, ...extra };
    const cols = Object.keys(row);
    U[name] = await one(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, cols.map((c) => row[c]));
  };
  await mk('owner', { role: 'admin', staff_role: 'super_admin' });
  await mk('admin2', { role: 'admin' });
  await mk('marketer', { role: 'buyer', staff_role: 'marketing' });     // staff, but not an admin
  await mk('buyer', { phone: '713-555-0100', phone_verified_at: new Date().toISOString(), phone_verified_e164: '+17135550100', email_verified: true });
  await mk('other', {});
  await mk('seller', { role: 'seller' });
  await mk('indiv', { role: 'seller' });
  await mk('susp', { is_active: false });
  await mk('bridge', { auth_source: 'bd_bridge' });
  global.__USERS = U;
  // Buyer history that must survive the conversion untouched.
  await q(`INSERT INTO bids (bidder_user_id, amount_cents) VALUES ($1, 500), ($1, 700)`, [U.buyer.id]);
  await q(`INSERT INTO payments (buyer_user_id, amount_cents, status) VALUES ($1, 1200, 'succeeded')`, [U.buyer.id]);
  await q(`INSERT INTO marketplace_orders (order_number, buyer_user_id, payment_status, fulfillment_status, total_charge_cents) VALUES ('MO-1', $1, 'paid', 'completed', 4000)`, [U.buyer.id]);
  // An Individual Seller with a submitted auction; a Professional Seller.
  const ind = await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, 'private', 'Indy') RETURNING id`, [U.indiv.id]);
  await q(`INSERT INTO auctions (seller_id, title, state) VALUES ($1, 'Garage sale', 'submitted')`, [ind.id]);
  await q(`INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, 'auction_house', 'Big Gavel')`, [U.seller.id]);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/users', require('../src/routes/adminUsers'));
  app.use((e, req, res, _next) => res.status(500).json({ error: e.message }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

describe('privilege escalation: only admins reach any member endpoint', () => {
  const endpoints = (id) => [
    ['GET', `/api/admin/users/${id}/account`], ['PATCH', `/api/admin/users/${id}/personal`, { full_name: 'x' }],
    ['POST', `/api/admin/users/${id}/convert-professional`, CONVERT], ['PATCH', `/api/admin/users/${id}/seller-profile`, { display_name: 'x' }],
    ['POST', `/api/admin/users/${id}/status`, { status: 'suspended', reason: 'nope nope' }], ['POST', `/api/admin/users/${id}/end-sessions`, { reason: 'nope nope' }],
    ['POST', `/api/admin/users/${id}/password-reset`, { reason: 'nope nope' }],
  ];
  test.each(['buyer', 'seller', 'marketer'])('%s gets 403 everywhere and changes nothing', async (who) => {
    for (const [m, url, body] of endpoints(U.other.id)) expect([m, url, (await call(who, m, url, body)).status]).toEqual([m, url, 403]);
    // A member cannot convert themselves or edit their own record through these routes either.
    expect((await call(who, 'POST', `/api/admin/users/${U[who].id}/convert-professional`, CONVERT)).status).toBe(403);
    const o = await one('SELECT full_name, role, is_active FROM users WHERE id = $1', [U.other.id]);
    expect(o).toEqual({ full_name: 'OTHER', role: 'buyer', is_active: true });
  });
  test('signed-out callers get 401', async () => {
    for (const [m, url, body] of endpoints(U.other.id)) expect((await call('nobody', m, url, body)).status).toBe(401);
  });
  test('an unknown or malformed member id is a 404, not an error', async () => {
    expect((await call('owner', 'GET', '/api/admin/users/00000000-0000-4000-a000-000000000000/account')).status).toBe(404);
    expect((await call('owner', 'GET', '/api/admin/users/not-a-uuid/account')).status).toBe(404);
    expect((await call('owner', 'PATCH', '/api/admin/users/1%20OR%201=1/personal', { full_name: 'x' })).status).toBe(404);
  });
});

describe('member record (read)', () => {
  test('never exposes a password hash or payout account / bank identifiers', async () => {
    const r = await call('owner', 'GET', `/api/admin/users/${U.seller.id}/account`);
    expect(r.status).toBe(200);
    expect(r.raw).not.toMatch(/password_hash|\$2b\$|acct_secret_should_not_leak|6789/);
    expect(r.body.data.payouts).toEqual(expect.objectContaining({ connect_status: 'onboarding', ready: false }));
    expect(r.body.data.access).toEqual(expect.objectContaining({ role: 'seller', can_buy: true, can_sell: true, professional: true }));
  });
  test('reading does not send the Seller Agreement (read-only status only)', async () => {
    const ag = require('../src/services/agreementService');
    ag.autoSendAgreement.mockClear();
    await call('owner', 'GET', `/api/admin/users/${U.indiv.id}/account`);
    expect(ag.autoSendAgreement).not.toHaveBeenCalled();
  });
});

describe('seller conversion: buyer → Professional Seller on the same account', () => {
  test('refuses without a reason, without confirmation, or with a non-Professional type', async () => {
    const url = `/api/admin/users/${U.buyer.id}/convert-professional`;
    expect((await call('owner', 'POST', url, { ...CONVERT, reason: '' })).body.code).toBe('REASON_REQUIRED');
    expect((await call('owner', 'POST', url, { ...CONVERT, confirm: undefined })).body.code).toBe('CONFIRM_REQUIRED');
    expect((await call('owner', 'POST', url, { ...CONVERT, confirm: 'true' })).body.code).toBe('CONFIRM_REQUIRED');
    for (const t of ['private', 'business', 'other', 'admin', '']) expect((await call('owner', 'POST', url, { ...CONVERT, seller_type: t })).body.code).toBe('INVALID_PROFESSIONAL_TYPE');
    expect((await call('owner', 'POST', url, { ...CONVERT, company_name: '   ' })).body.code).toBe('COMPANY_REQUIRED');
    expect(await one('SELECT count(*)::int AS n FROM seller_profiles WHERE user_id = $1', [U.buyer.id])).toEqual({ n: 0 });
  });

  test('converts, keeps buyer identity and history, grants no admin, and approves nothing', async () => {
    const before = await one('SELECT * FROM users WHERE id = $1', [U.buyer.id]);
    const r = await call('owner', 'POST', `/api/admin/users/${U.buyer.id}/convert-professional`,
      { ...CONVERT, role: 'admin', staff_role: 'super_admin', verification_approved: true, user_id: U.other.id });   // smuggled fields are ignored
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual(expect.objectContaining({ role: 'seller', seller_type: 'estate_sale_company', created_profile: true, verification_required_before_publication: true }));

    const after = await one('SELECT * FROM users WHERE id = $1', [U.buyer.id]);
    expect(after.role).toBe('seller');
    expect(after.staff_role).toBeNull();
    for (const f of ['id', 'email', 'password_hash', 'full_name', 'phone', 'phone_verified_e164', 'email_verified', 'is_active', 'created_at']) expect([f, after[f]]).toEqual([f, before[f]]);
    expect(await one('SELECT count(*)::int AS n FROM users WHERE lower(email) = $1', ['buyer@test.example'])).toEqual({ n: 1 });   // no second account
    expect(await one('SELECT count(*)::int AS n FROM bids WHERE bidder_user_id = $1', [U.buyer.id])).toEqual({ n: 2 });
    expect(await one('SELECT count(*)::int AS n FROM payments WHERE buyer_user_id = $1', [U.buyer.id])).toEqual({ n: 1 });
    expect(await one('SELECT count(*)::int AS n FROM marketplace_orders WHERE buyer_user_id = $1', [U.buyer.id])).toEqual({ n: 1 });
    // The other account named in the body is untouched.
    expect(await one('SELECT role FROM users WHERE id = $1', [U.other.id])).toEqual({ role: 'buyer' });
    expect(await one('SELECT count(*)::int AS n FROM seller_profiles WHERE user_id = $1', [U.other.id])).toEqual({ n: 0 });

    const sp = await one('SELECT * FROM seller_profiles WHERE user_id = $1', [U.buyer.id]);
    expect(sp).toEqual(expect.objectContaining({ seller_type: 'estate_sale_company', display_name: 'Lone Star Estates', verification_required_before_publication: true }));
    expect(await one(`SELECT count(*)::int AS n FROM verification_requests WHERE seller_profile_id = $1 AND status = 'approved'`, [sp.id])).toEqual({ n: 0 });
    // The first sale and storefront checkout stay closed until an admin approves verification.
    expect(await require('../src/services/verificationService').publicationGate(sp.id)).toEqual({ blocked: true, reason: 'verification_required' });
    await expect(require('../src/services/sellerSaleEligibility').assertSellerCanSell(sp.id)).rejects.toMatchObject({ code: 'SELLER_NOT_ACCEPTING_ORDERS' });

    const [a] = await audits(U.buyer.id, 'user.converted_to_professional');
    expect(a.actor_id).toBe(U.owner.id);
    expect(a.metadata).toEqual(expect.objectContaining({ reason: 'Owner-approved onboarding test', verification_approved: false, payout_setup: 'unchanged', seller_profile_id: sp.id }));
    expect(a.metadata.changes).toEqual(expect.arrayContaining([{ field: 'role', before: 'buyer', after: 'seller' }, { field: 'seller_type', before: null, after: 'estate_sale_company' }]));
  });

  test('a second conversion is refused and never creates a duplicate profile', async () => {
    const r = await call('owner', 'POST', `/api/admin/users/${U.buyer.id}/convert-professional`, CONVERT);
    expect([r.status, r.body.code]).toEqual([409, 'ALREADY_PROFESSIONAL']);
    expect(await one('SELECT count(*)::int AS n FROM seller_profiles WHERE user_id = $1', [U.buyer.id])).toEqual({ n: 1 });
  });

  test('an Individual Seller with a submitted auction needs an explicit acknowledgement; the profile is reused', async () => {
    const url = `/api/admin/users/${U.indiv.id}/convert-professional`;
    const first = await call('owner', 'POST', url, { ...CONVERT, company_name: 'Indy Pro' });
    expect([first.status, first.body.code, first.body.submitted_auctions]).toEqual([409, 'SUBMITTED_AUCTIONS', 1]);
    expect(await one('SELECT seller_type FROM seller_profiles WHERE user_id = $1', [U.indiv.id])).toEqual({ seller_type: 'private' });
    const ok = await call('owner', 'POST', url, { ...CONVERT, company_name: 'Indy Pro', acknowledge_submitted_auctions: true });
    expect([ok.status, ok.body.data.created_profile]).toEqual([200, false]);
    const sp = await one('SELECT seller_type, display_name, verification_required_before_publication FROM seller_profiles WHERE user_id = $1', [U.indiv.id]);
    expect(sp).toEqual({ seller_type: 'estate_sale_company', display_name: 'Indy', verification_required_before_publication: true });   // existing name kept
  });

  test('a suspended account cannot be converted', async () => {
    const r = await call('owner', 'POST', `/api/admin/users/${U.susp.id}/convert-professional`, CONVERT);
    expect([r.status, r.body.code]).toEqual([409, 'ACCOUNT_SUSPENDED']);
  });
});

describe('seller profile edits', () => {
  test('Professional type change needs a reason; downgrade to Individual and Individual → Professional here are refused', async () => {
    const url = `/api/admin/users/${U.seller.id}/seller-profile`;
    expect((await call('owner', 'PATCH', url, { seller_type: 'professional_liquidator' })).body.code).toBe('REASON_REQUIRED');
    expect((await call('owner', 'PATCH', url, { seller_type: 'private', reason: 'try downgrade' })).body.code).toBe('DOWNGRADE_NOT_SUPPORTED');
    const ok = await call('owner', 'PATCH', url, { seller_type: 'professional_liquidator', display_name: 'Big Gavel LLC', reason: 'Business restructured' });
    expect(ok.status).toBe(200);
    const sp = await one('SELECT id, seller_type, display_name, verification_required_before_publication FROM seller_profiles WHERE user_id = $1', [U.seller.id]);
    expect(sp).toEqual(expect.objectContaining({ seller_type: 'professional_liquidator', display_name: 'Big Gavel LLC', verification_required_before_publication: true }));
    const [a] = await audits(sp.id, 'seller_profile.updated');
    expect(a.metadata.changes).toEqual(expect.arrayContaining([{ field: 'seller_type', before: 'auction_house', after: 'professional_liquidator' }]));
    expect(a.metadata.user_id).toBe(U.seller.id);
    const fresh = await one(`INSERT INTO users (email, role) VALUES ('ind2@test.example', 'seller') RETURNING id`);
    await q(`INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1, 'private')`, [fresh.id]);
    expect((await call('owner', 'PATCH', `/api/admin/users/${fresh.id}/seller-profile`, { seller_type: 'auction_house', reason: 'shortcut attempt' })).body.code).toBe('USE_CONVERSION');
  });
});

describe('personal information', () => {
  test('saves name/phone/address with a per-field audit trail; a changed phone is no longer verified', async () => {
    const r = await call('owner', 'PATCH', `/api/admin/users/${U.other.id}/personal`,
      { full_name: 'Olive Other', phone: '(281) 555-0199', tax_address_line1: '1 Main St', tax_city: 'Houston', tax_state: 'tx', tax_postal_code: '77002', tax_country: 'us', reason: 'Member called in',
        role: 'admin', is_active: false, password_hash: 'x', id: U.owner.id });   // not editable here
    expect(r.status).toBe(200);
    const u = await one('SELECT * FROM users WHERE id = $1', [U.other.id]);
    expect(u).toEqual(expect.objectContaining({ full_name: 'Olive Other', phone: '(281) 555-0199', tax_state: 'TX', tax_country: 'US', role: 'buyer', is_active: true }));
    expect(u.password_hash).toBe('$2b$10$hash-other');
    expect((await one('SELECT full_name FROM users WHERE id = $1', [U.owner.id])).full_name).toBe('OWNER');
    const [a] = await audits(U.other.id, 'user.profile_updated');
    expect(a.actor_id).toBe(U.owner.id);
    expect(a.metadata.reason).toBe('Member called in');
    expect(a.metadata.changes).toEqual(expect.arrayContaining([{ field: 'full_name', before: 'OTHER', after: 'Olive Other' }, { field: 'tax_city', before: null, after: 'Houston' }]));

    await call('owner', 'PATCH', `/api/admin/users/${U.buyer.id}/personal`, { phone: '713-555-0111' });
    expect(await one('SELECT phone_verified_at, phone_verified_e164 FROM users WHERE id = $1', [U.buyer.id])).toEqual({ phone_verified_at: null, phone_verified_e164: null });
  });

  test('address and email changes require a reason; bad values are rejected', async () => {
    const url = `/api/admin/users/${U.other.id}/personal`;
    expect((await call('owner', 'PATCH', url, { tax_city: 'Dallas' })).body.code).toBe('REASON_REQUIRED');
    expect((await call('owner', 'PATCH', url, { email: 'new-other@test.example' })).body.code).toBe('REASON_REQUIRED');
    expect((await call('owner', 'PATCH', url, { email: 'not-an-email', reason: 'typo fix' })).body.code).toBe('INVALID_EMAIL');
    expect((await call('owner', 'PATCH', url, { tax_state: 'Texas', reason: 'typo fix' })).body.code).toBe('INVALID_ADDRESS');
    expect((await call('owner', 'PATCH', url, { phone: '123', reason: 'typo fix' })).body.code).toBe('INVALID_PHONE');
  });

  test('email: unique regardless of case, unverified after a change, and staff / linked identities are protected', async () => {
    const url = `/api/admin/users/${U.buyer.id}/personal`;
    expect((await call('owner', 'PATCH', url, { email: '  OTHER@Test.Example ', reason: 'Member request' })).body.code).toBe('EMAIL_TAKEN');
    const ok = await call('owner', 'PATCH', url, { email: 'Buyer.New@Test.Example', reason: 'Member request' });
    expect(ok.status).toBe(200);
    expect(await one('SELECT email, email_verified FROM users WHERE id = $1', [U.buyer.id])).toEqual({ email: 'buyer.new@test.example', email_verified: false });
    const [a] = await audits(U.buyer.id, 'user.profile_updated').then((rows) => rows.filter((x) => x.metadata.changes.some((c) => c.field === 'email')));
    expect(a.metadata.changes).toEqual([{ field: 'email', before: 'buyer@test.example', after: 'buyer.new@test.example' }]);
    expect((await call('owner', 'PATCH', `/api/admin/users/${U.admin2.id}/personal`, { email: 'mine@test.example', reason: 'takeover attempt' })).body.code).toBe('STAFF_IDENTITY');
    expect((await call('owner', 'PATCH', `/api/admin/users/${U.marketer.id}/personal`, { email: 'mine@test.example', reason: 'takeover attempt' })).body.code).toBe('STAFF_IDENTITY');
    expect((await call('owner', 'PATCH', `/api/admin/users/${U.bridge.id}/personal`, { email: 'mine@test.example', reason: 'linked change' })).body.code).toBe('LINKED_IDENTITY');
  });
});

describe('account status & session security', () => {
  test('an admin cannot suspend themselves or sign themselves out here', async () => {
    expect((await call('owner', 'POST', `/api/admin/users/${U.owner.id}/status`, { status: 'suspended', reason: 'oops oops' })).body.code).toBe('SELF_LOCKOUT');
    expect((await call('owner', 'POST', `/api/admin/users/${U.owner.id}/end-sessions`, { reason: 'oops oops' })).body.code).toBe('SELF_LOCKOUT');
    expect(await one('SELECT is_active FROM users WHERE id = $1', [U.owner.id])).toEqual({ is_active: true });
  });
  test('the last active Super Admin cannot be suspended', async () => {
    const svc = require('../src/services/adminMemberService');
    // Only owner + admin2 are active Super Admins; with admin2 suspended, owner is the last one.
    await q('UPDATE users SET is_active = false WHERE id = $1', [U.admin2.id]);
    await expect(svc.setStatus(U.owner.id, U.admin2.id, { status: 'suspended', reason: 'last admin test' })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await q('UPDATE users SET is_active = true WHERE id = $1', [U.admin2.id]);
    // With another active Super Admin, one admin may suspend the other.
    const r = await call('owner', 'POST', `/api/admin/users/${U.admin2.id}/status`, { status: 'suspended', reason: 'leaving the company' });
    expect(r.status).toBe(200);
    await call('owner', 'POST', `/api/admin/users/${U.admin2.id}/status`, { status: 'active' });
  });
  test('suspension needs a reason and ends every session; reactivation does not need one', async () => {
    const url = `/api/admin/users/${U.other.id}/status`;
    expect((await call('owner', 'POST', url, { status: 'suspended' })).body.code).toBe('REASON_REQUIRED');
    expect((await call('owner', 'POST', url, { status: 'deleted', reason: 'bad status value' })).status).toBe(400);
    const v0 = (await one('SELECT session_version FROM users WHERE id = $1', [U.other.id])).session_version;
    expect((await call('owner', 'POST', url, { status: 'suspended', reason: 'Chargeback review' })).status).toBe(200);
    expect(await one('SELECT is_active, session_version FROM users WHERE id = $1', [U.other.id])).toEqual({ is_active: false, session_version: v0 + 1 });
    const [a] = await audits(U.other.id, 'user.suspended');
    expect(a.metadata).toEqual(expect.objectContaining({ reason: 'Chargeback review', changes: [{ field: 'is_active', before: true, after: false }] }));
    expect((await call('owner', 'POST', url, { status: 'active' })).status).toBe(200);
  });
  test('sign out everywhere ends the member\'s sessions and is audited', async () => {
    const v0 = (await one('SELECT session_version FROM users WHERE id = $1', [U.other.id])).session_version;
    expect((await call('owner', 'POST', `/api/admin/users/${U.other.id}/end-sessions`, {})).body.code).toBe('REASON_REQUIRED');
    expect((await call('owner', 'POST', `/api/admin/users/${U.other.id}/end-sessions`, { reason: 'Lost phone' })).status).toBe(200);
    expect((await one('SELECT session_version FROM users WHERE id = $1', [U.other.id])).session_version).toBe(v0 + 1);
    expect((await audits(U.other.id, 'user.sessions_ended')).length).toBe(1);
  });
  test('password reset emails only the member\'s own address and never returns a password or token', async () => {
    const pr = require('../src/services/passwordResetService');
    pr.requestReset.mockClear();
    expect((await call('owner', 'POST', `/api/admin/users/${U.other.id}/password-reset`, {})).body.code).toBe('REASON_REQUIRED');
    const r = await call('owner', 'POST', `/api/admin/users/${U.other.id}/password-reset`, { reason: 'Member locked out', email: 'attacker@evil.example', password: 'x' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ sent: true });
    expect(pr.requestReset).toHaveBeenCalledTimes(1);
    expect(pr.requestReset.mock.calls[0][0]).toBe('other@test.example');
    expect(await one('SELECT password_hash FROM users WHERE id = $1', [U.other.id])).toEqual({ password_hash: '$2b$10$hash-other' });
    expect((await call('owner', 'POST', `/api/admin/users/${U.susp.id}/password-reset`, { reason: 'Member locked out' })).body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('audit history on the member record', () => {
  test('lists the account and seller-profile events with actor and reason', async () => {
    const r = await call('owner', 'GET', `/api/admin/users/${U.buyer.id}/account`);
    const types = r.body.data.history.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['user.converted_to_professional', 'user.profile_updated', 'seller_verification_required_auto']));
    expect(r.body.data.history.find((e) => e.event_type === 'user.converted_to_professional').actor_email).toBe('owner@test.example');
  });
});
