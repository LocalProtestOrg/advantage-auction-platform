'use strict';

/**
 * Server-side session invalidation (migration 194, security audit 2026-10-15, owner-approved), end to end against a
 * real Postgres (PGlite) and the real auth / admin routers over HTTP:
 *   - the rollout signs nobody out (tokens from before it keep working);
 *   - signing out ends that sign-in on the server (Bearer copy and cookie), including its sliding renewals, and leaves
 *     the account's other sign-ins alone;
 *   - a password reset, a suspension, and a staff role change / removal of Super Admin end every sign-in;
 *   - removing Super Admin also removes the marketplace admin role;
 *   - the current database role is used, not the one in the token;
 *   - the private-page gate, optional sign-in and the session probe honour all of this;
 *   - before migration 194 is applied, sessions behave exactly as before (no forced sign-out, no 503).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-session-revocation';
jest.mock('../src/db', () => require('./sasha-phone/pgHarness').dbAdapter(() => global.__PG));
jest.mock('../src/db/index', () => require('./sasha-phone/pgHarness').dbAdapter(() => global.__PG));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/emailVerificationService', () => ({ sendWelcome: jest.fn(async () => {}), verifyEmail: jest.fn() }));
jest.mock('../src/services/conversionService', () => ({ emit: () => {}, ctxFromReq: () => ({}) }));

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const SCHEMA = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, password_hash text, full_name text, role text DEFAULT 'buyer',
  is_active boolean DEFAULT true, staff_role text, staff_active boolean, last_login_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE staff_permission_overrides (user_id uuid, permission text, effect text);
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text, entity_type text, entity_id uuid, auction_id uuid, lot_id uuid,
  payment_id uuid, actor_id uuid, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE password_reset_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz, requested_ip text, created_at timestamptz NOT NULL DEFAULT now());
`;
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '194_session_revocation.sql'), 'utf8');

const sessionTokens = require('../src/lib/sessionTokens');
const auth = require('../src/middleware/authMiddleware');
const optionalAuth = require('../src/middleware/optionalAuthMiddleware');
const htmlAuthGate = require('../src/middleware/htmlAuthGate');
const passwordReset = require('../src/services/passwordResetService');

let server, base;
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', require('../src/routes/auth'));
  a.use('/api/admin/users', require('../src/routes/adminUsers'));
  a.use('/api/admin/staff', require('../src/routes/adminStaff'));
  a.get('/api/whoami', auth, (req, res) => res.json({ id: req.user.id, role: req.user.role }));
  a.post('/api/write', auth, (req, res) => res.json({ ok: true }));
  a.get('/api/public', optionalAuth, (req, res) => res.json({ user: req.user || null }));
  a.use(htmlAuthGate);
  a.get('/app.html', (req, res) => res.send('private'));
  return a;
}
const q = (sql, p) => global.__PG.query(sql, p || []).then((r) => r.rows);
async function call(method, p, { token, cookie, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (cookie) headers.cookie = 'aap_session=' + encodeURIComponent(cookie);
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* html */ }
  return { status: r.status, json, location: r.headers.get('location'), refreshed: r.headers.get('x-refreshed-token') };
}
async function user(email, { role = 'buyer', staff_role = null, password = 'Correct-horse-1' } = {}) {
  const hash = await bcrypt.hash(password, 4);
  return (await q(`INSERT INTO users (email, password_hash, role, staff_role, staff_active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [email, hash, role, staff_role, staff_role ? true : null]))[0].id;
}
async function login(email, password = 'Correct-horse-1') { return (await call('POST', '/api/auth/login', { body: { email, password } })).json.token; }
const legacyToken = (id, role, extra = {}) => jwt.sign({ id, role, ...extra }, process.env.JWT_SECRET, { expiresIn: '24h' });

jest.setTimeout(30000); // PGlite start-up in a worker can be slow on a loaded machine
beforeAll(async () => {
  global.__PG = await startPg(); // the Phone Sasha harness's worker-backed PGlite, with this suite's own schema
  await global.__PG.exec(SCHEMA);
  await global.__PG.exec(MIGRATION);
  server = http.createServer(app()).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);
afterAll(async () => { if (server) server.close(); if (global.__PG) await global.__PG.close(); });
beforeEach(() => { sessionTokens._clearCache(); require('../src/lib/accountStatus')._clearAccountStatusCache(); });

// The harness's PGlite-in-a-worker, without the Sasha schema.
function startPg() {
  const { Worker } = require('worker_threads');
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js')); worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return Promise.resolve({ exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() });
}

describe('rollout', () => {
  test('a token issued before the rollout (no sv / sid) keeps working — nobody is signed out by the deploy', async () => {
    const id = await user('legacy@example.com');
    const r = await call('GET', '/api/whoami', { token: legacyToken(id, 'buyer') });
    expect(r.status).toBe(200); expect(r.json).toEqual({ id, role: 'buyer' });
    expect((await call('POST', '/api/write', { token: legacyToken(id, 'buyer') })).status).toBe(200);
  });
  test('a new sign-in carries the account version and a sign-in id', async () => {
    await user('fresh@example.com');
    const d = jwt.decode(await login('fresh@example.com'));
    expect(d.sv).toBe(0); expect(typeof d.sid).toBe('string'); expect(d.sid.length).toBeGreaterThan(16);
  });
});

describe('signing out', () => {
  test('ends that sign-in on the server (a copied token stops working); the other device stays signed in', async () => {
    await user('two-devices@example.com');
    const phone = await login('two-devices@example.com');
    const laptop = await login('two-devices@example.com');
    expect((await call('POST', '/api/auth/logout', { token: phone })).status).toBe(200);
    expect((await call('GET', '/api/whoami', { token: phone })).status).toBe(401);
    expect((await call('GET', '/api/whoami', { cookie: phone })).status).toBe(401);
    expect((await call('GET', '/api/whoami', { token: laptop })).status).toBe(200);
  });
  test('signing out with only the cookie ends it too', async () => {
    await user('cookie-only@example.com');
    const t = await login('cookie-only@example.com');
    await call('POST', '/api/auth/logout', { cookie: t });
    expect((await call('GET', '/api/whoami', { token: t })).status).toBe(401);
  });
  test('a pre-rollout token can be signed out, and so can the renewals made from it', async () => {
    const id = await user('legacy-out@example.com');
    const nowSec = Math.floor(Date.now() / 1000);
    const old = jwt.sign({ id, role: 'buyer', iat: nowSec - 50000, exp: nowSec + 36400 }, process.env.JWT_SECRET); // past half-life
    const renewed = (await call('GET', '/api/whoami', { token: old })).refreshed;
    expect(renewed).toBeTruthy();
    expect(jwt.decode(renewed).sid).toBe(sessionTokens.sessionIdOf(jwt.decode(old), old)); // same sign-in lineage
    await call('POST', '/api/auth/logout', { token: renewed });
    expect((await call('GET', '/api/whoami', { token: old })).status).toBe(401);
    expect((await call('GET', '/api/whoami', { token: renewed })).status).toBe(401);
  });
  test('a renewed token keeps its sign-in id, so signing out the original ends the renewal', async () => {
    const id = await user('renew@example.com');
    const nowSec = Math.floor(Date.now() / 1000);
    const t = jwt.sign({ id, role: 'buyer', sv: 0, sid: 'sid-renew-1', iat: nowSec - 50000, exp: nowSec + 36400 }, process.env.JWT_SECRET);
    const renewed = (await call('GET', '/api/whoami', { token: t })).refreshed;
    expect(jwt.decode(renewed)).toMatchObject({ sid: 'sid-renew-1', sv: 0 });
    await call('POST', '/api/auth/logout', { token: t });
    expect((await call('GET', '/api/whoami', { token: renewed })).status).toBe(401);
  });
  test('the page sign-out (/logout style: cookie) is refused afterwards by the private-page gate and optional sign-in', async () => {
    await user('pages@example.com');
    const t = await login('pages@example.com');
    expect((await call('GET', '/app.html', { cookie: t })).status).toBe(200);
    expect((await call('GET', '/api/public', { token: t })).json.user).toBeTruthy();
    await call('POST', '/api/auth/logout', { cookie: t });
    const gate = await call('GET', '/app.html', { cookie: t });
    expect(gate.status).toBe(302); expect(gate.location).toMatch(/^\/login\.html/);
    expect((await call('GET', '/api/public', { token: t })).json.user).toBeNull();
    expect((await call('GET', '/api/auth/session-status', { cookie: t })).json).toEqual({ authenticated: false });
  });
});

describe('every sign-in ends on', () => {
  test('a password reset (and a new sign-in with the new password works)', async () => {
    const id = await user('reset@example.com');
    const a = await login('reset@example.com'); const b = legacyToken(id, 'buyer');
    const raw = crypto.randomBytes(32).toString('hex');
    await q(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [id, crypto.createHash('sha256').update(raw).digest('hex')]);
    expect((await passwordReset.resetPassword(raw, 'Brand-new-pass-2')).ok).toBe(true);
    expect((await call('GET', '/api/whoami', { token: a })).status).toBe(401);
    expect((await call('GET', '/api/whoami', { token: b })).status).toBe(401);
    const c = await login('reset@example.com', 'Brand-new-pass-2');
    expect(jwt.decode(c).sv).toBe(1);
    expect((await call('GET', '/api/whoami', { token: c })).status).toBe(200);
  });
  test('an admin suspending the account (and the account cannot sign back in)', async () => {
    const admin = await user('owner-a@example.com', { role: 'admin', staff_role: 'super_admin' });
    const id = await user('suspend@example.com');
    const t = await login('suspend@example.com');
    const r = await call('POST', `/api/admin/users/${id}/status`, { token: await login('owner-a@example.com'), body: { status: 'suspended' } });
    expect(r.status).toBe(200);
    expect((await call('GET', '/api/whoami', { token: t })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { body: { email: 'suspend@example.com', password: 'Correct-horse-1' } })).status).toBe(403);
    void admin;
  });
  test('removing Super Admin: sessions end AND the marketplace admin role is removed (seller profile → seller)', async () => {
    await user('owner-b@example.com', { role: 'admin', staff_role: 'super_admin' });
    const demoted = await user('demoted@example.com', { role: 'admin', staff_role: 'super_admin' });
    const sellerAdmin = await user('demoted-seller@example.com', { role: 'admin', staff_role: 'super_admin' });
    await q('INSERT INTO seller_profiles (user_id) VALUES ($1)', [sellerAdmin]);
    const t = await login('demoted@example.com');
    const owner = await login('owner-b@example.com');
    expect((await call('PATCH', `/api/admin/staff/${demoted}`, { token: owner, body: { staff_role: 'marketing' } })).status).toBe(200);
    expect((await q('SELECT role, staff_role FROM users WHERE id = $1', [demoted]))[0]).toEqual({ role: 'buyer', staff_role: 'marketing' });
    expect((await call('GET', '/api/whoami', { token: t })).status).toBe(401);
    expect((await call('PATCH', `/api/admin/staff/${sellerAdmin}`, { token: owner, body: { staff_active: false } })).status).toBe(200);
    expect((await q('SELECT role FROM users WHERE id = $1', [sellerAdmin]))[0].role).toBe('seller');
    const audit = await q(`SELECT metadata FROM audit_log WHERE event_type = 'staff_role_changed' AND entity_id = $1`, [demoted]);
    expect(audit[0].metadata.before.role).toBe('admin'); expect(audit[0].metadata.after.role).toBe('buyer');
  });
});

describe('the current database role is used', () => {
  test('a token that still says admin acts as the current (buyer) role, including on private admin pages', async () => {
    const id = await user('was-admin@example.com', { role: 'admin' });
    const t = await login('was-admin@example.com');
    await q(`UPDATE users SET role = 'buyer' WHERE id = $1`, [id]); // e.g. changed directly in the database
    sessionTokens._clearCache();
    expect((await call('GET', '/api/whoami', { token: t })).json.role).toBe('buyer');
    const r = await call('GET', '/api/admin/users', { token: t });
    expect(r.status).toBe(403);
  });
});

describe('before migration 194 is applied', () => {
  test('sessions behave as before: no forced sign-out, writes allowed, sign-in still issues tokens', async () => {
    const id = await user('premig@example.com');
    await global.__PG.exec('ALTER TABLE users RENAME COLUMN session_version TO session_version_x');
    try {
      sessionTokens._clearCache();
      const t = legacyToken(id, 'buyer');
      expect((await call('GET', '/api/whoami', { token: t })).status).toBe(200);
      expect((await call('POST', '/api/write', { token: t })).status).toBe(200);
      const fresh = await login('premig@example.com');
      expect((await call('GET', '/api/whoami', { token: fresh })).status).toBe(200);
    } finally {
      await global.__PG.exec('ALTER TABLE users RENAME COLUMN session_version_x TO session_version');
      sessionTokens._clearCache();
    }
  });
});
