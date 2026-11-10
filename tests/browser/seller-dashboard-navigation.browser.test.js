'use strict';

/**
 * Seller dashboard navigation and the automatic storefront link (owner 2026-11-10), on the isolated full-stack
 * environment (real app, real migrations; never production):
 *   - every seller page (My Storefront, Inventory, Orders, Create Auction, Payouts, Auction Payments) sits inside the SAME
 *     dashboard frame: the sidebar with the Buying / Selling switch on desktop, the current section highlighted, one header,
 *     no buyer top bar; on a phone, a Menu that opens and closes by touch, Close, Escape and a tap outside, with focus
 *     handled and the page's unsaved typing kept;
 *   - the storefront link is made from the business name, numbered when taken, assigned at enrollment, never editable and
 *     never changed by a name change; the page shows it read-only with View and Copy Link, and says whether the
 *     storefront page is public.
 */

const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(300000);

let stack; let browser; const T = { email: 'nav-pro@fullstack.test' };
async function api(token, method, p, body) {
  const r = await fetch(stack.baseUrl + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) { /* none */ }
  return { status: r.status, j };
}
const one = async (sql, p) => (await stack.query(sql, p || [])).rows[0];
async function proSeller(email, name) {
  const userId = await seed.user(stack, { email, role: 'seller', fullName: 'Pat Owner' });
  const profileId = await seed.sellerProfile(stack, { userId, sellerType: 'retail_gallery_studio', displayName: name,
    extra: { verification_required_before_publication: true } });
  await seed.signedStorefrontAgreement(stack, profileId);
  return { userId, profileId, token: await seed.apiLogin(stack, email) };
}

