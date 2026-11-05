'use strict';

/**
 * The professional seller demo (/seller-demo) and the Seller Academy (/seller-how-to), as SERVED by the real app in a
 * real browser on the isolated full-stack environment (never production). Owner roadmap items A and B (2026-11-04) and
 * the owner's review changes (2026-11-05): the Academy lessons and grouping Pro Tip, pickup note templates, branded
 * Avery 5160 lot labels (print and PDF at exact size), worksheet and checklists, and the single-photo catalog demo.
 */

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { startStack } = require('../fullstack/stack');
const health = require('../../src/services/watchdog/pageHealth');
const { CATEGORIES } = require('../../src/constants/lotCategories');

jest.setTimeout(300000);
let stack; let browser;
const ALLOW = { allowConsoleErrors: [/net::ERR_FAILED/] };
const BANNED = /\bAI\b|A\.I\.|artificial intelligence|machine learning|\bOpenAI\b|\bGPT\b|\bLLM\b|coming soon|—|–/i;   // no long dashes in customer copy
const PUBLIC = path.join(__dirname, '..', '..', 'public');
const PX = 96; // CSS pixels per inch

// The Seller How To Center is for Professional Sellers (and administrators): its pages are opened signed in as one.
const PRO_EMAIL = 'howto-pro@fullstack.test';
let PRO_TOKEN;
beforeAll(async () => {
  stack = await startStack(); browser = await chromium.launch();
  const seed = require('../fullstack/seed');
  const userId = await seed.user(stack, { email: PRO_EMAIL, role: 'seller', fullName: 'Hal How' });
  await seed.sellerProfile(stack, { userId, sellerType: 'estate_sale_company', displayName: 'Hal Estate Sales' });
  PRO_TOKEN = await seed.apiLogin(stack, PRO_EMAIL);
});
afterAll(async () => { if (browser) await browser.close(); if (stack) await stack.stop(); });

async function open(ctxOpts, p) {
  const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
  // Anything that is not a GET, or any request leaving the site (blob: and data: addresses stay in the browser).
  const sent = []; page.on('request', (r) => { const u = r.url(); if (r.method() !== 'GET' || (/^https?:/.test(u) && new URL(u).origin !== stack.baseUrl)) sent.push(r.method() + ' ' + u); });
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
  await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  if (p.startsWith('/seller-how-to')) {
    // Signed out, the server sends the visitor to sign in and back to the same address.
    await require('../fullstack/seed').browserLogin(page, stack, PRO_EMAIL, undefined, p);
    sent.length = 0;
  }
  const probe = health.attach(page, { origin: stack.baseUrl });
  await page.goto(stack.baseUrl + p, { waitUntil: 'networkidle' });
  return { ctx, page, probe, sent };
}
// Prints the current print area through Chromium's print engine and reads the page count and paper size.
async function printed(page) {
  await page.emulateMedia({ media: 'print' });
  const buf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  const s = buf.toString('latin1');
  return { pages: (s.match(/\/Type\s*\/Page\b/g) || []).length, boxes: [...new Set((s.match(/\/MediaBox\s*\[[^\]]*\]/g) || []).map((m) => m.replace(/\s+/g, ' ')))] };
}
function pdfInfo(buf) {
  const s = buf.toString('latin1');
  return { head: s.slice(0, 5), pages: (s.match(/\/Type\s*\/Page\b/g) || []).length, boxes: [...new Set((s.match(/\/MediaBox\s*\[[^\]]*\]/g) || []).map((m) => m.replace(/\s+/g, ' ')))] };
}
// Basic accessibility: one H1, no skipped heading levels, labelled form fields, named buttons, images with alt text.
async function a11y(page) {
  return page.evaluate(() => {
    const out = [];
    if (document.querySelectorAll('h1').length !== 1) out.push('h1 count ' + document.querySelectorAll('h1').length);
    const lv = [...document.querySelectorAll('main h1, main h2, main h3, header h1')].map((h) => +h.tagName[1]);
    for (let i = 1; i < lv.length; i++) if (lv[i] - lv[i - 1] > 1) out.push('heading skip ' + lv[i - 1] + '>' + lv[i]);
    for (const f of document.querySelectorAll('main input, main select, main textarea')) {
      const named = (f.id && document.querySelector('label[for="' + f.id + '"]')) || f.closest('label') || f.getAttribute('aria-label');
      if (!named) out.push('unlabelled ' + (f.id || f.name || f.type));
    }
    for (const b of document.querySelectorAll('main button, main a')) if (!(b.textContent.trim() || b.getAttribute('aria-label'))) out.push('unnamed ' + b.outerHTML.slice(0, 60));
    for (const i of document.querySelectorAll('main img')) if (!i.hasAttribute('alt')) out.push('img without alt ' + i.src);
    return out;
  });
}

