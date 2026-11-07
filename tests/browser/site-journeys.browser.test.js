'use strict';

/**
 * Site watchdog: stateful user journeys in a real browser (Chromium), against the real app on the real schema in the
 * ISOLATED test environment (tests/fullstack: in-memory database, no payment processor, no email provider). These
 * journeys register, sign in, bid and change data, so they run here and NEVER against production (the production
 * watchdog only reads pages: scripts/watchdog-browser.js).
 *
 * Every page is inspected with src/services/watchdog/pageHealth.js; any critical problem (script error, raw script
 * text, failed same-site request, missing content, placeholders) fails the journey. Requests to other sites are
 * blocked so the journeys are self-contained.
 */

const crypto = require('crypto');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const sj = require('../fullstack/seedJourneys');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(240000);

let stack; let browser;
const people = {};

// Blocked off-site requests log "net::ERR_FAILED" in the console; same-site failures are still caught as REQUEST_FAILED.
const ALLOW = { allowConsoleErrors: [/net::ERR_FAILED/] };

async function open(context) {
  const page = await context.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  return page;
}
async function visit(page, path, opts = {}) {
  const probe = health.attach(page, { origin: stack.baseUrl });
  // Live pages (auctions, lots) poll for updates and never go network-idle: they wait for their content instead.
  const res = await page.goto(stack.baseUrl + path, { waitUntil: opts.waitFor ? 'load' : 'networkidle' });
  if (opts.waitFor) { await page.waitForSelector(opts.waitFor, { timeout: 20000 }); await page.waitForTimeout(500); }
  const issues = await health.inspect(page, probe, { ...ALLOW, ...opts });
  return { res, issues, critical: health.critical(issues) };
}
const api = async (method, path, token, body) => {
  const r = await fetch(stack.baseUrl + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'Idempotency-Key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
};

beforeAll(async () => {
  stack = await startStack();
  people.adminId = await seed.user(stack, { email: 'ops-admin@fullstack.test', role: 'admin', fullName: 'Ola Operator' });
  people.buyerId = await seed.user(stack, { email: 'bidder@fullstack.test', role: 'buyer', fullName: 'Bea Bidder' });
  people.auctionSellerId = await seed.user(stack, { email: 'auctioneer@fullstack.test', role: 'seller', fullName: 'Al Auctioneer' });
  people.auctionSellerProfile = await seed.sellerProfile(stack, { userId: people.auctionSellerId, sellerType: 'auction_house', displayName: 'Al Auctions', extra: { agreement_waived_at: new Date() } });
  Object.assign(people, await sj.liveAuctionWithLot(stack, { sellerProfileId: people.auctionSellerProfile }));
  people.shop = await sj.publishedStorefront(stack);
  people.itemId = await sj.publishedItem(stack, { sellerProfileId: people.shop.sellerProfileId });
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

describe('front door', () => {
  test('homepage renders cleanly and its navigation leads to working pages (desktop and phone)', async () => {
    for (const ctxOpts of [{}, { ...devices['iPhone 13'] }]) {
      const ctx = await browser.newContext(ctxOpts); const page = await open(ctx);
      const home = await visit(page, '/', { expectText: ['Advantage'], checkOverflow: !!ctxOpts.isMobile });
      expect(home.res.status()).toBe(200);
      expect(home.critical).toEqual([]);
      const links = await page.$$eval('a[href^="/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))].filter((h) => /^\/(search|browse-categories|past-auctions|login)\.html/.test(h)));
      expect(links.length).toBeGreaterThan(1);
      for (const href of links.slice(0, 4)) {
        const r = await visit(page, href);
        expect([href, r.res.status(), r.critical]).toEqual([href, 200, []]);
      }
      await ctx.close();
    }
  });

  test('search and filtering show a live auction lot', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    const r = await visit(page, '/search.html?q=' + encodeURIComponent('Walnut'));
    expect(r.critical).toEqual([]);
    const api1 = await (await fetch(stack.baseUrl + '/api/public/lots/search?q=Walnut')).json();
    expect(JSON.stringify(api1)).toMatch(/Walnut Writing Desk/);
    await ctx.close();
  });
});

describe('accounts', () => {
  test('registration through the form creates an account and signs the person in', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    const r = await visit(page, '/login.html');
    expect(r.critical).toEqual([]);
    await page.click('#tab-register');
    await page.fill('#reg-email', 'new-buyer@fullstack.test');
    await page.fill('#reg-password', seed.TEST_PASSWORD);
    await page.fill('#reg-confirm', seed.TEST_PASSWORD);
    await page.check('#reg-terms');   // explicit acceptance of the Terms of Service and Buyer Terms (owner 2026-11-06)
    await Promise.all([page.waitForURL((u) => !/login\.html/.test(String(u)), { timeout: 20000 }), page.click('#register-btn')]);
    expect(await page.evaluate(() => !!localStorage.getItem('token'))).toBe(true);
    expect((await stack.query(`SELECT count(*)::int n FROM users WHERE email = 'new-buyer@fullstack.test'`)).rows[0].n).toBe(1);
    await ctx.close();
  });

  test('sign in through the form reaches the member area (buyer account access)', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    await seed.browserLogin(page, stack, 'bidder@fullstack.test');
    // the member area renders its main section (it makes several API calls at once; the isolated database answers them one
    // at a time, so under a full-suite load "network idle" can take longer than the timeout; the page itself is ~0.7 s)
    const r = await visit(page, '/app.html', { waitFor: '#adv-main' });
    expect(r.critical).toEqual([]);
    const me = await page.evaluate(async () => (await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } })).status);
    expect(me).toBe(200);
    await ctx.close();
  });

  test('password reset request shows the generic confirmation (no email provider in this environment)', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    const r = await visit(page, '/forgot-password.html');
    expect(r.critical).toEqual([]);
    await page.fill('#email', 'bidder@fullstack.test');
    await page.click('#btn');
    await page.waitForFunction(() => /reset link|If an account exists/i.test(document.body.innerText));
    expect(health.critical(await health.inspect(page, health.attach(page, { origin: stack.baseUrl }), ALLOW))).toEqual([]);
    await ctx.close();
  });
});

