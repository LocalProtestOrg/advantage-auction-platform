'use strict';

/**
 * Professional Seller website widget ("My Website Widget", roadmap 7.5 basic release).
 *
 * Real Postgres (PGlite) with the real storefront migrations, item/order/page services and routes (same harness as
 * storefront-sold-price-privacy.test.js). Covers seller isolation, automatic inventory sync, sold-price privacy, canonical
 * item SEO (product page, structured data, sitemap, crawlable storefront links), embed headers, the owner panel and the
 * Marketplace Integrity Suite check.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-storefront-widget'; // test value, never a real secret

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

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
// Public item page viewer: the REAL token verification (sessionAuth) runs on a real signed token; only the server-side
// session-state lookup is replaced, so each state can be tested (default 'ok'; global.__SESSION_STATE[userId] overrides).
jest.mock('../src/lib/sessionTokens', () => ({
  ...jest.requireActual('../src/lib/sessionTokens'),
  checkSession: jest.fn(async (decoded) => {
    const s = (global.__SESSION_STATE || {})[decoded && decoded.id];
    if (s === 'throw') throw new Error('session lookup failed');
    return { state: s || 'ok', role: decoded && decoded.role };
  }),
}));
// Management routes: the test names the signed-in user with a header (the real middleware is covered by the session tests).
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: u.id, role: u.role, staff_role: u.staff_role || null };
  return next();
});

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
CREATE UNIQUE INDEX uq_payment_disputes_stripe_dispute ON payment_disputes (stripe_dispute_id);
`;

let orders, items, widget, storefront, pages, pdata, server, base;
const U = {};      // users by name
const SP = {};     // seller profile ids
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];

const tokenFor = (user) => require('jsonwebtoken').sign({ id: U[user].id, role: U[user].role }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function call(user, method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) { headers['x-test-user'] = user; headers.authorization = 'Bearer ' + tokenFor(user); }
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, headers: r.headers, body: json };
}
const anon = (url) => call(null, 'GET', url);
const feed = (sellerId) => anon('/api/public/storefront/widget/' + sellerId);

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
  await global.__PG.exec(mig('197_storefront_order_integrity.sql'));
  await global.__PG.exec(mig('198_storefront_moderation_reports.sql'));

  for (const [name, role] of [['nora', 'seller'], ['sue', 'seller'], ['ivy', 'seller'], ['dan', 'seller'], ['bea', 'buyer']]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3) RETURNING *`, [name + '@test.example', name.toUpperCase(), role]);
  }
  global.__USERS = U;
  // nora + sue: published Professional storefronts; ivy: an Individual Seller (never a storefront); dan: Professional, unpublished
  for (const [name, type, published, display] of [['nora', 'estate_sale_company', true, 'Nora "Fine" & Co $&'], ['sue', 'auction_house', true, 'Sue Auctions'],
    ['ivy', 'private', true, 'Ivy Household'], ['dan', 'professional_liquidator', false, 'Dan Liquidators']]) {
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug)
      VALUES ($1, $2, $3, $4, 'Houston', 'TX', '77001', 'US', now(), $5, $6) RETURNING id`,
      [U[name].id, type, display, '1 ' + name + ' Private St', published, name])).id;
  }

  orders = require('../src/services/marketplaceOrderService');
  items = require('../src/services/marketplaceItemService');
  widget = require('../src/services/storefrontWidgetService');
  storefront = require('../src/services/storefrontService');
  pages = require('../src/services/productPageService');
  pdata = require('../src/lib/productData');

  const express = require('express');
  const app = express();
  app.use(require('helmet')({ contentSecurityPolicy: false }));
  app.use(require('../src/middleware/widgetFraming'));
  app.use(express.json());
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  app.use('/api/seller-storefront', require('../src/routes/sellerStorefront'));
  app.use('/api/public/storefront', require('../src/routes/publicStorefront'));
  app.use(express.static(path.join(ROOT, 'public')));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

const IMG = 'https://res.example.com/item-photo.jpg';
async function listing(owner, extra = {}) {
  return items.createDirectListing(U[owner].id, { title: 'Walnut chest ' + Math.random().toString(36).slice(2, 7), price_cents: 12500,
    images: [IMG], ...extra });
}
async function beaBuys(item) {
  const created = await orders.createOrder(item.id, U.bea.id, { policiesAcknowledged: true });
  const paid = await orders.payOrder(created.order.id, U.bea.id, { paymentMethodId: 'pm_bea' });
  expect(paid.status).toBe('succeeded');
  return created.order;
}
// Every key anywhere in a JSON value (to prove private fields never appear).
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

describe('one widget per seller, bound to that seller on the server', () => {
  test('each seller\'s widget lists only that seller\'s items; nothing private is returned', async () => {
    const n1 = await listing('nora', { title: 'Nora oak table' });
    const s1 = await listing('sue', { title: 'Sue brass lamp' });
    const nora = await feed(SP.nora); const sue = await feed(SP.sue);
    expect(nora.status).toBe(200); expect(sue.status).toBe(200);
    const noraIds = nora.body.data.items.map((x) => x.id); const sueIds = sue.body.data.items.map((x) => x.id);
    expect(noraIds).toContain(n1.id); expect(noraIds).not.toContain(s1.id);
    expect(sueIds).toContain(s1.id); expect(sueIds).not.toContain(n1.id);
    // only the requested seller's items, by the database's own ownership
    const owners = await q(`SELECT DISTINCT seller_id FROM marketplace_items WHERE id = ANY($1::uuid[])`, [noraIds]);
    expect(owners.map((r) => r.seller_id)).toEqual([SP.nora]);
    // an allow-list: no ids of people or companies, no address, no inventory or order data
    const keys = [...allKeys(nora.body)];
    for (const bad of ['seller_id', 'user_id', 'owner_user_id', 'buyer_user_id', 'email', 'phone', 'pickup_address_line1', 'pickup_postal_code',
      'default_pickup_address_line1', 'zip', 'postal_code', 'inventory_number', 'order_id', 'source_lot_id', 'moderation_status', 'is_demo']) {
      expect(keys).not.toContain(bad);
    }
    expect(JSON.stringify(nora.body)).not.toMatch(/Private St|77001|@test\.example/);
    expect(nora.body.data.seller).toEqual({ name: 'Nora "Fine" & Co $&', storefront_url: storefront.APP_BASE + '/pro/nora' });
    expect(nora.body.data.attribution).toMatchObject({ label: 'Shop securely on Advantage.Bid', url: storefront.APP_BASE + '/pro/nora' });
  });

  test('unknown, malformed, unpublished and non-Professional sellers have no widget', async () => {
    expect((await feed('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await feed('not-a-uuid')).status).toBe(404);
    expect((await feed("x' OR '1'='1")).status).toBe(404);
    await listing('dan'); // Professional but unpublished
    const dan = await feed(SP.dan);
    expect(dan.status).toBe(404); expect(dan.body.code).toBe('WIDGET_NOT_AVAILABLE');
    expect((await feed(SP.ivy)).status).toBe(404);   // Individual Seller: storefronts and widgets are Professional only
    // a seller id supplied any other way is ignored: the path decides, and only that seller's items return
    const r = await anon('/api/public/storefront/widget/' + SP.nora + '?seller_id=' + SP.sue + '&seller=' + SP.sue);
    expect(r.body.data.items.every((x) => !x.title.startsWith('Sue'))).toBe(true);
  });

  test('the widget never reads a session: a signed-in member gets exactly the public answer', async () => {
    const pub = await feed(SP.nora);
    const member = await call('bea', 'GET', '/api/public/storefront/widget/' + SP.nora);
    expect(member.body).toEqual(pub.body);
    expect(member.headers.get('set-cookie')).toBe(null);
    expect(pub.headers.get('cache-control')).toBe('no-cache');
  });
});

describe('inventory stays in sync automatically (no copies)', () => {
  test('publish, edit, sell, pending checkout, remove: the widget always shows the live state', async () => {
    const it = await listing('nora', { title: 'Sync cabinet', price_cents: 4000 });
    let ids = (await feed(SP.nora)).body.data.items;
    expect(ids.find((x) => x.id === it.id)).toMatchObject({ title: 'Sync cabinet', price_cents: 4000, image: IMG });
    // edit title and price
    await items.updateItem(it.id, U.nora.id, { title: 'Sync cabinet, restored', price_cents: 4500 });
    const edited = (await feed(SP.nora)).body.data.items.find((x) => x.id === it.id);
    expect(edited).toMatchObject({ title: 'Sync cabinet, restored', price_cents: 4500 });
    expect(edited.url).toBe(pdata.canonicalUrl(require('../src/lib/publicUrls').publicBaseUrl(), { id: it.id, title: 'Sync cabinet, restored' }));
    // a checkout in progress is not offered
    const pend = await listing('nora', { title: 'Pending mirror' });
    await orders.createOrder(pend.id, U.bea.id, { policiesAcknowledged: true });
    ids = (await feed(SP.nora)).body.data.items.map((x) => x.id);
    expect(ids).not.toContain(pend.id);
    // sold: gone from the widget at once, and its price appears nowhere in the widget
    const sold = await listing('nora', { title: 'Sold armoire', price_cents: 98765 });
    await beaBuys(sold);
    const after = await feed(SP.nora);
    expect(after.body.data.items.map((x) => x.id)).not.toContain(sold.id);
    expect(JSON.stringify(after.body)).not.toMatch(/98765|987\.65/);
    // removed (unpublished): gone
    await items.updateItem(it.id, U.nora.id, { status: 'removed' });
    expect((await feed(SP.nora)).body.data.items.map((x) => x.id)).not.toContain(it.id);
    // the widget, the storefront page's list and the canonical live-item count always agree
    const w = (await feed(SP.nora)).body.data;
    const pageList = await items.listPublicForSeller(SP.nora, 100);
    const canonical = (await one(`SELECT count(*)::int n FROM marketplace_items m WHERE m.seller_id = $1 AND ${require('../src/lib/marketplaceVisibility').activeMarketplaceItemSql('m')}`, [SP.nora])).n;
    expect(w.count).toBe(pageList.length); expect(w.items.length).toBe(canonical);
  });

  test('a sold item whose seller lets members see its price still shows no price anywhere public', async () => {
    const it = await listing('nora', { title: 'Member price chest', price_cents: 55511 });
    await beaBuys(it);
    await items.updateItem(it.id, U.nora.id, { show_realized_price_to_members: true });
    const member = await call('bea', 'GET', '/api/public/storefront/widget/' + SP.nora);
    expect(JSON.stringify(member.body)).not.toMatch(/55511|555\.11/);
    const meta = await storefront.ssrMeta('nora');
    expect(JSON.stringify(meta)).not.toMatch(/55511/);
    expect(storefront.ssrItemsHtml(meta)).not.toMatch(/555\.11|55511/);
    const sm = await pages.sitemapEntries();
    expect(sm.items.map((x) => x.path)).not.toContain(pdata.canonicalPath(it));
  });
});

describe('review fixes: hidden Shop section, demo items, the "widget" slug, storefront page caching', () => {
  test('a seller who hid the Shop section shows no items in the widget (same as the storefront page)', async () => {
    await listing('sue', { title: 'Sue hidden-shop item' });
    expect((await feed(SP.sue)).body.data.items.length).toBeGreaterThan(0);
    await q(`UPDATE seller_profiles SET storefront = jsonb_set(COALESCE(storefront, '{}'::jsonb), '{section_visibility}', '{"marketplace": false}'::jsonb) WHERE id = $1`, [SP.sue]);
    const r = await feed(SP.sue);
    expect(r.status).toBe(200); expect(r.body.data.items).toEqual([]);
    const panel = (await call('sue', 'GET', '/api/seller-storefront/widget')).body.data;
    expect(panel).toMatchObject({ shop_hidden: true, item_count: 0 });
    expect((await storefront.ssrMeta('sue')).items).toEqual([]);
    await q(`UPDATE seller_profiles SET storefront = storefront - 'section_visibility' WHERE id = $1`, [SP.sue]);
    expect((await feed(SP.sue)).body.data.items.length).toBeGreaterThan(0);
  });

  test('a demo-flagged item on a real seller is left out (the canonical live-item rule)', async () => {
    const it = await listing('nora', { title: 'Leftover demo item' });
    await q('UPDATE marketplace_items SET is_demo = true WHERE id = $1', [it.id]);
    expect((await feed(SP.nora)).body.data.items.map((x) => x.id)).not.toContain(it.id);
    await q("UPDATE marketplace_items SET status = 'removed' WHERE id = $1", [it.id]);
  });

  test('a storefront whose slug is "widget" still serves its policies route', async () => {
    const r = await anon('/api/public/storefront/widget/policies');
    expect(r.body.code).not.toBe('WIDGET_NOT_AVAILABLE');   // not caught by the widget route
  });

  test('the storefront page (which now lists prices) is revalidated on every view', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const route = server.slice(server.indexOf("app.get('/pro/:slug', async"), server.indexOf("app.get('/pro/:slug/:page'"));
    expect(route).toMatch(/res\.set\('Cache-Control', 'no-cache'\)/);
  });
});

describe('item SEO lives on the canonical Advantage.Bid product page, not in the frame', () => {
  test('widget links = canonical URL; the page is crawlable HTML with canonical, Product data, image, seller; listed in the sitemap', async () => {
    const it = await listing('nora', { title: 'Georgian silver teapot', price_cents: 32000, description: 'A Georgian silver teapot, hallmarked, circa 1790.' });
    const pub = require('../src/lib/publicUrls').publicBaseUrl();
    const w = (await feed(SP.nora)).body.data.items.find((x) => x.id === it.id);
    expect(w.url).toBe(pdata.canonicalUrl(pub, it));
    expect(w.url).toMatch(/\/shop\/item\/[0-9a-f-]{36}\/georgian-silver-teapot$/);
    const page = await pages.render(it.id, pdata.slugify(it.title), pub);
    expect(page.status).toBe(200);
    expect(page.html).toContain(`<link rel="canonical" href="${w.url}">`);
    expect(page.html).toMatch(/<title>[^<]*Georgian silver teapot[^<]*<\/title>/);
    expect(page.html).toMatch(/<meta name="description" content="[^"]*Georgian silver teapot/);
    expect(page.html).toContain('<h1>Georgian silver teapot</h1>');           // real HTML content, not script-only
    expect(page.html).not.toMatch(/noindex/);
    const ld = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const product = ld.find((x) => x['@type'] === 'Product');
    expect(product).toMatchObject({ name: 'Georgian silver teapot', url: w.url });
    expect(product.image).toEqual(expect.arrayContaining([IMG]));
    expect(product.offers).toMatchObject({ price: '320.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' });
    expect(product.offers.seller).toMatchObject({ '@type': 'Organization', name: 'Nora "Fine" & Co $&' });
    expect(ld.find((x) => x['@type'] === 'BreadcrumbList')).toBeTruthy();
    // a different spelling of the slug redirects to the one canonical URL (no duplicate pages)
    expect(await pages.render(it.id, 'some-other-slug', pub)).toMatchObject({ status: 301, redirect: pdata.canonicalPath(it) });
    // sitemap: the item and the storefront are listed; the embed page never is
    const sm = await pages.sitemapEntries();
    expect(sm.items.map((x) => x.path)).toContain(pdata.canonicalPath(it));
    expect(sm.storefronts.map((x) => x.path)).toContain('/pro/nora');
    expect(JSON.stringify(sm)).not.toMatch(/embed/);
  });

  test('the storefront page carries crawlable links to every item (no script needed), escaped', async () => {
    const it = await listing('nora', { title: 'Tea caddy <script>alert(1)</script> $\' & co', price_cents: 1999 });
    const meta = await storefront.ssrMeta('nora');
    const html = storefront.ssrItemsHtml(meta);
    expect(html).toContain(`<a href="${pdata.canonicalPath(it)}">`);
    expect(html).toContain('Tea caddy &lt;script&gt;alert(1)&lt;/script&gt; $&#39; &amp; co</a> $19.99');
    expect(html).not.toMatch(/<script/);
    expect(html).toContain('Shop Nora &quot;Fine&quot; &amp; Co $&amp;');
    // every active item has a link; the template places the list inside the app container the script replaces
    const live = await items.listPublicForSeller(SP.nora, 100);
    for (const m of live) expect(html).toContain(`href="${pdata.canonicalPath(m)}"`);
    const tpl = fs.readFileSync(path.join(ROOT, 'public', 'storefront.html'), 'utf8');
    expect(tpl).toMatch(/<div id="app"[^>]*>[\s\S]*<!-- SSR-ITEMS -->[\s\S]*<\/div>\s*<div id="toast"/);
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(server).toMatch(/\.replace\('<!-- SSR-ITEMS -->', \(\) => itemsHtml\)/);
    // an unpublished storefront gets nothing
    expect(await storefront.ssrMeta('dan')).toBe(null);
  });
});

describe('embedding: the frame is embeddable and noindex; the rest of the site is not', () => {
  test('embed page headers and markup', async () => {
    const r = await fetch(base + '/embed/storefront.html?seller=' + SP.nora);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-frame-options')).toBe(null);
    expect(r.headers.get('content-security-policy')).toBe('frame-ancestors *');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    const html = await r.text();
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain("fetch('/api/public/storefront/widget/'+encodeURIComponent(SELLER),{credentials:'omit'})");
    expect(html).toMatch(/target="_blank" rel="noopener"/);
    expect(html).toContain('Shop securely on Advantage.Bid');
    expect(html).not.toMatch(/<form|\/api\/marketplace\/|paymentIntent|localStorage|Authorization/i);   // no checkout or session code
    expect(html).not.toMatch(/[–—]|&mdash;|&ndash;/);
    expect(html).not.toMatch(/\bA\.?I\b|artificial intelligence/i);
    // every value placed into the page goes through esc(); links only http(s)
    expect(html).toMatch(/href="'\+esc\(safeUrl\(it\.url\)\)\+'"/);
    expect(html).toMatch(/src="'\+esc\(it\.image\)\+'"/);
  });

  test('seller and other pages keep their frame protection', async () => {
    const r = await fetch(base + '/seller-storefront.html');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('x-robots-tag')).toBe(null);
    const api = await fetch(base + '/api/public/storefront/widget/' + SP.nora);
    expect(api.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
});

describe('My Website Widget panel (owner only, automatic)', () => {
  test('each owner gets their own embed code and link; nobody gets another company\'s', async () => {
    const r = await call('nora', 'GET', '/api/seller-storefront/widget');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({ eligible: true, active: true, published: true, seller_id: SP.nora,
      storefront_url: storefront.APP_BASE + '/pro/nora', embed_url: storefront.APP_BASE + '/embed/storefront.html?seller=' + SP.nora });
    expect(d.item_count).toBe((await feed(SP.nora)).body.data.count);
    // the snippet: an iframe to this seller's embed, with escaped title, plus a plain link to the canonical storefront
    expect(d.embed_code).toContain(`<iframe src="${storefront.APP_BASE}/embed/storefront.html?seller=${SP.nora}"`);
    expect(d.embed_code).toContain('title="Nora &quot;Fine&quot; &amp; Co $&amp; shop on Advantage.Bid"');
    expect(d.embed_code).toContain(`<a href="${storefront.APP_BASE}/pro/nora">Shop Nora &quot;Fine&quot; &amp; Co $&amp; on Advantage.Bid</a>`);
    expect(d.embed_code).not.toMatch(/<script/i);
    expect(d.embed_code).not.toContain(SP.sue);
    const sue = (await call('sue', 'GET', '/api/seller-storefront/widget')).body.data;
    expect(sue.seller_id).toBe(SP.sue); expect(sue.embed_code).not.toContain(SP.nora);
    // a seller id in the request is ignored (the company comes from the session)
    expect((await call('sue', 'GET', '/api/seller-storefront/widget?seller_id=' + SP.nora)).body.data.seller_id).toBe(SP.sue);
    // a buyer has no panel; signed out is refused
    expect([403, 404]).toContain((await call('bea', 'GET', '/api/seller-storefront/widget')).status);
    expect((await anon('/api/seller-storefront/widget')).status).toBe(401);
  });

  test('unpublished Professional: code ready but not active; Individual Seller: not eligible, no code', async () => {
    const dan = (await call('dan', 'GET', '/api/seller-storefront/widget')).body.data;
    expect(dan).toMatchObject({ eligible: true, active: false, published: false, item_count: 0 });
    expect(dan.embed_code).toContain('seller=' + SP.dan);
    const ivy = (await call('ivy', 'GET', '/api/seller-storefront/widget')).body.data;
    expect(ivy).toMatchObject({ eligible: false, active: false, embed_code: null });
  });

  test('the dashboard tab: owner only (hidden from staff), copy buttons, install steps, no banned wording', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'seller-storefront.html'), 'utf8');
    expect(html).toContain('<button id="t-widget" onclick="tab(\'widget\')">My Website Widget</button>');
    expect(html).toContain('>Copy Embed Code</button>');
    expect(html).toContain('>Copy Storefront Link</button>');
    expect(html).toMatch(/\['t-store','t-leads','t-widget','pane-store','pane-leads','pane-widget','loc-card'\]/);
    expect(html).toMatch(/api\('GET','\/api\/seller-storefront\/widget'\)/);
    const pane = html.slice(html.indexOf('<div id="pane-widget"'), html.indexOf('<script>'));
    expect(pane).toMatch(/WordPress[\s\S]*Squarespace[\s\S]*Wix[\s\S]*Brilliant Directories/);
    expect(pane).not.toMatch(/[–—]|\bA\.?I\b|artificial intelligence|cloudinary|railway/i);
  });
});

describe('Marketplace Integrity Suite: the widget is held to the canonical count', () => {
  const { verify } = require('../src/services/marketplaceIntegrity');
  const sampleDb = (row) => ({ query: async (sql) => {
    if (/FROM seller_profiles sp/.test(sql) && /storefront_published = true/.test(sql)) return { rows: row ? [row] : [] };
    if (/FROM events e/.test(sql)) return { rows: [{ kind: 'auction', n: 0, n_coord: 0 }] };
    if (/FROM organizations o/.test(sql)) return { rows: [] };
    return { rows: [{ n: 0 }] };
  } });
  const fetchWith = (data) => async (url) => (url.includes('/api/public/storefront/widget/')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) }
    : { ok: false, status: 404, text: async () => 'nf' });
  const it = (n) => Array.from({ length: n }, (_, i) => ({ id: 'i' + i, url: 'https://bid.example/shop/item/x' + i + '/t' }));
  const find = (r, s) => r.checks.find((c) => c.surface === s);

  test('matching count and canonical links pass', async () => {
    const r = await verify({ db: sampleDb({ id: 's1', n: 3 }), baseUrl: 'https://bid.example', fetchImpl: fetchWith({ items: it(3) }) });
    expect(find(r, 'widget:storefront-items').status).toBe('PASS');
    expect(find(r, 'widget:canonical-links').status).toBe('PASS');
  });
  test('a leaked extra item, a missing item, or a non-canonical link fails', async () => {
    expect(find(await verify({ db: sampleDb({ id: 's1', n: 3 }), baseUrl: 'https://bid.example', fetchImpl: fetchWith({ items: it(4) }) }), 'widget:storefront-items').status).toBe('FAIL');
    expect(find(await verify({ db: sampleDb({ id: 's1', n: 3 }), baseUrl: 'https://bid.example', fetchImpl: fetchWith({ items: it(2) }) }), 'widget:storefront-items').status).toBe('FAIL');
    const bad = it(3); bad[1].url = 'https://elsewhere.example/item';
    expect(find(await verify({ db: sampleDb({ id: 's1', n: 3 }), baseUrl: 'https://bid.example', fetchImpl: fetchWith({ items: bad }) }), 'widget:canonical-links').status).toBe('FAIL');
  });
  test('no published storefront: nothing to compare', async () => {
    const r = await verify({ db: sampleDb(null), baseUrl: 'https://bid.example', fetchImpl: fetchWith({ items: [] }) });
    expect(find(r, 'widget:storefront-items')).toBeUndefined();
  });
});
