'use strict';

/**
 * Item pages and storefronts, for buyers (owner 2026-11-10), on the isolated full-stack environment (never production):
 *   - Share on every item page: Facebook, Pinterest (with the main photo), Email, Copy Link, and the device's own share
 *     sheet where it exists; all with the item's permanent address; social preview tags on the server-rendered page;
 *   - Sold by links to the seller's storefront only when that page is published; otherwise the name is plain text (never a
 *     "not found" page); the seller's published policies stay readable either way;
 *   - Contact Seller always works: a question about THIS item, stored in that seller's inbox with the item, never in
 *     another seller's; the server takes the seller and item from the item id, never from the request;
 *   - the storefront shows its items (photo, title, price, link), View All Items after 12, a friendly empty shop, and a
 *     contact form worded for every kind of Professional Seller.
 */

const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const sj = require('../fullstack/seedJourneys');

jest.setTimeout(300000);

let stack; let browser; const A = {}; const B = {}; const C = {};
const PHOTO = 'https://isolated-photo-store.invalid/item-main.jpg';
const one = async (sql, p) => (await stack.query(sql, p || [])).rows[0];
async function post(p, body) {
  const r = await fetch(stack.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.' + Math.floor(Math.random() * 200 + 1) }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, j };
}
async function blockPhotos(page) { await page.route('https://isolated-photo-store.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) })); }

beforeAll(async () => {
  stack = await startStack();
  await seed.sellerAgreementTemplate(stack);
  // A: published storefront; B: storefront NOT published (items and policies published); C: published, no items
  Object.assign(A, await sj.publishedStorefront(stack, { email: 'share-a@fullstack.test', slug: 'harbor-antiques', name: 'Harbor Antiques' }));
  A.item = await sj.publishedItem(stack, { sellerProfileId: A.sellerProfileId, title: 'Brass Ship Lantern' });
  await stack.query('UPDATE marketplace_items SET images = $2::jsonb WHERE id = $1', [A.item, JSON.stringify([PHOTO])]);
  for (let i = 0; i < 13; i++) await sj.publishedItem(stack, { sellerProfileId: A.sellerProfileId, title: 'Shelf Item ' + (i + 1), inventoryNumber: 'SH-' + i });
  Object.assign(B, await sj.publishedStorefront(stack, { email: 'share-b@fullstack.test', slug: 'quiet-gallery', name: 'Quiet Gallery' }));
  await stack.query('UPDATE seller_profiles SET storefront_published = false WHERE id = $1', [B.sellerProfileId]);
  B.item = await sj.publishedItem(stack, { sellerProfileId: B.sellerProfileId, title: 'Blue Glass Vase', inventoryNumber: 'QG-1' });
  Object.assign(C, await sj.publishedStorefront(stack, { email: 'share-c@fullstack.test', slug: 'empty-shelf', name: 'Empty Shelf Auctions' }));
  A.path = (await (await fetch(stack.baseUrl + '/shop/item/' + A.item, { redirect: 'manual' })).headers.get('location'));
  B.path = (await (await fetch(stack.baseUrl + '/shop/item/' + B.item, { redirect: 'manual' })).headers.get('location'));
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

describe('sharing', () => {
  test('the server-rendered page carries the social preview: title, description, main photo, permanent address', async () => {
    const html = await (await fetch(stack.baseUrl + A.path)).text();
    const meta = (p) => (html.match(new RegExp(`<meta (?:property|name)="${p}" content="([^"]*)"`)) || [])[1];
    expect(A.path).toMatch(/^\/shop\/item\/[0-9a-f-]{36}\/brass-ship-lantern$/);
    expect(meta('og:title')).toBe('Brass Ship Lantern');
    expect(meta('og:url')).toMatch(new RegExp(A.path.replace(/[/]/g, '\\/') + '$'));
    expect(meta('og:image')).toBe(PHOTO);
    expect(meta('og:image:alt')).toBeTruthy();
    expect(meta('og:site_name')).toBe('Advantage.Bid');
    expect(meta('og:description')).toBeTruthy();
    expect(meta('twitter:card')).toBe('summary_large_image');
    expect(meta('twitter:image')).toBe(PHOTO);
    expect(html).not.toMatch(/share-a@fullstack\.test|100 Main St/);   // nothing private
  });
  test('desktop: Facebook, Pinterest with the photo, Email and Copy Link all use the permanent address', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await ctx.newPage(); await blockPhotos(page);
    await page.goto(stack.baseUrl + A.path);
    await page.waitForSelector('#shareBox', { state: 'visible' });
    const url = await page.$eval('link[rel="canonical"]', (l) => l.href);
    expect(url).toMatch(/\/shop\/item\/[0-9a-f-]{36}\/brass-ship-lantern$/);
    const fb = new URL(await page.getAttribute('#shareFacebook', 'href'));
    expect([fb.hostname, fb.searchParams.get('u')]).toEqual(['www.facebook.com', url]);
    const pin = new URL(await page.getAttribute('#sharePinterest', 'href'));
    expect([pin.hostname, pin.searchParams.get('url'), pin.searchParams.get('media'), pin.searchParams.get('description')]).toEqual(['www.pinterest.com', url, PHOTO, 'Brass Ship Lantern']);
    expect(await page.getAttribute('#shareFacebook', 'target')).toBe('_blank');
    const mail = await page.getAttribute('#shareEmail', 'href');
    expect(mail.startsWith('mailto:?')).toBe(true);
    expect(decodeURIComponent(mail)).toContain(url);
    await page.click('#shareCopy');
    await page.waitForFunction(() => document.getElementById('shareMsg').textContent === 'Link copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await ctx.close();
  });
  test('phone: the share box is there, and the device share sheet is offered where the browser has one', async () => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage(); await blockPhotos(page);
    await page.addInitScript(() => { navigator.share = (d) => { window.__shared = d; return Promise.resolve(); }; });
    await page.goto(stack.baseUrl + A.path);
    await page.waitForSelector('#shareNative', { state: 'visible' });
    await page.tap('#shareNative');
    const shared = await page.evaluate(() => window.__shared);
    expect(shared.url).toMatch(/\/shop\/item\/[0-9a-f-]{36}\/brass-ship-lantern$/);
    expect(shared.title).toBe('Brass Ship Lantern');
    expect(await page.isVisible('#sharePinterest')).toBe(true);
    await ctx.close();
  });
});

describe('Sold by and Contact Seller', () => {
  test('published storefront: Sold by opens it', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await blockPhotos(page);
    await page.goto(stack.baseUrl + A.path);
    await page.waitForSelector('#shareBox');
    const href = await page.getAttribute('.meta:has-text("Sold by") a', 'href');
    expect(href).toBe('/pro/harbor-antiques');
    expect((await fetch(stack.baseUrl + '/api/public/storefront/harbor-antiques')).status).toBe(200);
    await ctx.close();
  });
  test('unpublished storefront: Sold by is the plain name (no link to a missing page), policies still open', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await blockPhotos(page);
    await page.goto(stack.baseUrl + B.path);
    await page.waitForSelector('#shareBox');
    expect(await page.textContent('.meta:has-text("Sold by")')).toMatch(/Sold by Quiet Gallery/);
    expect(await page.$$eval('a', (as) => as.map((a) => a.getAttribute('href')).filter((h) => h && /^\/pro\/quiet-gallery(#.*)?$/.test(h)))).toEqual([]);
    // the server-rendered copy agrees, and "More from" offers no link to the unpublished page
    const html = await (await fetch(stack.baseUrl + B.path)).text();
    expect(html).not.toMatch(/href="\/pro\/quiet-gallery"/);
    // published policies remain readable (they are part of the purchase terms)
    for (const p of ['/pro/quiet-gallery/terms', '/pro/quiet-gallery/shipping-pickup']) {
      const r = await fetch(stack.baseUrl + p); const t = await r.text();
      expect([p, r.status]).toEqual([p, 200]);
      expect(t).not.toMatch(/href="\/pro\/quiet-gallery"|#shop/);   // no link to the unpublished storefront page
    }
    await ctx.close();
  });
  for (const [label, opts] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['phone', devices['iPhone 13']]]) {
    test(`${label}: Contact Seller on an unpublished storefront sends a question about this item to that seller only`, async () => {
      const ctx = await browser.newContext(opts); const page = await ctx.newPage(); await blockPhotos(page);
      await page.goto(stack.baseUrl + B.path);
      await page.waitForSelector('#contactBtn', { state: 'visible' });
      await page.click('#contactBtn');
      await page.waitForSelector('#cName', { state: 'visible' });
      await page.click('#cSend');
      expect(await page.textContent('#cErr')).toMatch(/your name/);
      await page.fill('#cName', 'Riley Buyer ' + label);
      await page.fill('#cEmail', `riley-${label}@buyer.test`);
      await page.fill('#cMsg', 'Is the vase chipped anywhere?');
      await page.click('#cSend');
      await page.waitForSelector('#cDoneMsg', { state: 'visible' });
      expect(await page.textContent('#cDoneMsg')).toMatch(/seller will reply/);
      const row = await one(`SELECT seller_id, marketplace_item_id, message FROM seller_inquiries WHERE name = $1`, ['Riley Buyer ' + label]);
      expect(row).toEqual({ seller_id: B.sellerProfileId, marketplace_item_id: B.item, message: 'Is the vase chipped anywhere?' });
      await ctx.close();
    });
  }
  test('the seller sees the item in its own inbox; another seller never does', async () => {
    const bTok = await seed.apiLogin(stack, B.email); const aTok = await seed.apiLogin(stack, A.email);
    const inbox = async (t) => (await (await fetch(stack.baseUrl + '/api/seller-storefront/inquiries', { headers: { Authorization: 'Bearer ' + t } })).json()).data;
    const mine = await inbox(bTok);
    expect(mine.filter((q) => q.item_id === B.item).map((q) => q.item_title)).toEqual(['Blue Glass Vase', 'Blue Glass Vase']);
    expect((await inbox(aTok)).some((q) => q.item_id === B.item)).toBe(false);
  });
  test('the server decides the seller and item; a submitted seller id is ignored; hidden-field bots are dropped quietly', async () => {
    const r = await post(`/api/public/storefront/item/${A.item}/inquiry`, { name: 'Sam', email: 'sam@buyer.test', message: 'Price firm?', seller_id: B.sellerProfileId, marketplace_item_id: B.item });
    expect(r.status).toBe(201);
    expect(await one(`SELECT seller_id, marketplace_item_id FROM seller_inquiries WHERE name = 'Sam'`)).toEqual({ seller_id: A.sellerProfileId, marketplace_item_id: A.item });
    const bot = await post(`/api/public/storefront/item/${A.item}/inquiry`, { name: 'Bot', email: 'bot@x.test', message: 'spam', company_website: 'http://spam.test' });
    expect(bot.status).toBe(201);
    expect(await one(`SELECT count(*)::int n FROM seller_inquiries WHERE name = 'Bot'`)).toEqual({ n: 0 });
    expect((await post(`/api/public/storefront/item/${A.item}/inquiry`, { name: 'No Contact', message: 'hi' })).status).toBe(400);
    expect((await post('/api/public/storefront/item/00000000-0000-4000-8000-000000000000/inquiry', { name: 'X', email: 'x@y.test', message: 'hi' })).status).toBe(404);
  });
});

describe('public storefront shop and contact form', () => {
  test('items with photo, title and price, each linking to its page; View All Items after the first 12', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await blockPhotos(page);
    await page.goto(stack.baseUrl + '/pro/harbor-antiques');
    await page.waitForSelector('#shopGrid');
    const visible = await page.$$eval('#shopGrid a.card', (as) => as.filter((a) => a.offsetParent !== null).length);
    expect(visible).toBe(12);
    expect(await page.textContent('#viewAllItems')).toBe('View All Items (14)');
    const first = await page.$eval('#shopGrid a.card', (a) => ({ href: a.getAttribute('href'), text: a.textContent }));
    expect(first.href).toMatch(/^\/shop\/item\/[0-9a-f-]{36}\//);
    expect(first.text).toMatch(/\$/);
    await page.click('#viewAllItems');
    expect(await page.$$eval('#shopGrid a.card', (as) => as.filter((a) => a.offsetParent !== null).length)).toBe(14);
    expect(await page.$('#viewAllItems')).toBeNull();
    await ctx.close();
  });
  test('a storefront with nothing for sale says so kindly', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(stack.baseUrl + '/pro/empty-shelf');
    await page.waitForSelector('#shop');
    expect(await page.textContent('#shop')).toMatch(/No items for sale right now[\s\S]*Follow Empty Shelf Auctions/);
    await ctx.close();
  });
  test('the contact form fits every kind of business, and still reaches only that seller', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await blockPhotos(page);
    await page.goto(stack.baseUrl + '/pro/harbor-antiques');
    await page.waitForSelector('#inqForm');
    const form = await page.textContent('#inqForm');
    expect(form).toMatch(/What can we help you with\?/);
    expect(form).not.toMatch(/Estate sale, appraisal/);
    expect(await page.getAttribute('#i-service', 'placeholder')).not.toMatch(/estate|appraisal/i);
    await page.fill('#i-name', 'Morgan Shopper');
    await page.fill('#i-email', 'morgan@buyer.test');
    await page.fill('#i-service', 'A painting I saw');
    await page.fill('#i-message', 'Do you have more by this artist?');
    await page.click('#inqForm button[type="submit"]');
    await page.waitForFunction(() => /sent/.test(document.getElementById('inqMsg').textContent));
    expect(await one(`SELECT seller_id, marketplace_item_id, service FROM seller_inquiries WHERE name = 'Morgan Shopper'`))
      .toEqual({ seller_id: A.sellerProfileId, marketplace_item_id: null, service: 'A painting I saw' });
    await ctx.close();
  });
});
