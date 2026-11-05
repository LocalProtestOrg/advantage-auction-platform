'use strict';

/**
 * Seller How To Center access (owner decision 2026-11-05): Professional Sellers and administrators only, enforced on the
 * server for the page, its scripts (checklists, worksheet, label geometry, pickup note templates) and the label PDF,
 * including direct, encoded and differently-cased addresses. The Seller Demo stays public and indexable. Real app on the
 * isolated full-stack environment (never production).
 */

const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const gate = require('../../src/middleware/sellerResourceGate');

jest.setTimeout(240000);
let stack; let browser; const T = {};
const PROTECTED_FILES = ['/js/seller-how-to.js', '/js/lot-label-layout.js', '/widgets/shared/pickup-note-templates.js', '/api/seller-resources/lot-labels.pdf?from=1&to=30'];
const DISGUISED = ['/Seller-How-To', '/SELLER-HOW-TO.HTML', '/seller-how-to%2Ehtml', '/seller-how-to/', '/js/../seller-how-to.html', '/JS/Seller-How-To.js', '/js/seller-how-to%2Ejs'];

beforeAll(async () => {
  stack = await startStack(); browser = await chromium.launch();
  const mk = async (key, role, sellerType) => {
    const email = key + '@fullstack.test';
    const userId = await seed.user(stack, { email, role, fullName: key });
    if (sellerType) await seed.sellerProfile(stack, { userId, sellerType, displayName: key + ' Co' });
    T[key] = { email, userId, token: await seed.apiLogin(stack, email) };
  };
  await mk('pro', 'seller', 'auction_house');
  await mk('retail', 'seller', 'retail_gallery_studio');
  await mk('individual', 'seller', 'private');
  await mk('business', 'seller', 'business');
  await mk('buyer', 'buyer', null);
  await mk('admin', 'admin', null);
  await mk('suspended', 'seller', 'estate_sale_company');
  await stack.query('UPDATE users SET is_active = false WHERE id = $1', [T.suspended.userId]);
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

const get = (p, token, extra = {}) => fetch(stack.baseUrl + p, { redirect: 'manual', ...extra, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(extra.headers || {}) } });
const privateHeaders = (r) => [r.headers.get('cache-control'), r.headers.get('x-robots-tag')];

test('path matching resolves addresses the way the static server does (decoded, normalized, any case)', () => {
  expect(['/Seller-How-To', '/seller-how-to%2Ehtml', '/seller-how-to/', '/js/../seller-how-to.html', '/JS/SELLER-HOW-TO.JS'].map(gate.servedPath))
    .toEqual(['/seller-how-to', '/seller-how-to.html', '/seller-how-to', '/seller-how-to.html', '/js/seller-how-to.js']);
  expect(gate.servedPath('/%E0%A4%A')).toBeNull();
});

test('signed out: the page sends the visitor to sign in and back; every protected file is refused; nothing is cached or indexed', async () => {
  for (const p of ['/seller-how-to', '/seller-how-to.html', '/seller-how-to?utm_source=email']) {
    const r = await get(p);
    expect([p, r.status]).toEqual([p, 302]);
    expect(r.headers.get('location')).toMatch(/^\/login\.html\?next=%2Fseller-how-to/);
    expect(privateHeaders(r)).toEqual(['private, no-store, must-revalidate', 'noindex, nofollow, noarchive']);
  }
  expect((await get('/seller-how-to?utm_source=email')).headers.get('location')).toBe('/login.html?next=%2Fseller-how-to%3Futm_source%3Demail');
  for (const p of PROTECTED_FILES) {
    const r = await get(p);
    expect([p, r.status]).toEqual([p, 401]);
    expect(privateHeaders(r)).toEqual(['private, no-store, must-revalidate', 'noindex, nofollow, noarchive']);
    expect(await r.text()).not.toMatch(/Pickup Day Checklist|IMPORTANT: Buyer is responsible|AVERY_5160/);
  }
  for (const p of DISGUISED) expect([p, [302, 401].includes((await get(p)).status)]).toEqual([p, true]);
  // the old public download address is gone
  expect((await get('/api/public/printables/lot-labels.pdf')).status).toBe(404);
});

test('signed in but not allowed (buyer, Individual Sellers, a suspended Professional): a 403 page pointing to the demo; files refused', async () => {
  for (const who of ['buyer', 'individual', 'business', 'suspended']) {
    const page = await get('/seller-how-to', T[who].token);
    expect([who, page.status]).toEqual([who, 403]);
    const html = await page.text();
    expect(html).toMatch(/The Seller How To Center is for Professional Sellers/);
    expect(html).toMatch(/href="\/seller-demo"/);
    expect(html).toMatch(/<meta name="robots" content="noindex,nofollow">/);
    expect(html).not.toMatch(/Organize your auction location|Pickup Day Checklist/);
    for (const p of [...PROTECTED_FILES, ...DISGUISED]) expect([who, p, (await get(p, T[who].token)).status]).toEqual([who, p, 403]);
  }
});

test('Professional Sellers (any professional type) and administrators get the page, its scripts and the downloads', async () => {
  for (const who of ['pro', 'retail', 'admin']) {
    const page = await get('/seller-how-to', T[who].token);
    expect([who, page.status]).toEqual([who, 200]);
    expect(privateHeaders(page)).toEqual(['private, no-store, must-revalidate', 'noindex, nofollow, noarchive']);
    const html = await page.text();
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow, noarchive" \/>/);
    expect(html).not.toMatch(/rel="canonical"|og:url/);
    for (const p of PROTECTED_FILES) expect([who, p, (await get(p, T[who].token)).status]).toEqual([who, p, 200]);
    const pdf = await get('/api/seller-resources/lot-labels.pdf?mode=calibrate', T[who].token);
    expect([pdf.headers.get('content-type'), pdf.headers.get('cache-control')]).toEqual(['application/pdf', 'private, no-store']);
  }
});

test('a section link from the welcome email or the dashboard: sign in, then straight back to that section', async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  await page.goto(stack.baseUrl + '/seller-how-to#photos');
  expect(new URL(page.url()).pathname).toBe('/login.html');
  await page.fill('#login-email', T.pro.email); await page.fill('#login-password', seed.TEST_PASSWORD);
  await Promise.all([page.waitForURL((u) => /\/seller-how-to/.test(String(u)), { timeout: 30000 }), page.click('#login-btn')]);
  const u = new URL(page.url());
  expect([u.pathname, u.hash]).toEqual(['/seller-how-to', '#photos']);
  await page.waitForSelector('#photos');
  // signed in with the browser session (cookie), the printable tools work: the label PDF downloads
  const status = await page.evaluate(async () => (await fetch('/api/seller-resources/lot-labels.pdf?from=1&to=3')).status);
  expect(status).toBe(200);
  await ctx.close();
});

test('the public Seller Demo stays open and indexable; the How To Center is out of the sitemap and disallowed for crawlers', async () => {
  const demo = await get('/seller-demo');
  expect(demo.status).toBe(200);
  expect(demo.headers.get('x-robots-tag')).toBeNull();
  const html = await demo.text();
  expect(html).toMatch(/<link rel="canonical" href="https:\/\/bid\.advantage\.bid\/seller-demo" \/>/);
  expect(html).not.toMatch(/noindex/);
  const map = await (await get('/sitemap.xml')).text();
  expect(map).toContain('/seller-demo</loc>'); expect(map).not.toMatch(/seller-how-to/);
  const robots = await (await get('/robots.txt')).text();
  expect((robots.match(/^Disallow: \/seller-how-to$/gm) || []).length).toBe(2);   // every crawler group
});