describe('auctions: pages, bidding and watchlist', () => {
  test('auction and lot pages render the live lot', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    const a = await visit(page, '/auction-view.html?id=' + people.auctionId, { waitFor: 'text=Walnut Writing Desk' });
    expect(a.critical).toEqual([]);
    const l = await visit(page, '/lot.html?id=' + people.lotId, { waitFor: 'text=Walnut Writing Desk' });
    expect(l.critical).toEqual([]);
    await ctx.close();
  });

  test('an eligible buyer bids and watches the lot; the bid and watchlist are recorded', async () => {
    await sj.buyerReadyToBid(stack, { userId: people.buyerId, auctionId: people.auctionId });
    const token = await seed.apiLogin(stack, 'bidder@fullstack.test');
    const bid = await api('POST', `/api/lots/${people.lotId}/bids`, token, { amount: 5 });
    expect([bid.status, bid.j && bid.j.success]).toEqual([200, true]);
    expect((await stack.query('SELECT count(*)::int n FROM bids WHERE lot_id = $1 AND bidder_user_id = $2', [people.lotId, people.buyerId])).rows[0].n).toBeGreaterThan(0);
    expect((await api('POST', '/api/watchlist/add', token, { lotId: people.lotId })).status).toBe(200);
    const list = await api('GET', '/api/watchlist', token);
    expect(JSON.stringify(list.j)).toMatch(new RegExp(people.lotId));
    // A seller can never bid on their own auction.
    const own = await api('POST', `/api/lots/${people.lotId}/bids`, await seed.apiLogin(stack, 'auctioneer@fullstack.test'), { amount: 10 });
    expect(own.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Professional Seller storefront (dual distribution)', () => {
  test('the product page, the storefront page and the embedded widget all show the published item', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    const item = await visit(page, '/shop/item/' + people.itemId, { expectText: ['Brass Ship Lantern'] });
    expect([item.res.status(), item.critical]).toEqual([200, []]);
    const store = await visit(page, '/pro/' + people.shop.slug, { waitFor: 'text=Brass Ship Lantern' });
    expect(store.critical).toEqual([]);
    const widget = await visit(page, '/embed/storefront.html?seller=' + people.shop.sellerProfileId, { waitFor: 'text=Brass Ship Lantern' });
    expect(widget.critical).toEqual([]);
    const feed = await (await fetch(stack.baseUrl + '/api/public/storefront/widget/' + people.shop.sellerProfileId)).json();
    expect(JSON.stringify(feed)).toMatch(/Brass Ship Lantern/);
    await ctx.close();
  });

  test('the seller dashboard and inventory workspace load for the seller', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    await seed.browserLogin(page, stack, people.shop.email);
    const app = await visit(page, '/app.html', { waitFor: '#adv-main' });
    expect(app.critical).toEqual([]);
    const inv = await visit(page, '/seller-inventory.html', { waitFor: 'text=Brass Ship Lantern' });
    expect(inv.critical).toEqual([]);
    await ctx.close();
  });
});

describe('administration', () => {
  test('an administrator opens the site watchdog dashboard and runs the checks against this environment', async () => {
    const ctx = await browser.newContext(); const page = await open(ctx);
    await seed.browserLogin(page, stack, 'ops-admin@fullstack.test', seed.TEST_PASSWORD, '/admin/site-watchdog.html');
    const r = await visit(page, '/admin/site-watchdog.html', { waitFor: '#checks table' });
    expect(r.critical).toEqual([]);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const run = await api('POST', '/api/admin/watchdog/run', token, { ids: ['served-pages', 'health', 'home', 'login'] });
    expect([run.status, run.j.data.ran]).toEqual([200, 4]);
    const users = await visit(page, '/admin/users.html');
    expect(users.critical).toEqual([]);
    await ctx.close();
  });
});
