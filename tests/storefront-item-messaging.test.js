'use strict';

/**
 * Milestone Q — secure item-specific buyer-to-seller messaging (migration 205; roadmap §9; owner requirements 2026-10-16).
 *
 * Real Postgres (PGlite, in memory) running the REAL storefront migrations (through 205), the real messaging, item and
 * notification services and the real routes. Two Professional Sellers — Nora and Sue — two buyers — Bea and Ben — and an
 * administrator with the moderation permission. Every prohibited action must fail and leave nothing behind.
 * Only email, owner alerts and the generic audit log are replaced.
 */

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
jest.mock('../src/services/ownerAlertService', () => ({ notifyAdminActionRequired: jest.fn(async () => {}),
  ALERT_TYPES: { STOREFRONT_MESSAGE_HELD: 'storefront_message_held', STOREFRONT_NOTIFICATION_FAILED: 'storefront_notification_failed',
    STOREFRONT_ITEM_REPORT: 'storefront_item_report', STOREFRONT_MESSAGE_REPORTED: 'storefront_message_reported' } }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
// The real switches are read from the environment on every request (STOREFRONT_MESSAGING_ENABLED / _PILOT_*).
const setFlag = (on) => { process.env.STOREFRONT_MESSAGING_ENABLED = on ? 'true' : ''; };
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: u.id, role: u.role, staff_role: u.staff_role || null };
  return next();
});

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
`;

let items, messaging, notify, mail, server, base;
const U = {}; const SP = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const rejects = async (sql, p) => { try { await global.__PG.query(sql, p || []); } catch (e) { return e; } throw new Error('expected the database to reject: ' + sql); };
async function call(user, method, url, body, xff) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-forwarded-for': xff || '203.0.113.' + (user.length) },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: json };
}

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  for (const f of ['119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql',
    '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql',
    '206_sold_price_privacy_and_message_moderation.sql']) {
    await global.__PG.exec(mig(f));
  }
  await global.__PG.exec(mig('205_storefront_item_messaging.sql'));   // idempotent
  await global.__PG.exec(mig('206_sold_price_privacy_and_message_moderation.sql'));   // idempotent; restores the 206 guard after re-running 205
  for (const [name, role, staff] of [['nora', 'seller'], ['sue', 'seller'], ['bea', 'buyer'], ['ben', 'buyer'], ['admin', 'admin', 'super_admin'], ['priv', 'seller']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role, staff_role) VALUES ($1, $2, $3, $4) RETURNING *`, [name + '@test.example', name.toUpperCase() + ' Person', role, staff || null]);
  }
  global.__USERS = U;
  for (const [name, type, branded] of [['nora', 'estate_sale_company', true], ['sue', 'auction_house', true], ['priv', 'professional_liquidator', false]]) {
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug, show_branding_to_buyers)
      VALUES ($1, $2, $3, '1 Private St', 'Houston', 'TX', '77001', 'US', now(), true, $4, $5) RETURNING id`,
      [U[name].id, type, name === 'nora' ? 'Nora Estate Sales' : name === 'sue' ? 'Sue Auctions' : 'Private Liquidators', name, branded])).id;
  }
  items = require('../src/services/marketplaceItemService');
  messaging = require('../src/services/storefrontMessagingService');
  notify = require('../src/services/storefrontNotificationService');
  mail = require('../src/services/emailService');
  // Hourly per-buyer and per-network limits are exercised in their own test; the other tests send freely.
  messaging.LIMITS.MESSAGES_PER_HOUR_BUYER = 1000; messaging.LIMITS.MESSAGES_PER_HOUR_IP = 1000; messaging.LIMITS.NEW_CONVERSATIONS_PER_DAY = 1000;

  const express = require('express');
  const app = express();
  app.set('trust proxy', 1);   // as in production: the last address is the one the platform proxy appended
  app.use(express.json());
  app.use('/api/storefront-messages', require('../src/routes/storefrontMessages'));
  app.use('/api/admin/storefront', require('../src/routes/adminStorefrontModeration'));
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });
beforeEach(() => { setFlag(true); delete process.env.STOREFRONT_MESSAGING_PILOT_SELLER_IDS; delete process.env.STOREFRONT_MESSAGING_PILOT_USER_IDS; });
afterAll(() => { setFlag(false); });

let seq = 0;
async function item(owner = 'nora', extra = {}) {
  seq++;
  return items.createDirectListing(U[owner].id, { title: 'Walnut sideboard ' + seq, price_cents: 10000, inventory_number: 'HH-' + (1000 + seq),
    thumbnail_url: 'https://img.example/' + seq + '.jpg', ...extra });
}
const ask = (user, itemId, body) => call(user, 'POST', '/api/storefront-messages/items/' + itemId + '/ask', { body });

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('feature switch', () => {
  test('while off, every buyer and seller messaging route answers 404 and nothing is stored', async () => {
    setFlag(false);
    const it = await item();
    const before = await one('SELECT count(*)::int n FROM storefront_messages');
    for (const [u, m, url, b] of [['bea', 'POST', '/api/storefront-messages/items/' + it.id + '/ask', { body: 'Is it solid wood?' }],
      ['bea', 'GET', '/api/storefront-messages/mine'], ['nora', 'GET', '/api/storefront-messages/seller'],
      ['nora', 'POST', '/api/storefront-messages/seller/00000000-0000-4000-8000-000000000001/messages', { body: 'x' }]]) {
      const r = await call(u, m, url, b);
      expect(r.status).toBe(404); expect(r.body.code).toBe('MESSAGING_OFF');
    }
    expect((await one('SELECT count(*)::int n FROM storefront_messages')).n).toBe(before.n);
    const cfg = await call('bea', 'GET', '/api/marketplace/config');
    expect(cfg.body.data.messaging_enabled).toBe(false);
  });
});

describe('controlled activation (pilot): one company, named askers, everyone else off', () => {
  test('with the general switch off, only the listed company and listed askers can use messaging', async () => {
    const noraIt = await item('nora'); const sueIt = await item('sue');
    setFlag(false);
    process.env.STOREFRONT_MESSAGING_PILOT_SELLER_IDS = SP.nora;
    process.env.STOREFRONT_MESSAGING_PILOT_USER_IDS = U.bea.id;
    // listed asker → listed company: works
    const ok = await ask('bea', noraIt.id, 'Pilot question: is the top solid?');
    expect(ok.status).toBe(201);
    // listed asker → a company not in the pilot: off
    const other = await ask('bea', sueIt.id, 'Pilot question to Sue?');
    expect(other.status).toBe(404); expect(other.body.code).toBe('MESSAGING_OFF');
    // an asker not in the list → the pilot company: off
    const ben = await ask('ben', noraIt.id, 'Not in the pilot?');
    expect(ben.status).toBe(404); expect(ben.body.code).toBe('MESSAGING_OFF');
    // the pilot company can read and answer; another company cannot use messaging at all
    expect((await call('nora', 'GET', '/api/storefront-messages/seller')).status).toBe(200);
    expect((await call('nora', 'POST', '/api/storefront-messages/seller/' + ok.body.data.conversation_id + '/messages', { body: 'Yes, solid oak.' })).status).toBe(201);
    expect((await call('sue', 'GET', '/api/storefront-messages/seller')).body.code).toBe('MESSAGING_OFF');
    // the item page offers the button only to a listed asker on a pilot company's item; the public config stays off
    const items = require('../src/services/marketplaceItemService');
    expect((await items.getPublicItem(noraIt.id, undefined, { viewerUserId: U.bea.id })).questions_enabled).toBe(true);
    expect((await items.getPublicItem(noraIt.id, undefined, { viewerUserId: U.ben.id })).questions_enabled).toBe(false);
    expect((await items.getPublicItem(noraIt.id)).questions_enabled).toBe(false);
    expect((await items.getPublicItem(sueIt.id, undefined, { viewerUserId: U.bea.id })).questions_enabled).toBe(false);
    expect((await call('bea', 'GET', '/api/marketplace/config')).body.data.messaging_enabled).toBe(false);
  });
  test('non-pilot conversations cannot be listed, read, withdrawn, appealed or reported (adversarial)', async () => {
    // Conversations created while the general switch was on (as if left over from before the pilot).
    setFlag(true);
    const noraIt = await item('nora'); const sueIt = await item('sue'); const sueIt2 = await item('sue'); const sueIt3 = await item('sue');
    const pilotConv = (await ask('bea', noraIt.id, 'Pilot thread: is the drawer original?')).body.data.conversation_id;
    const pilotReply = (await call('nora', 'POST', '/api/storefront-messages/seller/' + pilotConv + '/messages', { body: 'Yes, all original.' })).body.data.message;
    const benConv = (await ask('ben', noraIt.id, 'Ben asks Nora: any chips?')).body.data.conversation_id;
    const benReply = (await call('nora', 'POST', '/api/storefront-messages/seller/' + benConv + '/messages', { body: 'No chips at all.' })).body.data.message;
    const sueConv = (await ask('bea', sueIt.id, 'Sue thread: what wood is it?')).body.data.conversation_id;
    const sueReply = (await call('sue', 'POST', '/api/storefront-messages/seller/' + sueConv + '/messages', { body: 'It is walnut.' })).body.data.message;
    const beaToSue = (await call('bea', 'GET', '/api/storefront-messages/mine/' + sueConv)).body.data.messages.find((x) => x.from === 'you');
    const heldToSue = (await ask('bea', sueIt2.id, 'I will give you 5% off if you sell it to me in person')).body.data;
    expect(heldToSue.message.status).toBe('held');
    const declinedToSue = (await ask('bea', sueIt3.id, 'I will give you 5% off if you sell it to me in person')).body.data;
    expect((await call('admin', 'POST', '/api/admin/storefront/messages/' + declinedToSue.message.id + '/review', { decision: 'decline', note: 'Please keep the sale on Advantage.Bid.' })).body.data.status).toBe('declined');
    const sueHeld = (await call('sue', 'POST', '/api/storefront-messages/seller/' + sueConv + '/messages', { body: 'Google my business name and call me' })).body.data.message;
    expect(sueHeld.status).toBe('held');

    // Pilot: Nora's company only, Bea the only asker.
    setFlag(false);
    process.env.STOREFRONT_MESSAGING_PILOT_SELLER_IDS = SP.nora;
    process.env.STOREFRONT_MESSAGING_PILOT_USER_IDS = U.bea.id;
    const oa = require('../src/services/ownerAlertService');
    oa.notifyAdminActionRequired.mockClear();
    const snapshot = async () => q(`SELECT id, status, appealed_at, hidden_at FROM storefront_messages WHERE conversation_id = ANY($1::uuid[]) ORDER BY id`,
      [[sueConv, heldToSue.conversation_id, declinedToSue.conversation_id, benConv]]);
    const before = await snapshot();
    const reviewsBefore = (await one('SELECT count(*)::int n FROM storefront_message_reviews')).n;

    // listForBuyer: only the pilot company's thread; getForBuyer: non-pilot threads are "not found"
    const mine = (await call('bea', 'GET', '/api/storefront-messages/mine')).body.data.map((c) => c.id);
    expect(mine).toContain(pilotConv);
    for (const c of [sueConv, heldToSue.conversation_id, declinedToSue.conversation_id]) {
      expect(mine).not.toContain(c);
      expect((await call('bea', 'GET', '/api/storefront-messages/mine/' + c)).status).toBe(404);
    }
    // an asker outside the listed askers cannot see even a pilot company's thread
    expect((await call('ben', 'GET', '/api/storefront-messages/mine')).body.data).toEqual([]);
    expect((await call('ben', 'GET', '/api/storefront-messages/mine/' + benConv)).status).toBe(404);
    // withdraw / appeal / report on a non-pilot company's messages: refused, nothing changes
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + heldToSue.message.id + '/withdraw')).body.code).toBe('MESSAGING_OFF');
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + declinedToSue.message.id + '/appeal', { note: 'Please deliver it after all.' })).body.code).toBe('MESSAGING_OFF');
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + sueReply.id + '/report', { reason: 'Report outside the pilot' })).body.code).toBe('MESSAGING_OFF');
    // the non-pilot company cannot withdraw its own held message or report the buyer's message
    expect((await call('sue', 'POST', '/api/storefront-messages/messages/' + sueHeld.id + '/withdraw')).body.code).toBe('MESSAGING_OFF');
    expect((await call('sue', 'POST', '/api/storefront-messages/messages/' + beaToSue.id + '/report', { reason: 'Seller report outside pilot' })).body.code).toBe('MESSAGING_OFF');
    // a pilot company's message, reported by an asker who is not listed: refused
    expect((await call('ben', 'POST', '/api/storefront-messages/messages/' + benReply.id + '/report', { reason: 'Ben is not in the pilot' })).body.code).toBe('MESSAGING_OFF');
    expect(await snapshot()).toEqual(before);
    expect((await one('SELECT count(*)::int n FROM storefront_message_reviews')).n).toBe(reviewsBefore);
    expect(oa.notifyAdminActionRequired).not.toHaveBeenCalled();

    // positive control: inside the pilot, the listed asker can still read and report the pilot company's reply
    expect((await call('bea', 'GET', '/api/storefront-messages/mine/' + pilotConv)).status).toBe(200);
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + pilotReply.id + '/report', { reason: 'Pilot report works' })).body.data.reported).toBe(true);
    // seller-side positive control: the pilot company is checked as a SELLER (the asker list does not apply to it), so it
    // can report a buyer's message and withdraw its own held message (would fail if these used the buyer side)
    const pilotBuyerMsg = (await call('nora', 'GET', '/api/storefront-messages/seller/' + pilotConv)).body.data.messages.find((x) => x.from === 'buyer');
    expect((await call('nora', 'POST', '/api/storefront-messages/messages/' + pilotBuyerMsg.id + '/report', { reason: 'Seller report in pilot' })).body.data.reported).toBe(true);
    const noraHeld = (await call('nora', 'POST', '/api/storefront-messages/seller/' + pilotConv + '/messages', { body: 'Find our shop on Facebook and call us directly' })).body.data.message;
    expect(noraHeld.status).toBe('held');
    expect((await call('nora', 'POST', '/api/storefront-messages/messages/' + noraHeld.id + '/withdraw')).body.data.status).toBe('withdrawn');
  });
  test('with no pilot company and the switch off, everything is off', async () => {
    setFlag(false);
    const it = await item();
    expect((await ask('bea', it.id, 'Anyone there?')).body.code).toBe('MESSAGING_OFF');
    expect((await call('bea', 'GET', '/api/storefront-messages/mine')).body.code).toBe('MESSAGING_OFF');
  });
});

describe('conversations belong to the item\'s real seller, the asking buyer, and no one else', () => {
  test('a buyer asks; the thread is tied to the item\'s seller (a seller id in the request is ignored) and the seller is notified', async () => {
    const it = await item();
    const r = await call('bea', 'POST', '/api/storefront-messages/items/' + it.id + '/ask', { body: 'Is the finish original?', seller_id: SP.sue });
    expect(r.status).toBe(201);
    expect(r.body.data.message).toMatchObject({ from: 'you', status: 'delivered', body: 'Is the finish original?', delivered_body: 'Is the finish original?' });
    const c = await one('SELECT * FROM storefront_conversations WHERE id = $1', [r.body.data.conversation_id]);
    expect(c.seller_id).toBe(SP.nora); expect(c.buyer_user_id).toBe(U.bea.id);
    expect(c.subject_snapshot).toMatchObject({ title: it.title, inventory_number: it.inventory_number });
    const n = await q(`SELECT n.* FROM storefront_notifications n JOIN storefront_messages m ON m.id = n.message_id WHERE m.conversation_id = $1`, [c.id]);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ event: 'message_to_seller', recipient_email: 'nora@test.example', seller_id: SP.nora, order_id: null, status: 'pending' });
  });

  test('another seller and another buyer can neither list, read nor reply; the thread is unchanged', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Can you send a photo of the back?')).body.data.conversation_id;
    const count = async () => (await one('SELECT count(*)::int n FROM storefront_messages WHERE conversation_id = $1', [conv])).n;
    const before = await count();
    expect((await call('sue', 'GET', '/api/storefront-messages/seller/' + conv)).status).toBe(404);
    expect((await call('sue', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Buy from me instead' })).status).toBe(404);
    expect((await call('sue', 'GET', '/api/storefront-messages/seller')).body.data.map((c) => c.id)).not.toContain(conv);
    expect((await call('ben', 'GET', '/api/storefront-messages/mine/' + conv)).status).toBe(404);
    expect((await call('ben', 'POST', '/api/storefront-messages/mine/' + conv + '/messages', { body: 'hello' })).status).toBe(404);
    expect((await call('ben', 'GET', '/api/storefront-messages/mine')).body.data.map((c) => c.id)).not.toContain(conv);
    // a buyer is not a seller company
    expect((await call('bea', 'GET', '/api/storefront-messages/seller')).status).toBe(403);
    expect((await call('nora', 'GET', '/api/storefront-messages/mine/' + conv)).status).toBe(404);
    expect(await count()).toBe(before);
  });

  test('the seller replies; the buyer sees the reply from the company and is notified', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'What are the dimensions?')).body.data.conversation_id;
    await notify.tick();
    const r = await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'It measures 60 x 20 x 34 inches.' });
    expect(r.status).toBe(201);
    const b = await call('bea', 'GET', '/api/storefront-messages/mine/' + conv);
    expect(b.body.data.seller_name).toBe('Nora Estate Sales');
    expect(b.body.data.messages.map((m) => [m.from, m.body])).toEqual([['you', 'What are the dimensions?'], ['seller', 'It measures 60 x 20 x 34 inches.']]);
    const n = await one(`SELECT * FROM storefront_notifications WHERE message_id = $1`, [r.body.data.message.id]);
    expect(n).toMatchObject({ event: 'message_to_buyer', recipient_email: 'bea@test.example' });
  });

  test('a buyer asking again about the same item continues the same thread', async () => {
    const it = await item();
    const a = (await ask('bea', it.id, 'First question?')).body.data.conversation_id;
    const b = (await ask('bea', it.id, 'Second question?')).body.data.conversation_id;
    expect(b).toBe(a);
  });

  test('items that are not public, and the seller\'s own items, cannot be asked about', async () => {
    const own = await item();
    expect((await ask('nora', own.id, 'own?')).body.code).toBe('OWN_ITEM');
    const draft = await item('nora'); await q(`UPDATE marketplace_items SET status = 'draft' WHERE id = $1`, [draft.id]);
    const removed = await item('nora'); await q(`UPDATE marketplace_items SET status = 'removed' WHERE id = $1`, [removed.id]);
    for (const id of [draft.id, removed.id, '00000000-0000-4000-8000-000000000009', 'not-a-uuid']) {
      expect((await ask('bea', id, 'Hello?')).status).toBe(404);
    }
  });

  test('database: a thread cannot name another seller, a message cannot be written as someone else, and history is permanent', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Does it come apart for moving?')).body.data.conversation_id;
    const m = await one(`SELECT * FROM storefront_messages WHERE conversation_id = $1`, [conv]);
    // a conversation for Nora's item that claims Sue as the seller
    expect((await rejects(`INSERT INTO storefront_conversations (seller_id, item_id, buyer_user_id) VALUES ($1, $2, $3)`, [SP.sue, it.id, U.ben.id])).code).toBe('23503');
    // the seller opening a conversation with their own company
    expect((await rejects(`INSERT INTO storefront_conversations (seller_id, item_id, buyer_user_id) VALUES ($1, $2, $3)`, [SP.nora, it.id, U.nora.id])).code).toBe('23514');
    // Ben writing as Bea's buyer; Sue writing as Nora's company; a message filed under another seller
    expect((await rejects(`INSERT INTO storefront_messages (conversation_id, seller_id, sender_role, sender_user_id, body, delivered_body, status, delivered_at)
      VALUES ($1, $2, 'buyer', $3, 'x', 'x', 'delivered', now())`, [conv, SP.nora, U.ben.id])).code).toBe('23514');
    expect((await rejects(`INSERT INTO storefront_messages (conversation_id, seller_id, sender_role, sender_user_id, body, delivered_body, status, delivered_at)
      VALUES ($1, $2, 'seller', $3, 'x', 'x', 'delivered', now())`, [conv, SP.nora, U.sue.id])).code).toBe('23514');
    expect((await rejects(`INSERT INTO storefront_messages (conversation_id, seller_id, sender_role, sender_user_id, body, delivered_body, status, delivered_at)
      VALUES ($1, $2, 'buyer', $3, 'x', 'x', 'delivered', now())`, [conv, SP.sue, U.bea.id])).code).toBe('23503');
    // words, sender and delivered text never change; nothing is deleted
    for (const sql of [`UPDATE storefront_messages SET body = 'changed' WHERE id = $1`, `UPDATE storefront_messages SET delivered_body = 'changed' WHERE id = $1`,
      `UPDATE storefront_messages SET sender_user_id = '${U.ben.id}' WHERE id = $1`, `UPDATE storefront_messages SET status = 'held' WHERE id = $1`,
      `DELETE FROM storefront_messages WHERE id = $1`]) {
      expect((await rejects(sql, [m.id])).code).toBe('23514');
    }
    for (const sql of [`UPDATE storefront_conversations SET buyer_user_id = '${U.ben.id}' WHERE id = $1`, `UPDATE storefront_conversations SET is_demo = true WHERE id = $1`,
      `UPDATE storefront_conversations SET subject_snapshot = '{}'::jsonb WHERE id = $1`, `DELETE FROM storefront_conversations WHERE id = $1`]) {
      expect((await rejects(sql, [conv])).code).toBe('23514');
    }
    // a message notice can only reference its own seller's message
    expect((await rejects(`INSERT INTO storefront_notifications (seller_id, message_id, event, recipient_email) VALUES ($1, $2, 'message_to_seller', 'x@test.example')`,
      [SP.sue, m.id])).code).toBe('23503');
    expect((await rejects(`INSERT INTO storefront_notifications (seller_id, message_id, order_id, event, recipient_email) VALUES ($1, $2, NULL, 'sale_paid', 'x@test.example')`,
      [SP.nora, m.id])).code).toBe('23514');
  });
});

describe('demo records (testing only)', () => {
  test('a demo item\'s conversation is marked demo by the database and can be cleaned up with its messages, reviews and access log', async () => {
    const it = await item();
    await q(`UPDATE marketplace_items SET is_demo = true WHERE id = $1`, [it.id]);
    const h = (await ask('bea', it.id, 'Can I Venmo you for this?')).body.data;
    await call('admin', 'POST', '/api/admin/storefront/messages/' + h.message.id + '/review', { decision: 'release', note: 'Demo review note.' });
    expect((await one('SELECT is_demo FROM storefront_conversations WHERE id = $1', [h.conversation_id])).is_demo).toBe(true);
    expect((await one('SELECT is_demo FROM storefront_messages WHERE id = $1', [h.message.id])).is_demo).toBe(true);
    await q('DELETE FROM storefront_conversations WHERE id = $1', [h.conversation_id]);
    for (const t of ['storefront_messages', 'storefront_conversation_access_log']) {
      expect((await one(`SELECT count(*)::int n FROM ${t} WHERE conversation_id = $1`, [h.conversation_id])).n).toBe(0);
    }
    expect((await one('SELECT count(*)::int n FROM storefront_message_reviews WHERE message_id = $1', [h.message.id])).n).toBe(0);
  });
});

describe('privacy: neither side sees the other\'s identity or contact details', () => {
  test('the seller sees "Buyer", never the buyer\'s name or email; the buyer never sees the seller\'s account email', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Would this fit through a 30 inch door?')).body.data.conversation_id;
    const s = await call('nora', 'GET', '/api/storefront-messages/seller/' + conv);
    const list = await call('nora', 'GET', '/api/storefront-messages/seller');
    for (const json of [JSON.stringify(s.body), JSON.stringify(list.body)]) {
      expect(json).not.toMatch(/bea@test\.example|BEA Person/);
      expect(json).not.toContain(U.bea.id);
    }
    expect(s.body.data.buyer_label).toMatch(/^Buyer · question [0-9A-F]{8}$/);
    expect(s.body.data.inventory_number).toBe(it.inventory_number);
    const b = await call('bea', 'GET', '/api/storefront-messages/mine/' + conv);
    expect(JSON.stringify(b.body)).not.toMatch(/nora@test\.example|NORA Person|HH-|1 Private St/);
    expect(JSON.stringify(b.body)).not.toContain(U.nora.id);
  });

  test('contact details are hidden from the other party, while the sender sees what they wrote', async () => {
    const it = await item();
    const r = await ask('bea', it.id, 'Is it still available? My cell 713 555 0199 or bea.private@gmail.com');
    expect(r.body.data.message.status).toBe('delivered');
    expect(r.body.data.notice).toMatch(/hid contact details/);
    expect(r.body.data.message.body).toContain('713 555 0199');
    const s = await call('nora', 'GET', '/api/storefront-messages/seller/' + r.body.data.conversation_id);
    const seen = JSON.stringify(s.body);
    expect(seen).not.toMatch(/713|0199|bea\.private|gmail/);
    expect(s.body.data.messages[0].body).toBe('Is it still available? My cell [phone number hidden] or [email hidden]');
  });

  test('a seller whose branding is private appears as "The seller"', async () => {
    const it = await item('priv');
    const conv = (await ask('bea', it.id, 'Is the drawer original?')).body.data.conversation_id;
    const b = await call('bea', 'GET', '/api/storefront-messages/mine/' + conv);
    expect(b.body.data.seller_name).toBe('The seller');
    expect(b.body.data.storefront_slug).toBe(null);
    expect(JSON.stringify(b.body)).not.toMatch(/Private Liquidators/);
  });

  test('notification emails carry the item, the hidden-details excerpt and a reply link — no contact details or identities', async () => {
    await notify.tick(); mail.sendEmail.mockClear();
    const it = await item();
    const r = await ask('bea', it.id, 'Can I pick up Saturday? Text me at 713-555-0144');
    expect(r.body.data.message.status).toBe('held');      // "text" + a number = a request to continue elsewhere
    const r2 = await ask('bea', it.id, 'Can I pick up Saturday? 713-555-0144');
    expect(r2.body.data.message.status).toBe('delivered');
    await notify.tick();
    const sent = mail.sendEmail.mock.calls.map((c) => c[0]).filter((m) => m.subject.includes(it.title));
    expect(sent).toHaveLength(1);
    const all = sent[0].subject + sent[0].html + sent[0].text;
    expect(sent[0].to).toBe('nora@test.example');
    for (const s of [it.title, it.inventory_number, '[phone number hidden]', '/seller-messages.html?c=' + r2.body.data.conversation_id, 'Replies to this email are not delivered']) {
      expect(all).toContain(s);
    }
    expect(all).not.toMatch(/713-555|0144|bea@test|BEA Person/);
    const reply = await call('nora', 'POST', '/api/storefront-messages/seller/' + r2.body.data.conversation_id + '/messages', { body: 'Saturday 10am works for pickup.' });
    expect(reply.status).toBe(201);
    await notify.tick();
    const toBuyer = mail.sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to === 'bea@test.example');
    const allB = toBuyer.subject + toBuyer.html + toBuyer.text;
    expect(allB).toContain('Nora Estate Sales replied about ' + it.title);
    expect(allB).toContain('/my-questions.html?c=');
    expect(allB).not.toMatch(/nora@test|NORA Person|HH-/);
  });
});

describe('anti-circumvention: hidden, held for a person, never punished', () => {
  test('a payment-off-platform message is held: the seller never sees it, nothing is emailed, the sender is told politely', async () => {
    await notify.tick();
    const it = await item();
    const r = await ask('bea', it.id, 'Can I just Venmo you and skip the fee?');
    expect(r.status).toBe(201);
    expect(r.body.data.message).toMatchObject({ status: 'held', can_withdraw: true });
    expect(r.body.data.notice).toMatch(/waiting for a quick review/);
    const conv = r.body.data.conversation_id;
    const s = await call('nora', 'GET', '/api/storefront-messages/seller/' + conv);
    expect(s.body.data.messages).toEqual([]);
    expect(JSON.stringify(s.body)).not.toMatch(/Venmo/i);
    expect((await q(`SELECT n.id FROM storefront_notifications n JOIN storefront_messages m ON m.id = n.message_id WHERE m.conversation_id = $1`, [conv]))).toHaveLength(0);
    const m = await one(`SELECT screening FROM storefront_messages WHERE conversation_id = $1`, [conv]);
    expect(m.screening.hold).toEqual(expect.arrayContaining(['L3.payment_app', 'L4.off_platform']));
  });

  test('review: release delivers it with contact details hidden; decline shows the reason; one appeal; everything is recorded', async () => {
    const it = await item();
    const held = (await ask('bea', it.id, 'Google my business name and call me, or email bea@x.example')).body.data;
    expect(held.message.status).toBe('held');
    // a seller or buyer cannot use the review routes
    expect((await call('nora', 'GET', '/api/admin/storefront/messages')).status).toBe(403);
    expect((await call('bea', 'POST', '/api/admin/storefront/messages/' + held.message.id + '/review', { decision: 'release', note: 'fine by me' })).status).toBe(403);
    const queue = await call('admin', 'GET', '/api/admin/storefront/messages');
    const row = queue.body.data.find((x) => x.id === held.message.id);
    expect(row.delivered_preview).toContain('[email hidden]');
    expect((await one(`SELECT count(*)::int n FROM storefront_conversation_access_log WHERE conversation_id = $1 AND purpose = 'review_queue'`, [held.conversation_id])).n).toBeGreaterThan(0);
    expect((await call('admin', 'POST', '/api/admin/storefront/messages/' + held.message.id + '/review', { decision: 'release' })).body.code).toBe('NOTE_REQUIRED');
    const rel = await call('admin', 'POST', '/api/admin/storefront/messages/' + held.message.id + '/review', { decision: 'release', note: 'Asked for the business name only; released.' });
    expect(rel.body.data.status).toBe('delivered');
    const s = await call('nora', 'GET', '/api/storefront-messages/seller/' + held.conversation_id);
    expect(s.body.data.messages[0].body).toBe('Google my business name and call me, or email [email hidden]');
    expect((await call('admin', 'POST', '/api/admin/storefront/messages/' + held.message.id + '/review', { decision: 'decline', note: 'second decision' })).body.code).toBe('ALREADY_REVIEWED');

    const h2 = (await ask('bea', it.id, 'I will give you 5% off if you sell it to me in person')).body.data;
    const dec = await call('admin', 'POST', '/api/admin/storefront/messages/' + h2.message.id + '/review', { decision: 'decline', note: 'Please arrange the sale through Advantage.Bid.' });
    expect(dec.body.data.status).toBe('declined');
    const mine = await call('bea', 'GET', '/api/storefront-messages/mine/' + h2.conversation_id);
    expect(mine.body.data.messages.find((x) => x.id === h2.message.id)).toMatchObject({ status: 'declined', decline_reason: 'Please arrange the sale through Advantage.Bid.', can_appeal: true });
    expect((await call('nora', 'GET', '/api/storefront-messages/seller/' + h2.conversation_id)).body.data.messages.map((x) => x.id)).not.toContain(h2.message.id);
    // Ben cannot appeal Bea's message; Bea can, once
    expect((await call('ben', 'POST', '/api/storefront-messages/messages/' + h2.message.id + '/appeal', { note: 'please deliver' })).status).toBe(404);
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + h2.message.id + '/appeal', { note: 'I meant pickup in person, paying here.' })).body.data.status).toBe('held');
    await call('admin', 'POST', '/api/admin/storefront/messages/' + h2.message.id + '/review', { decision: 'decline', note: 'Still an off-platform discount.' });
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + h2.message.id + '/appeal', { note: 'again please' })).body.code).toBe('CANNOT_APPEAL');
    const hist = await q(`SELECT action FROM storefront_message_reviews WHERE message_id = $1 ORDER BY created_at, id`, [h2.message.id]);
    expect(hist.map((x) => x.action)).toEqual(['declined', 'appealed', 'declined']);
    expect((await rejects(`UPDATE storefront_message_reviews SET note = 'rewritten' WHERE message_id = $1`, [h2.message.id])).code).toBe('23514');
    expect((await rejects(`DELETE FROM storefront_conversation_access_log WHERE conversation_id = $1`, [held.conversation_id])).code).toBe('23514');
    // no automatic penalty: the buyer's account is untouched and they can keep asking normal questions
    expect((await one('SELECT is_active, role FROM users WHERE id = $1', [U.bea.id]))).toEqual({ is_active: true, role: 'buyer' });
    expect((await ask('bea', it.id, 'Is pickup available on weekdays?')).body.data.message.status).toBe('delivered');
  });

  test('the sender can withdraw a held message and rephrase; nobody else can withdraw it; the record is kept', async () => {
    const it = await item();
    const h = (await ask('bea', it.id, 'Find me on Facebook and message me')).body.data;
    expect((await call('ben', 'POST', '/api/storefront-messages/messages/' + h.message.id + '/withdraw')).status).toBe(404);
    expect((await call('nora', 'POST', '/api/storefront-messages/messages/' + h.message.id + '/withdraw')).status).toBe(404);
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + h.message.id + '/withdraw')).body.data.status).toBe('withdrawn');
    expect((await one('SELECT status, body FROM storefront_messages WHERE id = $1', [h.message.id]))).toEqual({ status: 'withdrawn', body: 'Find me on Facebook and message me' });
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + h.message.id + '/withdraw')).body.code).toBe('NOT_HELD');
    expect((await ask('bea', it.id, 'Could you share more photos here?')).body.data.message.status).toBe('delivered');
  });

  test('a seller reply is screened the same way', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Is the price firm?')).body.data.conversation_id;
    const r = await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Contact our store directly and I will give you a better price.' });
    expect(r.body.data.message.status).toBe('held');
    const b = await call('bea', 'GET', '/api/storefront-messages/mine/' + conv);
    expect(b.body.data.messages.map((x) => x.from)).toEqual(['you']);
    const ok = await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'I can lower the listed price to $90 here on Advantage.Bid.' });
    expect(ok.body.data.message.status).toBe('delivered');
  });
});

describe('abuse controls', () => {
  test('the same words again within minutes return the earlier message (no second row, no second notice)', async () => {
    const it = await item();
    const a = await ask('bea', it.id, 'Is it still available?');
    const b = await ask('bea', it.id, 'Is it still available?');
    expect(b.body.data.duplicate).toBe(true);
    expect(b.body.data.message.id).toBe(a.body.data.message.id);
    expect((await one('SELECT count(*)::int n FROM storefront_messages WHERE conversation_id = $1', [a.body.data.conversation_id])).n).toBe(1);
  });

  test('a busy thread waits for one notice per recipient instead of emailing every message', async () => {
    await notify.tick();
    const it = await item();
    const conv = (await ask('bea', it.id, 'Question one')).body.data.conversation_id;
    await ask('bea', it.id, 'Question two');
    await ask('bea', it.id, 'Question three');
    const pending = await q(`SELECT n.status FROM storefront_notifications n JOIN storefront_messages m ON m.id = n.message_id WHERE m.conversation_id = $1`, [conv]);
    expect(pending).toEqual([{ status: 'pending' }]);
  });

  test('per-conversation, new-conversation and repeated-text limits', async () => {
    const it = await item();
    let conv;
    for (let i = 0; i < messaging.LIMITS.MESSAGES_PER_HOUR_CONVERSATION; i++) {
      const r = await ask('ben', it.id, 'Detail question number ' + i);
      expect(r.status).toBe(201); conv = r.body.data.conversation_id;
    }
    const over = await ask('ben', it.id, 'One more');
    expect(over.status).toBe(429); expect(over.body.code).toBe('TOO_MANY_MESSAGES');
    expect((await one('SELECT count(*)::int n FROM storefront_messages WHERE conversation_id = $1', [conv])).n).toBe(messaging.LIMITS.MESSAGES_PER_HOUR_CONVERSATION);

    // the same text to many sellers' items
    const spam = 'Do you ship to Canada? Great prices here';
    const targets = [];
    for (let i = 0; i < messaging.LIMITS.SAME_TEXT_CONVERSATIONS_PER_HOUR + 1; i++) targets.push(await item(i % 2 ? 'sue' : 'nora'));
    for (let i = 0; i < messaging.LIMITS.SAME_TEXT_CONVERSATIONS_PER_HOUR; i++) expect((await ask('bea', targets[i].id, spam)).status).toBe(201);
    const rep = await ask('bea', targets[messaging.LIMITS.SAME_TEXT_CONVERSATIONS_PER_HOUR].id, spam);
    expect(rep.status).toBe(429); expect(rep.body.code).toBe('REPEATED_MESSAGE');
  }, 60000);

  test('new conversations per day are limited per buyer', async () => {
    const asker = await one(`INSERT INTO users (email, full_name, role) VALUES ('cara@test.example', 'Cara', 'buyer') RETURNING *`);
    U.cara = asker;
    messaging.LIMITS.NEW_CONVERSATIONS_PER_DAY = 10;
    for (let i = 0; i < messaging.LIMITS.NEW_CONVERSATIONS_PER_DAY; i++) {
      const it = await item(i % 2 ? 'sue' : 'nora');
      expect((await ask('cara', it.id, 'Hello, question ' + i)).status).toBe(201);
    }
    const last = await item();
    const r = await ask('cara', last.id, 'One more item question');
    expect(r.status).toBe(429); expect(r.body.code).toBe('TOO_MANY_CONVERSATIONS');
    messaging.LIMITS.NEW_CONVERSATIONS_PER_DAY = 1000;
  }, 60000);

  test('hourly limits per buyer and per network address', async () => {
    const it = await item();
    const saved = { ...messaging.LIMITS };
    try {
      messaging.LIMITS.MESSAGES_PER_HOUR_BUYER = 2;
      const dan = await one(`INSERT INTO users (email, full_name, role) VALUES ('dan@test.example', 'Dan', 'buyer') RETURNING *`); U.dan = dan;
      expect((await ask('dan', it.id, 'First?')).status).toBe(201);
      expect((await ask('dan', it.id, 'Second?')).status).toBe(201);
      expect((await ask('dan', it.id, 'Third?')).body.code).toBe('TOO_MANY_MESSAGES');
      messaging.LIMITS.MESSAGES_PER_HOUR_BUYER = 1000; messaging.LIMITS.MESSAGES_PER_HOUR_IP = 2;
      expect((await ask('dan', it.id, 'Fourth from the same network?')).body.code).toBe('TOO_MANY_MESSAGES');
    } finally { Object.assign(messaging.LIMITS, saved); }
  });

  test('empty and over-long messages are refused', async () => {
    const it = await item();
    expect((await ask('bea', it.id, '   ')).body.code).toBe('MESSAGE_REQUIRED');
    expect((await ask('bea', it.id, 'x'.repeat(2001))).body.code).toBe('MESSAGE_TOO_LONG');
  });
});

describe('review fixes (independent security review 2026-10-26)', () => {
  test('a message delivered while the previous notice is being sent still gets its own notice', async () => {
    await notify.tick();
    const it = await item();
    const a = (await ask('bea', it.id, 'First question about the legs')).body.data;
    await q(`UPDATE storefront_notifications SET status = 'processing', locked_at = now() WHERE message_id = $1`, [a.message.id]);
    const b = (await ask('bea', it.id, 'Second question about the top')).body.data;
    expect((await one(`SELECT count(*)::int n FROM storefront_notifications WHERE message_id = $1`, [b.message.id])).n).toBe(1);
    await q(`UPDATE storefront_notifications SET status = 'pending', locked_at = NULL WHERE message_id = $1`, [a.message.id]);
  });

  test('the network limit uses the address the platform proxy saw; a client cannot rotate it', async () => {
    const it = await item();
    const saved = { ...messaging.LIMITS };
    try {
      messaging.LIMITS.MESSAGES_PER_HOUR_IP = 2;
      const eve = await one(`INSERT INTO users (email, full_name, role) VALUES ('eve@test.example', 'Eve', 'buyer') RETURNING *`); U.eve = eve;
      const send = (n) => call('eve', 'POST', '/api/storefront-messages/items/' + it.id + '/ask', { body: 'Question ' + n }, '10.0.0.' + n + ', 198.51.100.77');
      expect((await send(1)).status).toBe(201);
      expect((await send(2)).status).toBe(201);
      const third = await send(3);
      expect(third.status).toBe(429); expect(third.body.code).toBe('TOO_MANY_MESSAGES');
    } finally { Object.assign(messaging.LIMITS, saved); }
  });

  test('only the sender can withdraw a seller reply waiting for review; another company cannot', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Is the mirror original?')).body.data.conversation_id;
    const r = (await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Pay me directly by Zelle please.' })).body.data;
    expect(r.message.status).toBe('held');
    expect((await call('sue', 'POST', '/api/storefront-messages/messages/' + r.message.id + '/withdraw')).status).toBe(404);
    expect((await call('nora', 'POST', '/api/storefront-messages/messages/' + r.message.id + '/withdraw')).body.data.status).toBe('withdrawn');
  });

  test('database: a decline reason, delivery time and appeal note are written only with their decision', async () => {
    const it = await item();
    const d = (await ask('bea', it.id, 'Cash only if you come by?')).body.data;
    await call('admin', 'POST', '/api/admin/storefront/messages/' + d.message.id + '/review', { decision: 'decline', note: 'Please pay through Advantage.Bid.' });
    expect((await rejects(`UPDATE storefront_messages SET decline_reason = 'rewritten reason' WHERE id = $1`, [d.message.id])).code).toBe('23514');
    expect((await rejects(`UPDATE storefront_messages SET appeal_note = 'sneaky' WHERE id = $1`, [d.message.id])).code).toBe('23514');
    const ok = (await ask('bea', it.id, 'Is the frame solid oak?')).body.data;
    expect((await rejects(`UPDATE storefront_messages SET delivered_at = now() - interval '1 day' WHERE id = $1`, [ok.message.id])).code).toBe('23514');
  });
});

describe('reports and moderator hiding (owner decisions 2026-10-26)', () => {
  test('only the recipient can report a delivered message; once per person; it creates review work, nothing else', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Is the hinge original?')).body.data.conversation_id;
    const rep = (await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Stop wasting my time, idiot.' })).body.data.message;
    expect(rep.status).toBe('delivered');
    // the sender, another buyer and another company cannot report it
    for (const u of ['nora', 'ben', 'sue']) expect((await call(u, 'POST', '/api/storefront-messages/messages/' + rep.id + '/report', { reason: 'Rude reply here' })).status).toBe(404);
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + rep.id + '/report', { reason: '' })).body.code).toBe('REASON_REQUIRED');
    const oa = require('../src/services/ownerAlertService');
    oa.notifyAdminActionRequired.mockClear();
    const r1 = await call('bea', 'POST', '/api/storefront-messages/messages/' + rep.id + '/report', { reason: 'The seller insulted me.' });
    expect(r1.body.data).toEqual({ reported: true, already_reported: false });
    // the admin alert says "reported" (never "held by the safety rules"), is keyed to the message, and carries no message text
    expect(oa.notifyAdminActionRequired).toHaveBeenCalledTimes(1);
    const alert = oa.notifyAdminActionRequired.mock.calls[0][0];
    expect(alert).toMatchObject({ actionType: 'storefront_message_reported', entityType: 'storefront_message', entityId: rep.id, headline: 'Item message reported' });
    expect(JSON.stringify(alert)).not.toMatch(/held by the safety rules|insulted|idiot/i);
    expect((await call('bea', 'POST', '/api/storefront-messages/messages/' + rep.id + '/report', { reason: 'Again, insulted.' })).body.data.already_reported).toBe(true);
    expect(oa.notifyAdminActionRequired).toHaveBeenCalledTimes(1);   // a repeat report sends no second alert
    const q1 = await call('admin', 'GET', '/api/admin/storefront/messages?status=reported');
    const row = q1.body.data.find((x) => x.id === rep.id);
    expect(row.reports).toEqual(['The seller insulted me.']);
    // a report alone changes nothing for anyone
    expect((await one('SELECT hidden_at FROM storefront_messages WHERE id = $1', [rep.id])).hidden_at).toBe(null);
    expect((await call('bea', 'GET', '/api/storefront-messages/mine/' + conv)).body.data.messages.find((x) => x.id === rep.id).body).toBe('Stop wasting my time, idiot.');
  });

  test('a moderator hides an abusive message: the recipient sees a removal note, the sender sees why, the record is kept', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Do you deliver?')).body.data.conversation_id;
    const msg = (await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Abusive words here.' })).body.data.message;
    expect((await call('nora', 'POST', '/api/admin/storefront/messages/' + msg.id + '/hide', { reason: 'Abusive' })).status).toBe(403);
    expect((await call('admin', 'POST', '/api/admin/storefront/messages/' + msg.id + '/hide', {})).body.code).toBe('REASON_REQUIRED');
    const h = await call('admin', 'POST', '/api/admin/storefront/messages/' + msg.id + '/hide', { reason: 'Abusive language toward the buyer.' });
    expect(h.body.data).toEqual({ id: msg.id, hidden: true });
    const b = (await call('bea', 'GET', '/api/storefront-messages/mine/' + conv)).body.data.messages.find((x) => x.id === msg.id);
    expect(b).toEqual({ id: msg.id, from: 'seller', created_at: expect.any(String), hidden: true, body: null });
    const s = (await call('nora', 'GET', '/api/storefront-messages/seller/' + conv)).body.data.messages.find((x) => x.id === msg.id);
    expect(s).toMatchObject({ hidden: true, hidden_reason: 'Abusive language toward the buyer.', body: 'Abusive words here.' });
    expect((await call('admin', 'POST', '/api/admin/storefront/messages/' + msg.id + '/hide', { reason: 'Second time' })).body.code).toBe('ALREADY_HIDDEN');
    expect((await one(`SELECT body FROM storefront_messages WHERE id = $1`, [msg.id])).body).toBe('Abusive words here.');
    expect((await q(`SELECT action FROM storefront_message_reviews WHERE message_id = $1`, [msg.id])).map((x) => x.action)).toEqual(['hidden']);
    // database: never unhidden, rewritten, or hidden without a reason; a held message cannot be "hidden"
    expect((await rejects(`UPDATE storefront_messages SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL WHERE id = $1`, [msg.id])).code).toBe('23514');
    expect((await rejects(`UPDATE storefront_messages SET hidden_reason = 'changed reason' WHERE id = $1`, [msg.id])).code).toBe('23514');
    const held = (await ask('bea', it.id, 'Can I Zelle you?')).body.data.message;
    expect((await call('admin', 'POST', '/api/admin/storefront/messages/' + held.id + '/hide', { reason: 'Not delivered yet' })).body.code).toBe('NOT_DELIVERED');
    const ok = (await ask('bea', it.id, 'Thanks, what about Tuesday?')).body.data.message;
    expect((await rejects(`UPDATE storefront_messages SET hidden_at = now() WHERE id = $1`, [ok.id])).code).toBe('23514');
    // no automatic penalty: both accounts are unchanged
    expect((await one('SELECT is_active FROM users WHERE id = $1', [U.nora.id])).is_active).toBe(true);
  });

  test('reasons and notes are counted in characters like the database: short emoji reasons get a 422, long ones are kept, never a 500', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Is the mirror original?')).body.data.conversation_id;
    const reply = (await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Yes, original glass.' })).body.data.message;
    const short = '\u{1F600}\u{1F600}x';            // 5 UTF-16 code units, but 3 characters (the database minimum is 5)
    const rep = await call('bea', 'POST', '/api/storefront-messages/messages/' + reply.id + '/report', { reason: short });
    expect(rep.status).toBe(422); expect(rep.body.code).toBe('REASON_REQUIRED');
    const hide = await call('admin', 'POST', '/api/admin/storefront/messages/' + reply.id + '/hide', { reason: short });
    expect(hide.status).toBe(422); expect(hide.body.code).toBe('REASON_REQUIRED');
    const it2 = await item();
    const held = (await ask('bea', it2.id, 'Pay me in cash and I will give you 5% off the mirror')).body.data.message;
    expect(held.status).toBe('held');
    const dec = await call('admin', 'POST', '/api/admin/storefront/messages/' + held.id + '/review', { decision: 'decline', note: short });
    expect(dec.status).toBe(422);
    // the longest allowed: 1000 characters of emoji (2000 code units) is accepted; more is cut to 1000 characters
    const long = '\u{1F600}'.repeat(1200);
    const ok = await call('admin', 'POST', '/api/admin/storefront/messages/' + reply.id + '/hide', { reason: long });
    expect(ok.status).toBe(200);
    expect((await one('SELECT length(hidden_reason)::int AS n FROM storefront_messages WHERE id = $1', [reply.id])).n).toBe(1000);
    // five real characters are enough
    expect((await call('admin', 'POST', '/api/admin/storefront/messages/' + held.id + '/review', { decision: 'decline', note: '\u{1F600}\u{1F600}\u{1F600}ab' })).status).toBe(200);
  });

  test('hiding skips a queued, not-yet-sent notice for that message (an email already sent cannot be retracted)', async () => {
    await notify.tick(); mail.sendEmail.mockClear();
    const it = await item();
    const conv = (await ask('ben', it.id, 'Is the drawer pull brass?')).body.data.conversation_id;
    await notify.tick(); mail.sendEmail.mockClear();
    const msg = (await call('nora', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Hateful reply.' })).body.data.message;
    await call('admin', 'POST', '/api/admin/storefront/messages/' + msg.id + '/hide', { reason: 'Hateful content.' });
    await notify.tick();
    expect(mail.sendEmail.mock.calls.filter((c) => c[0].to === 'ben@test.example')).toHaveLength(0);
    expect((await one(`SELECT status, last_error FROM storefront_notifications WHERE message_id = $1`, [msg.id]))).toEqual({ status: 'skipped', last_error: 'message hidden by Advantage.Bid' });
  });

  test('moderators never write as the seller', async () => {
    const it = await item();
    const conv = (await ask('bea', it.id, 'Any chips on the marble?')).body.data.conversation_id;
    const r = await call('admin', 'POST', '/api/storefront-messages/seller/' + conv + '/messages', { body: 'Reply from support pretending to be the seller' });
    expect(r.status).toBe(403);
    expect((await one(`SELECT count(*)::int n FROM storefront_messages WHERE conversation_id = $1 AND sender_role = 'seller'`, [conv])).n).toBe(0);
  });
});

describe('seller permissions', () => {
  test('messages permissions exist for the owner only (staff roles get them only when the owner decides)', () => {
    const rbac = require('../src/lib/sellerRbac');
    expect(rbac.hasSellerPermission({ sellerId: SP.nora, role: 'owner' }, 'company.messages.respond')).toBe(true);
    for (const role of ['inventory_manager', 'fulfillment', 'finance']) {
      expect(rbac.hasSellerPermission({ sellerId: SP.nora, role }, 'company.messages.view')).toBe(false);
    }
  });
});
