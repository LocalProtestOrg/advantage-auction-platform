'use strict';

/**
 * /shop — the Advantage.Bid fixed-price marketplace (owner request 2026-11-04: products discoverable and indexable from one
 * marketplace page), as SERVED by the real app in a real browser on the isolated full-stack environment (never production).
 * Lists exactly the canonical public items (active, not demo, Professional Sellers, not demo sellers), links each to its
 * canonical product page and its seller's storefront, filters by category, paginates, carries valid structured data, is in
 * the sitemap with its category pages, and is reachable from the shared header.
 */

const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const sj = require('../fullstack/seedJourneys');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(240000);
let stack; let browser;
const A = {};
const ALLOW = { allowConsoleErrors: [/net::ERR_FAILED/] };

beforeAll(async () => {
  stack = await startStack();
  await seed.sellerAgreementTemplate(stack);
  Object.assign(A, await sj.publishedStorefront(stack, { email: 'shop-a@fullstack.test', slug: 'harbor-antiques', name: 'Harbor Antiques' }));
  const item = (title, key, label, extra = '') => stack.query(
    `INSERT INTO marketplace_items (seller_id, title, description, category, category_key, category_status, condition, price_cents, status, city, state, zip, pickup_location_source${extra ? ', is_demo' : ''})
     VALUES ($1, $2, 'Described.', $3, $4, 'assigned', 'Good', 12500, 'active', 'Houston', 'TX', '77002', 'default'${extra ? ', true' : ''}) RETURNING id`,
    [A.sellerProfileId, title, label, key]).then((r) => r.rows[0].id);
  A.lamp = await item('Brass Banker Lamp', 'lighting', 'Lighting');
  A.desk = await item('Walnut Partners Desk', 'furniture', 'Furniture');
  A.chair = await item('Pair of Bergere Chairs', 'furniture', 'Furniture');
  A.demo = await item('Demo Only Vase', 'ceramics_glass', 'Ceramics & Glass', 'demo');
  A.draft = await item('Unfinished Draft Rug', 'rugs_textiles', 'Rugs & Textiles');
  await stack.query(`UPDATE marketplace_items SET status = 'draft' WHERE id = $1`, [A.draft]);
  // a demo seller's item never appears, even if the item itself is not flagged
  const d = await sj.publishedStorefront(stack, { email: 'demo-shop@fullstack.test', slug: 'demo-shop', name: 'Demo Shop' });
  await stack.query('UPDATE seller_profiles SET is_demo = true WHERE id = $1', [d.sellerProfileId]);
  A.demoSellerItem = await sj.publishedItem(stack, { sellerProfileId: d.sellerProfileId, title: 'Demo Seller Teapot' });
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

test('lists exactly the public items, each linked to its canonical product page and the seller storefront', async () => {
  const j = await (await fetch(stack.baseUrl + '/api/public/shop/items')).json();
  expect(j.pagination.total).toBe(3);
  expect(j.data.map((x) => x.title).sort()).toEqual(['Brass Banker Lamp', 'Pair of Bergere Chairs', 'Walnut Partners Desk']);
  for (const it of j.data) {
    expect(it.url).toMatch(new RegExp('/shop/item/' + it.id + '/[a-z0-9-]+$'));
    expect(it.seller).toEqual({ name: 'Harbor Antiques', storefront_url: expect.stringMatching(/\/pro\/harbor-antiques$/) });
    expect(Object.keys(it)).not.toEqual(expect.arrayContaining(['zip', 'pickup_address_line1', 'seller_id']));
  }
  expect(j.categories).toEqual([{ key: 'furniture', label: 'Furniture', count: 2 }, { key: 'lighting', label: 'Lighting', count: 1 }]);
  const furniture = await (await fetch(stack.baseUrl + '/api/public/shop/items?category=furniture')).json();
  expect(furniture.data.map((x) => x.title).sort()).toEqual(['Pair of Bergere Chairs', 'Walnut Partners Desk']);
  // an unknown category is ignored (never an error, never an empty trap)
  expect((await (await fetch(stack.baseUrl + '/api/public/shop/items?category=nope')).json()).pagination.total).toBe(3);
});

test.each([['desktop', {}], ['phone', devices['iPhone 13']], ['small phone (360px)', devices['Galaxy S8']]])('%s: the page renders cleanly with the shared header, and items open', async (label, ctxOpts) => {
  const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  const probe = health.attach(page, { origin: stack.baseUrl });
  await page.goto(stack.baseUrl + '/shop', { waitUntil: 'networkidle' });
  const issues = await health.inspect(page, probe, { ...ALLOW, expectText: ['Shop Antiques, Art, Vintage and Home Decor', 'Brass Banker Lamp', 'Harbor Antiques'] });
  expect(issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')).toEqual([]);
  expect(await page.textContent('body')).not.toMatch(/Demo Only Vase|Unfinished Draft Rug|Demo Seller Teapot/);
  expect(await page.locator('header a[href="/shop"]').count()).toBeGreaterThan(0);   // the shared header links here
  await Promise.all([page.waitForURL(/\/shop\/item\//), page.click('a.ci:has-text("Walnut Partners Desk")')]);
  expect(await page.textContent('h1')).toMatch(/Walnut Partners Desk/);
  await ctx.close();
});

test('search engines: canonical, indexable, valid structured data; category pages; sitemap', async () => {
  const html = await (await fetch(stack.baseUrl + '/shop')).text();
  expect(html).toMatch(/<link rel="canonical" href="[^"]*\/shop">/);
  expect(html).toMatch(/<meta name="robots" content="index,follow">/);
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const types = ld['@graph'].map((g) => g['@type']);
  expect(types).toEqual(['CollectionPage', 'BreadcrumbList', 'ItemList']);
  expect(ld['@graph'][2]).toMatchObject({ numberOfItems: 3 });
  expect(ld['@graph'][2].itemListElement.every((x) => /\/shop\/item\//.test(x.url))).toBe(true);
  const cat = await (await fetch(stack.baseUrl + '/shop?category=furniture')).text();
  expect(cat).toMatch(/<h1>Furniture for Sale<\/h1>/);
  expect(cat).toMatch(/<link rel="canonical" href="[^"]*\/shop\?category=furniture">/);
  const empty = await (await fetch(stack.baseUrl + '/shop?category=coins_currency')).text();
  expect(empty).toMatch(/<meta name="robots" content="noindex,follow">/);   // an empty category is not indexed
  const map = await (await fetch(stack.baseUrl + '/sitemap.xml')).text();
  for (const p of ['/shop</loc>', '/shop?category=furniture</loc>', '/shop?category=lighting</loc>', '/professional-sellers.html</loc>']) expect(map).toContain(p);
  expect(map).not.toContain('category=ceramics_glass');   // only categories with public items
});

test('pages of 24 with crawlable numbered links', async () => {
  for (let i = 0; i < 25; i++) await sj.publishedItem(stack, { sellerProfileId: A.sellerProfileId, title: 'Bulk Item ' + i, inventoryNumber: 'B-' + i });
  const p1 = await (await fetch(stack.baseUrl + '/shop')).text();
  expect((p1.match(/<li class="c">/g) || []).length).toBe(24);
  expect(p1).toMatch(/<link rel="next" href="[^"]*\/shop\?page=2">/);
  const p2 = await (await fetch(stack.baseUrl + '/shop?page=2')).text();
  expect((p2.match(/<li class="c">/g) || []).length).toBe(28 - 24);
  expect(p2).toMatch(/<link rel="canonical" href="[^"]*\/shop\?page=2">/);
  expect(p2).toMatch(/<title>Shop Antiques, Art, Vintage and Home Decor \(Page 2\) \| Advantage\.Bid<\/title>/);
});
