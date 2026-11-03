'use strict';

/**
 * Auction-house website widget (owner request 2026-11-03), in a real browser on the isolated full-stack environment
 * (tests/fullstack; in-memory database; never production). The widget is installed with its real loader
 * (/widgets/company-auctions.js) on a separate "auctioneer website" (another origin), and the shopper:
 *   - sees the auctioneer's live and upcoming auctions, opens a catalog, browses the lots and opens a lot, all inside the
 *     frame (the host page address never changes and nothing opens elsewhere);
 *   - views every photo and enlarges it in the gallery (the frame fills the screen while the viewer is open);
 *   - returns with Back to Catalog / All Auctions and with the browser Back button;
 *   - bids through "Bid on Advantage.Bid", which opens the lot's own page in a NEW tab (bidding stays on the platform).
 * Seller isolation: one auctioneer's key never shows another auctioneer's auction or lot, nor an unpublished auction.
 */

const http = require('http');
const zlib = require('zlib');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const seed = require('../fullstack/seed');

jest.setTimeout(240000);

function png(w, h, rgb) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const PHOTO = png(240, 160, [90, 120, 60]);
const photoUrl = (n) => `https://isolated-photo-store.invalid/lots/${n}.png`;
async function serveFakePhotos(page) {
  await page.route('https://isolated-photo-store.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO }));
}

let stack; let browser; let site; let siteUrl;
const A = {}; const B = {};
const day = 24 * 60 * 60 * 1000;
const KEY_A = 'wgt_' + 'a1'.repeat(18); const KEY_B = 'wgt_' + 'b2'.repeat(18);

async function auctioneer(email, name, key) {
  const userId = await seed.user(stack, { email, role: 'seller', fullName: name + ' Owner' });
  const sellerProfileId = await seed.sellerProfile(stack, { userId, sellerType: 'auction_house', displayName: name, extra: { agreement_waived_at: new Date() } });
  const orgId = (await stack.query(`INSERT INTO organizations (name, slug, linked_seller_profile_id, profile_data) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [name, name.toLowerCase().replace(/[^a-z]+/g, '-'), sellerProfileId, JSON.stringify({ widget_key: key })])).rows[0].id;
  await stack.query(`INSERT INTO organization_members (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [orgId, userId]);
  return { userId, sellerProfileId, key };
}
async function auction(sellerProfileId, title, state, extra = {}) {
  return (await stack.query(
    `INSERT INTO auctions (seller_id, title, description, state, start_time, end_time, city, address_state, zip, marketplace_status, is_archived)
     VALUES ($1, $2, 'Estate contents, furniture and art.', $3, $4, $5, 'Houston', 'TX', '77002', $6, false) RETURNING id`,
    [sellerProfileId, title, state, state === 'active' ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 3 * day),
      new Date(Date.now() + (state === 'active' ? 1 : 5) * day), extra.marketplace_status || 'syndicated'])).rows[0].id;
}
async function lot(auctionId, n, title, photos = 0, extra = {}) {
  const id = (await stack.query(
    `INSERT INTO lots (auction_id, title, description, state, closes_at, lot_number, starting_bid_cents, current_bid_cents, bid_count, category, size_category, condition)
     VALUES ($1, $2, 'Described from the seller''s catalog.', 'open', $3, $4, 100, $5, $6, 'Furniture', 'B', 'Light wear') RETURNING id`,
    [auctionId, title, new Date(Date.now() + day + n * 60e3), n, extra.current || 0, extra.bids || 0])).rows[0].id;
  for (let i = 0; i < photos; i++) await stack.query('INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1, $2, $3)', [id, photoUrl(title.replace(/\W+/g, '-') + '-' + i), i]);
  return id;
}

beforeAll(async () => {
  stack = await startStack({ fakeStorage: true });
  Object.assign(A, await auctioneer('harbor-auctions@fullstack.test', 'Harbor Auction House', KEY_A));
  Object.assign(B, await auctioneer('ridge-auctions@fullstack.test', 'Ridge Auctions', KEY_B));
  A.live = await auction(A.sellerProfileId, 'Harbor Estate Sale', 'active');
  A.upcoming = await auction(A.sellerProfileId, 'Spring Fine Art Auction', 'published');
  A.draft = await auction(A.sellerProfileId, 'Unpublished Draft Sale', 'draft');
  A.desk = await lot(A.live, 1, 'Walnut Writing Desk', 3, { current: 4500, bids: 3 });
  A.lamp = await lot(A.live, 2, 'Brass Floor Lamp', 1);
  A.draftLot = await lot(A.draft, 1, 'Draft Lot', 1);
  B.live = await auction(B.sellerProfileId, 'Ridge Barn Finds', 'active');
  B.lot = await lot(B.live, 1, 'Ridge Copper Kettle', 1);
  // The auctioneer's own website: a different origin (localhost) installing the widget with the published embed code.
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbor Auction House</title></head>
      <body style="margin:0;font-family:sans-serif"><header style="padding:16px;background:#0f172a;color:#fff">Harbor Auction House</header>
      <main style="padding:12px"><h2>Our auctions</h2><div data-advantage-auctions data-key="${KEY_A}"></div>
      <script src="${stack.baseUrl}/widgets/company-auctions.js" async></script></main></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://localhost:${site.address().port}/`;
  browser = await chromium.launch();
}, 240000);

afterAll(async () => {
  if (browser) await browser.close();
  if (site) await new Promise((r) => site.close(r));
  if (stack) await stack.stop();
});

const frameOf = (page) => page.frame({ url: /embed\/auctions\.html/ });

describe('a shopper browses auctions, catalogs and lots without leaving the auctioneer\'s website', () => {
  test.each([['desktop', {}], ['tablet', devices['iPad Mini']], ['phone', devices['iPhone 13']]])('%s: list -> catalog -> lot -> photos -> back', async (label, ctxOpts) => {
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage(); await serveFakePhotos(page);
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(siteUrl, { waitUntil: 'networkidle' });
    let frame = frameOf(page);
    await frame.waitForSelector('.wl-card');
    expect(await frame.textContent('#wl-root')).toMatch(/Harbor Estate Sale[\s\S]*Spring Fine Art Auction/);
    expect(await frame.textContent('#wl-root')).not.toMatch(/Ridge|Unpublished Draft Sale/);
    // the frame grows with its content (loader height message)
    await page.waitForFunction(() => document.querySelector('iframe').getBoundingClientRect().height > 320);

    // 1. the catalog opens inside the frame
    await frame.click('.wl-card:has-text("Harbor Estate Sale") a.wl-cta');
    await frame.waitForSelector('a.wl-lot');
    expect(page.url()).toBe(siteUrl); expect(ctx.pages()).toHaveLength(1);
    expect(frame.url()).toContain('auction=' + A.live);
    expect(await frame.textContent('.wl-h1')).toBe('Harbor Estate Sale');
    expect(await frame.$$eval('a.wl-lot', (x) => x.map((a) => a.querySelector('.wl-title').textContent))).toEqual(['Walnut Writing Desk', 'Brass Floor Lamp']);
    expect(await frame.textContent('.wl-ahead')).toMatch(/buyer's premium is added to each winning bid/);
    expect(await frame.textContent('a.wl-lot >> nth=0')).toMatch(/Current bid \$45 · 3 bids/);

    // 2. a lot opens inside the frame, with all its photos
    await frame.click('a.wl-lot:has-text("Walnut Writing Desk")');
    await frame.waitForSelector('.advg-main');
    expect(page.url()).toBe(siteUrl); expect(ctx.pages()).toHaveLength(1);
    expect(frame.url()).toContain('lot=' + A.desk);
    expect(await frame.textContent('.wl-h1')).toBe('Walnut Writing Desk');
    expect(await frame.$$eval('.advg-thumbs .advg-thumb', (t) => t.length)).toBe(3);
    expect(await frame.textContent('.wl-item')).toMatch(/Condition: Light wear/);
    // 3. enlarge: the viewer opens and the frame fills the screen; Escape closes it and the frame returns to its place
    await frame.click('.advg-main');
    await frame.waitForSelector('.advg-box[role="dialog"]');
    expect(await frame.textContent('.advg-count')).toBe('Photo 1 of 3');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('iframe')).position === 'fixed');
    const box = await page.$eval('iframe', (f) => { const r = f.getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
    expect(Math.abs(box.w - box.vw)).toBeLessThan(2); expect(Math.abs(box.h - box.vh)).toBeLessThan(2);
    await frame.click('.advg-next');
    expect(await frame.textContent('.advg-count')).toBe('Photo 2 of 3');
    await page.keyboard.press('Escape');
    expect(await frame.$('.advg-box')).toBeNull();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('iframe')).position !== 'fixed');

    // 4. bidding: the lot's own Advantage.Bid page, in a new tab (the auctioneer's page stays open)
    const bid = await frame.$('a.wl-btn');
    expect(await bid.textContent()).toBe('Bid on Advantage.Bid');
    expect(await bid.getAttribute('target')).toBe('_blank');
    expect(await bid.getAttribute('rel')).toMatch(/noopener/);
    // the lot's canonical page on the platform (APP_BASE_URL; the isolated stack keeps the production default)
    expect(await bid.getAttribute('href')).toMatch(new RegExp('^https://bid\\.advantage\\.bid/lot\\.html\\?id=' + A.desk + '$'));

    // 5. back: the button, then the browser Back button inside the frame, then forward again
    await frame.click('#wl-back');
    await frame.waitForSelector('a.wl-lot');
    expect(frame.url()).not.toContain('lot=');
    await frame.click('a.wl-lot:has-text("Brass Floor Lamp")');
    await frame.waitForSelector('.advg-main');
    await frame.evaluate(() => history.back());
    await frame.waitForSelector('a.wl-lot');
    frame = frameOf(page);
    await frame.click('#wl-back');
    await frame.waitForSelector('.wl-card a.wl-cta');
    expect(frame.url()).not.toContain('auction=');
    expect(page.url()).toBe(siteUrl); expect(ctx.pages()).toHaveLength(1);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('a direct address to a lot view works (shared or reloaded frame)', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await serveFakePhotos(page);
    await page.goto(`${stack.baseUrl}/embed/auctions.html?key=${KEY_A}&auction=${A.live}&lot=${A.desk}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.advg-main');
    expect(await page.textContent('.wl-h1')).toBe('Walnut Writing Desk');
    await page.click('#wl-back');
    await page.waitForSelector('a.wl-lot');
    await ctx.close();
  });
});

describe('professional sellers find both website widgets in one place', () => {
  // The member menu's "Website Widgets" opens Storefront Settings > Website Widgets, which mounts the shared panel
  // (public/widgets/shared/website-widgets.js; the page wiring is covered in storefront-website-widget.test.js). Here the
  // panel itself runs in a real browser with this auctioneer's REAL widget data from the two seller APIs (read once,
  // signed in as the seller), so the test does not depend on the rest of the settings page loading on a busy machine.
  test('the auctions and storefront widgets, each with copy, link, preview and install steps', async () => {
    const token = await seed.apiLogin(stack, 'harbor-auctions@fullstack.test');
    const read = async (p) => (await fetch(stack.baseUrl + p, { headers: { Authorization: 'Bearer ' + token } })).text();
    const auctionsCfg = await read('/api/sellers/me/widget');
    const storefrontCfg = await read('/api/seller-storefront/widget');
    expect(JSON.parse(auctionsCfg)).toMatchObject({ success: true, eligible: true, key: KEY_A });
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.route(stack.baseUrl + '/__website-widgets-panel', (r) => r.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="website-widgets"></div>'
        + '<script src="/widgets/shared/website-widgets.js"></script>'
        + '<script>AdvWebsiteWidgets.mount(document.getElementById("website-widgets"), { token: "t", first: "storefront" });</script></body></html>' }));
    await page.route(stack.baseUrl + '/api/sellers/me/widget', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: auctionsCfg }));
    await page.route(stack.baseUrl + '/api/seller-storefront/widget', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: storefrontCfg }));
    await page.goto(stack.baseUrl + '/__website-widgets-panel', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#website-widgets #aww-auctions');
    // storefront first here (Storefront Settings), then auctions
    expect(await page.$$eval('#website-widgets .aww-card', (c) => c.map((x) => x.id))).toEqual(['aww-storefront', 'aww-auctions']);
    const auc = page.locator('#aww-auctions');
    expect(await auc.textContent()).toMatch(/Auctions widget[\s\S]*showing 2 auctions/);
    expect(await auc.locator('textarea').inputValue()).toContain('data-key="' + KEY_A + '"');
    expect(await auc.locator('input').inputValue()).toContain('/embed/auctions.html?key=' + KEY_A);
    for (const b of ['Copy Embed Code', 'Copy Widget Link', 'Preview Widget']) expect(await auc.locator('button', { hasText: b }).isEnabled()).toBe(true);
    expect(await auc.locator('summary').textContent()).toBe('How to add it to your website');
    await auc.locator('button', { hasText: 'Preview Widget' }).click();
    await page.frameLocator('#aww-auctions iframe').locator('.wl-card').first().waitFor();   // the live preview shows the widget itself
    // the storefront widget is listed beside it (this auction house has not chosen a storefront address yet)
    const sf = page.locator('#aww-storefront');
    expect(await sf.textContent()).toMatch(/Storefront widget[\s\S]*Choose your storefront address/);
    expect(await sf.locator('button', { hasText: 'Copy Embed Code' }).isDisabled()).toBe(true);
    await ctx.close();
  });
});

describe('one auctioneer\'s widget never shows another\'s inventory, or anything unpublished', () => {
  const get = async (p) => { const r = await fetch(stack.baseUrl + p); let j = null; try { j = await r.json(); } catch (e) { /* not json */ } return { status: r.status, j }; };
  test('catalog and lot feeds answer only for the key\'s own public auctions', async () => {
    expect((await get(`/api/public/widget/auctions/${A.live}/lots?key=${KEY_A}`)).status).toBe(200);
    expect((await get(`/api/public/widget/auctions/${B.live}/lots?key=${KEY_A}`)).status).toBe(404);   // another auctioneer
    expect((await get(`/api/public/widget/lots/${B.lot}?key=${KEY_A}`)).status).toBe(404);
    expect((await get(`/api/public/widget/auctions/${A.draft}/lots?key=${KEY_A}`)).status).toBe(404);   // not published
    expect((await get(`/api/public/widget/lots/${A.draftLot}?key=${KEY_A}`)).status).toBe(404);
    expect((await get(`/api/public/widget/lots/${A.desk}?key=wgt_${'0'.repeat(36)}`)).status).toBe(404);   // unknown key
    expect((await get(`/api/public/widget/lots/${A.desk}`)).status).toBe(404);                              // no key
    expect((await get(`/api/public/widget/auctions/not-an-id/lots?key=${KEY_A}`)).status).toBe(404);
  });
  test('only public lot fields leave the platform (no bidder, winner, reserve or account data)', async () => {
    const r = await get(`/api/public/widget/lots/${A.desk}?key=${KEY_A}`);
    const text = JSON.stringify(r.j);
    expect(text).not.toMatch(/winner|user_id|reserve|email|seller_id|street_address|zip/i);
    expect(r.j.data.lot).toMatchObject({ title: 'Walnut Writing Desk', current_bid_cents: 4500, bid_count: 3 });
    expect(r.j.data.lot.images).toHaveLength(3);
  });
  test('the other auctioneer\'s own widget shows only theirs', async () => {
    const r = await get(`/api/public/widget/auctions?key=${KEY_B}`);
    expect(r.j.current.map((a) => a.title)).toEqual(['Ridge Barn Finds']);
    expect(r.j.upcoming).toEqual([]);
  });
});
