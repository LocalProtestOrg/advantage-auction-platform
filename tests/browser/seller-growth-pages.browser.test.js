'use strict';

/**
 * The professional seller demo (/seller-demo) and the Seller How To Center (/seller-how-to), as SERVED by the real app in
 * a real browser on the isolated full-stack environment (never production). Owner roadmap items A and B (2026-11-04).
 */

const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(240000);
let stack; let browser;
const ALLOW = { allowConsoleErrors: [/net::ERR_FAILED/] };
const BANNED = /\bAI\b|A\.I\.|artificial intelligence|machine learning|\bOpenAI\b|\bGPT\b|\bLLM\b|coming soon|—|–/i;   // no long dashes in customer copy

beforeAll(async () => { stack = await startStack(); browser = await chromium.launch(); });
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

async function open(ctxOpts, path) {
  const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  const probe = health.attach(page, { origin: stack.baseUrl });
  await page.goto(stack.baseUrl + path, { waitUntil: 'networkidle' });
  return { ctx, page, probe };
}

test('clean addresses; the .html forms redirect; both are in the sitemap', async () => {
  for (const p of ['/seller-demo', '/seller-how-to']) {
    expect((await fetch(stack.baseUrl + p)).status).toBe(200);
    const r = await fetch(stack.baseUrl + p + '.html?utm_source=x', { redirect: 'manual' });
    expect([r.status, r.headers.get('location')]).toEqual([301, p + '?utm_source=x']);
  }
  const map = await (await fetch(stack.baseUrl + '/sitemap.xml')).text();
  expect(map).toContain('/seller-demo</loc>'); expect(map).toContain('/seller-how-to</loc>');
});

describe('seller demo', () => {
  test.each([['desktop', {}], ['phone', devices['iPhone 13']], ['small phone (360px)', devices['Galaxy S8']]])('%s: renders cleanly; every view works', async (label, ctxOpts) => {
    const { ctx, page, probe } = await open(ctxOpts, '/seller-demo');
    await page.fill('#d-name', 'Harbor Estate Sales');
    const tabs = await page.$$eval('#d-tabs button', (b) => b.map((x) => x.textContent));
    expect(tabs).toEqual(['Your storefront', 'On your website', 'On Advantage.Bid', 'Easy cataloging', 'Auction day', 'More consignments']);
    for (const t of tabs) {
      await page.click(`#d-tabs button:has-text("${t}")`);
      const issues = await health.inspect(page, probe, { ...ALLOW, expectText: ['See your business on Advantage.Bid'] });
      expect([t, issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')]).toEqual([t, []]);
      expect(await page.textContent('#d-explain h2')).toBeTruthy();
    }
    await page.click('#d-tabs button:has-text("Your storefront")');
    expect(await page.textContent('#d-preview')).toMatch(/Harbor Estate Sales[\s\S]*bid\.advantage\.bid\/pro\/harbor-estate-sales/);
    expect(await page.textContent('#d-preview .logo')).toBe('HE');
    expect(await page.textContent('body')).not.toMatch(BANNED);
    await ctx.close();
  });
  test('the call to action opens the existing professional registration with the chosen type and the outreach tags', async () => {
    const { ctx, page } = await open({}, '/seller-demo?utm_source=kymmie&utm_medium=outreach&utm_campaign=pro&evil=1');
    await page.selectOption('#d-type', 'auction_house');
    const href = await page.getAttribute('#d-cta', 'href');
    const u = new URL(href, stack.baseUrl);
    expect(u.pathname).toBe('/become-professional-seller.html');
    expect(Object.fromEntries(u.searchParams)).toEqual({ seller_type: 'auction_house', utm_source: 'kymmie', utm_medium: 'outreach', utm_campaign: 'pro' });
    await ctx.close();
  });
});

describe('Seller How To Center', () => {
  test.each([['desktop', {}], ['small phone (360px)', devices['Galaxy S8']]])('%s: renders cleanly with every guide', async (label, ctxOpts) => {
    const { ctx, page, probe } = await open(ctxOpts, '/seller-how-to');
    const issues = await health.inspect(page, probe, { ...ALLOW, expectText: ['Seller How To Center', "painter's tape", 'Lot numbering', 'Photography that sells', 'Pickup preparation', 'Printables'] });
    expect(issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')).toEqual([]);
    expect(await page.textContent('body')).not.toMatch(BANNED);
    await ctx.close();
  });
  test('printables: 30 labels per sheet with the lot numbers, worksheet rows, both checklists', async () => {
    const { ctx, page } = await open({}, '/seller-how-to');
    await page.fill('#l-from', '101'); await page.fill('#l-to', '135'); await page.fill('#l-seller', 'Harbor Estate Sales'); await page.fill('#l-auction', 'Westside Estate');
    await page.click('#p-labels');
    const sheets = await page.$$eval('#print-area .labels', (s) => s.map((x) => x.children.length));
    expect(sheets).toEqual([30, 5]);
    const first = await page.textContent('#print-area .label');
    expect(first).toMatch(/LOT 101[\s\S]*Westside Estate[\s\S]*Harbor Estate Sales[\s\S]*Advantage\.Bid/);
    expect(await page.evaluate(() => window.__printed)).toBe(1);
    await page.fill('#w-pages', '2'); await page.fill('#w-from', '201'); await page.click('#p-worksheet');
    expect(await page.$$eval('#print-area tbody tr', (r) => r.length)).toBe(30);
    expect(await page.$$eval('#print-area tbody tr td:first-child', (c) => [c[0].textContent, c[29].textContent])).toEqual(['201', '230']);
    await page.click('#p-setup');
    expect(await page.textContent('#print-area h1')).toBe('Advantage.Bid Auction Setup Checklist');
    await page.click('#p-pickup');
    expect(await page.textContent('#print-area')).toMatch(/paid invoice/);
    // printing shows only the printable, on Letter paper
    await page.emulateMedia({ media: 'print' });
    expect(await page.isVisible('main')).toBe(false); expect(await page.isVisible('#print-area')).toBe(true);
    await ctx.close();
  });
  test('reachable from the auction creation page and the Seller FAQ', async () => {
    const fs = require('fs'); const path = require('path');
    for (const f of ['seller-create.html', 'seller-faq.html']) expect(fs.readFileSync(path.join(__dirname, '..', '..', 'public', f), 'utf8')).toMatch(/href="\/seller-how-to"/);
  });
});
