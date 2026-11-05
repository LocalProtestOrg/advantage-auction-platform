'use strict';

/**
 * Professional Seller welcome email, end to end on the isolated full-stack environment (the REAL app and schema; never
 * production; no mail service is configured there, so nothing can be sent: a delivered welcome is recorded 'skipped').
 * Owner request 2026-11-05: once per new Professional Seller registration, never for buyers, Individual Sellers, logins
 * or repeat submissions; links to the real seller dashboard and resources; reads well on a phone and on a desktop.
 */

const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const { buildWelcomeEmail } = require('../../src/services/professionalSellerEmails');

jest.setTimeout(240000);
let stack; let browser;
beforeAll(async () => { stack = await startStack(); browser = await chromium.launch(); });
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

const api = async (token, method, p, body) => {
  const r = await fetch(stack.baseUrl + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const welcomes = async (email) => (await stack.query(
  `SELECT w.status, w.attempts, w.recipient_email FROM seller_welcome_emails w JOIN users u ON u.id = w.user_id WHERE u.email = $1`, [email])).rows;
const settle = async (email, want) => { for (let i = 0; i < 40; i++) { const r = await welcomes(email); if (r.length && r.every((x) => x.status !== 'pending' && x.status !== 'processing')) return r; if (want === 0) return r; await new Promise((s) => setTimeout(s, 250)); } return welcomes(email); };
const PRO = { seller_type: 'estate_sale_company', company_name: 'Harbor Estate Sales', phone: '5551234567', state: 'TX' };

test('a new Professional Seller registration queues exactly one welcome and delivers it at once; repeat submissions add nothing', async () => {
  await seed.user(stack, { email: 'new-pro@fullstack.test', role: 'buyer' });
  const token = await seed.apiLogin(stack, 'new-pro@fullstack.test');
  const first = await api(token, 'POST', '/api/sellers/apply-professional', PRO);
  expect(first.status).toBe(201);
  const rows = await settle('new-pro@fullstack.test');
  // one welcome; the immediate attempt ran (no mail service here, so it is recorded as skipped, never as sent)
  expect(rows).toEqual([{ status: 'skipped', attempts: 1, recipient_email: 'new-pro@fullstack.test' }]);
  for (let i = 0; i < 3; i++) expect((await api(token, 'POST', '/api/sellers/apply-professional', PRO)).status).toBe(200);
  await seed.apiLogin(stack, 'new-pro@fullstack.test');                       // an ordinary sign-in
  expect(await welcomes('new-pro@fullstack.test')).toHaveLength(1);
});

test('buyers, Individual Sellers and sign-ins get no Professional Seller welcome; an Individual upgrading to Professional gets one', async () => {
  await seed.user(stack, { email: 'just-buyer@fullstack.test', role: 'buyer' });
  await seed.apiLogin(stack, 'just-buyer@fullstack.test');
  expect(await welcomes('just-buyer@fullstack.test')).toEqual([]);
  await seed.user(stack, { email: 'individual@fullstack.test', role: 'buyer' });
  const t = await seed.apiLogin(stack, 'individual@fullstack.test');
  const enr = await api(t, 'POST', '/api/sellers/enroll', { seller_type: 'private', display_name: 'Pat Private', phone: '5559876543' });
  expect([200, 201]).toContain(enr.status);
  expect(await settle('individual@fullstack.test', 0)).toEqual([]);
  expect((await api(t, 'POST', '/api/sellers/apply-professional', { ...PRO, company_name: 'Pat Pro Liquidators', seller_type: 'professional_liquidator' })).status).toBe(200);
  expect((await settle('individual@fullstack.test')).map((r) => r.status)).toEqual(['skipped']);
});

test('every link in the email reaches a real destination; the dashboard is the authenticated member area', async () => {
  const m = buildWelcomeEmail({ companyName: 'Harbor Estate Sales' });
  const paths = [...new Set([...m.html.matchAll(/(?:href|src)="https:\/\/bid\.advantage\.bid(\/[^"]*)"/g)].map((x) => x[1]))];
  expect(paths.sort()).toEqual(['/app.html', '/img/brand/advantage-bid-logo-white.png', '/seller-demo', '/seller-how-to']);
  expect((await fetch(stack.baseUrl + '/seller-demo')).status).toBe(200);                         // public
  // The How To Center is for Professional Sellers: signed out, the email link goes to sign-in and back to it.
  const howOut = await fetch(stack.baseUrl + '/seller-how-to', { redirect: 'manual' });
  expect([howOut.status, howOut.headers.get('location')]).toEqual([302, '/login.html?next=%2Fseller-how-to']);
  const logo = await fetch(stack.baseUrl + '/img/brand/advantage-bid-logo-white.png');
  // the logo may be shown inside any mail client or website (not limited to this site)
  expect([logo.status, logo.headers.get('content-type'), logo.headers.get('cross-origin-resource-policy')]).toEqual([200, 'image/png', 'cross-origin']);
  // signed out: the dashboard sends the visitor to sign in and back to the dashboard
  const out = await fetch(stack.baseUrl + '/app.html', { redirect: 'manual', headers: { Accept: 'text/html' } });
  expect(out.status).toBeGreaterThanOrEqual(300); expect(out.status).toBeLessThan(400);
  expect(decodeURIComponent(out.headers.get('location') || '')).toMatch(/login\.html\?next=\/app\.html/);
  // signed in as the new Professional Seller: the dashboard opens
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  await seed.browserLogin(page, stack, 'new-pro@fullstack.test', seed.TEST_PASSWORD, '/app.html');
  expect(new URL(page.url()).pathname).toBe('/app.html');
  // ...and the new Professional Seller opens the How To Center from the email link
  const how = await page.goto(stack.baseUrl + '/seller-how-to');
  expect([how.status(), new URL(page.url()).pathname]).toEqual([200, '/seller-how-to']);
  await ctx.close();
});

test.each([['phone', { width: 375, height: 812 }], ['desktop', { width: 1280, height: 900 }]])('the email reads well on a %s: no sideways scrolling, the button is visible and tappable', async (label, viewport) => {
  const m = buildWelcomeEmail({ companyName: 'Harbor Estate Sales and Appraisal Services of Westchester' });
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  await page.setContent(m.html.replace(/https:\/\/bid\.advantage\.bid/g, stack.baseUrl), { waitUntil: 'load' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const btn = await page.locator('a:has-text("Go To Your Seller Dashboard")').boundingBox();
  expect(btn.height).toBeGreaterThanOrEqual(40); expect(btn.x + btn.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.$eval('img[alt="Advantage.Bid"]', (i) => i.complete && i.naturalWidth > 0)).toBe(true);
  const small = await page.$$eval('p, td div', (els) => els.filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 11).length);
  expect(small).toBe(0);
  await ctx.close();
});