test('clean addresses; the .html forms redirect; the public demo is in the sitemap, the members-only How To Center is not', async () => {
  expect((await fetch(stack.baseUrl + '/seller-demo')).status).toBe(200);
  const d = await fetch(stack.baseUrl + '/seller-demo.html?utm_source=x', { redirect: 'manual' });
  expect([d.status, d.headers.get('location')]).toEqual([301, '/seller-demo?utm_source=x']);
  const auth = { headers: { Authorization: 'Bearer ' + PRO_TOKEN } };
  expect((await fetch(stack.baseUrl + '/seller-how-to', auth)).status).toBe(200);
  const h = await fetch(stack.baseUrl + '/seller-how-to.html?utm_source=x', { redirect: 'manual', ...auth });
  expect([h.status, h.headers.get('location')]).toEqual([301, '/seller-how-to?utm_source=x']);
  const map = await (await fetch(stack.baseUrl + '/sitemap.xml')).text();
  expect(map).toContain('/seller-demo</loc>'); expect(map).not.toContain('/seller-how-to');
});

describe('seller demo', () => {
  test.each([['desktop', {}], ['phone', devices['iPhone 13']], ['small phone (360px)', devices['Galaxy S8']]])('%s: renders cleanly; every view works', async (label, ctxOpts) => {
    const { ctx, page, probe } = await open(ctxOpts, '/seller-demo');
    await page.fill('#d-name', 'Harbor Estate Sales');
    const tabs = await page.$$eval('#d-tabs button', (b) => b.map((x) => x.textContent));
    expect(tabs).toEqual(['Your storefront', 'On your website', 'On Advantage.Bid', 'Easy cataloging', 'Auction day', 'More consignments']);
    // the page opens on the branded storefront, right after the business setup; nothing else comes first
    expect(await page.$eval('#d-tabs button[aria-selected="true"]', (b) => b.textContent)).toBe('Your storefront');
    expect(await page.isVisible('#try')).toBe(false);
    expect(await page.$$eval('main > *', (els) => els.slice(0, 3).map((e) => e.id || e.className))).toEqual(['d-tabs', 'try', 'stage']);
    expect(await page.$('.hero-cta')).toBeNull();
    for (const t of tabs) {
      await page.click(`#d-tabs button:has-text("${t}")`);
      const issues = await health.inspect(page, probe, { ...ALLOW, expectText: ['See your business on Advantage.Bid'] });
      expect([t, issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')]).toEqual([t, []]);
      // the photo demo shows only at the top of Easy cataloging
      expect([t, await page.isVisible('#try')]).toEqual([t, t === 'Easy cataloging']);
      expect(await page.textContent('#d-explain h2')).toBeTruthy();
    }
    await page.click('#d-tabs button:has-text("Your storefront")');
    expect(await page.textContent('#d-preview')).toMatch(/Harbor Estate Sales[\s\S]*bid\.advantage\.bid\/pro\/harbor-estate-sales/);
    expect(await page.textContent('#d-preview .logo')).toBe('HE');
    expect(await page.textContent('body')).not.toMatch(BANNED);
    expect(await a11y(page)).toEqual([]);
    await ctx.close();
  });

  test.each([['desktop', {}], ['small phone (360px)', devices['Galaxy S8']]])('%s: single-photo catalog demo: the photo stays in the browser; the sample listing is editable and shows on the storefront and the marketplace', async (label, ctxOpts) => {
    const { ctx, page, probe, sent } = await open(ctxOpts, '/seller-demo');
    await page.fill('#d-name', 'Harbor Estate Sales');
    await page.click('#d-tabs button:has-text("Easy cataloging")');
    expect(await page.isVisible('#try')).toBe(true);
    // honest labelling is on the page before anything happens
    expect(await page.textContent('#try')).toMatch(/Your photo stays on this device[\s\S]*not uploaded or saved/);
    expect(await page.textContent('#try')).toMatch(/Demonstration only: nothing on this page creates an account, publishes an item or charges anyone/);
    // categories are the platform's one taxonomy
    expect(await page.$$eval('#t-cat option', (o) => o.map((x) => [x.value, x.textContent]))).toEqual(CATEGORIES.map((c) => [c.key, c.label]));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#t-photo', { name: 'my-item.png', mimeType: 'image/png', buffer: png });
    expect(await page.getAttribute('#t-drop img', 'src')).toMatch(/^blob:/);
    await page.click('#t-kinds button:has-text("Furniture")');
    await page.fill('#t-words', 'walnut dresser with brass pulls');
    await page.click('#t-go');
    expect(await page.inputValue('#t-title')).toBe('Walnut Dresser with Brass Pulls');
    expect(await page.inputValue('#t-cat')).toBe('furniture');
    expect(await page.inputValue('#t-desc')).toMatch(/\[add what you find\][\s\S]*Condition: \[describe/);
    expect(await page.textContent('#ts-3 .sample')).toMatch(/Sample listing\.[\s\S]*not from your photo/);
    await page.fill('#t-title', 'Edited Walnut Dresser'); await page.fill('#t-price', '275');
    expect(await page.textContent('#t-store')).toMatch(/Harbor Estate Sales[\s\S]*Edited Walnut Dresser[\s\S]*\$275/);
    expect(await page.textContent('#t-market .mine')).toMatch(/Edited Walnut Dresser[\s\S]*\$275[\s\S]*Sold by Harbor Estate Sales/);
    expect(await page.$eval('#t-store .ph', (d) => d.style.backgroundImage)).toMatch(/blob:/);
    expect(await page.getAttribute('#t-market .mkbar img', 'src')).toBe('/img/brand/advantage-bid-logo-white.png');
    // the sample photo works without a file
    await page.click('#t-sample');
    expect(await page.getAttribute('#t-drop img', 'src')).toMatch(/^data:image\/svg\+xml/);
    // nothing was sent anywhere: no POST/PUT and no request off the site
    expect(sent).toEqual([]);
    const issues = await health.inspect(page, probe, { ...ALLOW, checkOverflow: true });
    expect(issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')).toEqual([]);
    expect(await page.textContent('body')).not.toMatch(BANNED);
    await ctx.close();
  });

  test('Easy cataloging step 3 is Import Your Inventory & Photos, with Photo_1 to Photo_15 matching explained', async () => {
    const { ctx, page } = await open({}, '/seller-demo');
    await page.click('#d-tabs button:has-text("Easy cataloging")');
    const steps = await page.$$eval('#d-preview .steps li b', (b) => b.map((x) => x.textContent));
    expect(steps[2]).toBe('Import Your Inventory & Photos');
    const t = await page.textContent('#d-preview .imp');
    expect(t).toMatch(/Bring your entire storefront inventory into Advantage\.Bid at once, including product details and matching photos/);
    expect(t).toMatch(/Photo_1 to Photo_15/); expect(t).toMatch(/up to 2,000 rows/); expect(t).toMatch(/before a single item is created/);
    expect(t).not.toMatch(/Shopify|competitor/i);
    await ctx.close();
  });

  test('a link ending in #try opens Easy cataloging with the photo demo', async () => {
    const { ctx, page } = await open({}, '/seller-demo#try');
    expect(await page.$eval('#d-tabs button[aria-selected="true"]', (b) => b.textContent)).toBe('Easy cataloging');
    expect(await page.isVisible('#try')).toBe(true);
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

describe('Seller Academy (/seller-how-to)', () => {
  test.each([['desktop', {}], ['small phone (360px)', devices['Galaxy S8']]])('%s: renders cleanly with every lesson, accessible', async (label, ctxOpts) => {
    const { ctx, page, probe } = await open(ctxOpts, '/seller-how-to');
    const issues = await health.inspect(page, probe, { ...ALLOW, checkOverflow: true, expectText: ['Seller How To Center', "painter's tape"] });
    expect(await page.$$eval('section.lesson h2', (h) => h.map((x) => x.textContent))).toEqual(['Organize your auction location', 'Build lots that encourage competitive bidding',
      'Photography that sells', 'Create clear, searchable listings', 'Launch and promote your auction', 'Prepare for pickup day', 'Printables and seller tools']);
    const text = await page.textContent('main');
    expect(text).not.toMatch(/comparable sales|research prices behind|Research behind these lessons|appraiser/i);
    expect(await page.$$eval('sup, #sources, [id^="src-"]', (e) => e.length)).toBe(0);
    expect(issues.filter((i) => i.severity === 'critical' || i.code === 'HORIZONTAL_OVERFLOW')).toEqual([]);
    expect(await page.textContent('body')).not.toMatch(BANNED);
    expect(await a11y(page)).toEqual([]);
    // marks and condition are still represented accurately
    expect(await page.textContent('#photos')).toMatch(/Maker's marks, signatures, hallmarks, labels/);
    expect(await page.textContent('#listings')).toMatch(/You do not need to research prices/);
    await ctx.close();
  });

  test('the grouping Pro Tip: the three cats, $10 separately vs $30 or more grouped, an illustration, and when not to group', async () => {
    const { ctx, page } = await open({ reducedMotion: 'reduce' }, '/seller-how-to');
    const tip = await page.textContent('#grouping-tip');
    expect(tip).toMatch(/Why grouping can increase competition/);
    expect(tip).toMatch(/one red, one gray and one purple/);
    expect(tip).toMatch(/Sarah[\s\S]*red cat[\s\S]*Rachel[\s\S]*gray cat/);
    expect(tip).toMatch(/Total\s*\$10/);
    expect(tip).toMatch(/at least two interested bidders/);
    expect(tip).toMatch(/This is an illustration, not a prediction/);
    expect(tip).not.toMatch(/research/i);
    await page.click('#cat-play');
    expect(await page.textContent('#cat-ladder li.win')).toMatch(/\$30 or more/);
    const lots = await page.textContent('#lots');
    expect(lots).toMatch(/Sell individually when[\s\S]*recognized maker[\s\S]*strong independent demand/);
    await ctx.close();
  });

  test('photography: the primary photo has no prominent lot label; labels belong in supporting photos', async () => {
    const { ctx, page } = await open({}, '/seller-how-to');
    const t = await page.textContent('#photos');
    expect(t).toMatch(/No prominent lot label/); expect(t).toMatch(/Supporting photos[\s\S]*A photo with the lot label/);
    expect(t).not.toMatch(/First photo:[^.]*lot label visible/);
    await ctx.close();
  });

  test('pickup: sellers must not lift or load; the IMPORTANT heavy-item note comes first, then the variations; copyable and in the lot editor', async () => {
    const { ctx, page } = await open({ permissions: ['clipboard-read', 'clipboard-write'] }, '/seller-how-to');
    expect(await page.textContent('#pickup .danger')).toMatch(/Do not lift, carry, disassemble or load heavy purchases for buyers\.[\s\S]*Terms of Service[\s\S]*not required to help/);
    const notes = await page.$$eval('#pickup .pn-row', (r) => r.map((x) => [x.querySelector('b').textContent, x.querySelector('p').textContent]));
    expect(notes[0]).toEqual(['IMPORTANT: Heavy item, no seller assistance', 'IMPORTANT: Buyer is responsible for providing sufficient manpower, equipment, and a suitable vehicle to safely disassemble, move, load, and remove this item. Seller personnel will NOT provide lifting, moving, or loading assistance. Please make arrangements before bidding.']);
    expect(notes.slice(1, 5).map((n) => n[0])).toEqual(['Second floor or stairs', 'Fragile', 'Large furniture, disassembly required', 'Oversized or unusually heavy']);
    expect(await page.$eval('#pickup .pn-row', (r) => r.classList.contains('lead-note'))).toBe(true);
    const t = await page.textContent('#pickup');
    for (const w of ['stairs', 'elevators', 'restricted access', 'park', 'oversized furniture', 'fragile']) expect(t).toMatch(new RegExp(w, 'i'));
    expect(t).toMatch(/no note covers every situation/);
    await page.click('#pickup .pn-copy >> nth=2');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^This item is fragile\./);
    // the lot editor menu appends the chosen note to the description
    await page.evaluate(() => { const ta = document.createElement('textarea'); ta.id = 'x-desc'; ta.setAttribute('data-pickup-notes', ''); ta.value = 'Oak table.'; document.querySelector('main').appendChild(ta); window.AdvPickupNotes.init(); });
    await page.selectOption('#x-desc + .pickup-notes-add select', '0');
    expect(await page.inputValue('#x-desc')).toMatch(/^Oak table\.\n\nIMPORTANT: Buyer is responsible for providing sufficient manpower/);
    for (const f of ['dashboard/lots.html', 'lot-builder.html']) {
      const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
      expect([f, /data-pickup-notes/.test(src), /\/widgets\/shared\/pickup-note-templates\.js/.test(src)]).toEqual([f, true, true]);
    }
    await ctx.close();
  });

  test('lot labels: the official logo, numbered across sheets, exact Avery 5160 positions, long names stay inside the label', async () => {
    const { ctx, page, sent } = await open({}, '/seller-how-to');
    await page.fill('#l-from', '101'); await page.fill('#l-to', '135');
    await page.fill('#l-seller', 'Harbor Estate Sales and Appraisal Services of Westchester Co'); await page.fill('#l-auction', 'Westside Estate Contents Online Auction, Part Two of Three');
    expect(await page.textContent('#l-count')).toMatch(/35 labels \(lots 101 to 135\) on 2 sheets/);
    await page.click('#p-labels');
    await page.waitForFunction(() => window.__printed === 1);
    expect(await page.$$eval('#print-area .lsheet', (s) => s.map((x) => x.querySelectorAll('.lbl').length))).toEqual([30, 5]);
    expect(await page.$$eval('#print-area .lbl .num b', (b) => [b[0].textContent, b[29].textContent, b[30].textContent, b[34].textContent])).toEqual(['101', '130', '131', '135']);
    expect(await page.$eval('#print-area .lbl img.logo', (i) => [new URL(i.src).pathname, i.complete && i.naturalWidth > 0])).toEqual(['/img/brand/advantage-bid-logo.png', true]);
    await page.emulateMedia({ media: 'print' });
    const geo = await page.$$eval('#print-area .lsheet', (sheets) => sheets.map((sh) => {
      const o = sh.getBoundingClientRect();
      return { sheet: [o.width, o.height], labels: [...sh.querySelectorAll('.lbl')].map((l) => { const r = l.getBoundingClientRect(); const f = l.querySelector('.foot').getBoundingClientRect();
        return [r.left - o.left, r.top - o.top, r.width, r.height, f.right <= r.right + 0.5 && f.bottom <= r.bottom + 0.5]; }) };
    }));
    expect(geo[0].sheet).toEqual([8.5 * PX, 11 * PX]);
    const at = (i) => [(0.1875 + (i % 3) * 2.75) * PX, (0.5 + Math.floor(i / 3)) * PX, 2.625 * PX, 1 * PX, true];
    for (const i of [0, 1, 2, 3, 28, 29]) geo[0].labels[i].forEach((v, k) => (typeof v === 'boolean' ? expect(v).toBe(true) : expect(v).toBeCloseTo(at(i)[k], 1)));
    geo[1].labels[4].forEach((v, k) => (typeof v === 'boolean' ? expect(v).toBe(true) : expect(v).toBeCloseTo(at(4)[k], 1)));
    // the lot number is the largest text on the label, larger than the logo is tall
    const sizes = await page.$eval('#print-area .lbl', (l) => [parseFloat(getComputedStyle(l.querySelector('.num b')).fontSize), l.querySelector('img.logo').getBoundingClientRect().height]);
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    // the larger official logo (1.40 in wide) leaves room for a five-digit lot number
    expect(await page.$eval('#print-area .lbl img.logo', (i) => i.getBoundingClientRect().width)).toBeCloseTo(1.40 * PX, 0);
    await page.emulateMedia({ media: 'screen' });
    const out = await printed(page);
    expect(out).toEqual({ pages: 2, boxes: ['/MediaBox [0 0 612 792]'] });
    expect(sent).toEqual([]);   // typing and printing send nothing
    await ctx.close();
  });

  test('calibration page, plain paper option and the PDF link carry the same settings', async () => {
    const { ctx, page } = await open({}, '/seller-how-to');
    await page.click('#p-calibrate');
    expect(await page.$$eval('#print-area .cal-box', (b) => b.length)).toBe(30);
    expect(await page.textContent('#print-area')).toMatch(/Square = exactly 1 in[\s\S]*Actual size/);
    expect(await printed(page)).toEqual({ pages: 1, boxes: ['/MediaBox [0 0 612 792]'] });
    await page.fill('#l-from', '7'); await page.fill('#l-to', '40'); await page.fill('#l-seller', 'Harbor'); await page.check('#l-plain'); await page.uncheck('#l-web');
    const u = new URL(await page.getAttribute('#d-labels', 'href'), stack.baseUrl);
    expect(u.pathname).toBe('/api/seller-resources/lot-labels.pdf');
    expect(Object.fromEntries(u.searchParams)).toEqual({ from: '7', to: '40', seller: 'Harbor', web: '0', plain: '1' });
    await page.click('#p-labels');
    expect(await page.$$eval('#print-area .lbl.plain', (l) => l.length)).toBe(34);
    expect(await page.$$eval('#print-area .lbl .web', (l) => l.length)).toBe(0);
    await ctx.close();
  });

  test('PDF download: exact Letter pages, 30 labels per sheet, calibration sheet, bad input normalized, no caching', async () => {
    const get = async (q) => { const r = await fetch(stack.baseUrl + '/api/seller-resources/lot-labels.pdf' + q, { headers: { Authorization: 'Bearer ' + PRO_TOKEN } }); return { r, info: pdfInfo(Buffer.from(await r.arrayBuffer())) }; };
    const a = await get('?from=1&to=31&seller=' + encodeURIComponent('A Very Long Business Name That Keeps Going and Going Estate Services LLC'));
    expect([a.r.status, a.r.headers.get('content-type'), a.r.headers.get('content-disposition'), a.r.headers.get('cache-control')])
      .toEqual([200, 'application/pdf', 'attachment; filename="advantage-bid-lot-labels-1-31.pdf"', 'private, no-store']);
    expect(a.info).toEqual({ head: '%PDF-', pages: 2, boxes: ['/MediaBox [0 0 612 792]'] });
    expect((await get('?mode=calibrate')).info.pages).toBe(1);
    expect((await get('?from=101&to=700')).info.pages).toBe(20);   // 600 labels, the most at once
    const bad = await get('?from=abc&to=-4&seller=%3Cscript%3E');
    expect([bad.r.status, bad.info.pages]).toEqual([200, 1]);
  });

  test('worksheet: landscape, 12 numbered rows a page with zone and quantity, sale and date filled in, page numbers', async () => {
    const { ctx, page } = await open({}, '/seller-how-to');
    await page.fill('#w-sale', 'Westside Estate'); await page.fill('#w-date', '2026-11-14'); await page.fill('#w-pages', '2'); await page.fill('#w-from', '201');
    await page.click('#p-worksheet');
    expect(await page.$$eval('#print-area thead th', (h) => h.slice(0, 9).map((x) => x.textContent))).toEqual(['Lot', 'Zone', 'Item', 'Maker, marks and details', 'Condition and flaws', 'Size', 'Qty', 'Photos', 'Notes']);
    expect(await page.$$eval('#print-area tbody tr', (r) => r.length)).toBe(24);
    expect(await page.$$eval('#print-area tbody td.lot', (c) => [c[0].textContent, c[23].textContent])).toEqual(['201', '224']);
    expect(await page.textContent('#print-area')).toMatch(/Sale: Westside Estate[\s\S]*Date: 11\/14\/2026[\s\S]*Page 1 of 2[\s\S]*Page 2 of 2/);
    expect(await printed(page)).toEqual({ pages: 2, boxes: ['/MediaBox [0 0 792 612]'] });
    await ctx.close();
  });

  test('checklists: the expanded setup and pickup sequences, one page each, no fixed closing interval or featured-lot count', async () => {
    const { ctx, page } = await open({}, '/seller-how-to');
    await page.click('#p-setup');
    const setup = await page.$$eval('#print-area .cl h2', (h) => h.map((x) => x.textContent));
    expect(setup).toEqual(['Sale scope and excluded property', 'Merchandise evaluation and grouping', 'Inventory locations and lot numbering', 'Photography and descriptions',
      'Condition and dimensions', 'Dates, previews, pickup terms and fulfillment', 'Featured lots and marketing', 'Catalog quality review before publication']);
    const st = await page.textContent('#print-area');
    expect(st).not.toMatch(/one minute apart|three featured|3 featured/i);
    expect(await printed(page)).toEqual({ pages: 1, boxes: ['/MediaBox [0 0 612 792]'] });
    await page.click('#p-pickup');
    const pt = await page.textContent('#print-area');
    for (const s of [/identity/i, /paid on Advantage\.Bid/, /released on the pickup list/, /appointments/i, /access instructions/i, /furniture/i, /fragile/i,
      /Uncollected lots: follow the published pickup terms and platform procedures/, /Write down anything unusual/, /Lock rooms/]) expect(pt).toMatch(s);
    expect(pt).not.toMatch(/contact Advantage\.Bid support/i);
    expect(await printed(page)).toEqual({ pages: 1, boxes: ['/MediaBox [0 0 612 792]'] });
    await ctx.close();
  });

  test('no unsupported promises; reachable from the auction creation page and the Seller FAQ', async () => {
    const src = fs.readFileSync(path.join(PUBLIC, 'seller-how-to.html'), 'utf8');
    expect(src).not.toMatch(/guarantee|will sell for|you will get/i);
    for (const f of ['seller-create.html', 'seller-faq.html']) expect(fs.readFileSync(path.join(PUBLIC, f), 'utf8')).toMatch(/href="\/seller-how-to"/);
  });
});

describe('Seller Resources links throughout the seller account', () => {
  // Every link: the place it appears, and the How To Center section it must land on.
  const LINKS = [
    ['public/widgets/shared/member-shell.js', '/seller-how-to', 'organize'],
    ['public/widgets/shared/member-shell.js', '/seller-how-to#printables', 'printables'],
    ['public/widgets/shared/member-shell.js', '/seller-how-to#photos', 'photos'],
    ['public/widgets/shared/member-shell.js', '/seller-how-to#pickup-checklist', 'pickup-checklist'],
    ['public/widgets/shared/member-nav-config.js', '/seller-how-to', 'organize'],
    ['public/seller-create.html', '/seller-how-to', 'organize'],
    ['public/seller-create.html', '/seller-how-to#pickup-checklist', 'pickup-checklist'],
    ['public/seller-create.html', '/seller-how-to#pickup-notes', 'pickup-notes'],
    ['public/dashboard/lots.html', '/seller-how-to#photos', 'photos'],
    ['public/dashboard/lots.html', '/seller-how-to#t-labels', 't-labels'],
    ['public/dashboard/lots.html', '/seller-how-to#t-worksheet', 't-worksheet'],
    ['public/seller-orders.html', '/seller-how-to#pickup-checklist', 'pickup-checklist'],
    ['public/seller-orders.html', '/seller-how-to#pickup-notes', 'pickup-notes'],
  ];
  test('each link is present where it belongs and lands on an existing section, on desktop and phone', async () => {
    for (const [file, href] of LINKS) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      expect([file, href, src.includes("'" + href + "'") || src.includes('"' + href + '"')]).toEqual([file, href, true]);
    }
    for (const opts of [{}, devices['Galaxy S8']]) {
      const { ctx, page } = await open(opts, '/seller-how-to');
      for (const [, href, id] of LINKS) {
        await page.goto(stack.baseUrl + href, { waitUntil: 'domcontentloaded' });
        expect([href, await page.$('#' + id) !== null]).toEqual([href, true]);
      }
      await ctx.close();
    }
  });
  test('a signed-in seller sees Seller Resources on the dashboard home and Seller How To Center in the navigation', async () => {
    // Its own fresh environment: the member area makes several requests at once, which the in-memory database answers one
    // at a time; after the rest of this file's load it can stall (a test-environment limit, not a page fault).
    const seed = require('../fullstack/seed');
    const stack = await startStack();
    try {
    const userId = await seed.user(stack, { email: 'resources-seller@fullstack.test', role: 'seller', fullName: 'Rae Resources' });
    const sellerProfileId = await seed.sellerProfile(stack, { userId, sellerType: 'estate_sale_company', displayName: 'Rae Estate Sales', extra: { agreement_waived_at: new Date() } });
    await seed.signedStorefrontAgreement(stack, sellerProfileId);
    for (const opts of [{}, devices['Galaxy S8']]) {
      const ctx = await browser.newContext(opts); const page = await ctx.newPage();
      await page.route('**/*', (route) => (new URL(route.request().url()).origin === stack.baseUrl ? route.continue() : route.abort()));
      await page.addInitScript(() => { try { localStorage.setItem('ab_active_mode', 'selling'); } catch (e) { /* default mode */ } });
      await seed.browserLogin(page, stack, 'resources-seller@fullstack.test');
      await page.goto(stack.baseUrl + '/app.html#home');
      await page.waitForSelector('#adv-seller-resources', { timeout: 60000 }).catch(async (e) => { throw new Error(e.message + ' | page: ' + (await page.evaluate(() => document.body.innerText.slice(0, 600)))); });
      const links = await page.$$eval('#adv-seller-resources a', (a) => a.map((x) => [x.textContent.replace(/^\W+/, '').trim(), x.getAttribute('href')]));
      expect(links).toEqual([['Auction Setup Guide', '/seller-how-to'], ['Lot Labels & Inventory Worksheets', '/seller-how-to#printables'],
        ['Photography Tips', '/seller-how-to#photos'], ['Pickup Day Checklist', '/seller-how-to#pickup-checklist']]);
      expect(await page.$$eval('a[href="/seller-how-to"]', (a) => a.some((x) => /Seller How To Center/.test(x.textContent)))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await ctx.close();
    }
    } finally { await stack.stop(); }
  });
});
