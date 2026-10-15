'use strict';

/**
 * Sign-in protections (security audit 2026-10-15, owner item 6), against a real Postgres (PGlite) and the real auth
 * router over HTTP: case-insensitive email matching (never merging accounts), a per-account sign-in throttle that
 * does not reveal whether an account exists, and the guarded case-insensitive unique index (migration 195).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-login-protections';
jest.mock('../src/db', () => require('./sasha-phone/pgHarness').dbAdapter(() => global.__PG));
jest.mock('../src/db/index', () => require('./sasha-phone/pgHarness').dbAdapter(() => global.__PG));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/emailVerificationService', () => ({ sendWelcome: jest.fn(async () => {}), verifyEmail: jest.fn() }));
jest.mock('../src/services/conversionService', () => ({ emit: () => {}, ctxFromReq: () => ({}) }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const { Worker } = require('worker_threads');
const throttle = require('../src/lib/loginThrottle');

const SCHEMA = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, password_hash text, full_name text, role text DEFAULT 'buyer',
  is_active boolean DEFAULT true, staff_role text, staff_active boolean, last_login_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE password_reset_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, used_at timestamptz, requested_ip text, created_at timestamptz NOT NULL DEFAULT now());
`;
const M194 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '194_session_revocation.sql'), 'utf8');
const M195 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '195_users_email_case_insensitive_unique.sql'), 'utf8');

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
async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function user(email, password = 'Correct-horse-1') {
  return (await q('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await bcrypt.hash(password, 4)]))[0].id;
}

jest.setTimeout(30000);
beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(SCHEMA); await global.__PG.exec(M194);
  const a = express(); a.use(express.json()); a.use('/api/auth', require('../src/routes/auth'));
  server = http.createServer(a).listen(0); await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);
afterAll(async () => { server.close(); await global.__PG.close(); });
beforeEach(() => throttle._reset());

describe('case-insensitive email', () => {
  test('an account stored with capitals signs in with any letter case and surrounding spaces', async () => {
    await user('Mixed.Case@Example.com');
    for (const e of ['mixed.case@example.com', 'MIXED.CASE@EXAMPLE.COM', '  Mixed.Case@Example.com ']) {
      expect((await post('/api/auth/login', { email: e, password: 'Correct-horse-1' })).status).toBe(200);
    }
    expect((await q(`SELECT email FROM users WHERE lower(email) = 'mixed.case@example.com'`))[0].email).toBe('Mixed.Case@Example.com'); // never rewritten
  });
  test('registration stores the address lower-case and refuses a case variant of an existing account', async () => {
    expect((await post('/api/auth/register', { email: '  New.Person@Example.com ', password: 'longenough1' })).status).toBe(200);
    expect((await q(`SELECT email FROM users WHERE email = 'new.person@example.com'`))).toHaveLength(1);
    const dup = await post('/api/auth/register', { email: 'MIXED.case@example.COM', password: 'longenough1' });
    expect(dup.status).toBe(409);
    expect((await q(`SELECT count(*)::int n FROM users WHERE lower(email) = 'mixed.case@example.com'`))[0].n).toBe(1);
  });
  test('two existing accounts that differ only by case are never merged: exact match signs in, a third spelling is refused', async () => {
    await user('Twin@Example.com', 'Pass-one-111'); await user('twin@example.com', 'Pass-two-222');
    expect((await post('/api/auth/login', { email: 'Twin@Example.com', password: 'Pass-one-111' })).status).toBe(200);
    expect((await post('/api/auth/login', { email: 'twin@example.com', password: 'Pass-two-222' })).status).toBe(200);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await post('/api/auth/login', { email: 'TWIN@example.com', password: 'Pass-one-111' })).status).toBe(401);
    warn.mockRestore();
    expect((await q(`SELECT count(*)::int n FROM users WHERE lower(email) = 'twin@example.com'`))[0].n).toBe(2);
  });
  test('password reset finds the account case-insensitively', async () => {
    await user('Reset.Me@Example.com');
    const svc = require('../src/services/passwordResetService');
    expect(await svc.requestReset('reset.me@EXAMPLE.com', { ip: '1.1.1.1' })).toEqual({ ok: true });
    expect((await q(`SELECT count(*)::int n FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = 'Reset.Me@Example.com'`))[0].n).toBe(1);
  });
});

describe('per-account sign-in throttle', () => {
  test(`after ${throttle.MAX_FAILURES} wrong passwords the account is locked from every address, even with the right password`, async () => {
    await user('target@example.com');
    for (let i = 0; i < throttle.MAX_FAILURES; i++) expect((await post('/api/auth/login', { email: 'target@example.com', password: 'wrong-' + i })).status).toBe(401);
    const locked = await post('/api/auth/login', { email: 'TARGET@example.com', password: 'Correct-horse-1' });
    expect(locked.status).toBe(429); expect(locked.json.code).toBe('TOO_MANY_ATTEMPTS');
  });
  test('an email with no account locks the same way (no account enumeration)', async () => {
    for (let i = 0; i < throttle.MAX_FAILURES; i++) await post('/api/auth/login', { email: 'nobody@example.com', password: 'x' + i });
    expect((await post('/api/auth/login', { email: 'nobody@example.com', password: 'x' })).status).toBe(429);
  });
  test('a correct password before the limit clears the count', async () => {
    await user('forgetful@example.com');
    for (let i = 0; i < throttle.MAX_FAILURES - 1; i++) await post('/api/auth/login', { email: 'forgetful@example.com', password: 'nope' });
    expect((await post('/api/auth/login', { email: 'forgetful@example.com', password: 'Correct-horse-1' })).status).toBe(200);
    for (let i = 0; i < throttle.MAX_FAILURES - 1; i++) expect((await post('/api/auth/login', { email: 'forgetful@example.com', password: 'nope' })).status).toBe(401);
  });
  test('other accounts are unaffected by one account\'s lock', async () => {
    await user('victim2@example.com'); await user('bystander@example.com');
    for (let i = 0; i < throttle.MAX_FAILURES; i++) await post('/api/auth/login', { email: 'victim2@example.com', password: 'bad' });
    expect((await post('/api/auth/login', { email: 'bystander@example.com', password: 'Correct-horse-1' })).status).toBe(200);
  });
});

describe('migration 195 (prepared, guarded)', () => {
  test('refuses while case-variant duplicates exist and changes nothing', async () => {
    // "Twin@Example.com" and "twin@example.com" exist from the test above.
    await expect(global.__PG.exec(M195)).rejects.toThrow(/differ only by case/);
    expect(await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_users_email_ci'`)).toHaveLength(0);
  });
  test('applies cleanly once there are none, and then blocks a new case variant', async () => {
    await q(`DELETE FROM users WHERE email = 'twin@example.com'`);
    await global.__PG.exec(M195);
    expect(await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_users_email_ci'`)).toHaveLength(1);
    await expect(q(`INSERT INTO users (email) VALUES ('TWIN@EXAMPLE.COM')`)).rejects.toThrow(/duplicate|unique/i);
  });
});