beforeAll(async () => {
  stack = await startStack();
  Object.assign(T, await proSeller(T.email, 'Timeless Treasures'));
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

describe('automatic storefront link', () => {
  test('made from the business name the first time the seller opens My Storefront; a second business with that name gets -2', async () => {
    expect((await one('SELECT storefront_slug FROM seller_profiles WHERE id = $1', [T.profileId])).storefront_slug).toBeNull();
    const cfg = await api(T.token, 'GET', '/api/seller-storefront/config');
    expect(cfg.j.data).toMatchObject({ slug: 'timeless-treasures', published: false });
    expect(cfg.j.data.public_url).toMatch(/\/pro\/timeless-treasures$/);
    const other = await proSeller('nav-pro-2@fullstack.test', 'Timeless Treasures!');
    expect((await api(other.token, 'GET', '/api/seller-storefront/config')).j.data.slug).toBe('timeless-treasures-2');
  });
  test('assigned at enrollment for a new Professional Seller, with punctuation cleaned', async () => {
    await seed.user(stack, { email: 'oak-iron@fullstack.test', role: 'buyer' });
    const t = await seed.apiLogin(stack, 'oak-iron@fullstack.test');
    const r = await api(t, 'POST', '/api/sellers/apply-professional', { business_categories: ['retail_resale'], company_name: "Oak & Iron Antiques, LLC.", legal_name: 'Oli Oak', phone: '2015550199' });
    expect(r.status).toBeLessThan(300);
    expect((await one('SELECT storefront_slug FROM seller_profiles WHERE id = $1', [r.j.data.seller_profile_id])).storefront_slug).toBe('oak-and-iron-antiques-llc');
  });
  test('a seller cannot change it, and a business name change keeps it', async () => {
    const tryEdit = await api(T.token, 'PUT', '/api/seller-storefront/config', { slug: 'something-else' });
    expect(tryEdit.status).toBe(200);
    expect(tryEdit.j.data.slug).toBe('timeless-treasures');
    const renamed = await api(T.token, 'PUT', '/api/seller-storefront/config', { business_name: 'Timeless Treasures and Gifts' });
    expect([renamed.status, renamed.j.data.name, renamed.j.data.slug]).toEqual([200, 'Timeless Treasures and Gifts', 'timeless-treasures']);
    await api(T.token, 'PUT', '/api/seller-storefront/config', { business_name: 'Timeless Treasures' });
  });
});

describe('desktop: the dashboard sidebar stays on every seller page', () => {
  test('My Storefront: sidebar, Buying / Selling switch, current section, one header, the read-only link and the public status', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await seed.browserLogin(page, stack, T.email, seed.TEST_PASSWORD, '/seller-storefront.html?tab=store');
    await page.waitForSelector('.adv-rail', { state: 'visible' });
    await page.waitForFunction(() => /\/pro\/timeless-treasures/.test((document.getElementById('s-link') || {}).textContent || ''));
    expect(await page.$$eval('.adv-rail', (e) => e.length)).toBe(1);
    expect(await page.$$eval('header.adv-header', (e) => e.length)).toBe(1);
    expect(await page.$('#buyer-nav')).toBeNull();
    expect(await page.textContent('#adv-mode-switch')).toMatch(/Buying[\s\S]*Selling/);
    expect(await page.$eval('.adv-rail a[aria-current="page"]', (a) => a.textContent.trim())).toMatch(/My Storefront/);
    expect(await page.getAttribute('.adv-rail a.adv-nav-item:has-text("Dashboard Home")', 'href')).toBe('/app.html#home');
    // the page's own content is inside the frame, once
    expect(await page.$$eval('#adv-main h1', (h) => h.map((x) => x.textContent.trim()))).toEqual(['My Storefront']);
    // the link: read-only, View and Copy Link; no slug field
    expect(await page.$('#s-slug')).toBeNull();
    expect(await page.textContent('#s-link')).toMatch(/\/pro\/timeless-treasures$/);
    expect(await page.isVisible('#copyLinkBtn')).toBe(true);
    // not published: says so, and View waits for publishing
    expect(await page.isChecked('#s-pub')).toBe(false);
    expect(await page.textContent('#s-pub-state')).toMatch(/not public yet[\s\S]*Items you publish are listed separately/);
    expect(await page.getAttribute('#viewBtn', 'aria-disabled')).toBe('true');
    // a tab change moves the highlight with it
    await page.click('#t-market');
    await page.waitForFunction(() => /Add Item/.test((document.querySelector('.adv-rail a[aria-current="page"]') || {}).textContent || ''));
    await page.click('#t-widget');
    await page.waitForFunction(() => /Website Widgets/.test((document.querySelector('.adv-rail a[aria-current="page"]') || {}).textContent || ''));
    // back to Dashboard Home from the sidebar
    await Promise.all([page.waitForURL(/\/app\.html/), page.click('.adv-rail a.adv-nav-item:has-text("Dashboard Home")')]);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('Inventory, Orders, Create Auction, Payouts and Auction Payments are framed too, each with its own section marked', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await seed.browserLogin(page, stack, T.email);
    for (const [p, label] of [['/seller-inventory.html', 'Manage Inventory'], ['/seller-orders.html', 'Orders'], ['/seller-create.html', 'Create Auction'],
      ['/payout-profile.html', 'Payouts'], ['/seller-settlements.html', 'Auction Payments']]) {
      await page.goto(stack.baseUrl + p);
      await page.waitForSelector('.adv-rail', { state: 'visible' });
      expect([p, await page.$eval('.adv-rail a[aria-current="page"]', (a) => a.textContent.trim())]).toEqual([p, expect.stringContaining(label)]);
      expect([p, await page.$$eval('header.adv-header', (e) => e.length), await page.$('#buyer-nav'), await page.$('#hdr')]).toEqual([p, 1, null, null]);
      expect([p, await page.$eval('#adv-main', (m) => m.children.length > 0)]).toEqual([p, true]);
      // the frame's own controls are not restyled by the page (e.g. a page that styles every button)
      const sw = await page.$eval('#adv-mode-switch .adv-mode-opt:not(.on)', (b) => getComputedStyle(b).marginTop);
      expect([p, sw]).toEqual([p, '0px']);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

describe('phone: a clear Menu that opens and closes by touch and keyboard, keeping what was typed', () => {
  test('Menu, Close, Escape and a tap outside; focus moves in and back; Dashboard Home is always one tap away', async () => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await seed.browserLogin(page, stack, T.email, seed.TEST_PASSWORD, '/seller-storefront.html?tab=store');
    await page.waitForSelector('#adv-more-btn', { state: 'visible' });
    expect(await page.isVisible('.adv-rail')).toBe(false);
    expect(await page.textContent('#adv-more-btn')).toMatch(/Menu/);
    // unsaved typing on the page
    await page.waitForSelector('#s-tagline', { state: 'visible' });
    await page.fill('#s-tagline', 'Unsaved tagline in progress');
    // open by touch
    await page.tap('#adv-more-btn');
    await page.waitForSelector('#adv-more', { state: 'visible' });
    expect(await page.getAttribute('#adv-more-btn', 'aria-expanded')).toBe('true');
    const sheet = await page.textContent('#adv-more');
    for (const l of ['Dashboard Home', 'Add Item', 'Manage Inventory', 'My Storefront', 'Orders', 'Create Auction', 'Seller Settings']) expect(sheet).toContain(l);
    expect(await page.$eval('#adv-more a[aria-current="page"]', (a) => a.textContent.trim())).toMatch(/My Storefront/);
    expect(await page.evaluate(() => document.activeElement && document.activeElement.closest('#adv-more') !== null)).toBe(true);
    // Escape closes and returns focus to the Menu button
    await page.keyboard.press('Escape');
    await page.waitForSelector('#adv-more', { state: 'hidden' });
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('adv-more-btn');
    // keyboard: Enter on the focused Menu button opens it; Close closes it
    await page.keyboard.press('Enter');
    await page.waitForSelector('#adv-more', { state: 'visible' });
    await page.tap('#adv-more-close');
    await page.waitForSelector('#adv-more', { state: 'hidden' });
    // a tap outside closes it
    await page.tap('#adv-more-btn');
    await page.waitForSelector('#adv-more', { state: 'visible' });
    await page.tap('#adv-title');
    await page.waitForSelector('#adv-more', { state: 'hidden' });
    expect(await page.getAttribute('#adv-more-btn', 'aria-expanded')).toBe('false');
    // the page was never reloaded: the unsaved text is still there
    expect(await page.inputValue('#s-tagline')).toBe('Unsaved tagline in progress');
    // the Buying / Selling switch is in the header on a phone
    expect(await page.isVisible('.adv-header .adv-mode-mini button[data-mode="buying"]')).toBe(true);
    // Dashboard Home from the Menu
    await page.tap('#adv-more-btn');
    await Promise.all([page.waitForURL(/\/app\.html/), page.tap('#adv-more a.adv-nav-item:has-text("Dashboard Home")')]);
    await ctx.close();
  });
});
