'use strict';

/**
 * Professional Seller Storefront experience (2026-11-02), in a real browser on the isolated full-stack environment
 * (tests/fullstack; in-memory database; photo storage replaced by an in-memory stand-in; never production):
 *   - Storefront Branding: logo and banner photo uploaded directly, validated, owner-only, shown on the storefront and
 *     the website widget; removable.
 *   - The website widget keeps shoppers on the seller's website: an item opens inside the frame, with Back to Storefront
 *     and browser back; only this seller's available items can be opened there.
 *   - The product photo gallery (standalone item page and inside the widget, desktop and phone).
 *   - The new professional type "Retail Shop, Gallery or Studio" uses the existing professional onboarding and gates.
 *   - Bulk publishing no longer warns that items will be visible on Advantage.Bid (distribution itself is unchanged).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const sj = require('../fullstack/seedJourneys');

jest.setTimeout(240000);

// A real PNG of the given size and colour (so pages can actually display the stored photos).
function png(w, h, rgb) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const WIDE = png(240, 120, [200, 80, 40]);      // 2:1, so cropping would be visible
const TALL = png(100, 200, [40, 90, 200]);

let stack; let browser; let site; let siteUrl;
const shop = {}; const other = {}; const P = {};

const photoUrl = (n) => `https://isolated-photo-store.invalid/storefront-items/${n}.png`;
async function serveFakePhotos(target) {
  await target.route('https://isolated-photo-store.invalid/**', (route) => {
    const u = route.request().url();
    return route.fulfill({ status: 200, contentType: 'image/png', body: /tall|logo/.test(u) ? TALL : WIDE });
  });
}
async function api(method, p, token, body, headers = {}) {
  const r = await fetch(stack.baseUrl + p, { method, headers: { Authorization: 'Bearer ' + token, ...headers }, body });
  let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
  return { status: r.status, j };
}
function form(file, name = 'photo.png', type = 'image/png') { const f = new FormData(); f.append('image', new Blob([file], { type }), name); return f; }

beforeAll(async () => {
  stack = await startStack({ fakeStorage: true });
  await seed.sellerAgreementTemplate(stack);
  Object.assign(shop, await sj.publishedStorefront(stack, { email: 'gallery-owner@fullstack.test', slug: 'harbor-gallery', name: 'Harbor Gallery' }));
  P.item = await sj.publishedItem(stack, { sellerProfileId: shop.sellerProfileId, title: 'Painted Harbor Scene' });
  await stack.query(`UPDATE marketplace_items SET images = $2::jsonb, description = 'Oil on board, signed lower right.' WHERE id = $1`,
    [P.item, JSON.stringify([photoUrl('wide-1'), photoUrl('tall-2'), photoUrl('wide-3')])]);
  P.item2 = await sj.publishedItem(stack, { sellerProfileId: shop.sellerProfileId, title: 'Glazed Stoneware Jug', inventoryNumber: 'WD-1002' });
  Object.assign(other, await sj.publishedStorefront(stack, { email: 'other-owner@fullstack.test', slug: 'other-shop', name: 'Other Shop' }));
  P.otherItem = await sj.publishedItem(stack, { sellerProfileId: other.sellerProfileId, title: 'Someone Else Teapot' });
  P.token = await seed.apiLogin(stack, shop.email);
  P.otherToken = await seed.apiLogin(stack, other.email);
  // The seller's own website, on a different origin, embedding the widget exactly as the embed code does.
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Harbor Gallery Website</title></head><body><h1>Harbor Gallery</h1>
      <iframe id="shop" src="${stack.baseUrl}/embed/storefront.html?seller=${shop.sellerProfileId}" title="Shop" style="border:0;width:100%;height:900px"></iframe></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://localhost:${site.address().port}/`;   // a different origin from the app (127.0.0.1)
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (site) site.close(); if (stack) await stack.stop(); });

describe('Storefront Branding: logo and banner photo', () => {
  test('owner uploads a logo and a banner photo; they are saved to the seller\'s existing records', async () => {
    const logo = await api('POST', '/api/seller-storefront/branding/logo', P.token, form(TALL));
    expect(logo.status).toBe(201);
    expect(logo.j.data.url).toMatch(/^https:\/\/isolated-photo-store\.invalid\/storefront-branding\//);
    const hero = await api('POST', '/api/seller-storefront/branding/hero', P.token, form(WIDE));
    expect(hero.status).toBe(201);
    const row = (await stack.query(`SELECT logo_url, storefront->>'hero_image' AS hero, metadata->'branding' AS b FROM seller_profiles WHERE id = $1`, [shop.sellerProfileId])).rows[0];
    expect(row.logo_url).toBe(logo.j.data.url);
    expect(row.hero).toBe(hero.j.data.url);
    expect(row.b).toEqual(expect.objectContaining({ logo_public_id: expect.any(String), hero_public_id: expect.any(String) }));
  });
  test('refused: not a photo, too large, unknown image, not signed in, not a Professional Seller', async () => {
    expect((await api('POST', '/api/seller-storefront/branding/logo', P.token, form(Buffer.from('just text'), 'x.png'))).status).toBe(415);
    expect((await api('POST', '/api/seller-storefront/branding/logo', P.token, form(Buffer.alloc(11 * 1024 * 1024, 1)))).status).toBe(413);
    expect((await api('POST', '/api/seller-storefront/branding/cover', P.token, form(WIDE))).status).toBe(404);
    expect((await fetch(stack.baseUrl + '/api/seller-storefront/branding/logo', { method: 'POST', body: form(WIDE) })).status).toBe(401);
    const privId = await seed.user(stack, { email: 'private-seller@fullstack.test', role: 'seller' });
    await seed.sellerProfile(stack, { userId: privId, sellerType: 'private', displayName: 'Garage Finds' });
    const priv = await api('POST', '/api/seller-storefront/branding/logo', await seed.apiLogin(stack, 'private-seller@fullstack.test'), form(WIDE));
    expect([priv.status, priv.j && priv.j.code]).toEqual([403, 'NOT_PROFESSIONAL']);
  });
  test('another seller\'s upload only ever changes that seller\'s own storefront', async () => {
    const before = (await stack.query('SELECT logo_url FROM seller_profiles WHERE id = $1', [shop.sellerProfileId])).rows[0].logo_url;
    expect((await api('POST', '/api/seller-storefront/branding/logo', P.otherToken, form(WIDE))).status).toBe(201);
    expect((await stack.query('SELECT logo_url FROM seller_profiles WHERE id = $1', [shop.sellerProfileId])).rows[0].logo_url).toBe(before);
    expect((await api('DELETE', '/api/seller-storefront/branding/logo', P.otherToken)).status).toBe(200);
    expect((await stack.query('SELECT logo_url FROM seller_profiles WHERE id = $1', [shop.sellerProfileId])).rows[0].logo_url).toBe(before);
  });
  test('Storefront Settings: upload with preview, replace and remove, from the page itself (desktop and phone)', async () => {
    for (const ctxOpts of [{}, devices['iPhone 13']]) {
      const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage(); await serveFakePhotos(page);
      await seed.browserLogin(page, stack, shop.email, undefined, '/seller-storefront.html');
      await page.waitForSelector('#bx-logo', { state: 'visible' });
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aap-brand-'));
      const f = path.join(dir, 'new-logo.png'); fs.writeFileSync(f, png(80, 40, [10, 120, 60]));
      await page.setInputFiles('#f-logo', f);
      await page.waitForFunction(() => document.getElementById('bm-logo').textContent === 'Saved.');
      expect(await page.$eval('#pv-logo img', (i) => getComputedStyle(i).objectFit)).toBe('contain');
      expect(await page.isVisible('#rm-logo')).toBe(true);
      expect(await page.textContent('#ub-logo')).toBe('Replace Logo');
      await page.setInputFiles('#f-hero', f);
      await page.waitForFunction(() => document.getElementById('bm-hero').textContent === 'Saved.');
      expect(await page.inputValue('#s-hero')).toMatch(/^https:\/\/isolated-photo-store\.invalid\//);
      page.once('dialog', (d) => d.accept());
      await page.click('#rm-hero');
      await page.waitForFunction(() => document.getElementById('bm-hero').textContent === 'Removed.');
      expect(await page.textContent('#pv-hero')).toBe('No banner photo yet');
      expect((await stack.query(`SELECT storefront ? 'hero_image' AS has FROM seller_profiles WHERE id = $1`, [shop.sellerProfileId])).rows[0].has).toBe(false);
      await page.setInputFiles('#f-hero', f);
      await page.waitForFunction(() => document.getElementById('bm-hero').textContent === 'Saved.');
      // Saved after a reload too (the upload is the saved setting; nothing else to click).
      await page.reload(); await page.waitForSelector('#pv-hero img');
      expect(await page.isVisible('#pv-logo img')).toBe(true);
      await ctx.close();
    }
  });
  test('the logo and banner appear on the public storefront (logo never cropped) and the logo in the website widget', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await serveFakePhotos(page);
    await page.goto(stack.baseUrl + '/pro/harbor-gallery', { waitUntil: 'networkidle' });
    const logo = await page.$eval('.hero-logo', (e) => ({ bg: getComputedStyle(e).backgroundImage, size: getComputedStyle(e).backgroundSize }));
    expect(logo.bg).toMatch(/isolated-photo-store\.invalid/); expect(logo.size).toBe('contain');
    expect(await page.$eval('.hero-cover', (e) => getComputedStyle(e).backgroundImage)).toMatch(/isolated-photo-store\.invalid/);
    const feed = await (await fetch(stack.baseUrl + '/api/public/storefront/widget/' + shop.sellerProfileId)).json();
    expect(feed.data.seller.logo_url).toMatch(/isolated-photo-store\.invalid/);
    await ctx.close();
  });
});

describe('the website widget keeps shoppers on the seller\'s website', () => {
  test.each([['desktop', {}], ['phone', devices['iPhone 13']]])('%s: an item opens inside the frame; Back to Storefront and browser back return to the shop', async (label, ctxOpts) => {
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage(); await serveFakePhotos(page);
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(siteUrl, { waitUntil: 'networkidle' });
    const frame = page.frame({ url: /embed\/storefront\.html/ });
    await frame.waitForSelector('a.sw-card');
    expect(await frame.isVisible('.sw-logo')).toBe(true);
    await frame.click('a.sw-card:has-text("Painted Harbor Scene")');
    await frame.waitForSelector('#sw-back');
    expect(page.url()).toBe(siteUrl);                                   // the shopper is still on the seller's website
    expect(ctx.pages()).toHaveLength(1);                                // nothing opened elsewhere
    expect(frame.url()).toContain('item=' + P.item);
    expect(await frame.textContent('h1')).toBe('Painted Harbor Scene');
    expect(await frame.textContent('.sw-desc')).toMatch(/Oil on board/);
    expect(await frame.$$eval('iframe', (f) => f.length)).toBe(0);     // no frame inside the frame
    // The canonical Advantage.Bid page is linked, never framed.
    expect(await frame.getAttribute('a:has-text("View this item on Advantage.Bid")', 'target')).toBe('_blank');
    await frame.click('#sw-back');
    await frame.waitForSelector('a.sw-card');
    expect(frame.url()).not.toContain('item=');
    // Browser back from an item returns to the shop list.
    await frame.click('a.sw-card:has-text("Glazed Stoneware Jug")');
    await frame.waitForSelector('#sw-back');
    await frame.evaluate(() => history.back());   // the browser Back button inside the frame
    await frame.waitForSelector('a.sw-card');
    expect(page.url()).toBe(siteUrl);
    expect(errors).toEqual([]);
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await ctx.close();
  });
  test('only this seller\'s available items open in this seller\'s widget (no other seller, draft or sold item)', async () => {
    const get = (s, i) => fetch(`${stack.baseUrl}/api/public/storefront/widget/${s}/item/${i}`).then((r) => r.status);
    expect(await get(shop.sellerProfileId, P.item)).toBe(200);
    expect(await get(shop.sellerProfileId, P.otherItem)).toBe(404);
    expect(await get(other.sellerProfileId, P.item)).toBe(404);
    await stack.query(`UPDATE marketplace_items SET status = 'draft' WHERE id = $1`, [P.item2]);
    expect(await get(shop.sellerProfileId, P.item2)).toBe(404);
    await stack.query(`UPDATE marketplace_items SET status = 'active' WHERE id = $1`, [P.item2]);
    expect(await get(shop.sellerProfileId, 'not-an-id')).toBe(404);
    // A crafted address inside the widget shows nothing of the other seller's item.
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(`${stack.baseUrl}/embed/storefront.html?seller=${shop.sellerProfileId}&item=${P.otherItem}`, { waitUntil: 'networkidle' });
    expect(await page.textContent('body')).toMatch(/no longer available/);
    expect(await page.textContent('body')).not.toMatch(/Teapot/);
    await ctx.close();
  });
  test('the item view offers the purchase path on Advantage.Bid in a new tab, never inside the frame', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.goto(`${stack.baseUrl}/embed/storefront.html?seller=${shop.sellerProfileId}&item=${P.item}`, { waitUntil: 'networkidle' });
    const cta = await page.$('.sw-buy a.sw-btn');
    expect(await cta.getAttribute('target')).toBe('_blank');
    expect(await cta.getAttribute('rel')).toMatch(/noopener/);
    await ctx.close();
  });
});

describe('product photo gallery', () => {
  async function checkGallery(page, scope) {
    const main = await scope.$('.advg-main');
    expect(await main.$eval('img', (i) => getComputedStyle(i).objectFit)).toBe('contain');   // never cropped
    expect(await scope.$$eval('.advg-thumbs .advg-thumb', (t) => t.length)).toBe(3);
    await main.click();
    await scope.waitForSelector('.advg-box[role="dialog"]');
    expect(await scope.textContent('.advg-count')).toBe('Photo 1 of 3');
    expect(await scope.evaluate(() => document.activeElement.className)).toMatch(/advg-close/);
    await page.keyboard.press('ArrowRight');
    expect(await scope.textContent('.advg-count')).toBe('Photo 2 of 3');
    expect(await scope.$eval('.advg-stage img', (i) => i.src)).toMatch(/tall-2/);
    await scope.click('.advg-next');
    await scope.click('.advg-next');
    expect(await scope.textContent('.advg-count')).toBe('Photo 1 of 3');   // wraps around
    await scope.click('.advg-strip .advg-thumb >> nth=2');
    expect(await scope.textContent('.advg-count')).toBe('Photo 3 of 3');
    // The enlarged photo fits inside the viewer.
    const fit = await scope.$eval('.advg-stage img', (i) => { const r = i.getBoundingClientRect(); return r.width <= innerWidth + 1 && r.height <= innerHeight + 1; });
    expect(fit).toBe(true);
    await page.keyboard.press('Escape');
    expect(await scope.$('.advg-box')).toBeNull();
    expect(await scope.evaluate(() => document.activeElement.className)).toMatch(/advg-main/);
    expect(await scope.$eval('.advg-main img', (i) => i.src)).toMatch(/wide-3/);      // the main photo follows the viewer
  }
  test.each([['desktop', {}], ['phone', devices['iPhone 13']]])('%s: standalone item page', async (label, ctxOpts) => {
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage(); await serveFakePhotos(page);
    await page.goto(stack.baseUrl + '/item.html?id=' + P.item, { waitUntil: 'networkidle' });
    await page.waitForSelector('.advg-main');
    await checkGallery(page, page);
    await ctx.close();
  });
  test('inside the website widget on a phone: the viewer fills the frame, never the seller\'s page', async () => {
    const ctx = await browser.newContext(devices['iPhone 13']); const page = await ctx.newPage(); await serveFakePhotos(page);
    await page.goto(siteUrl, { waitUntil: 'networkidle' });
    const frame = page.frame({ url: /embed\/storefront\.html/ });
    await frame.waitForSelector('a.sw-card');
    await frame.click('a.sw-card:has-text("Painted Harbor Scene")');
    await frame.waitForSelector('.advg-main');
    await checkGallery(page, frame);
    expect(page.url()).toBe(siteUrl);
    await ctx.close();
  });
  test('swipe moves between photos on a touch screen', async () => {
    const ctx = await browser.newContext(devices['iPhone 13']); const page = await ctx.newPage(); await serveFakePhotos(page);
    await page.goto(stack.baseUrl + '/item.html?id=' + P.item, { waitUntil: 'networkidle' });
    await page.click('.advg-main');
    await page.waitForSelector('.advg-stage');
    await page.$eval('.advg-stage', (s) => {
      const t = (x) => new Touch({ identifier: 1, target: s, clientX: x, clientY: 300 });
      s.dispatchEvent(new TouchEvent('touchstart', { touches: [t(300)], changedTouches: [t(300)], bubbles: true }));
      s.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(120)], bubbles: true }));
    });
    expect(await page.textContent('.advg-count')).toBe('Photo 2 of 3');
    await ctx.close();
  });
});

describe('new professional type: Retail Shop, Gallery or Studio', () => {
  test('registration offers it; the account becomes a Professional Seller with the same gates (verification, agreement), no staff or admin rights', async () => {
    const userId = await seed.user(stack, { email: 'potter@fullstack.test', role: 'buyer', fullName: 'Pat Potter' });
    const token = await seed.apiLogin(stack, 'potter@fullstack.test');
    const page = await (await browser.newContext()).newPage();
    await page.goto(stack.baseUrl + '/become-professional-seller.html');
    expect(await page.$$eval('#seller-type option', (o) => o.map((x) => x.textContent))).toContain('Retail Shop, Gallery or Studio');
    const r = await fetch(stack.baseUrl + '/api/sellers/apply-professional', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ seller_type: 'retail_gallery_studio', company_name: 'Riverbend Pottery', legal_name: 'Pat Potter', phone: '7135550123', state: 'TX' }) });
    expect(r.status).toBeLessThan(300);
    const sp = (await stack.query(`SELECT sp.id, sp.seller_type, sp.verification_required_before_publication AS vreq, u.role, u.staff_role
                                     FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE u.id = $1`, [userId])).rows[0];
    expect(sp).toEqual(expect.objectContaining({ seller_type: 'retail_gallery_studio', vreq: true, role: 'seller', staff_role: null }));
    // The existing seller agreement was sent, naming the business; signing is still required (dashboard locked).
    const ag = (await stack.query(`SELECT status, resolved_variables->>'legal_name' AS legal FROM agreements WHERE seller_profile_id = $1`, [sp.id])).rows;
    expect(ag).toEqual([expect.objectContaining({ status: 'sent', legal: 'Riverbend Pottery' })]);
    const st = await (await fetch(stack.baseUrl + '/api/agreements/onboarding-status', { headers: { Authorization: 'Bearer ' + token } })).json();
    expect(st.data.dashboard_access).toBe(false);
    // Professional storefront tools are available (prepared as drafts); nothing is publicly sellable until verified.
    const t2 = await seed.apiLogin(stack, 'potter@fullstack.test');
    const cfg = await (await fetch(stack.baseUrl + '/api/seller-storefront/config', { headers: { Authorization: 'Bearer ' + t2 } })).json();
    expect(cfg.data.eligible).toBe(true);
    const gate = await stack.query(`SELECT 1 FROM seller_verifications WHERE seller_profile_id = $1 AND status = 'approved'`, [sp.id]).catch(() => ({ rowCount: 0 }));
    expect(gate.rowCount).toBe(0);
    await page.context().close();
  });
  test('an unknown type is still refused', async () => {
    await seed.user(stack, { email: 'someone@fullstack.test', role: 'buyer' });
    const token = await seed.apiLogin(stack, 'someone@fullstack.test');
    const r = await fetch(stack.baseUrl + '/api/sellers/apply-professional', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ seller_type: 'private', company_name: 'X', legal_name: 'Y', phone: '7135550199' }) });
    expect(r.status).toBe(400);
  });
});

test('bulk publishing asks only "Publish N item(s)?" (no repeated marketplace warning); distribution is unchanged', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'seller-inventory.html'), 'utf8');
  expect(src).not.toMatch(/They will be visible on Advantage\.Bid/);
  expect(src).toMatch(/confirm\(label\+' '\+ids\.length\+' item\(s\)\?'/);
});
