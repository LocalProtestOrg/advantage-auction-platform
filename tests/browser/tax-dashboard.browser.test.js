'use strict';
/**
 * The Sales Tax dashboard (/admin/tax.html; migration 231) as served by the real app in a real browser on the isolated
 * full-stack environment (tests/fullstack; never production). Covers:
 *  - an administrator opens the page and sees the ledger totals for two states, correct to the cent, with the rule,
 *    registration and filing of each state, the all-states total, and no page errors;
 *  - the ledger tab lists the entries and never shows a buyer; seller reporting says filing is not enabled;
 *  - the page fits a phone-width screen without sideways scrolling;
 *  - the rules page offers only the two current options, shows a historical rule as Retired, and records a verification;
 *  - a seller account and a buyer account cannot open the page (the page gate sends them away) or read the API.
 */
const { chromium } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(120000);
let stack; let browser;
const ADMIN = 'taxpage-admin@fullstack.test';
const SELLER = 'taxpage-seller@fullstack.test';
const BUYER = 'taxpage-buyer@fullstack.test';
const S = {};

async function entry(e) {
  const cols = Object.keys(e);
  await stack.query(
    `INSERT INTO tax_ledger_entries (${cols.join(', ')}, occurred_at, tax_period)
     VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, now(), date_trunc('month', now() AT TIME ZONE 'America/New_York')::date)`, Object.values(e));
}

