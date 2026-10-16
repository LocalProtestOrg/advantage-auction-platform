'use strict';

/**
 * Professional Storefront product SEO foundation (permanent roadmap §4.1–4.3, required tests §4.5).
 *
 * Real Postgres (PGlite) with the real storefront migrations (incl. 200), the real item service, the real product-page
 * service and the real item.html template. Two Professional Sellers (Nora, Sue) and one private seller (Pat).
 * Checks: published product data equals the database; price and availability follow the item; sold, reserved, removed
 * and taken-down items are never advertised as available; seller attribution is the item's real seller; draft, private,
 * demo and moderated listings never reach the sitemap or structured data; no buyer's premium in any storefront price;
 * one canonical URL and one product record per item; no private address, buyer or order data in public output.
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

const ROOT = path.join(__dirname, '..');
const mig = (f) => fs.readFileSync(path.join(ROOT, 'db', 'migrations', f), 'utf8');
const BASE_URL = 'https://bid.advantage.bid';
const BASE = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, full_name text, role text DEFAULT 'buyer', is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text, display_name text,
  platform_fee_bps int, metadata jsonb DEFAULT '{}'::jsonb, is_demo boolean DEFAULT false, show_branding_to_buyers boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid REFERENCES seller_profiles(id), title text, city text, address_state text,
  street_address text, zip text, state text, end_time timestamptz, is_demo boolean DEFAULT false, buyer_premium_bps int);
CREATE TABLE seller_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, buyer_premium_pct numeric, superseded_at timestamptz);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid REFERENCES auctions(id), title text, state text, winning_buyer_user_id uuid);
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, buyer_user_id uuid, status text);
CREATE TABLE seller_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid);
CREATE TABLE payment_disputes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stripe_dispute_id text NOT NULL, status text NOT NULL, closed_at timestamptz);
`;

let items; let pages; let productData;
const U = {}; const SP = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const jsonlds = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const product = (html) => jsonlds(html).find((j) => j['@type'] === 'Product');

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  for (const f of ['119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
    '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
    '198_storefront_moderation_reports.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql']) await global.__PG.exec(mig(f));
  await global.__PG.exec(mig('200_storefront_product_data.sql'));   // idempotent
  for (const [name, type, demo] of [['nora', 'estate_sale_company'], ['sue', 'auction_house'], ['pat', 'private'], ['demo', 'auction_house', true]]) {
    U[name] = await one(`INSERT INTO users (email, full_name, role) VALUES ($1, $2, 'seller') RETURNING *`, [name + '@test.example', name.toUpperCase()]);
    SP[name] = (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, is_demo, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug)
      VALUES ($1, $2, $3, $4, $5, 'Houston', 'TX', '77001', 'US', now(), true, $6) RETURNING id`,
      [U[name].id, type, name === 'nora' ? 'Nora Estate Sales' : name === 'sue' ? 'Sue Auctions' : name + ' co', !!demo, '1 ' + name + ' Secret St', name])).id;
  }
  // Nora's AUCTION premium is high — it must never touch a storefront price.
  await q(`INSERT INTO seller_terms (seller_profile_id, buyer_premium_pct) VALUES ($1, 25)`, [SP.nora]);
  items = require('../src/services/marketplaceItemService');
  pages = require('../src/services/productPageService');
  productData = require('../src/lib/productData');
}, 60000);
afterAll(async () => { if (global.__PG) await global.__PG.close(); });

const add = (who, extra = {}) => items.createDirectListing(U[who].id, { title: 'Walnut Side Table', price_cents: 45000, description: 'Solid walnut, c. 1950.',
  images: ['https://img.example/a.jpg', 'https://img.example/b.jpg'], ...extra });
const page = async (it, slug) => pages.render(it.id, slug === undefined ? productData.slugify(it.title) : slug, BASE_URL);

describe('product page: data equals the database', () => {
  test('server-rendered title, canonical, Product + Offer from the item; price is the item price only (no buyer\'s premium)', async () => {
    const it = await add('nora', { condition: 'Excellent', condition_type: 'used', era_or_period: 'Mid-century', material: 'Walnut',
      image_alt: ['Front view of the walnut side table'] });
    const r = await page(it);
    expect(r.status).toBe(200);
    const canonical = `${BASE_URL}/shop/item/${it.id}/walnut-side-table`;
    expect(r.html).toContain(`<link rel="canonical" href="${canonical}">`);
    expect(r.html).toContain('<title>Walnut Side Table | Nora Estate Sales | Advantage.Bid</title>');
    expect((r.html.match(/<title>/g) || []).length).toBe(1);
    expect(r.html).toContain('<h1>Walnut Side Table</h1>');
    expect(r.html).toContain('alt="Front view of the walnut side table"');
    expect(r.html).toContain('alt="Walnut Side Table - photo 2"');
    const p = product(r.html);
    expect(p).toMatchObject({ name: 'Walnut Side Table', url: canonical, sku: it.id, material: 'Walnut', itemCondition: 'https://schema.org/UsedCondition',
      image: ['https://img.example/a.jpg', 'https://img.example/b.jpg'],
      offers: { price: '450.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: canonical,
        seller: { '@type': 'Organization', name: 'Nora Estate Sales', url: `${BASE_URL}/pro/nora` } } });
    expect(jsonlds(r.html).filter((j) => j['@type'] === 'Product')).toHaveLength(1);
    expect(jsonlds(r.html).find((j) => j['@type'] === 'BreadcrumbList')).toBeTruthy();
    // a later price change is reflected immediately
    await items.updateItem(it.id, U.nora.id, { price_cents: 39900 });
    expect(product((await page(it)).html).offers.price).toBe('399.00');
  });
  test('antiques and one-of-a-kind items: no brand, GTIN or MPN is published unless the seller entered it; invalid barcodes are refused', async () => {
    const antique = await add('nora', { title: 'Georgian Silver Teapot' });
    const p = product((await page(antique)).html);
    expect(p.brand).toBeUndefined(); expect(p.gtin).toBeUndefined(); expect(p.mpn).toBeUndefined();
    expect(productData.identifierExists(antique)).toBe(false);
    await expect(add('nora', { title: 'Bad code', gtin: '036000291453' })).rejects.toMatchObject({ code: 'GTIN_INVALID' });
    const branded = await add('nora', { title: 'Eames Lounge Chair', brand: 'Herman Miller', mpn: 'ES670', gtin: '036000291452' });
    const b = product((await page(branded)).html);
    expect(b).toMatchObject({ brand: { '@type': 'Brand', name: 'Herman Miller' }, gtin: '036000291452', mpn: 'ES670' });
    expect(productData.identifierExists(branded)).toBe(true);
    expect(productData.validGtin('4006381333931')).toBe(true);   // EAN-13
    expect(productData.validGtin('96385074')).toBe(true);        // GTIN-8
    expect(productData.validGtin('4006381333932')).toBe(false);
  });
});

describe('availability is never overstated', () => {
  test('in checkout → out of stock; sold → sold out (still reachable, not in the sitemap); hidden → 404 + noindex', async () => {
    const it = await add('nora', { title: 'Brass Floor Lamp' });
    await q(`UPDATE marketplace_items SET status = 'pending_purchase' WHERE id = $1`, [it.id]);
    expect(product((await page(it)).html).offers.availability).toBe('https://schema.org/OutOfStock');
    await q(`UPDATE marketplace_items SET status = 'sold' WHERE id = $1`, [it.id]);
    const sold = await page(it);
    expect(sold.status).toBe(200);
    expect(product(sold.html).offers.availability).toBe('https://schema.org/SoldOut');
    expect((await pages.sitemapEntries()).items.map((e) => e.path)).not.toContain(productData.canonicalPath(it));
    for (const st of ['draft', 'removed']) {
      await q(`UPDATE marketplace_items SET status = $2 WHERE id = $1`, [it.id, st]);
      const r = await page(it);
      expect(r.status).toBe(404); expect(r.html).toContain('<meta name="robots" content="noindex">');
      expect(product(r.html)).toBeUndefined();
      expect(await pages.canonicalPathFor(it.id)).toBeNull();
    }
  });
  test('a taken-down listing is never public, in the sitemap or in structured data', async () => {
    const it = await add('nora', { title: 'Taken Down Vase' });
    expect((await pages.sitemapEntries()).items.map((e) => e.path)).toContain(productData.canonicalPath(it));
    await q(`UPDATE marketplace_items SET status = 'removed', moderation_status = 'taken_down', moderation_reason = 'test takedown' WHERE id = $1`, [it.id]);
    expect((await page(it)).status).toBe(404);
    expect((await pages.sitemapEntries()).items.map((e) => e.path)).not.toContain(productData.canonicalPath(it));
  });
});

describe('who and what is listed', () => {
  test('a private (non-Professional) seller\'s item has no product page and is not in the sitemap', async () => {
    const row = await one(`INSERT INTO marketplace_items (seller_id, title, price_cents, status) VALUES ($1, 'Pat chair', 1000, 'active') RETURNING *`, [SP.pat]);
    expect((await page(row)).status).toBe(404);
    expect((await pages.sitemapEntries()).items.map((e) => e.path)).not.toContain(productData.canonicalPath(row));
    expect((await pages.sitemapEntries()).storefronts.map((e) => e.path)).not.toContain('/pro/pat');
  });
  test('demo items render but are noindex and never in the sitemap; demo storefronts are not listed', async () => {
    const it = await add('demo', { title: 'Demo Clock' });
    const r = await page(it);
    expect(r.status).toBe(200); expect(r.html).toContain('<meta name="robots" content="noindex">');
    const sm = await pages.sitemapEntries();
    expect(sm.items.map((e) => e.path)).not.toContain(productData.canonicalPath(it));
    expect(sm.storefronts.map((e) => e.path)).toEqual(expect.arrayContaining(['/pro/nora', '/pro/sue']));
    expect(sm.storefronts.map((e) => e.path)).not.toContain('/pro/demo');
  });
  test('attribution is always the item\'s real seller; "more from this seller" lists only that seller\'s live items', async () => {
    const sueIt = await add('sue', { title: 'Sue Mirror' });
    await add('sue', { title: 'Sue Rug' });
    const r = await page(sueIt);
    expect(product(r.html).offers.seller.name).toBe('Sue Auctions');
    expect(r.html).toContain('More from Sue Auctions');
    expect(r.html).toContain('Sue Rug');
    expect(r.html).not.toMatch(/Nora Estate Sales|Walnut Side Table/);
  });
  test('a seller whose branding is hidden is not named: the offer is from Advantage.Bid', async () => {
    await q('UPDATE seller_profiles SET show_branding_to_buyers = false WHERE id = $1', [SP.sue]);
    try {
      const it = await add('sue', { title: 'Unbranded Bowl' });
      const r = await page(it);
      expect(product(r.html).offers.seller).toEqual({ '@type': 'Organization', name: 'Advantage.Bid' });
      expect(r.html).not.toMatch(/Sue Auctions|\/pro\/sue/);
    } finally { await q('UPDATE seller_profiles SET show_branding_to_buyers = true WHERE id = $1', [SP.sue]); }
  });
});

describe('one canonical URL per item; no private data in public output', () => {
  test('any other slug (or a changed title) 301s to the one canonical URL; the id is authoritative', async () => {
    const it = await add('nora', { title: 'Oak Bench' });
    expect(await page(it, 'cheap-stuff')).toEqual({ status: 301, redirect: `/shop/item/${it.id}/oak-bench` });
    expect(await page(it, null)).toEqual({ status: 301, redirect: `/shop/item/${it.id}/oak-bench` });
    await items.updateItem(it.id, U.nora.id, { title: 'Antique Oak Bench' });
    expect((await page(it, 'oak-bench')).redirect).toBe(`/shop/item/${it.id}/antique-oak-bench`);
    expect(await pages.canonicalPathFor(it.id)).toBe(`/shop/item/${it.id}/antique-oak-bench`);
    expect((await pages.render('not-a-uuid', 'x', BASE_URL)).status).toBe(404);
  });
  test('no street address, ZIP, seller or user ids, buyer or order data appear in the page or sitemap', async () => {
    const it = await add('nora', { title: 'Private Check Desk' });
    const r = await page(it);
    const forbidden = [/Secret St/, /77001/, new RegExp(SP.nora), new RegExp(U.nora.id), /nora@test/, /pickup_address/, /seller_proceeds|platform_fee/, /MO-\d/];
    for (const f of forbidden) expect(r.html).not.toMatch(f);
    const sm = JSON.stringify(await pages.sitemapEntries());
    for (const f of forbidden) expect(sm).not.toMatch(f);
  });
  test("'$' sequences in seller text are shown literally and never corrupt the page", async () => {
    const it = await add('nora', { title: "Rare $' and $` and $& Records ($'90s)", description: "Priced at $'50 $1 $$" });
    const r = await page(it);
    expect(r.status).toBe(200);
    expect(r.html).toContain("Rare $&#39; and $` and $&amp; Records ($&#39;90s)");
    expect((r.html.match(/<script src="https:\/\/js\.stripe\.com\/v3\/"><\/script>/g) || []).length).toBe(1);
    expect((r.html.match(/<body>/g) || []).length).toBe(1);
    expect(product(r.html).name).toBe("Rare $' and $` and $& Records ($'90s)");
  });
  test('the item page template carries no browser-built product record (the server renders exactly one)', () => {
    const tpl = fs.readFileSync(path.join(ROOT, 'public', 'item.html'), 'utf8');
    expect(tpl).not.toMatch(/'@type':'Product'/);
    for (const m of ['<!-- SSR-META -->', '<!-- SSR-JSONLD -->', '<!-- SSR-BODY:START -->', '<!-- SSR-BODY:END -->', '<!-- SSR-MORE -->']) expect(tpl).toContain(m);
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(server).toMatch(/app\.get\(\['\/shop\/item\/:id', '\/shop\/item\/:id\/:slug'\]/);
    expect(server).toMatch(/app\.get\('\/item\.html'/);
    expect(server.indexOf("app.get('/item.html'")).toBeLessThan(server.indexOf('express.static(path.join(__dirname, \'public\'))'));
    expect(server).toMatch(/productPageService'\)\.sitemapEntries\(\)/);
    // storefront links go straight to the canonical URL
    expect(fs.readFileSync(path.join(ROOT, 'public', 'storefront.html'), 'utf8')).toMatch(/href="'\+esc\(itemUrl\(m\)\)\+'"/);
  });
  test('the browser and server slugs agree', () => {
    const sf = fs.readFileSync(path.join(ROOT, 'public', 'storefront.html'), 'utf8');
    const src = sf.slice(sf.indexOf('function itemSlug'), sf.indexOf('function itemUrl'));
    // eslint-disable-next-line no-new-func
    const itemSlug = new Function(src + '; return itemSlug;')();
    for (const t of ['Walnut Side Table', 'Café & Bistro Chairs (Set of 4)', '  ', 'Ünïcödé — 1920s Art Déco Lamp!!', 'x'.repeat(200)]) {
      expect(itemSlug(t)).toBe(productData.slugify(t));
    }
  });
});

describe('editing product details on existing listings', () => {
  test('a seller adds, changes and clears product details on an existing item; the page follows the database', async () => {
    const it = await add('nora', { title: 'Carved Oak Chest' });
    expect(product((await page(it)).html).brand).toBeUndefined();
    await items.updateItem(it.id, U.nora.id, { condition_type: 'used', era_or_period: 'Victorian', brand: 'Gillows', material: 'Oak',
      image_alt: ['Front of the carved oak chest', 'Detail of the carving'] });
    let r = await page(it); let p = product(r.html);
    expect(p).toMatchObject({ brand: { name: 'Gillows' }, material: 'Oak', itemCondition: 'https://schema.org/UsedCondition' });
    expect(p.additionalProperty).toEqual(expect.arrayContaining([{ '@type': 'PropertyValue', name: 'Era or period', value: 'Victorian' }]));
    expect(r.html).toContain('alt="Detail of the carving"');
    const row = await one('SELECT brand, era_or_period, image_alt FROM marketplace_items WHERE id = $1', [it.id]);
    expect(row).toEqual({ brand: 'Gillows', era_or_period: 'Victorian', image_alt: ['Front of the carved oak chest', 'Detail of the carving'] });
    // clearing a field (empty text) removes it everywhere — nothing is kept or guessed
    await items.updateItem(it.id, U.nora.id, { brand: '', condition_type: '' });
    p = product((await page(it)).html);
    expect(p.brand).toBeUndefined(); expect(p.itemCondition).toBeUndefined();
    expect(await one('SELECT brand, condition_type FROM marketplace_items WHERE id = $1', [it.id])).toEqual({ brand: null, condition_type: null });
  });
  test('an invalid barcode on an existing item is refused and nothing changes; only the fields sent are changed', async () => {
    const it = await add('nora', { title: 'Pressed Glass Bowl', brand: 'Fenton', material: 'Glass' });
    await expect(items.updateItem(it.id, U.nora.id, { gtin: '012345678901', title: 'Renamed' })).rejects.toMatchObject({ code: 'GTIN_INVALID' });
    expect(await one('SELECT title, gtin, brand FROM marketplace_items WHERE id = $1', [it.id])).toEqual({ title: 'Pressed Glass Bowl', gtin: null, brand: 'Fenton' });
    await items.updateItem(it.id, U.nora.id, { mpn: 'FB-12' });
    expect(await one('SELECT brand, material, mpn FROM marketplace_items WHERE id = $1', [it.id])).toEqual({ brand: 'Fenton', material: 'Glass', mpn: 'FB-12' });
  });
  test("a sold item's details stay as they were at the sale; another seller cannot edit the details", async () => {
    const it = await add('nora', { title: 'Sold Clock', brand: 'Seth Thomas' });
    await expect(items.updateItem(it.id, U.sue.id, { brand: 'Fake Brand' })).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await q(`UPDATE marketplace_items SET status = 'sold' WHERE id = $1`, [it.id]);
    await expect(items.updateItem(it.id, U.nora.id, { brand: 'Changed' })).rejects.toMatchObject({ code: 'ITEM_SOLD' });
    expect((await one('SELECT brand FROM marketplace_items WHERE id = $1', [it.id])).brand).toBe('Seth Thomas');
  });
  test('the seller page offers editing for existing items (not sold or in checkout) and its script is valid', () => {
    const h = fs.readFileSync(path.join(ROOT, 'public', 'seller-storefront.html'), 'utf8');
    expect(h).toMatch(/function editDetails\(id\)/);
    expect(h).toMatch(/var editable=m\.status!=='sold'&&m\.status!=='pending_purchase';/);
    for (const k of ['condition_type', 'era_or_period', 'brand', 'manufacturer', 'material', 'mpn', 'gtin', 'image_alt']) expect(h).toContain(k + ':');
    for (const s of [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) {
      // eslint-disable-next-line no-new-func
      expect(() => new Function(s)).not.toThrow();
    }
  });
});
