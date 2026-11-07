'use strict';

/**
 * Buyer safeguards (owner direction 2026-11-06), against a real Postgres (PGlite) and the real routers over HTTP:
 *  1. account registration requires explicit acceptance of the CURRENT terms and records it (ip, user agent) together
 *     with the account; a version changed meanwhile is refused; history is never rewritten;
 *  2. re-acceptance: the auction registration and bid gates require the CURRENT version; accepting records exactly
 *     the version shown;
 *  3. verified-email requirement: OFF by default; ON blocks unverified new accounts; established buyers keep a grace
 *     period; administrators are exempt; one-click resend is throttled.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-buyer-safeguards';
jest.mock('../src/db', () => require('./sasha-phone/pgHarness').dbAdapter(() => global.__PG));
jest.mock('../src/db/index', () => require('./sasha-phone/pgHarness').dbAdapter(() => global.__PG));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/conversionService', () => ({ emit: () => {}, ctxFromReq: () => ({}) }));
jest.mock('../src/services/cardService', () => ({ hasCardOnFile: jest.fn(async () => true) }));
jest.mock('../src/services/accountPhoneService', () => ({
  phoneGate: jest.fn(async () => ({ required: false, ok: true })), isVerified: () => false }));
// Session-carrying routes: the signed-in account comes from test headers (the real JWT middleware is covered elsewhere).
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  if (!req.headers['x-user']) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: req.headers['x-user'], role: req.headers['x-role'] || 'buyer' }; next();
});

const path = require('path');
const http = require('http');
const express = require('express');
const { Worker } = require('worker_threads');

const SCHEMA = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, contact_email text, password_hash text, full_name text,
  role text DEFAULT 'buyer', is_active boolean DEFAULT true, email_verified boolean NOT NULL DEFAULT false, email_verified_at timestamptz,
  phone text, phone_verified_at timestamptz, phone_verified_e164 text,
  created_at timestamptz DEFAULT now());
CREATE TABLE email_verification_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, token_hash text, expires_at timestamptz,
  used_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE platform_config (key text PRIMARY KEY, value jsonb, category text, description text, updated_at timestamptz DEFAULT now());
CREATE TABLE terms_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL DEFAULT 'buyer_terms', version_int int NOT NULL,
  title text NOT NULL, body_markdown text NOT NULL, effective_at timestamptz NOT NULL DEFAULT now(), is_current boolean NOT NULL DEFAULT false,
  includes_sales_near_you boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (kind, version_int));
CREATE UNIQUE INDEX idx_terms_versions_current ON terms_versions(kind) WHERE is_current;
CREATE TABLE terms_acceptances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version_id uuid NOT NULL REFERENCES terms_versions(id), accepted_at timestamptz NOT NULL DEFAULT now(), ip_address text, user_agent text,
  UNIQUE (user_id, terms_version_id));
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state text);
CREATE TABLE auction_buyers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, user_id uuid, paddle_number int, terms_acceptance_id uuid,
  pickup_acknowledged boolean, status text, registered_at timestamptz DEFAULT now(), UNIQUE (auction_id, user_id));
CREATE TABLE bids (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, bidder_user_id uuid, amount_cents int, created_at timestamptz DEFAULT now());
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text, entity_type text, entity_id uuid, auction_id uuid, lot_id uuid,
  payment_id uuid, actor_id uuid, metadata jsonb, created_at timestamptz DEFAULT now());
`;

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js')); worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
let server, base;
const q = (sql, p) => global.__PG.query(sql, p || []).then((r) => r.rows);
async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const post = (p, body, headers) => call('POST', p, body, headers);
async function publishVersion(v, { body = 'Terms version ' + v } = {}) {
  await q(`UPDATE terms_versions SET is_current = false WHERE kind = 'buyer_terms' AND is_current`);
  return (await q(`INSERT INTO terms_versions (version_int, title, body_markdown, is_current) VALUES ($1, $2, $3, true) RETURNING id`, [v, 'Terms v' + v, body]))[0].id;
}
async function mkUser(email, over = {}) {
  return (await q(`INSERT INTO users (email, role, email_verified, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, over.role || 'buyer', !!over.verified, over.created_at || new Date()]))[0].id;
}
const gate = require('../src/services/buyerEmailGate');
const termsService = require('../src/services/termsService');
const registration = require('../src/services/auctionRegistrationService');

jest.setTimeout(30000);
beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(SCHEMA);
  const a = express(); a.use(express.json());
  a.use('/api/auth', require('../src/routes/auth'));
  a.use('/api/terms', require('../src/routes/terms'));
  server = http.createServer(a).listen(0); await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  await publishVersion(1);
}, 60000);
afterAll(async () => { server.close(); await global.__PG.close(); });
beforeEach(async () => { await q('DELETE FROM platform_config'); gate._resetResends(); });

describe('account registration: explicit acceptance of the current terms', () => {
  test('refused without acceptance (no account is created); a non-true value does not count', async () => {
    for (const accept of [undefined, false, 'true', 1]) {
      const r = await post('/api/auth/register', { email: 'no-terms@example.com', password: 'longenough1', accept_terms: accept });
      expect(r.status).toBe(400); expect(r.json.code).toBe('TERMS_REQUIRED');
    }
    expect(await q(`SELECT 1 FROM users WHERE email = 'no-terms@example.com'`)).toHaveLength(0);
  });
  test('with acceptance: the account and an acceptance of the CURRENT version (ip, user agent) are recorded together', async () => {
    const cur = await termsService.getCurrentTerms();
    const r = await post('/api/auth/register', { email: 'yes-terms@example.com', password: 'longenough1', accept_terms: true, terms_version_int: cur.version_int },
      { 'user-agent': 'JestBrowser/1.0', 'x-forwarded-for': '203.0.113.9' });
    expect(r.status).toBe(200); expect(r.json.success).toBe(true);
    const rows = await q(`SELECT ta.ip_address, ta.user_agent, ta.accepted_at, tv.version_int FROM terms_acceptances ta
      JOIN terms_versions tv ON tv.id = ta.terms_version_id JOIN users u ON u.id = ta.user_id WHERE u.email = 'yes-terms@example.com'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip_address: '203.0.113.9', user_agent: 'JestBrowser/1.0', version_int: cur.version_int });
    expect(rows[0].accepted_at).toBeTruthy();
  });
  test('the page showed an older version than the current one: refused with TERMS_CHANGED and nothing is created', async () => {
    const cur = await termsService.getCurrentTerms();
    const r = await post('/api/auth/register', { email: 'stale@example.com', password: 'longenough1', accept_terms: true, terms_version_int: cur.version_int - 1 });
    expect(r.status).toBe(409); expect(r.json.code).toBe('TERMS_CHANGED');
    expect(await q(`SELECT 1 FROM users WHERE email = 'stale@example.com'`)).toHaveLength(0);
  });
  test('login is unaffected (no terms field needed)', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
    const login = src.slice(src.indexOf("router.post('/login'"), src.indexOf("router.post('/session'"));
    expect(login).not.toMatch(/accept_terms|termsService/);
  });
});

describe('re-acceptance and acceptance history', () => {
  let userId, auctionId, v1Accepted;
  beforeAll(async () => {
    userId = await mkUser('history@example.com', { verified: true });
    auctionId = (await q(`INSERT INTO auctions (state) VALUES ('active') RETURNING id`))[0].id;
    await termsService.acceptCurrentTerms(userId, { ip: '198.51.100.1', userAgent: 'UA-1' });
    v1Accepted = (await q(`SELECT ta.id, ta.accepted_at, ta.ip_address, ta.user_agent FROM terms_acceptances ta WHERE ta.user_id = $1`, [userId]))[0];
    await registration.registerForAuction(userId, auctionId, { pickupAcknowledged: true });
    expect((await registration.assertCanBid(userId, auctionId)).ok).toBe(true);
    await publishVersion(2);
  });
  afterAll(async () => { await publishVersion(3); });
  test('after a new version is published, the bid gate and auction registration require it', async () => {
    expect(await termsService.hasAcceptedCurrentTerms(userId)).toBe(false);
    const g = await registration.assertCanBid(userId, auctionId);
    expect(g).toMatchObject({ ok: false, code: 'TERMS_NOT_ACCEPTED' });
    await expect(registration.registerForAuction(userId, auctionId, { pickupAcknowledged: true })).rejects.toMatchObject({ code: 'TERMS_NOT_ACCEPTED' });
    expect((await registration.getRegistrationStatus(userId, auctionId)).can_bid).toBe(false);
  });
  test('accepting with a stale version shown records nothing (409 TERMS_CHANGED)', async () => {
    const r = await post('/api/terms/accept', { version_int: 1 }, { 'x-user': userId });
    expect(r.status).toBe(409); expect(r.json.code).toBe('TERMS_CHANGED');
    expect(await termsService.hasAcceptedCurrentTerms(userId)).toBe(false);
  });
  test('accepting the version shown re-opens bidding, and the earlier acceptance is preserved unchanged', async () => {
    const r = await post('/api/terms/accept', { version_int: 2 }, { 'x-user': userId, 'user-agent': 'UA-2' });
    expect(r.status).toBe(200); expect(r.json.data).toMatchObject({ version_int: 2, already_accepted: false });
    expect((await registration.assertCanBid(userId, auctionId)).ok).toBe(true);
    const rows = await q(`SELECT ta.id, ta.accepted_at, ta.ip_address, ta.user_agent, tv.version_int FROM terms_acceptances ta
      JOIN terms_versions tv ON tv.id = ta.terms_version_id WHERE ta.user_id = $1 ORDER BY tv.version_int`, [userId]);
    expect(rows.map((x) => x.version_int)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ id: v1Accepted.id, ip_address: '198.51.100.1', user_agent: 'UA-1' });
    expect(new Date(rows[0].accepted_at).getTime()).toBe(new Date(v1Accepted.accepted_at).getTime());
    // accepting again is idempotent: no second row, the first stays as recorded
    const again = await post('/api/terms/accept', {}, { 'x-user': userId });
    expect(again.json.data.already_accepted).toBe(true);
    expect(await q(`SELECT 1 FROM terms_acceptances WHERE user_id = $1`, [userId])).toHaveLength(2);
  });
  test('the acceptance status route reports the current version', async () => {
    const r = await call('GET', '/api/terms/me/acceptance', undefined, { 'x-user': userId });
    expect(r.json.data).toMatchObject({ accepted_current: true, current_version_int: 2 });
  });
});

describe('verified email to bid (buyers.require_verified_email_to_bid)', () => {
  let auctionId;
  const turnOn = (days, sinceDaysAgo = 0) => q(`INSERT INTO platform_config (key, value, category) VALUES
      ('buyers.require_verified_email_to_bid', 'true'::jsonb, 'buyers'),
      ('buyers.verified_email_grace_days', to_jsonb($1::int), 'buyers'),
      ('buyers.require_verified_email_since', to_jsonb((now() - make_interval(days => $2::int))::text), 'buyers')`, [days, sinceDaysAgo]);
  async function readyBuyer(email, over) {
    const id = await mkUser(email, over);
    await termsService.acceptCurrentTerms(id, {});
    return id;
  }
  beforeAll(async () => { auctionId = (await q(`INSERT INTO auctions (state) VALUES ('active') RETURNING id`))[0].id; });

  test('OFF by default: an unverified account registers and bids as before', async () => {
    expect(await gate.config()).toMatchObject({ required: false, grace_days: 30 });
    const id = await readyBuyer('off-default@example.com');
    await registration.registerForAuction(id, auctionId, { pickupAcknowledged: true });
    expect((await registration.assertCanBid(id, auctionId)).ok).toBe(true);
    const s = await call('GET', '/api/auth/email-verification', undefined, { 'x-user': id });
    expect(s.json.data).toMatchObject({ verified: false, required_to_bid: false, can_bid: true, must_verify: false });
  });
  test('ON: a new unverified account cannot register or bid; a verified one can; administrators are exempt', async () => {
    await turnOn(30, 0);
    const fresh = await readyBuyer('new-unverified@example.com');
    await expect(registration.registerForAuction(fresh, auctionId, { pickupAcknowledged: true })).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED', status: 403 });
    await q(`INSERT INTO auction_buyers (auction_id, user_id, paddle_number, pickup_acknowledged, status) VALUES ($1, $2, 900, true, 'active')`, [auctionId, fresh]);
    const g = await registration.assertCanBid(fresh, auctionId);
    expect(g).toMatchObject({ ok: false, status: 403, code: 'EMAIL_VERIFICATION_REQUIRED' });
    expect(g.message).toMatch(/confirm your email address/);
    const st = await registration.getRegistrationStatus(fresh, auctionId);
    expect(st).toMatchObject({ can_bid: false, email_verification_required: true });

    const verified = await readyBuyer('verified@example.com', { verified: true });
    await registration.registerForAuction(verified, auctionId, { pickupAcknowledged: true });
    expect((await registration.assertCanBid(verified, auctionId)).ok).toBe(true);

    const admin = await readyBuyer('admin-bidder@example.com', { role: 'admin' });
    expect((await gate.gate(admin)).ok).toBe(true);
  });
  test('established buyers (bid before the requirement) keep bidding during the grace period, then must confirm', async () => {
    const created = new Date(Date.now() - 90 * 86400000);
    const est = await readyBuyer('established@example.com', { created_at: created });
    await q(`INSERT INTO bids (bidder_user_id, amount_cents, created_at) VALUES ($1, 500, now() - interval '60 days')`, [est]);
    const neverBid = await readyBuyer('old-no-bids@example.com', { created_at: created });

    await turnOn(30, 10);   // turned on 10 days ago, 30-day grace: still inside it
    const inGrace = await gate.status(est);
    expect(inGrace).toMatchObject({ ok: true, grandfathered: true, must_verify: true });
    expect(new Date(inGrace.grace_until).getTime()).toBeGreaterThan(Date.now());
    await registration.registerForAuction(est, auctionId, { pickupAcknowledged: true });
    expect((await registration.assertCanBid(est, auctionId)).ok).toBe(true);
    const s = await call('GET', '/api/auth/email-verification', undefined, { 'x-user': est });
    expect(s.json.data).toMatchObject({ can_bid: true, must_verify: true, required_to_bid: true });
    // an old account with no bids or purchases is not "established"
    expect((await gate.status(neverBid)).ok).toBe(false);

    await q('DELETE FROM platform_config');
    await turnOn(30, 31);   // grace over
    expect(await gate.status(est)).toMatchObject({ ok: false, grandfathered: true });
    expect((await registration.assertCanBid(est, auctionId)).code).toBe('EMAIL_VERIFICATION_REQUIRED');

    // confirming the address restores bidding immediately
    await q('UPDATE users SET email_verified = true WHERE id = $1', [est]);
    expect((await registration.assertCanBid(est, auctionId)).ok).toBe(true);
  });
  test('the administrator switch validates input, starts the grace period when turned on, and keeps the configured days', async () => {
    await expect(gate.setConfig({ required: 'yes' })).rejects.toMatchObject({ code: 'BAD_VALUE' });
    await expect(gate.setConfig({ grace_days: 400 })).rejects.toMatchObject({ code: 'BAD_VALUE' });
    const on = await gate.setConfig({ required: true, grace_days: 14 }, { actorId: null });
    expect(on).toMatchObject({ required: true, grace_days: 14 });
    expect(Math.abs(new Date(on.required_since).getTime() - Date.now())).toBeLessThan(60000);
    const off = await gate.setConfig({ required: false });
    expect(off.required).toBe(false);
  });
  test('one-click resend: sends to the account, then throttles; an already confirmed account is told so', async () => {
    const id = await mkUser('resend@example.com');
    const { sendEmail } = require('../src/services/emailService');
    sendEmail.mockClear();
    const first = await post('/api/auth/resend-verification', {}, { 'x-user': id });
    expect(first.status).toBe(200); expect(first.json.data.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toBe('Confirm your Advantage.Bid email address');
    expect(await q('SELECT 1 FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL', [id])).toHaveLength(1);
    const second = await post('/api/auth/resend-verification', {}, { 'x-user': id });
    expect(second.status).toBe(429); expect(second.json.code).toBe('RESEND_THROTTLED');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const v = await mkUser('already@example.com', { verified: true });
    expect((await post('/api/auth/resend-verification', {}, { 'x-user': v })).json.data.already_verified).toBe(true);
  });
  test('welcome email wording follows the switch (optional while OFF, needed before bidding while ON)', () => {
    const b = require('../src/services/emailVerificationService')._builders;
    expect(b.buildWelcomeEmail('https://x/l').html).toMatch(/It is optional and does not affect bidding/);
    expect(b.buildRequiredWelcomeEmail('https://x/l').html).toMatch(/before you register for an auction or place a bid/);
    for (const m of [b.buildWelcomeEmail('l'), b.buildRequiredWelcomeEmail('l'), b.buildConfirmEmail('l')]) {
      expect(m.html + m.text + m.subject).not.toMatch(/[–—]/);
    }
  });
});
