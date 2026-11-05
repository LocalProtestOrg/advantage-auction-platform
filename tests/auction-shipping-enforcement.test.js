'use strict';

/**
 * Auction shipping Phase 1, server enforcement (spec docs/projects/auction-shipping-spec.md; migration 218).
 * Real Postgres (PGlite) with the real migration 218, the real routes (auction shipping, lots, auction summary) and the
 * real audit writer. Covers: the flag off changes nothing; an Individual Seller without approval is refused; an unverified
 * Professional Seller is refused; the payout and fraud education must be acknowledged first; a lot ships only when marked
 * eligible; a seller can never touch another seller's shipping settings or lots; administrator approval, limit and
 * overrides are audited; labels come from the lots (some pickup-only lots = Limited Shipping, never Shipping Available).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-auction-shipping'; // test value, never a real secret

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
// The test names the signed-in user with a header (the real session middleware has its own tests).
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: u.id, role: u.role };
  return next();
});
jest.mock('../src/middleware/optionalAuthMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (u) req.user = { id: u.id, role: u.role };
  return next();
});

const BASE = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, full_name text, role text DEFAULT 'buyer', staff_role text,
  staff_active boolean DEFAULT true, is_active boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE staff_permission_overrides (user_id uuid, permission text, effect text);
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text,
  capabilities jsonb DEFAULT '{}'::jsonb, verification_required_before_publication boolean DEFAULT false, display_name text,
  metadata jsonb DEFAULT '{}'::jsonb, show_branding_to_buyers boolean DEFAULT true, storefront_slug text, storefront_published boolean DEFAULT false,
  is_demo boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE verification_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid REFERENCES seller_profiles(id), status text,
  reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  auction_id uuid, lot_id uuid, payment_id uuid, actor_id uuid, metadata jsonb, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid REFERENCES seller_profiles(id), title text, subtitle text,
  description text, state text, public_auction_type text, city text, address_state text, street_address text, zip text, start_time timestamptz,
  end_time timestamptz, pickup_window_start timestamptz, pickup_window_end timestamptz, timezone text, banner_image_url text, cover_image_url text,
  shipping_available boolean DEFAULT false, is_archived boolean DEFAULT false, buyer_premium_bps int, bid_increment_cents int,
  marketplace_status text DEFAULT 'syndicated', is_demo boolean DEFAULT false);
CREATE TABLE seller_followers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid REFERENCES auctions(id), lot_number int, lot_number_display text,
  title text, description text, category text, size_category text, pickup_category text, condition text, material text, era text, maker_artist text,
  weight text, dimensions jsonb, shippable boolean DEFAULT false, shipping_cost_cents int, shipping_notes text, starting_bid_cents int,
  bid_increment_cents int, current_bid_cents int, bid_count int DEFAULT 0, winning_amount_cents int, current_winner_user_id uuid,
  winning_buyer_user_id uuid, state text DEFAULT 'open', is_withdrawn boolean DEFAULT false, is_featured boolean DEFAULT false, closes_at timestamptz,
  extended_until timestamptz, extension_count int DEFAULT 0, thumbnail_url text, images_count int DEFAULT 0, reserve_cents int,
  reserve_visible boolean DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE lot_proxy_bids (lot_id uuid, bidder_user_id uuid, max_amount_cents int);
CREATE TABLE lot_images (lot_id uuid, image_url text, sort_order int DEFAULT 0);
`;

let server, base;
const U = {}; const SP = {}; const A = {}; const L = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
async function call(user, method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}
const on = () => { process.env.AUCTION_SHIPPING_ENABLED = 'true'; };
const off = () => { delete process.env.AUCTION_SHIPPING_ENABLED; };
const audits = (type, entityId) => q('SELECT * FROM audit_log WHERE event_type = $1 AND entity_id = $2 ORDER BY created_at', [type, entityId]);

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  await global.__PG.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '218_auction_shipping_phase1.sql'), 'utf8'));
  for (const [name, role] of [['sue', 'seller'], ['nora', 'seller'], ['ivy', 'seller'], ['ian', 'seller'], ['bea', 'buyer'], ['admin', 'admin']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3) RETURNING *`, [name + '@test.example', name.toUpperCase(), role]);
  }
  global.__USERS = U;
  // sue: Professional, verified. nora: Professional, verification required, not approved. ivy, ian: Individual (private).
  for (const [name, type, required] of [['sue', 'auction_house', true], ['nora', 'estate_sale_company', true], ['ivy', 'private', false], ['ian', 'private', false]]) {
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, verification_required_before_publication)
      VALUES ($1, $2, $3, $4) RETURNING id`, [U[name].id, type, name.toUpperCase() + ' Co', required])).id;
    // Individual Sellers edit only while their auction is a draft (catalog edit lock), so theirs are drafts here.
    A[name] = (await one(`INSERT INTO auctions (seller_id, title, state, city, address_state, shipping_available)
      VALUES ($1, $2, $3, 'Houston', 'TX', true) RETURNING id`, [SP[name], name + ' auction', type === 'private' ? 'draft' : 'published'])).id;
    L[name] = [];
    for (let i = 1; i <= 2; i++) {
      // The legacy lots.shippable flag is set on purpose: the new label must ignore it.
      L[name].push((await one(`INSERT INTO lots (auction_id, lot_number, title, starting_bid_cents, shippable) VALUES ($1, $2, $3, 100, true) RETURNING id`,
        [A[name], i, name + ' lot ' + i])).id);
    }
  }
  await q(`INSERT INTO verification_requests (seller_profile_id, status, reviewed_by, reviewed_at) VALUES ($1, 'approved', $2, now())`, [SP.sue, U.admin.id]);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auctions', require('../src/routes/auctions'));
  app.use('/api/lots', require('../src/routes/lots'));
  app.use('/api/auction-shipping', require('../src/routes/auctionShipping'));
  app.use((err, req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { off(); if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

describe('flag off (default): nothing changes', () => {
  beforeAll(off);
  test('config says off; every other shipping route is not found', async () => {
    expect((await call(null, 'GET', '/api/auction-shipping/config')).body.data).toEqual({ enabled: false });
    expect((await call('sue', 'GET', '/api/auction-shipping/seller/status')).status).toBe(404);
    const r = await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.sue[0], { shipping_eligible: true });
    expect(r.status).toBe(404); expect(r.body.code).toBe('AUCTION_SHIPPING_DISABLED');
    expect((await call('admin', 'POST', '/api/auction-shipping/admin/sellers/' + SP.ivy + '/approve', { reason: 'reviewed seller' })).status).toBe(404);
  });
  test('auction and lot payloads carry no shipping summary', async () => {
    const s = await call(null, 'GET', '/api/auctions/' + A.sue + '/summary');
    expect(s.status).toBe(200); expect(s.body.data).not.toHaveProperty('shipping');
    expect(s.body.data.shipping_available).toBe(true);   // legacy field untouched
    const lot = await call(null, 'GET', '/api/lots/' + L.sue[0]);
    expect(lot.status).toBe(200); expect(lot.body.data).not.toHaveProperty('shipping');
    const list = await call(null, 'GET', '/api/lots/auction/' + A.sue);
    expect(list.body.data.every((l) => !('shipping' in l))).toBe(true);
  });
});

describe('flag on', () => {
  beforeAll(on);

  test('config says on', async () => {
    expect((await call(null, 'GET', '/api/auction-shipping/config')).body.data).toEqual({ enabled: true });
  });

  test('Individual Seller without admin approval is refused (status, acknowledgment, profiles, lots)', async () => {
    const st = await call('ivy', 'GET', '/api/auction-shipping/seller/status');
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ eligible: false, can_enable: false, reason: 'approval_required' });
    expect(st.body.data.payout_explanation).toMatch(/held until the carrier confirms delivery, plus 3 business days/);
    expect((await call('ivy', 'POST', '/api/auction-shipping/seller/acknowledge', { acknowledged: true })).status).toBe(403);
    expect((await call('ivy', 'POST', '/api/auction-shipping/seller/profiles', { name: 'Mine' })).status).toBe(403);
    const r = await call('ivy', 'PUT', '/api/auction-shipping/lots/' + L.ivy[0], { shipping_eligible: true });
    expect(r.status).toBe(403); expect(r.body.code).toBe('SHIPPING_NOT_ALLOWED');
    expect((await one('SELECT shipping_eligible FROM lots WHERE id = $1', [L.ivy[0]])).shipping_eligible).toBe(false);
  });

  test('unverified Professional Seller is refused', async () => {
    const st = await call('nora', 'GET', '/api/auction-shipping/seller/status');
    expect(st.body.data).toMatchObject({ eligible: false, reason: 'verification_required' });
    expect((await call('nora', 'POST', '/api/auction-shipping/seller/acknowledge', { acknowledged: true })).status).toBe(403);
    const r = await call('nora', 'PUT', '/api/auction-shipping/lots/' + L.nora[0], { shipping_eligible: true });
    expect(r.status).toBe(403); expect(r.body.code).toBe('SHIPPING_NOT_ALLOWED');
  });

  test('verified Professional Seller must acknowledge the payout and fraud education first', async () => {
    const st = await call('sue', 'GET', '/api/auction-shipping/seller/status');
    expect(st.body.data).toMatchObject({ eligible: true, can_enable: false, needs_acknowledgment: true, per_shipment_limit_cents: 50000 });
    const r = await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.sue[0], { shipping_eligible: true });
    expect(r.status).toBe(403); expect(r.body.code).toBe('ACK_REQUIRED');
    expect((await call('sue', 'POST', '/api/auction-shipping/seller/acknowledge', {})).status).toBe(400);
    const ack = await call('sue', 'POST', '/api/auction-shipping/seller/acknowledge', { acknowledged: true });
    expect(ack.status).toBe(200);
    expect(ack.body.data.can_enable).toBe(true);
    expect(ack.body.data.acknowledged_at).toBeTruthy();
    // a sensible default profile is created so the seller does not configure each lot
    expect(ack.body.data.profiles).toHaveLength(1);
    expect(ack.body.data.profiles[0]).toMatchObject({ is_default: true, method: 'quote_required', handling_days: 3 });
    expect(await audits('auction_shipping_education_acknowledged', SP.sue)).toHaveLength(1);
  });

  test('lots are Local Pickup until marked eligible (the auction toggle and legacy flag never make a lot ship)', async () => {
    const lot = await call(null, 'GET', '/api/lots/' + L.sue[0]);
    expect(lot.body.data.shipping).toMatchObject({ label: 'local_pickup', label_text: 'Local Pickup', ships: false });
    const s = await call(null, 'GET', '/api/auctions/' + A.sue + '/summary');
    expect(s.body.data.shipping).toMatchObject({ label: 'local_pickup', shipping_lot_count: 0, lot_count: 2 });
  });

  test('marking one lot eligible: that lot ships, the auction is Limited Shipping (never Shipping Available)', async () => {
    const r = await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.sue[0], { shipping_eligible: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ shipping_eligible: true, shipping_quote_required: false });
    expect((await one('SELECT shippable FROM lots WHERE id = $1', [L.sue[0]])).shippable).toBe(true);
    // default profile is quote required → Limited Shipping
    expect((await call(null, 'GET', '/api/lots/' + L.sue[0])).body.data.shipping.label).toBe('limited_shipping');
    // switch the default profile to a flat rate → the lot is Shipping Available
    const pid = r.body.data.shipping_profile_id;
    const up = await call('sue', 'PATCH', '/api/auction-shipping/seller/profiles/' + pid, { method: 'flat_rate', flat_rate_cents: 2500 });
    expect(up.status).toBe(200);
    const lot = (await call(null, 'GET', '/api/lots/' + L.sue[0])).body.data.shipping;
    expect(lot).toMatchObject({ label: 'shipping_available', flat_rate_cents: 2500 });
    const a = (await call(null, 'GET', '/api/auctions/' + A.sue + '/summary')).body.data.shipping;
    expect(a).toMatchObject({ label: 'limited_shipping', shipping_lot_count: 1, lot_count: 2 });
    const list = (await call(null, 'GET', '/api/lots/auction/' + A.sue)).body.data;
    expect(list.map((l) => l.shipping.label).sort()).toEqual(['local_pickup', 'shipping_available']);
    expect(await audits('lot_shipping_updated', L.sue[0])).toHaveLength(1);
  });

  test('every lot eligible at a flat rate: Shipping Available; a restriction makes that lot Limited Shipping', async () => {
    expect((await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.sue[1], { shipping_eligible: true })).status).toBe(200);
    expect((await call(null, 'GET', '/api/auctions/' + A.sue + '/summary')).body.data.shipping.label).toBe('shipping_available');
    expect((await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.sue[1],
      { shipping_eligible: true, shipping_restriction: 'Frame ships without glass' })).status).toBe(200);
    const lot = (await call(null, 'GET', '/api/lots/' + L.sue[1])).body.data.shipping;
    expect(lot.label).toBe('limited_shipping'); expect(lot.restriction).toBe('Frame ships without glass');
    expect((await call(null, 'GET', '/api/auctions/' + A.sue + '/summary')).body.data.shipping.label).toBe('limited_shipping');
  });

  test('profile validation', async () => {
    expect((await call('sue', 'POST', '/api/auction-shipping/seller/profiles', { name: 'Bad', method: 'flat_rate' })).body.code).toBe('INVALID_RATE');
    expect((await call('sue', 'POST', '/api/auction-shipping/seller/profiles', { name: 'Bad', excluded_states: 'ZZ' })).body.code).toBe('INVALID_STATES');
    const ok = await call('sue', 'POST', '/api/auction-shipping/seller/profiles', { name: 'Freight', excluded_states: 'hi, ak' });
    expect(ok.status).toBe(200); expect(ok.body.data).toMatchObject({ excluded_states: ['AK', 'HI'], is_default: false, method: 'quote_required' });
  });

  test('administrator approves an Individual Seller (reason required, audited, non-admins refused)', async () => {
    expect((await call('ian', 'POST', '/api/auction-shipping/admin/sellers/' + SP.ian + '/approve', { reason: 'self approval' })).status).toBe(403);
    expect((await call('admin', 'POST', '/api/auction-shipping/admin/sellers/' + SP.ian + '/approve', {})).body.code).toBe('REASON_REQUIRED');
    const r = await call('admin', 'POST', '/api/auction-shipping/admin/sellers/' + SP.ian + '/approve', { reason: 'Reviewed identity and history' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ eligible: true, needs_acknowledgment: true, approval_reason: 'Reviewed identity and history' });
    const sp = await one('SELECT capabilities, shipping_approved_at, shipping_approved_by FROM seller_profiles WHERE id = $1', [SP.ian]);
    expect(sp.capabilities.shipping_enabled).toBe(true);   // the existing gate, reused
    expect(sp.shipping_approved_by).toBe(U.admin.id); expect(sp.shipping_approved_at).toBeTruthy();
    const a = await audits('auction_shipping_seller_approved', SP.ian);
    expect(a).toHaveLength(1); expect(a[0].actor_id).toBe(U.admin.id);
    expect((await call('ian', 'POST', '/api/auction-shipping/seller/acknowledge', { acknowledged: true })).status).toBe(200);
    expect((await call('ian', 'PUT', '/api/auction-shipping/lots/' + L.ian[0], { shipping_eligible: true })).status).toBe(200);
  });

  test('ownership isolation: a seller cannot read or change another seller\'s settings or lots', async () => {
    const ianProfile = (await call('ian', 'GET', '/api/auction-shipping/seller/profiles')).body.data[0];
    expect((await call('sue', 'PATCH', '/api/auction-shipping/seller/profiles/' + ianProfile.id, { name: 'Taken' })).status).toBe(404);
    expect((await call('sue', 'DELETE', '/api/auction-shipping/seller/profiles/' + ianProfile.id)).status).toBe(404);
    expect((await call('sue', 'GET', '/api/auction-shipping/lots/' + L.ian[0])).status).toBe(404);
    expect((await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.ian[1], { shipping_eligible: true })).status).toBe(404);
    // nor attach another seller's profile to her own lot
    const r = await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.sue[0], { shipping_eligible: true, shipping_profile_id: ianProfile.id });
    expect(r.status).toBe(404); expect(r.body.code).toBe('PROFILE_NOT_FOUND');
    expect((await one('SELECT name FROM seller_shipping_profiles WHERE id = $1', [ianProfile.id])).name).toBe('Standard shipping');
    expect((await one('SELECT shipping_eligible FROM lots WHERE id = $1', [L.ian[1]])).shipping_eligible).toBe(false);
    // the sue profile list never includes ian's
    const mine = (await call('sue', 'GET', '/api/auction-shipping/seller/profiles')).body.data;
    expect(mine.some((p) => p.id === ianProfile.id)).toBe(false);
  });

  test('a profile used by an open shipping lot cannot be removed', async () => {
    const ianProfile = (await call('ian', 'GET', '/api/auction-shipping/seller/profiles')).body.data[0];
    const r = await call('ian', 'DELETE', '/api/auction-shipping/seller/profiles/' + ianProfile.id);
    expect(r.status).toBe(409); expect(r.body.code).toBe('PROFILE_IN_USE');
  });

  test('per-seller limit: admin adjusts it (audited) and buyers see it', async () => {
    expect((await call('admin', 'PUT', '/api/auction-shipping/admin/sellers/' + SP.ian + '/limit', { per_shipment_limit_cents: 120000 })).body.code).toBe('REASON_REQUIRED');
    const r = await call('admin', 'PUT', '/api/auction-shipping/admin/sellers/' + SP.ian + '/limit', { per_shipment_limit_cents: 120000, reason: 'Good track record' });
    expect(r.status).toBe(200); expect(r.body.data.per_shipment_limit_cents).toBe(120000);
    expect((await call('ian', 'GET', '/api/lots/' + L.ian[0])).body.data.shipping.max_item_value_cents).toBe(120000);
    const a = await audits('auction_shipping_limit_changed', SP.ian);
    expect(a).toHaveLength(1); expect(a[0].metadata).toMatchObject({ before: null, after: 120000 });
    await call('admin', 'PUT', '/api/auction-shipping/admin/sellers/' + SP.ian + '/limit', { per_shipment_limit_cents: null, reason: 'Back to the default' });
    expect((await call('ian', 'GET', '/api/lots/' + L.ian[0])).body.data.shipping.max_item_value_cents).toBe(50000);
  });

  test('after bidding starts the seller cannot change shipping; an admin can, with a reason (audited)', async () => {
    await q('UPDATE lots SET bid_count = 1, current_bid_cents = 500 WHERE id = $1', [L.sue[1]]);
    const r = await call('sue', 'PUT', '/api/auction-shipping/lots/' + L.sue[1], { shipping_eligible: false });
    expect(r.status).toBe(409); expect(r.body.code).toBe('LOT_HAS_BIDS');
    expect((await call('admin', 'PUT', '/api/auction-shipping/lots/' + L.sue[1], { shipping_eligible: false })).body.code).toBe('OVERRIDE_REASON_REQUIRED');
    const ok = await call('admin', 'PUT', '/api/auction-shipping/lots/' + L.sue[1], { shipping_eligible: false, override_reason: 'Item found to be hazardous to ship' });
    expect(ok.status).toBe(200); expect(ok.body.data.shipping_eligible).toBe(false);
    const a = await audits('auction_shipping_admin_override', L.sue[1]);
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe(U.admin.id);
    expect(a[0].metadata).toMatchObject({ override_reason: 'Item found to be hazardous to ship', overrides: ['lot_has_bids_or_closed'] });
  });

  test('admin override for a seller who is not eligible is allowed only with a reason, and audited', async () => {
    const prof = await one(`INSERT INTO seller_shipping_profiles (seller_profile_id, name, method, flat_rate_cents, is_default)
      VALUES ($1, 'Admin set', 'flat_rate', 1500, true) RETURNING id`, [SP.nora]);
    expect((await call('admin', 'PUT', '/api/auction-shipping/lots/' + L.nora[0], { shipping_eligible: true })).body.code).toBe('OVERRIDE_REASON_REQUIRED');
    const ok = await call('admin', 'PUT', '/api/auction-shipping/lots/' + L.nora[0], { shipping_eligible: true, override_reason: 'Verification in final review; owner approved' });
    expect(ok.status).toBe(200); expect(ok.body.data.shipping_profile_id).toBe(prof.id);
    const a = await audits('auction_shipping_admin_override', L.nora[0]);
    expect(a).toHaveLength(1); expect(a[0].metadata.overrides).toEqual(['seller_not_eligible:verification_required']);
  });

  test('buyers see the terms again after winning (won lots view)', async () => {
    await q(`UPDATE lots SET state = 'closed', winning_buyer_user_id = $2, winning_amount_cents = 4000, bid_count = 2 WHERE id = $1`, [L.sue[0], U.bea.id]);
    await q('INSERT INTO lot_proxy_bids (lot_id, bidder_user_id, max_amount_cents) VALUES ($1, $2, 4000)', [L.sue[0], U.bea.id]);
    const r = await call('bea', 'GET', '/api/lots/my-bids');
    expect(r.status).toBe(200);
    const won = r.body.data.find((l) => l.id === L.sue[0]);
    expect(won.viewer_is_high_bidder).toBe(true);
    expect(won.shipping).toMatchObject({ label: 'shipping_available', ships: true });
    expect(won.shipping.terms.join(' ')).toContain('Estimated shipping: $25.00.');
  });

  test('revoking an approval returns open lots without bids to Local Pickup (audited)', async () => {
    const r = await call('admin', 'POST', '/api/auction-shipping/admin/sellers/' + SP.ian + '/revoke', { reason: 'Shipping complaints under review' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ eligible: false, lots_returned_to_pickup: 1, open_lots_kept_with_bids: 0 });
    expect((await call('ian', 'GET', '/api/lots/' + L.ian[0])).body.data.shipping.label).toBe('local_pickup');
    expect((await one('SELECT capabilities FROM seller_profiles WHERE id = $1', [SP.ian])).capabilities.shipping_enabled).toBe(false);
    expect(await audits('auction_shipping_seller_revoked', SP.ian)).toHaveLength(1);
    expect((await call('ian', 'PUT', '/api/auction-shipping/lots/' + L.ian[0], { shipping_eligible: true })).status).toBe(403);
  });

  test('database rule: an eligible lot always names its shipping settings', async () => {
    await expect(q('UPDATE lots SET shipping_eligible = true, shipping_profile_id = NULL WHERE id = $1', [L.ivy[1]])).rejects.toThrow(/lots_shipping_eligible_has_profile/);
  });

  test('turning the flag off again hides everything immediately', async () => {
    off();
    expect((await call(null, 'GET', '/api/lots/' + L.sue[1])).body.data).not.toHaveProperty('shipping');
    expect((await call(null, 'GET', '/api/auctions/' + A.sue + '/summary')).body.data).not.toHaveProperty('shipping');
    on();
  });
});
