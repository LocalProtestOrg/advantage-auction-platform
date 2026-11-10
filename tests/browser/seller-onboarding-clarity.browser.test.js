'use strict';

/**
 * Seller onboarding clarity (owner 2026-11-10), end to end with a NORMAL seller account (never an administrator) on the
 * isolated full-stack environment (real app, real migrations; never production):
 *   - Become a Seller offers two clear paths (auction vs Professional Storefront), without long dashes;
 *   - the dashboard's Buying / Selling switch is always available to sellers and decides the menu;
 *   - an existing Individual Seller (type "business", agreement signed) upgrades to Professional Seller without
 *     registering again: the company name becomes the business name, the signed agreement is kept, the role stays seller;
 *   - in Selling: Add Item, Manage Inventory, My Storefront, Orders, Seller Settings;
 *   - storefront setup, a draft item with a photo, and a published item, all without an administrator;
 *   - the published item is public at once, before business verification (owner 2026-11-10), but it cannot be bought:
 *     the seller is not accepting orders until verified, agreement in place and payout account connected;
 *   - the business name is editable before verification and locked after it.
 * Checkout stays off in this environment.
 */

const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(300000);

let stack; let browser; const T = {};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

async function api(token, method, p, body) {
  const r = await fetch(stack.baseUrl + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, j };
}
const one = async (sql, p) => (await stack.query(sql, p || [])).rows[0];
const railLabels = (page) => page.$$eval('.adv-rail .adv-nav a.adv-nav-item span:last-child', (els) => els.map((e) => e.textContent.trim()));

beforeAll(async () => {
  stack = await startStack({ fakeStorage: true });   // photo storage stand-in (in memory)
  // An existing Individual Seller, exactly like the account the owner registered: type "business", the person's own name,
  // the current Seller Agreement signed, no auctions.
  T.email = 'tt-owner@fullstack.test';
  T.userId = await seed.user(stack, { email: T.email, role: 'seller', fullName: 'Pat Person' });
  T.profileId = await seed.sellerProfile(stack, { userId: T.userId, sellerType: 'business', displayName: 'Pat Person' });
  T.agreementId = await seed.signedStorefrontAgreement(stack, T.profileId);
  T.token = await seed.apiLogin(stack, T.email);
  const adminEmail = 'tt-admin@fullstack.test';
  await seed.user(stack, { email: adminEmail, role: 'admin', fullName: 'Admin Person' });
  T.adminToken = await seed.apiLogin(stack, adminEmail);
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

test('Become a Seller offers two clear paths, and neither onboarding page uses a long dash', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await seed.browserLogin(page, stack, T.email, seed.TEST_PASSWORD, '/become-seller.html');
  await page.waitForSelector('#sell-paths', { state: 'visible' });
  expect(await page.textContent('h1')).toBe('How do you want to sell?');
  expect(await page.textContent('#path-auction')).toMatch(/Sell at auction/);
  expect(await page.textContent('#path-storefront')).toMatch(/Open a Professional Storefront[\s\S]*Your items are visible as soon as you publish them/);
  expect(await page.getAttribute('#go-pro-link', 'href')).toBe('/become-professional-seller.html');
  expect(await page.textContent('#seller-type')).toMatch(/Business selling at auction/);
  expect(await page.textContent('body')).not.toMatch(/[—–]/);
  await page.goto(stack.baseUrl + '/become-professional-seller.html');
  await page.waitForSelector('#form-wrap', { state: 'visible' });
  expect(await page.textContent('body')).not.toMatch(/[—–]/);
  expect(await page.textContent('#form-wrap .ob-lede')).toMatch(/retail shop, gallery or studio[\s\S]*upgrades the same account/);
  await ctx.close();
});

test('an existing Individual Seller switches to Selling and is offered a Professional Storefront (no storefront tools yet)', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await seed.browserLogin(page, stack, T.email);
  await page.waitForSelector('#adv-mode-switch');
  expect(await page.textContent('#adv-mode-switch')).toMatch(/Buying[\s\S]*Selling/);
  expect(await page.textContent('#adv-mode-chip')).toBe('Buying');
  await page.click('#adv-mode-switch button[data-mode="selling"]');
  await page.waitForFunction(() => (document.getElementById('adv-mode-chip') || {}).textContent === 'Selling');
  const labels = await railLabels(page);
  expect(labels).toEqual(expect.arrayContaining(['Create Online Auction', 'Manage Online Auctions', 'Open a Professional Storefront', 'Seller Settings']));
  expect(labels).not.toContain('Add Item');
  expect(labels).not.toContain('Watchlist');   // Buying items are in Buying
  await ctx.close();
});