beforeAll(async () => {
  stack = await startStack();
  await seed.user(stack, { email: ADMIN, role: 'admin', fullName: 'Ada Admin' });
  const su = await seed.user(stack, { email: SELLER, role: 'seller', fullName: 'Sam Seller' });
  S.seller = await seed.sellerProfile(stack, { userId: su, sellerType: 'auction_house', displayName: 'Delta Auction Gallery' });
  S.buyer = await seed.user(stack, { email: BUYER, role: 'buyer', fullName: 'Bea Hiddenbuyer' });
  const base = { source_type: 'manual', seller_profile_id: S.seller, buyer_user_id: S.buyer };
  // Texas: Advantage.Bid remits. Two sales and a partial refund.
  await entry({ ...base, idempotency_key: 'b:tx1', entry_type: 'sale', channel: 'auction', state: 'TX', remitter: 'platform', gross_cents: 10825, taxable_cents: 10000, tax_calculated_cents: 825, tax_collected_cents: 825 });
  await entry({ ...base, idempotency_key: 'b:tx2', entry_type: 'sale', channel: 'marketplace', state: 'TX', remitter: 'platform', gross_cents: 5413, taxable_cents: 5000, tax_calculated_cents: 413, tax_collected_cents: 413 });
  await entry({ ...base, idempotency_key: 'b:tx1r', entry_type: 'refund', channel: 'auction', state: 'TX', remitter: 'platform', gross_cents: -2165, taxable_cents: -2000, tax_calculated_cents: -165, tax_collected_cents: -165 });
  // Ohio: the seller is responsible; nothing collected.
  await entry({ ...base, idempotency_key: 'b:oh1', entry_type: 'sale', channel: 'auction', state: 'OH', remitter: 'seller_direct', gross_cents: 123456, exempt_cents: 123456 });
  // A remittance already recorded for Texas.
  await entry({ idempotency_key: 'b:remit', entry_type: 'remittance', channel: 'platform', source_type: 'manual', state: 'TX', remitter: 'platform', tax_remitted_cents: 300 });
  await stack.query(`INSERT INTO tax_registrations (state, status, filing_frequency) VALUES ('TX', 'active', 'monthly')`);
  await stack.query(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from) VALUES ('TX', 'platform', 'TEST ONLY rule', DATE '2020-01-01'), ('OH', 'seller_direct', 'TEST ONLY rule', DATE '2020-01-01')`);
  // A historical rule with the retired option (it can no longer be saved through the page or the API).
  await stack.query(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from) VALUES ('NM', 'seller', 'TEST ONLY historical rule', DATE '2020-01-01')`);
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

async function open(email, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await seed.browserLogin(page, stack, email, seed.TEST_PASSWORD, '/admin/tax.html');
  await page.goto(stack.baseUrl + '/admin/tax.html');
  return { ctx, page, errors };
}
const cell = (page, state, key) => page.$eval(`#ov-rows tr[data-state="${state}"] td[data-k="${key}"]`, (e) => e.textContent);

test('an administrator sees the ledger totals for two states, correct to the cent', async () => {
  const { ctx, page, errors } = await open(ADMIN);
  await page.waitForSelector('#ov-rows tr[data-state="TX"]');
  expect(await page.title()).toBe('Sales Tax - Admin');
  expect(await page.$eval('h1', (e) => e.textContent)).toBe('Sales Tax');
  // Texas: 108.25 + 54.13 gross; taxable 100 + 50 - 20; collected 8.25 + 4.13; refunded 1.65; to remit 10.73; remitted 3.00; outstanding 7.73.
  expect([await cell(page, 'TX', 'gross_cents'), await cell(page, 'TX', 'taxable_cents'), await cell(page, 'TX', 'tax_collected_cents'), await cell(page, 'TX', 'tax_refunded_cents'),
    await cell(page, 'TX', 'platform_net_tax_cents'), await cell(page, 'TX', 'all_time_remitted_cents'), await cell(page, 'TX', 'outstanding_cents')])
    .toEqual(['$162.38', '$130.00', '$12.38', '$1.65', '$10.73', '$3.00', '$7.73']);
  expect([await cell(page, 'OH', 'gross_cents'), await cell(page, 'OH', 'taxable_cents'), await cell(page, 'OH', 'tax_collected_cents'), await cell(page, 'OH', 'outstanding_cents')])
    .toEqual(['$1,234.56', '$0.00', '$0.00', '$0.00']);
  const total = (k) => page.$eval(`#ov-totals td[data-k="${k}"]`, (e) => e.textContent);
  expect([await total('gross_cents'), await total('taxable_cents'), await total('tax_collected_cents'), await total('platform_net_tax_cents'), await total('outstanding_cents')])
    .toEqual(['$1,396.94', '$130.00', '$12.38', '$10.73', '$7.73']);
  const tx = await page.$eval('#ov-rows tr[data-state="TX"]', (e) => e.textContent);
  expect(tx).toMatch(/Advantage\.Bid collects and remits/); expect(tx).toMatch(/Active/); expect(tx).toMatch(/No filing row/);
  expect(await page.$eval('#ov-rows tr[data-state="OH"]', (e) => e.textContent)).toMatch(/Not collected; seller is responsible/);
  expect(await page.$eval('#reserve-text', (e) => e.textContent)).toMatch(/Outstanding: \$7\.73/);
  await page.waitForFunction(() => /REPORT ONLY/.test(document.getElementById('mode-text').textContent));
  expect(await page.$eval('#owner-note', (e) => e.textContent)).toMatch(/Only the platform owner can change these settings/);
  expect(await page.$eval('#mode-enforce', (e) => e.disabled)).toBe(true);
  // amounts use tabular numerals
  expect(await page.$eval('#ov-rows td.num', (e) => getComputedStyle(e).fontVariantNumeric)).toMatch(/tabular-nums/);

  // Ledger tab: every entry, the seller by name, never the buyer.
  await page.click('#tabs .tab[data-tab="ledger"]');
  await page.waitForFunction(() => document.querySelectorAll('#lf-rows tr').length === 5);
  const ledgerText = await page.$eval('#panel-ledger', (e) => e.textContent);
  expect(ledgerText).toMatch(/Delta Auction Gallery/);
  expect(ledgerText).toMatch(/1 to 5 of 5 entries/);
  expect(ledgerText).not.toMatch(/Hiddenbuyer|taxpage-buyer/);
  expect(await page.content()).not.toContain(S.buyer);

  // Seller reporting: preparation only.
  await page.click('#tabs .tab[data-tab="sellers"]');
  await page.waitForFunction(() => /not enabled/.test(document.getElementById('sr-note').textContent));
  await page.waitForFunction(() => /Delta Auction Gallery/.test(document.getElementById('sr-rows').textContent));
  expect(await page.$eval('#sr-rows', (e) => e.textContent)).toMatch(/\$1,396\.94/);

  // Registrations tab is reachable by its address (the rules page links to it).
  await page.goto(stack.baseUrl + '/admin/tax.html#registrations');
  await page.reload();
  await page.waitForSelector('#reg-rows tr[data-state="TX"]');
  expect(await page.isVisible('#panel-registrations')).toBe(true);
  expect(await page.isVisible('#panel-overview')).toBe(false);

  // Public Language Standard: no technology or vendor wording anywhere on the page.
  await page.goto(stack.baseUrl + '/admin/tax.html');
  await page.waitForSelector('#ov-rows tr[data-state="TX"]');
  const visible = await page.$eval('.wrap', (e) => e.textContent);
  expect(visible).not.toMatch(/\bAI\b|Stripe|Railway|Neon|Postmark/);
  expect(visible).not.toMatch(/[–—]/);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('the page fits a phone-width screen without sideways scrolling', async () => {
  const { ctx, page, errors } = await open(ADMIN, { width: 390, height: 800 });
  await page.waitForSelector('#ov-rows tr[data-state="TX"]');
  for (const tab of ['overview', 'ledger', 'registrations', 'rules', 'codes', 'nexus', 'exceptions', 'sellers']) {
    await page.click(`#tabs .tab[data-tab="${tab}"]`);
    expect(await page.isVisible('#panel-' + tab)).toBe(true);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect([tab, over <= 1]).toEqual([tab, true]);
  }
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a seller and a buyer cannot open the page or read the API', async () => {
  for (const email of [SELLER, BUYER]) {
    const { ctx, page } = await open(email);
    expect(new URL(page.url()).pathname).not.toBe('/admin/tax.html');
    expect(await page.$('#ov-rows')).toBeNull();
    const direct = await ctx.request.get(stack.baseUrl + '/admin/tax.html', { maxRedirects: 0 });
    expect(direct.status()).toBe(302);
    expect(direct.headers().location).toBe('/app.html');
    const token = await seed.apiLogin(stack, email);
    for (const p of ['/api/admin/tax/overview', '/api/admin/tax/ledger', '/api/admin/tax/ledger.csv', '/api/admin/tax/seller-reporting', '/api/admin/tax-jurisdictions']) {
      const r = await fetch(stack.baseUrl + p, { headers: { Authorization: 'Bearer ' + token } });
      expect([email, p, r.status]).toEqual([email, p, 403]);
      expect(await r.text()).not.toMatch(/162\.38|10825|Delta Auction Gallery/);
    }
    await ctx.close();
  }
  // No session at all: the page goes to sign-in and the API answers 401.
  const anon = await fetch(stack.baseUrl + '/admin/tax.html', { redirect: 'manual' });
  expect(anon.status).toBe(302);
  expect(anon.headers.get('location')).toMatch(/^\/login\.html\?next=/);
  expect((await fetch(stack.baseUrl + '/api/admin/tax/overview')).status).toBe(401);
});

test('the rules page offers only the two current options and shows a historical rule as Retired', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await seed.browserLogin(page, stack, ADMIN, seed.TEST_PASSWORD, '/admin/tax-jurisdictions.html');
  await page.goto(stack.baseUrl + '/admin/tax-jurisdictions.html');
  await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 3);
  expect(await page.title()).toBe('Sales Tax Rules - Admin');
  expect(await page.$$eval('#rem option', (os) => os.map((o) => o.value))).toEqual(['platform', 'seller_direct']);
  const rows = await page.$$eval('#rows tr', (trs) => trs.map((t) => t.textContent));
  expect(rows[0]).toMatch(/^NM/); expect(rows[0]).toMatch(/Retired/);
  expect(rows[2]).toMatch(/^TX/); expect(rows[2]).toMatch(/Advantage.Bid remits/); expect(rows[2]).toMatch(/Never/);
  // Mark Texas verified, then read its history.
  await page.click('#rows tr:nth-child(3) button:has-text("Mark Verified")');
  await page.waitForFunction(() => /Verification recorded/.test(document.getElementById('msg').textContent));
  await page.waitForFunction(() => !/Never/.test(document.querySelector('#rows tr:nth-child(3)').textContent));
  await page.click('#rows tr:nth-child(3) button:has-text("History")');
  await page.waitForSelector('#rows tr.hist');
  expect(await page.$eval('#rows tr.hist', (e) => e.textContent)).toMatch(/Verified by Ada Admin/);
  // Saving the retired rule again is not possible: the form has no such option, and replacing it works.
  await page.selectOption('#st', 'NM'); await page.selectOption('#rem', 'seller_direct'); await page.fill('#basis', 'TEST ONLY: replaced after advice');
  await page.click('#save');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('msg').textContent));
  await page.waitForFunction(() => !/Retired/.test(document.getElementById('rows').textContent));
  expect((await stack.query(`SELECT remitter FROM marketplace_tax_jurisdictions WHERE state = 'NM'`)).rows[0].remitter).toBe('seller_direct');
  expect(await page.$eval('.wrap', (e) => e.textContent)).not.toMatch(/\bAI\b|Stripe|Railway|[–—]/);
  expect(errors).toEqual([]);
  await ctx.close();
});
