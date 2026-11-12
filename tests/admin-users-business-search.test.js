'use strict';

/**
 * Admin User Management search by business name (owner 2026-11-12): GET /api/admin/users?q=...
 *
 * Real Postgres (PGlite) and the real admin users router, role middleware and search builder; only sign-in is a
 * stand-in (a header names the test user). Proves: the search matches the seller business name
 * (seller_profiles.display_name); each result carries both the business and the account owner (full name + email);
 * only admins can search; % and _ typed by the admin are matched literally (escaped), never as wildcards; no new
 * personal fields are returned.
 */

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
    return { rows: r.rows, rowCount: r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: u.id, role: u.role };
  return next();
});

const SCHEMA = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, full_name text, phone text, role text DEFAULT 'buyer',
  is_active boolean DEFAULT true, stripe_customer_id text, stripe_customer_livemode boolean, created_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text, display_name text);
CREATE TABLE card_verifications (user_id uuid, status text, livemode boolean);
CREATE TABLE bids (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bidder_user_id uuid);
CREATE TABLE auction_buyers (user_id uuid);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), winning_buyer_user_id uuid, state text);
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_user_id uuid, refunded_amount_cents int DEFAULT 0);
`;

let server, base;
const U = {};
const one = async (sql, p) => (await global.__PG.query(sql, p || [])).rows[0];
async function search(user, q) {
  const r = await fetch(base + '/api/admin/users?q=' + encodeURIComponent(q), { headers: { 'x-test-user': user } });
  let body = null; try { body = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, body };
}

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(SCHEMA);
  const mk = async (key, email, fullName, role) => { U[key] = await one('INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3) RETURNING *', [email, fullName, role]); };
  await mk('admin', 'admin@test.example', 'Ada Admin', 'admin');
  await mk('buyer', 'buyer@test.example', 'Bo Buyer', 'buyer');
  await mk('pro', 'pat@test.example', 'Pat Owner', 'seller');
  await mk('pct', 'percy@test.example', 'Percy Percent', 'seller');
  await mk('indiv', 'ivy@test.example', 'Ivy Individual', 'seller');
  await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, 'retail_gallery_studio', 'Timeless Treasures') RETURNING id`, [U.pro.id]);
  await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, 'auction_house', '100% Vintage_Finds') RETURNING id`, [U.pct.id]);
  await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, 'private', 'Ivy Garage') RETURNING id`, [U.indiv.id]);
  global.__USERS = U;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/users', require('../src/routes/adminUsers'));
  app.use((e, req, res, _next) => res.status(500).json({ error: e.message }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

test('finds a seller by business name, and the row carries both the business and the account owner', async () => {
  const r = await search('admin', 'timeless');
  expect(r.status).toBe(200);
  expect(r.body.data).toHaveLength(1);
  expect(r.body.data[0]).toMatchObject({ id: U.pro.id, seller_name: 'Timeless Treasures', full_name: 'Pat Owner', email: 'pat@test.example' });
  // a partial, differently cased business name still matches
  expect((await search('admin', 'TREASU')).body.data.map((u) => u.id)).toEqual([U.pro.id]);
});

test('existing matches still work (owner name, email), and buyers without a business are unaffected', async () => {
  expect((await search('admin', 'Pat Owner')).body.data.map((u) => u.id)).toEqual([U.pro.id]);
  expect((await search('admin', 'buyer@test')).body.data.map((u) => [u.id, u.seller_name])).toEqual([[U.buyer.id, null]]);
});

test('no new personal fields: the row keeps the existing list-card shape', async () => {
  const row = (await search('admin', 'timeless')).body.data[0];
  expect(Object.keys(row).sort()).toEqual(['bids_placed', 'card_on_file', 'created_at', 'email', 'full_name', 'id', 'is_active', 'lots_won',
    'phone', 'refunds', 'registrations', 'role', 'seller_name'].sort());
});

test('only admins can search (a buyer and a seller are refused; signed out is 401)', async () => {
  expect((await search('buyer', 'timeless')).status).toBe(403);
  expect((await search('pro', 'timeless')).status).toBe(403);
  expect((await search('nobody', 'timeless')).status).toBe(401);
});

test('% and _ are matched literally, never as wildcards', async () => {
  // "%" alone would match every account if passed through as a wildcard.
  expect((await search('admin', '%')).body.data.map((u) => u.id)).toEqual([U.pct.id]);
  // "_" alone would match every non-empty value as a wildcard.
  expect((await search('admin', '_')).body.data.map((u) => u.id)).toEqual([U.pct.id]);
  expect((await search('admin', '0% Vintage_F')).body.data.map((u) => u.id)).toEqual([U.pct.id]);
  // a backslash is literal too (no escape-sequence injection), and a quote is just text (parameterized)
  expect((await search('admin', '\\')).body.data).toEqual([]);
  expect((await search('admin', "' OR 1=1 --")).body.data).toEqual([]);
});
