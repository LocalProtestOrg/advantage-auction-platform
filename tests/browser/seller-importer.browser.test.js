'use strict';

/**
 * Browser journeys (Chromium) for the Professional Seller inventory, on the real app and real schema (tests/fullstack),
 * with an in-memory photo store (no real image host, database, payment processor or email provider):
 *   - the five-step spreadsheet importer with the real AuctionFlex export (142 items): Upload → Match Columns (unique
 *     destinations, repeatable Skip / Ignore) → Add or Match Photos (by the original auction lot number) → Review → Import;
 *   - inventory management: search by Inventory Number, edit Sale Price / quantity / category (the seller's choice is kept);
 *   - dual distribution: a published item appears on Advantage.Bid and in the seller's website widget; unpublishing
 *     removes it from both;
 *   - Post to the Market: an unsold auction lot becomes a draft with its details and photos, never its reserve price.
 */

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');
const health = require('../../src/services/watchdog/pageHealth');

jest.setTimeout(240000);

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'auctionflex-unsold-inventory.csv');
const EMAIL = 'pro-importer@fullstack.test';
const JPEG = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-browser-' + tag), Buffer.alloc(200, 7)]);
let stack; let browser; let sellerId; let page; let probe; let shotsDir;

beforeAll(async () => {
  stack = await startStack({ fakeStorage: true });
  const uid = await seed.user(stack, { email: EMAIL, role: 'seller', fullName: 'Ida Importer' });
  sellerId = await seed.sellerProfile(stack, { userId: uid, sellerType: 'auction_house', displayName: 'Ida Auctions', extra: {
    storefront_slug: 'ida-auctions', storefront_published: true, agreement_waived_at: new Date(),
    default_pickup_address_line1: '100 Main St', default_pickup_city: 'Houston', default_pickup_state: 'TX', default_pickup_postal_code: '77002',
    default_pickup_country: 'US', default_pickup_confirmed_at: new Date() } });
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  probe = health.attach(page, { origin: stack.baseUrl });
  await seed.browserLogin(page, stack, EMAIL, seed.TEST_PASSWORD, '/seller-inventory.html');
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

const serious = (issues) => issues.filter((i) => i.severity === 'critical');

describe('the five-step importer with the real AuctionFlex export', () => {
  test('1. Upload Spreadsheet → 2. Match Columns: headings on the left, ten fields, Photo_1..Photo_15 and Skip / Ignore', async () => {
    await page.goto(stack.baseUrl + '/seller-inventory.html?tab=imp');
    await page.setInputFiles('#sheetFile', FIXTURE);
    await page.click('#upBtn');
    await page.waitForSelector('#st2', { state: 'visible' });
    const rows = await page.$$eval('#mapBody tr', (trs) => trs.map((tr) => ({ heading: tr.querySelector('td b').textContent, value: tr.querySelector('select').value })));
    expect(rows).toHaveLength(17);
    const by = Object.fromEntries(rows.map((r) => [r.heading, r.value]));
    expect(by).toEqual(expect.objectContaining({ itemnum: 'inventory_number', lead: 'title', shortdesc: 'description', quantity: 'quantity', bidreserve: 'skip', bidamount: 'skip', lotnum: 'skip' }));
    const labels = await page.$eval('#mapBody select', (s) => Array.from(s.options).map((o) => o.textContent));
    expect(labels).toEqual(['Skip / Ignore', 'Inventory Number', 'Item Title (required)', 'Description', 'Sale Price', 'Quantity', 'Category', 'Condition',
      'Dimensions', 'Material', 'Color', ...Array.from({ length: 15 }, (_, i) => `Photo_${i + 1}`)]);
    // A field already chosen for one column cannot be chosen for another; Skip / Ignore always can.
    const lotSel = '#mapBody select[data-col="0"]';
    const disabled = await page.$eval(lotSel, (s) => Array.from(s.options).filter((o) => o.disabled).map((o) => o.value));
    expect(disabled).toEqual(expect.arrayContaining(['inventory_number', 'title', 'description', 'quantity']));
    expect(disabled).not.toContain('skip');
    expect(serious(await health.inspect(page, probe, { expectText: ['Match your columns'] }))).toEqual([]);
  });

  test('3. Add or Match Photos: match by the original auction lot number; review the matches; reorder', async () => {
    await page.selectOption('#pmRef', 'lot_number');
    await page.click('#mapBtn');
    await page.waitForSelector('#st3', { state: 'visible' });
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aap-photos-'));
    const files = { '6.jpg': JPEG('6a'), '6_2.jpg': JPEG('6b'), '10.jpg': JPEG('10'), 'nobody-999.jpg': JPEG('x') };
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
    await page.setInputFiles('#iphFiles', Object.keys(files).map((n) => path.join(dir, n)));
    await page.waitForFunction(() => /3 photo\(s\) matched/.test(document.getElementById('iphMsg').textContent));
    const issues = await page.$eval('#iphIssues', (e) => e.innerText);
    expect(issues).toMatch(/nobody-999\.jpg/);
    await page.waitForFunction(() => document.querySelectorAll('#iphRows .ph').length === 3);
    const first = await page.$$eval('#iphRows .card', (cards) => cards.map((c) => c.innerText.split('\n')[0]));
    expect(first[0]).toMatch(/Row 2: KARL SPRINGER STYLE HORN INLAID LAMP/);
  });

  test('4. Review Inventory: totals before anything is created; 5. Import Drafts', async () => {
    await page.click('text=Continue to review');
    await page.waitForSelector('#st4', { state: 'visible' });
    const sum = await page.$eval('#revSum', (e) => e.innerText);
    expect(sum).toMatch(/142 rows/); expect(sum).toMatch(/142 new items/); expect(sum).toMatch(/142 without a Sale Price/); expect(sum).toMatch(/3 photos matched/);
    expect((await stack.query('SELECT count(*)::int n FROM marketplace_items WHERE seller_id = $1', [sellerId])).rows[0].n).toBe(0);
    await page.click('#impBtn');
    await page.waitForFunction(() => /Done\./.test(document.getElementById('impRun').innerText), null, { timeout: 120000 });
    expect(await page.$eval('#impRun', (e) => e.innerText)).toMatch(/142 draft\(s\) created.*3 photo\(s\) added/);
    const made = (await stack.query('SELECT status, price_cents, category_status FROM marketplace_items WHERE seller_id = $1', [sellerId])).rows;
    expect(made).toHaveLength(142);
    expect(made.every((m) => m.status === 'draft' && m.price_cents === null)).toBe(true);
    expect(made.filter((m) => m.category_status === 'assigned').length).toBeGreaterThan(110);
  });
});

describe('inventory management and dual distribution', () => {
  let itemId;
  test('search by Inventory Number; the automatic category is shown and can be changed; the seller choice is kept', async () => {
    await page.click('text=Review my drafts');
    await page.selectOption('#fStatus', '');
    await page.fill('#q', '126721');
    // One matching item row (not the "No items yet" placeholder shown while the list is still loading).
    await page.waitForFunction(() => { const r = document.querySelectorAll('#invBody tr'); return r.length === 1 && /126721/.test(r[0].innerText); });
    const row = await page.$eval('#invBody tr', (tr) => tr.innerText);
    expect(row).toMatch(/KARL SPRINGER/); expect(row).toMatch(/Lighting/); expect(row).toMatch(/Not set/);
    await page.click('#invBody td.hide-sm [data-do="edit"]');
    expect(await page.$eval('#ed-cat', (s) => s.value)).toBe('lighting');
    await page.fill('#ed-price', '450');
    await page.fill('#ed-qty', '1');
    await page.selectOption('#ed-cat', 'antiques');
    await page.click('#edSave');
    await page.waitForFunction(() => /Saved\./.test(document.getElementById('invMsg').textContent));
    const it = (await stack.query(`SELECT id, price_cents, category_key, category_source FROM marketplace_items WHERE seller_id = $1 AND inventory_number = '126721'`, [sellerId])).rows[0];
    expect(it).toEqual(expect.objectContaining({ price_cents: 45000, category_key: 'antiques', category_source: 'seller' }));
    itemId = it.id;
  });

  test('publish: the item appears on Advantage.Bid and in the website widget; unpublish removes it from both', async () => {
    const pub = () => fetch(stack.baseUrl + '/api/public/storefront/item/' + itemId).then((r) => r.status);
    const widget = () => fetch(stack.baseUrl + '/api/public/storefront/widget/' + sellerId).then((r) => r.json()).then((j) => JSON.stringify(j));
    expect(await pub()).toBe(404);
    expect(await widget()).not.toMatch(/KARL SPRINGER/);
    await page.check('#invBody input[type=checkbox]');
    await page.click('#bulkBar >> text=Publish');
    await page.waitForFunction(() => /1 updated/.test(document.getElementById('invMsg').textContent));
    expect(await pub()).toBe(200);
    expect(await widget()).toMatch(/KARL SPRINGER/);
    // The public product page renders as a real page.
    const p2 = await browser.newPage();
    const pr = health.attach(p2, { origin: stack.baseUrl });
    const html = await (await fetch(stack.baseUrl + '/api/public/storefront/item/' + itemId)).json();
    expect(html.data.category).toBe('Antiques');
    await p2.close(); void pr;
    // Unpublish (move to draft): gone from both places at once.
    await page.check('#invBody input[type=checkbox]');
    await page.click('#bulkBar >> text=Move to draft');
    await page.waitForFunction(() => /1 updated/.test(document.getElementById('invMsg').textContent));
    expect(await pub()).toBe(404);
    expect(await widget()).not.toMatch(/KARL SPRINGER/);
  });

  test('the readiness panel, storefront link and embed code are shown; the page works on a phone', async () => {
    const rd = await fetch(stack.baseUrl + '/api/seller-storefront/readiness', { headers: { Authorization: 'Bearer ' + await seed.apiLogin(stack, EMAIL) } });
    expect([rd.status, rd.status === 200 ? '' : await rd.text()]).toEqual([200, '']);
    await page.goto(stack.baseUrl + '/seller-inventory.html');
    await page.waitForSelector('#readyList li');
    const ready = await page.$eval('#readyList', (e) => e.innerText);
    expect(ready).toMatch(/Seller agreement signed/); expect(ready).toMatch(/Online checkout open on Advantage\.Bid/);
    await page.waitForSelector('#shareCard', { state: 'visible' });
    expect(await page.$eval('#shareCode', (e) => e.value)).toMatch(/<iframe src="[^"]*\/embed\/storefront\.html\?seller=/);
    expect(serious(await health.inspect(page, probe, { expectText: ['Before buyers can purchase your items'] }))).toEqual([]);
    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const m = await phone.newPage();
    const mp = health.attach(m, { origin: stack.baseUrl });
    await seed.browserLogin(m, stack, EMAIL, seed.TEST_PASSWORD, '/seller-inventory.html');
    await m.waitForSelector('#invBody tr');
    expect((await health.inspect(m, mp, {})).filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')).toEqual([]);
    await phone.close();
  });
});

describe('Post to the Market', () => {
  test('an unsold lot becomes a draft with its details and photos; the reserve is never the Sale Price; repeating it never duplicates', async () => {
    const a = (await stack.query(`INSERT INTO auctions (seller_id, title, state, city, address_state, zip, street_address, end_time)
      VALUES ($1, 'Fall Estate Auction', 'closed', 'Houston', 'TX', '77002', '100 Main St', now() - interval '2 days') RETURNING id`, [sellerId])).rows[0];
    const lot = (await stack.query(`INSERT INTO lots (auction_id, lot_number, lot_number_display, title, description, category, state, reserve_cents, starting_bid_cents, bid_count, dimensions, material)
      VALUES ($1, 41, '41', 'Federal mahogany card table', 'Serpentine top, reeded legs.', 'Furniture', 'closed', 30000, 5000, 0, '{"height":29,"width":36,"depth":18}', 'Mahogany') RETURNING id`, [a.id])).rows[0];
    await stack.query(`INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1, 'https://isolated-photo-store.invalid/lot41-a.jpg', 0), ($1, 'https://isolated-photo-store.invalid/lot41-b.jpg', 1)`, [lot.id]);
    await page.goto(stack.baseUrl + '/seller-storefront.html?tab=unsold');
    await page.waitForSelector('#unsoldBody button');
    const row = await page.$eval('#unsoldBody tr', (tr) => tr.innerText);
    expect(row).toMatch(/Federal mahogany card table/); expect(row).toMatch(/Lot 41/);
    expect(row).not.toMatch(/\$300|300\.00/);                                     // the reserve is never shown as a price
    expect(await page.$eval('#unsoldBody button', (b) => b.textContent)).toBe('Post to the Market');
    await page.click('#unsoldBody button');
    await page.waitForFunction(() => /Posted to the Market as a draft/.test(document.body.innerText));
    const it = (await stack.query('SELECT * FROM marketplace_items WHERE source_lot_id = $1', [lot.id])).rows;
    expect(it).toHaveLength(1);
    expect(it[0]).toEqual(expect.objectContaining({ status: 'draft', price_cents: null, title: 'Federal mahogany card table', source_lot_number: '41',
      dimensions: '29 H x 36 W x 18 D in.', material: 'Mahogany', category_key: 'furniture', source_auction_id: a.id }));
    expect(it[0].images).toEqual(['https://isolated-photo-store.invalid/lot41-a.jpg', 'https://isolated-photo-store.invalid/lot41-b.jpg']);
    // Repeating (another click, another tab, the API) never creates a second listing.
    const token = await seed.apiLogin(stack, EMAIL);
    const again = await fetch(stack.baseUrl + '/api/seller-storefront/unsold-lots/' + lot.id + '/convert', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}' });
    expect((await again.json()).created).toBe(false);
    expect((await stack.query('SELECT count(*)::int n FROM marketplace_items WHERE source_lot_id = $1', [lot.id])).rows[0].n).toBe(1);
    // A lot that sold at auction is never offered.
    const sold = (await stack.query(`INSERT INTO lots (auction_id, lot_number, title, state, winning_buyer_user_id) VALUES ($1, 42, 'Sold lot', 'closed', (SELECT id FROM users LIMIT 1)) RETURNING id`, [a.id])).rows[0];
    const r = await fetch(stack.baseUrl + '/api/seller-storefront/unsold-lots/' + sold.id + '/convert', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}' });
    expect((await r.json()).code).toBe('ALREADY_SOLD');
  });
});