test('the upgrade to Professional Seller: company name becomes the business name, agreement kept, role unchanged, lands in Selling', async () => {
  const agreementsBefore = (await stack.query('SELECT id, status FROM agreements WHERE seller_profile_id = $1 ORDER BY created_at', [T.profileId])).rows;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await seed.browserLogin(page, stack, T.email, seed.TEST_PASSWORD, '/become-professional-seller.html');
  await page.waitForSelector('#form-wrap', { state: 'visible' });
  await page.selectOption('#seller-type', 'retail_gallery_studio');
  await page.fill('#company-name', 'Timeless Treasures');
  await page.fill('#legal-name', 'Pat Person');
  await page.fill('#phone', '2015550123');
  await page.fill('#state', 'NJ');
  await Promise.all([page.waitForURL(/\/(app|sign-agreement)\.html/, { timeout: 30000 }), page.click('#submit-btn')]);
  expect(page.url()).toMatch(/\/app\.html/);   // agreement already signed: straight to the dashboard
  await page.waitForFunction(() => (document.getElementById('adv-mode-chip') || {}).textContent === 'Selling');
  const sp = await one('SELECT seller_type, display_name, verification_required_before_publication FROM seller_profiles WHERE id = $1', [T.profileId]);
  expect(sp).toEqual({ seller_type: 'retail_gallery_studio', display_name: 'Timeless Treasures', verification_required_before_publication: true });
  expect((await stack.query('SELECT id, status FROM agreements WHERE seller_profile_id = $1 ORDER BY created_at', [T.profileId])).rows).toEqual(agreementsBefore);
  expect(await one('SELECT role, staff_role, is_platform_owner FROM users WHERE id = $1', [T.userId])).toEqual({ role: 'seller', staff_role: null, is_platform_owner: false });
  const labels = await railLabels(page);
  for (const l of ['Add Item', 'Manage Inventory', 'My Storefront', 'Orders', 'Seller Settings', 'Payouts', 'Create Online Auction']) expect(labels).toContain(l);
  expect(labels.indexOf('Add Item')).toBeLessThan(labels.indexOf('Create Online Auction'));
  // the Selling home leads with the storefront actions
  await page.waitForSelector('#adv-storefront-actions');
  expect(await page.textContent('#adv-storefront-actions')).toMatch(/Add Item[\s\S]*Manage Inventory[\s\S]*My Storefront[\s\S]*Orders/);
  // Add Item opens the item tab
  await Promise.all([page.waitForURL(/seller-storefront\.html\?tab=market/), page.click('.adv-rail a.adv-nav-item:has-text("Add Item")')]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('normal seller permissions: the seller cannot use administrator tools', async () => {
  expect((await api(T.token, 'GET', '/api/admin/verification/requests')).status).toBe(403);
  expect((await api(T.token, 'GET', '/api/admin/tax-jurisdictions')).status).toBe(403);
});

test('storefront setup, a draft item with a photo, publishing: all without an administrator; the item is public before verification but not purchasable', async () => {
  // storefront settings: the business name is editable while verification is pending; first save sets the address from it
  const cfg = await api(T.token, 'GET', '/api/seller-storefront/config');
  expect(cfg.j.data).toMatchObject({ name: 'Timeless Treasures', business_name_editable: true });
  const saved = await api(T.token, 'PUT', '/api/seller-storefront/config', { published: true, business_name: 'Timeless Treasures',
    config: { tagline: 'Antiques and vintage finds', about: 'A small shop of carefully chosen pieces.' } });
  expect(saved.status).toBe(200);
  expect(saved.j.data).toMatchObject({ slug: 'timeless-treasures', published: true });
  T.slug = saved.j.data.slug;
  // the storefront pickup location (a seller step; publishing needs it)
  const loc = await api(T.token, 'PUT', '/api/seller-storefront/pickup-location', { line1: '10 Main St', city: 'Montclair', state: 'NJ', postal_code: '07042' });
  expect(loc.status).toBe(200);
  // a draft item, a photo, then published
  const created = await api(T.token, 'POST', '/api/seller-storefront/items', { title: 'Brass Candlestick Pair', price_cents: 4500, status: 'draft', category_key: 'home_decor' });
  expect(created.status).toBe(201);
  T.itemId = created.j.data.id;
  const fd = new FormData(); fd.append('photos', new Blob([PNG], { type: 'image/png' }), 'candlesticks.png');
  const up = await fetch(stack.baseUrl + `/api/seller-storefront/items/${T.itemId}/photos`, { method: 'POST', headers: { Authorization: 'Bearer ' + T.token }, body: fd });
  const upErr = up.status === 200 ? '' : (await up.text()) + ' | ' + stack.logs().split(String.fromCharCode(10)).filter((l) => /error|ERROR|Must|failed/.test(l)).slice(-6).join(' / ');
  expect([up.status, upErr]).toEqual([200, '']);
  const pub = await api(T.token, 'PATCH', `/api/seller-storefront/items/${T.itemId}`, { status: 'active' });
  expect([pub.status, pub.j && pub.j.data && pub.j.data.status, pub.status === 200 ? null : pub.j]).toEqual([200, 'active', null]);
  expect((await one('SELECT jsonb_array_length(COALESCE(images, \'[]\'::jsonb)) n FROM marketplace_items WHERE id = $1', [T.itemId])).n).toBeGreaterThan(0);
  // the seller sees it in their own inventory
  const mine = await api(T.token, 'GET', '/api/seller-storefront/items');
  expect(JSON.stringify(mine.j)).toContain(T.itemId);
  // ...and so does everyone else, at once, before Advantage.Bid verifies the business (owner 2026-11-10)
  expect((await (await fetch(stack.baseUrl + '/api/public/shop/items')).json()).data.some((i) => i.id === T.itemId)).toBe(true);
  const pubItem = await fetch(stack.baseUrl + '/api/public/storefront/item/' + T.itemId);
  expect(pubItem.status).toBe(200);
  // listed, but not purchasable: the seller is not accepting orders yet (the server's own sale-eligibility check)
  expect((await pubItem.json()).data).toMatchObject({ title: 'Brass Candlestick Pair', accepting_orders: false });
  expect([200, 301]).toContain((await fetch(stack.baseUrl + '/shop/item/' + T.itemId, { redirect: 'manual' })).status);   // public (301 = to its canonical address)
  expect(((await (await fetch(stack.baseUrl + '/api/public/storefront/' + T.slug)).json()).data.marketplace || []).map((i) => i.id)).toContain(T.itemId);
  expect(await (await fetch(stack.baseUrl + '/sitemap.xml')).text()).toContain(T.itemId);
  const ready = await api(T.token, 'GET', '/api/seller-storefront/readiness');
  const step = ready.j.data.company.find((s) => s.key === 'verification');
  expect(step).toMatchObject({ done: false });
  expect(step.detail).toMatch(/already visible to buyers\. Advantage\.Bid verifies your business before buyers can purchase online/);
});

test('after Advantage.Bid approves the business (the compliance step), the item stays public, is still not purchasable without a payout account, and the name is locked', async () => {
  const reqId = (await one(`INSERT INTO verification_requests (seller_profile_id, status) VALUES ($1, 'submitted') RETURNING id`, [T.profileId])).id;
  const rv = await api(T.adminToken, 'POST', `/api/admin/verification/requests/${reqId}/review`, { status: 'approved' });
  expect(rv.status).toBe(200);
  expect((await (await fetch(stack.baseUrl + '/api/public/shop/items')).json()).data.some((i) => i.id === T.itemId)).toBe(true);
  const item = await (await fetch(stack.baseUrl + '/api/public/storefront/item/' + T.itemId)).json();
  expect(item.data).toMatchObject({ title: 'Brass Candlestick Pair', seller_name: 'Timeless Treasures', accepting_orders: false });
  expect(((await (await fetch(stack.baseUrl + '/api/public/storefront/' + T.slug)).json()).data.marketplace || []).map((i) => i.id)).toContain(T.itemId);
  // the verified business name is now set; the settings field is read-only
  const cfg = await api(T.token, 'GET', '/api/seller-storefront/config');
  expect(cfg.j.data.business_name_editable).toBe(false);
  const rename = await api(T.token, 'PUT', '/api/seller-storefront/config', { business_name: 'Another Name' });
  expect([rename.status, rename.j.code]).toEqual([409, 'BUSINESS_NAME_LOCKED']);
  expect((await one('SELECT display_name FROM seller_profiles WHERE id = $1', [T.profileId])).display_name).toBe('Timeless Treasures');
  // checkout stays off here: the item page offers no Buy Now
  expect((await (await fetch(stack.baseUrl + '/api/marketplace/config')).json()).data.checkout_enabled).toBe(false);
});

test('on a phone, the header carries the switch; the choice is remembered across visits', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await seed.browserLogin(page, stack, T.email);
  await page.waitForSelector('#adv-mode-chip');
  const chip = await page.textContent('#adv-mode-chip');
  const other = chip === 'Selling' ? 'buying' : 'selling';
  const mini = page.locator(`.adv-header .adv-mode-mini button[data-mode="${other}"]`);
  expect(await mini.isVisible()).toBe(true);
  await mini.click();
  await page.waitForFunction((want) => (document.getElementById('adv-mode-chip') || {}).textContent === want, other === 'selling' ? 'Selling' : 'Buying');
  await page.reload();
  await page.waitForSelector('#adv-mode-chip');
  expect(await page.textContent('#adv-mode-chip')).toBe(other === 'selling' ? 'Selling' : 'Buying');
  await ctx.close();
});
