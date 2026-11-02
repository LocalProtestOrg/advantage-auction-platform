'use strict';

/**
 * /sell-online (Professional Seller Storefront marketing page) as SERVED by the real app, in a real browser, on the
 * isolated full-stack environment (tests/fullstack; never production). Checks the page is healthy on desktop and a
 * phone, the CTAs reach the existing professional registration (no second sign-up), every internal link works, the
 * search markup is valid and matches the visible FAQ, and the copy keeps to the approved pricing and public-language rules.
 */

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(180000);

let stack; let browser;
const ALLOW = { allowConsoleErrors: [/net::ERR_FAILED/] };
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'sell-online.html'), 'utf8');

async function open(ctxOpts = {}) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  return { ctx, page };
}

beforeAll(async () => { stack = await startStack({ env: { SELL_ONLINE_PAGE_ENABLED: 'true' } }); browser = await chromium.launch(); });
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

test('served at the clean address; the .html address redirects to it; listed in the sitemap', async () => {
  const r = await fetch(stack.baseUrl + '/sell-online');
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toMatch(/html/);
  const old = await fetch(stack.baseUrl + '/sell-online.html', { redirect: 'manual' });
  expect(old.status).toBe(301);
  expect(old.headers.get('location')).toBe('/sell-online');
  const map = await (await fetch(stack.baseUrl + '/sitemap.xml')).text();
  expect(map).toMatch(/<loc>[^<]*\/sell-online<\/loc>/);
});

test.each([['desktop', {}], ['phone', devices['iPhone 13']]])('%s: renders cleanly, readable, no sideways scrolling', async (label, ctxOpts) => {
  const { ctx, page } = await open(ctxOpts);
  const probe = health.attach(page, { origin: stack.baseUrl });
  await page.goto(stack.baseUrl + '/sell-online', { waitUntil: 'networkidle' });
  const issues = await health.inspect(page, probe, { ...ALLOW, expectText: ['Your Shop. Your Website.', 'Pay only when you sell', 'Made for independent shops, galleries and makers', 'From sign-up to your first listing'], checkOverflow: true });
  expect(issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')).toEqual([]);
  // Reading text is at least 18px everywhere on the page.
  const small = await page.$$eval('main p, main li, main summary', (els) => els.filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 18).map((e) => e.textContent.trim().slice(0, 40)));
  expect(small).toEqual([]);
  await ctx.close();
});

test('staged (launch switch off): both addresses answer 404 and the sitemap leaves it out, never the static file', async () => {
  const off = await startStack();
  try {
    for (const p of ['/sell-online', '/sell-online.html']) {
      const r = await fetch(off.baseUrl + p, { redirect: 'manual', headers: { Accept: 'text/html' } });
      expect([p, r.status]).toEqual([p, 404]);
      expect(await r.text()).not.toMatch(/Your Shop\. Your Website\./);
    }
    expect(await (await fetch(off.baseUrl + '/sitemap.xml')).text()).not.toMatch(/sell-online/);
  } finally { await off.stop(); }
});

test('one H1, ordered headings, a canonical address and a description', async () => {
  const { ctx, page } = await open();
  await page.goto(stack.baseUrl + '/sell-online', { waitUntil: 'networkidle' });
  expect(await page.$$eval('h1', (h) => h.map((x) => x.textContent.trim()))).toEqual(['Your Shop. Your Website. A Bigger Marketplace.']);
  const levels = await page.$$eval('main h1, main h2, main h3', (hs) => hs.map((h) => Number(h.tagName[1])));
  for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  expect(await page.$eval('link[rel=canonical]', (l) => l.href)).toBe('https://bid.advantage.bid/sell-online');
  const desc = await page.$eval('meta[name=description]', (m) => m.content);
  expect(desc.length).toBeGreaterThan(70); expect(desc.length).toBeLessThanOrEqual(165);
  expect(await page.title()).toMatch(/Advantage\.Bid$/);
  await ctx.close();
});

test('calls to action go to the existing professional registration, with Title Case labels; every internal link works', async () => {
  const { ctx, page } = await open();
  await page.goto(stack.baseUrl + '/sell-online', { waitUntil: 'networkidle' });
  const ctas = await page.$$eval('main a.so-btn', (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })));
  const labels = new Set(ctas.map((c) => c.text));
  for (const l of ['Start Selling', 'See How It Works', 'Create Your Storefront']) expect(labels.has(l)).toBe(true);
  for (const c of ctas) {
    const minor = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for']);
    expect(c.text).toBe(c.text.split(' ').map((w, i) => (i > 0 && minor.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join(' '));
    if (/Start Selling|Create Your Storefront/.test(c.text)) expect(c.href).toBe('/become-professional-seller.html');
  }
  const internal = await page.$$eval('a[href^="/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href').split('#')[0]))].filter(Boolean));
  for (const href of internal) {
    const r = await fetch(stack.baseUrl + href, { redirect: 'manual' });
    expect([href, r.status < 400]).toEqual([href, true]);
  }
  for (const id of await page.$$eval('a[href^="#"]', (as) => as.map((a) => a.getAttribute('href').slice(1)))) expect(await page.$('#' + id)).not.toBeNull();
  await ctx.close();
});

test('structured data is valid JSON and the FAQ markup matches the visible FAQ exactly', async () => {
  const { ctx, page } = await open();
  await page.goto(stack.baseUrl + '/sell-online', { waitUntil: 'networkidle' });
  const ld = JSON.parse(await page.$eval('script[type="application/ld+json"]', (s) => s.textContent));
  const faq = ld['@graph'].find((n) => n['@type'] === 'FAQPage');
  const visible = await page.$$eval('.so-faq details', (ds) => ds.map((d) => ({ q: d.querySelector('summary').textContent.trim(), a: d.querySelector('p').textContent.trim() })));
  expect(faq.mainEntity.map((q) => ({ q: q.name, a: q.acceptedAnswer.text }))).toEqual(visible);
  expect(ld['@graph'].map((n) => n['@type'])).toEqual(expect.arrayContaining(['WebPage', 'Service', 'FAQPage']));
  await ctx.close();
});

test('copy keeps to approved pricing and the public language rules', () => {
  const text = SRC.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
  expect(text).toMatch(/flat 11% selling fee, which includes credit card processing/i);
  expect(text).toMatch(/not on shipping or sales tax/);
  // No other percentage, price or subscription amount is advertised.
  expect((text.match(/\d+(\.\d+)?%/g) || []).every((p) => p === '11%')).toBe(true);
  expect(text).not.toMatch(/\$\s?\d/);
  // No artificial-intelligence wording, no vendor names, no long dashes, no guarantees or nationwide claims.
  expect(text).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|OpenAI|GPT|Stripe|Cloudinary|Railway/i);
  expect(SRC).not.toMatch(/[–—]/);
  expect(text).not.toMatch(/guarantee|nationwide|zero fees|free forever/i);
  // Written for the finished service (no temporary or coming-soon wording); the new professional type is named.
  expect(text).not.toMatch(/coming soon|until then|not yet available|launching soon/i);
  expect(text).toMatch(/Retail Shop, Gallery or Studio/);
});
