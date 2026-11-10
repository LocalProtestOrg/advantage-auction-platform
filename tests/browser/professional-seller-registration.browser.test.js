'use strict';

/**
 * Professional Seller registration, end to end with an ORDINARY new account (owner 2026-11-10), on the isolated full-stack
 * environment (real app, real migrations; never production). Checkout stays off here.
 *   1. register as a buyer;  2. enroll as a Professional Seller;  3. select several business categories;
 *   4. business name and representative;  5. accept the Seller Agreement on the signing page;  6. Buying / Selling switch;
 *   7. fixed-price, auction and estate sale tools in one Selling menu;  8. publish an item before business verification;
 *   9. checkout and payouts stay protected.
 * Plus: categories can be changed later without reclassifying the account, and a sign-in for an account that no longer
 * exists (the 2026-11-10 enrollment failure) is told to sign in again instead of "try again shortly".
 */

const crypto = require('crypto');
const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(300000);

let stack; let browser; const T = { email: 'new-pro@fullstack.test' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
async function api(token, method, p, body) {
  const r = await fetch(stack.baseUrl + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, j };
}
const one = async (sql, p) => (await stack.query(sql, p || [])).rows[0];
const railLabels = (page) => page.$$eval('.adv-rail .adv-nav a.adv-nav-item span:last-child', (els) => els.map((e) => e.textContent.trim()));

beforeAll(async () => {
  stack = await startStack({ fakeStorage: true });
  await seed.sellerAgreementTemplate(stack);   // the one general Seller Agreement every seller type signs
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

test('1. an ordinary visitor registers as a buyer', async () => {
  const r = await api(null, 'POST', '/api/auth/register', { email: T.email, password: seed.TEST_PASSWORD, accept_terms: true });
  expect([r.status, r.j && r.j.success]).toEqual([200, true]);
  T.userId = (await one('SELECT id, role FROM users WHERE email = $1', [T.email])).id;
  expect((await one('SELECT role FROM users WHERE id = $1', [T.userId])).role).toBe('buyer');
});

test('2-5. enrolls as a Professional Seller with several business categories, then accepts the Seller Agreement', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await seed.browserLogin(page, stack, T.email, seed.TEST_PASSWORD, '/become-professional-seller.html');
  await page.waitForSelector('#form-wrap', { state: 'visible' });
  expect(await page.textContent('#biz-cats legend')).toMatch(/What type of business do you operate\? Select all that apply\./);
  // nothing selected: a clear message, nothing sent
  await page.fill('#company-name', 'Timeless Treasures');
  await page.fill('#legal-name', 'Pat Owner');
  await page.fill('#phone', '2015550123');
  await page.fill('#state', 'NJ');
  await page.click('#submit-btn');
  expect(await page.textContent('#form-err')).toMatch(/select at least one type of business/);
  expect(await one('SELECT count(*)::int n FROM seller_profiles WHERE user_id = $1', [T.userId])).toEqual({ n: 0 });
  // a retail shop today, auctions and estate sales later: all three, one account
  for (const v of ['retail_resale', 'auction_house', 'estate_sale_company']) await page.check(`input[name="biz-cat"][value="${v}"]`);
  await Promise.all([page.waitForURL(/\/sign-agreement\.html/, { timeout: 30000 }), page.click('#submit-btn')]);
  const sp = await one(`SELECT id, seller_type, business_categories, display_name, verification_required_before_publication FROM seller_profiles WHERE user_id = $1`, [T.userId]);
  T.profileId = sp.id;
  expect(sp).toMatchObject({ seller_type: 'auction_house', display_name: 'Timeless Treasures', verification_required_before_publication: true,
    business_categories: ['auction_house', 'estate_sale_company', 'retail_resale'] });
  expect(await one('SELECT role, staff_role FROM users WHERE id = $1', [T.userId])).toEqual({ role: 'seller', staff_role: null });
  // the representative signs the agreement on the signing page
  await page.waitForSelector('#sign-form', { state: 'visible', timeout: 30000 });
  await page.fill('#typed-name', 'Pat Owner');
  const c = await page.$('#sig-canvas'); const b = await c.boundingBox();
  await page.mouse.move(b.x + 20, b.y + 40); await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + 90, { steps: 8 }); await page.mouse.move(b.x + 220, b.y + 30, { steps: 8 }); await page.mouse.up();
  for (const id of ['#reviewed', '#consent', '#intent']) await page.check(id);
  await page.click('#sign-btn');
  await page.waitForSelector('#signed-card', { state: 'visible' });
  expect((await one(`SELECT status FROM agreements WHERE seller_profile_id = $1`, [T.profileId])).status).toBe('signed');
  expect(errors).toEqual([]);
  await ctx.close();
  T.token = await seed.apiLogin(stack, T.email);
});

test('6-7. one Selling menu with fixed-price, auction and estate sale tools; Buying is one tap away', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await seed.browserLogin(page, stack, T.email);
  await page.waitForSelector('#adv-mode-switch');
  await page.click('#adv-mode-switch button[data-mode="selling"]');
  await page.waitForFunction(() => (document.getElementById('adv-mode-chip') || {}).textContent === 'Selling');
  const labels = await railLabels(page);
  for (const l of ['Add Item', 'Manage Inventory', 'My Storefront', 'Orders', 'Create Auction', 'Manage Auctions', 'Create Estate Sale', 'Manage Events', 'Seller Settings']) {
    expect(labels).toContain(l);
  }
  expect(labels).not.toContain('Open a Professional Storefront');
  await page.click('#adv-mode-switch button[data-mode="buying"]');
  await page.waitForFunction(() => (document.getElementById('adv-mode-chip') || {}).textContent === 'Buying');
  expect(await railLabels(page)).toEqual(expect.arrayContaining(['Watchlist', 'My Bids', 'Purchases']));
  // each tool opens for this seller (no second account, no reclassification)
  for (const [p, sel] of [['/seller-create.html', 'body'], ['/org/event-new.html', '#saleType'], ['/seller-storefront.html?tab=market', 'body']]) {
    const resp = await page.goto(stack.baseUrl + p);
    expect([p, resp.status()]).toEqual([p, 200]);
    expect(page.url()).not.toMatch(/login\.html|app\.html#home/);
    await page.waitForSelector(sel);
  }
  expect(await page.goto(stack.baseUrl + '/org/event-new.html').then(() => page.inputValue('#saleType'))).toBe('estate_sale');
  await ctx.close();
});

test('8-9. an item is published and public before business verification; checkout and payouts stay protected', async () => {
  expect((await api(T.token, 'PUT', '/api/seller-storefront/config', { published: true, business_name: 'Timeless Treasures', config: { tagline: 'Antiques' } })).status).toBe(200);
  expect((await api(T.token, 'PUT', '/api/seller-storefront/pickup-location', { line1: '10 Main St', city: 'Montclair', state: 'NJ', postal_code: '07042' })).status).toBe(200);
  const created = await api(T.token, 'POST', '/api/seller-storefront/items', { title: 'Oak Side Table', price_cents: 12000, status: 'draft', category_key: 'furniture' });
  expect(created.status).toBe(201);
  const id = created.j.data.id;
  const fd = new FormData(); fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'table.png');
  expect((await fetch(stack.baseUrl + `/api/seller-storefront/items/${id}/photos`, { method: 'POST', headers: { Authorization: 'Bearer ' + T.token }, body: fd })).status).toBe(200);
  expect((await api(T.token, 'PATCH', `/api/seller-storefront/items/${id}`, { status: 'active' })).status).toBe(200);
  // public at once, while verification is still pending
  expect((await one(`SELECT count(*)::int n FROM verification_requests WHERE seller_profile_id = $1 AND status = 'approved'`, [T.profileId])).n).toBe(0);
  const pub = await api(null, 'GET', '/api/public/storefront/item/' + id);
  expect([pub.status, pub.j.data.accepting_orders]).toEqual([200, false]);
  expect((await api(null, 'GET', '/api/public/shop/items')).j.data.some((i) => i.id === id)).toBe(true);
  // checkout is off and the server refuses an order; the seller cannot be paid out yet
  expect((await api(null, 'GET', '/api/marketplace/config')).j.data.checkout_enabled).toBe(false);
  await seed.user(stack, { email: 'pilot-buyer@fullstack.test', role: 'buyer' });
  const buyer = await seed.apiLogin(stack, 'pilot-buyer@fullstack.test');
  const quote = await api(buyer, 'POST', '/api/marketplace/orders/quote', { item_id: id, fulfillment_method: 'pickup' });
  expect(quote.status).toBeGreaterThanOrEqual(400);
  const order = await fetch(stack.baseUrl + '/api/marketplace/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + buyer, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ item_id: id, fulfillment_method: 'pickup' }) });
  expect(order.status).toBeGreaterThanOrEqual(400);
  expect((await one('SELECT count(*)::int n FROM marketplace_orders')).n).toBe(0);
  expect((await one('SELECT count(*)::int n FROM storefront_payouts')).n).toBe(0);
});

test('categories can be changed later; the account is never reclassified and keeps every tool', async () => {
  const r = await api(T.token, 'PUT', '/api/sellers/me/business-categories', { business_categories: ['retail_resale', 'gallery_studio'] });
  expect([r.status, r.j.data.business_categories]).toEqual([200, ['retail_resale', 'gallery_studio']]);
  expect(await one('SELECT seller_type, business_categories FROM seller_profiles WHERE id = $1', [T.profileId]))
    .toEqual({ seller_type: 'auction_house', business_categories: ['retail_resale', 'gallery_studio'] });
  expect((await api(T.token, 'PUT', '/api/sellers/me/business-categories', { business_categories: [] })).status).toBe(400);
  expect((await api(T.token, 'PUT', '/api/sellers/me/business-categories', { business_categories: ['admin'] })).status).toBe(400);
  expect((await api(T.token, 'GET', '/api/sellers/me')).j.data.business_categories).toEqual(['retail_resale', 'gallery_studio']);
  // the settings page shows them
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await seed.browserLogin(page, stack, T.email, seed.TEST_PASSWORD, '/seller-storefront.html?tab=store');
  await page.waitForFunction(() => document.querySelector('input[name="s-cat"][value="gallery_studio"]') && document.querySelector('input[name="s-cat"][value="gallery_studio"]').checked);
  expect(await page.isChecked('input[name="s-cat"][value="auction_house"]')).toBe(false);
  await ctx.close();
  // an Individual Seller cannot set categories (Professional only)
  const indId = await seed.user(stack, { email: 'individual@fullstack.test', role: 'seller' });
  await seed.sellerProfile(stack, { userId: indId, sellerType: 'business', displayName: 'Ind' });
  const ind = await seed.apiLogin(stack, 'individual@fullstack.test');
  expect((await api(ind, 'PUT', '/api/sellers/me/business-categories', { business_categories: ['retail_resale'] })).status).toBe(403);
});

test('a sign-in whose account no longer exists is told to sign in again (the 2026-11-10 failure), never "try again shortly"', async () => {
  const goneId = await seed.user(stack, { email: 'gone@fullstack.test', role: 'buyer' });
  const goneToken = await seed.apiLogin(stack, 'gone@fullstack.test');
  await stack.query('DELETE FROM users WHERE id = $1', [goneId]);
  const r = await api(goneToken, 'POST', '/api/sellers/apply-professional', { business_categories: ['retail_resale'], company_name: 'X', legal_name: 'Y', phone: '2015550123' });
  expect(r.status).toBe(401);
  // the enrollment page, opened with that stale sign-in, asks the visitor to sign in or create an account
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(stack.baseUrl + '/login.html');
  await page.evaluate((t) => localStorage.setItem('token', t), goneToken);
  await page.goto(stack.baseUrl + '/become-professional-seller.html');
  await page.waitForSelector('#need-login', { state: 'visible' });
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  await ctx.close();
});
