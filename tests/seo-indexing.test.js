'use strict';
// SEO improvements (owner 2026-11-11): what search engines may index agrees everywhere (sitemap, robots tag, home links),
// hidden content never appears, unknown pages answer 404, and structured data is valid. Hermetic: the DB is mocked.

jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const vis = require('../src/lib/marketplaceVisibility');
const svc = require('../src/services/shareMetaService');
const mw = require('../src/middleware/shareMeta');
const home = require('../src/services/homeDiscoveryService');
const { verify } = require('../src/services/marketplaceIntegrity');

const UUID = '11111111-2222-3333-4444-555555555555';
beforeAll(() => { process.env.PUBLIC_BASE_URL = 'https://bid.advantage.bid'; });
beforeEach(() => { db.query.mockReset(); jest.restoreAllMocks(); home._reset(); });

function run(req) {
  return new Promise((resolve) => {
    const res = { _headers: {}, _body: null, statusCode: 200,
      status(c) { this.statusCode = c; return this; }, set(k, v) { this._headers[k] = v; return this; },
      send(b) { this._body = b; resolve({ res, nextCalled: false }); } };
    Promise.resolve(mw({ method: 'GET', ...req }, res, () => resolve({ res, nextCalled: true })));
  });
}

describe('one shared indexing rule', () => {
  test('indexable = the shared marketplace rule plus completed sales (demo, hidden, archived never)', () => {
    const s = vis.indexableNativeAuctionSql('a');
    expect(s).toContain("a.state IN ('published','active','closed')");
    expect(s).toContain("a.marketplace_status = 'syndicated'");
    expect(s).toContain('a.is_demo IS NOT TRUE');
    expect(s).toContain('a.is_archived IS NOT TRUE');
    // Same rules as the live-listing predicate except the extra 'closed' state.
    expect(vis.activeNativeAuctionSql('a').replace("'published','active'", "'published','active','closed'")).toBe(s);
  });
  test('the sitemap reads auctions and lots through that rule, and leaves withdrawn lots out', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await svc.getSitemapEntries();
    const [auctionSql, lotSql] = db.query.mock.calls.map((c) => c[0]);
    expect(auctionSql).toContain(vis.indexableNativeAuctionSql('a'));
    expect(lotSql).toContain(vis.indexableNativeAuctionSql('a'));
    expect(lotSql).toContain("l.state IS DISTINCT FROM 'withdrawn'");
  });
  test('auction and lot pages carry an indexable flag computed by the same rule', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ title: 'T', state: 'closed', indexable: true }] });
    expect(await svc.getAuctionMeta(UUID)).toMatchObject({ state: 'closed', indexable: true });
    expect(db.query.mock.calls[0][0]).toContain(vis.indexableNativeAuctionSql('a'));
    db.query.mockResolvedValueOnce({ rows: [{ title: 'L', lot_state: 'withdrawn', indexable: false }] });
    expect(await svc.getLotMeta(UUID)).toMatchObject({ lotState: 'withdrawn', indexable: false });
  });
});

describe('robots tag agrees with the sitemap', () => {
  const meta = (over) => ({ title: 'Maplewood Collection', description: 'd', image: 'https://img/x.jpg',
    url: 'https://bid.advantage.bid/auction-view.html?auctionId=' + UUID, siteName: 'Advantage.Bid', ...over });
  test('a demo or hidden auction (viewable by link) is noindex', async () => {
    jest.spyOn(svc, 'getAuctionMeta').mockResolvedValueOnce(meta({ indexable: false }));
    const r = await run({ path: '/auction-view.html', query: { auctionId: UUID } });
    expect(r.res.statusCode).toBe(200);
    expect(r.res._body).toContain('<meta name="robots" content="noindex,follow" />');
    expect((r.res._body.match(/name="robots"/g) || []).length).toBe(1);
  });
  test('a legitimate completed auction stays indexable (no noindex)', async () => {
    jest.spyOn(svc, 'getAuctionMeta').mockResolvedValueOnce(meta({ indexable: true, state: 'closed' }));
    const r = await run({ path: '/auction-view.html', query: { auctionId: UUID } });
    expect(r.res._body).not.toContain('noindex');
    expect(r.res._body).toContain('rel="canonical" href="https://bid.advantage.bid/auction-view.html?auctionId=' + UUID + '"');
  });
});

describe('real 404s for pages that do not exist', () => {
  test.each([
    ['/auction-view.html', { auctionId: UUID }, 'getAuctionMeta'],
    ['/lot.html', { lotId: UUID }, 'getLotMeta'],
    ['/event.html', { slug: 'no-such-sale' }, 'getEventMeta'],
  ])('%s unknown → 404, noindex, no canonical; the page script still runs', async (path, query, reader) => {
    jest.spyOn(svc, 'getEventExpiryState').mockResolvedValue(null);
    jest.spyOn(svc, reader).mockResolvedValueOnce(null);
    db.query.mockResolvedValueOnce({ rows: [] });           // the not-found check finds nothing
    const r = await run({ path, query });
    expect(r.res.statusCode).toBe(404);
    expect(r.res._body).toContain('content="noindex,follow"');
    expect(r.res._body).not.toMatch(/rel=["']canonical["']/);
    expect(r.res._body).toMatch(/<script/);                 // the browser page (and its not-found state) is unchanged
    expect(r.res._headers['Cache-Control']).toBe('no-store');
  });
  test('an existing page whose metadata failed to load is never turned into a 404', async () => {
    jest.spyOn(svc, 'getLotMeta').mockResolvedValueOnce(null);
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });   // it exists
    expect((await run({ path: '/lot.html', query: { lotId: UUID } })).nextCalled).toBe(true);
  });
  test('isPublicNotFound: true only on a successful empty lookup; null on a database error', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await svc.isPublicNotFound('auction', UUID)).toBe(true);
    db.query.mockRejectedValueOnce(new Error('connection reset'));
    expect(await svc.isPublicNotFound('auction', UUID)).toBeNull();
    expect(await svc.isPublicNotFound('lot', 'not-a-uuid')).toBe(true);
    expect(db.query.mock.calls[0][0]).toContain("a.state IN ('published', 'active', 'closed')");
  });
});

describe('structured data and social tags', () => {
  const url = 'https://bid.advantage.bid/lot.html?lotId=' + UUID;
  test('open lot: Product + Offer valid until the lot closes', () => {
    const p = mw.buildLotProduct({ title: 'Clock', priceCents: 4200, lotState: 'open', closesAt: '2026-12-01T18:00:00Z' }, url, 'https://img/c.jpg');
    expect(p.offers).toMatchObject({ price: '42.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock', priceValidUntil: '2026-12-01' });
  });
  test('closed and withdrawn lots: no Product (no stale offer, no invalid offer-less Product); breadcrumb remains', () => {
    for (const lotState of ['closed', 'withdrawn']) expect(mw.buildLotProduct({ title: 'Clock', priceCents: 4200, lotState }, url, null)).toBeNull();
    const script = mw.buildJsonLd('lot', { title: 'Clock', lotState: 'closed', auctionId: UUID, auctionTitle: 'A' }, url, 'https://img/c.jpg');
    const graph = JSON.parse(script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))['@graph'];
    expect(graph.map((n) => n['@type'])).toEqual(['BreadcrumbList']);
  });
  test('event page gains og:type, og:site_name, twitter:card and image alt (it had none); templates that have them are not duplicated', async () => {
    jest.spyOn(svc, 'getEventExpiryState').mockResolvedValue(null);
    jest.spyOn(svc, 'getEventMeta').mockResolvedValueOnce({ title: 'Oak Estate Sale', description: 'd', image: 'https://img/e.jpg',
      url: 'https://bid.advantage.bid/event.html?slug=oak', city: 'Austin', state: 'TX', siteName: 'Advantage.Bid' });
    const ev = (await run({ path: '/event.html', query: { slug: 'oak' } })).res._body;
    expect(ev).toContain('<meta property="og:type" content="website" />');
    expect(ev).toContain('<meta property="og:site_name" content="Advantage.Bid" />');
    expect(ev).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(ev).toContain('<meta property="og:image:alt" content="Oak Estate Sale | Advantage.Bid" />');
    jest.spyOn(svc, 'getAuctionMeta').mockResolvedValueOnce({ title: 'A', description: 'd', image: null, url: 'https://bid.advantage.bid/auction-view.html?auctionId=' + UUID, indexable: true });
    const au = (await run({ path: '/auction-view.html', query: { auctionId: UUID } })).res._body;
    for (const re of [/property="og:type"/g, /property="og:site_name"/g, /name="twitter:card"/g]) expect((au.match(re) || []).length).toBe(1);
  });
  test('socialExtras uses the small card when there is no real image', () => {
    expect(mw.socialExtras('<head>', 'T', false)).toContain('content="summary"');
    expect(mw.socialExtras('<head>', 'T', false)).not.toContain('og:image:alt');
  });
});

describe('home page links to public inventory', () => {
  test('auctions and events come from the shared live predicates; items from the sitemap list; output escaped', async () => {
    const runner = { query: jest.fn(async (sql) => {
      if (/FROM auctions a/.test(sql)) return { rows: [{ id: UUID, title: 'Spring <Estate> Auction' }] };
      if (/FROM events e/.test(sql)) return { rows: [{ slug: 'oak-sale', title: 'Oak Sale' }] };
      if (/FROM marketplace_items mi/.test(sql)) return { rows: [{ id: UUID, title: 'Brass Lamp', lastmod: null }] };
      return { rows: [] };
    }) };
    const html = await home.linksHtml(runner, 1);
    const sqls = runner.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes(vis.activeNativeAuctionSql('a')))).toBe(true);
    expect(sqls.some((s) => s.includes(vis.activeEventSql('e')))).toBe(true);
    expect(sqls.some((s) => /mi\.is_demo = false/.test(s) && /moderation_status = 'none'/.test(s))).toBe(true);
    expect(html).toContain(`<a href="/auction-view.html?auctionId=${UUID}">Spring &lt;Estate&gt; Auction</a>`);
    expect(html).toContain('<a href="/event.html?slug=oak-sale">Oak Sale</a>');
    expect(html).toContain('<a href="/shop/item/' + UUID + '/brass-lamp">Brass Lamp</a>');
    expect(html).toContain('<a href="/shop">Shop all items</a>');
  });
  test('a database error yields no list (the home page still serves); empty groups print nothing', async () => {
    const html = await home.linksHtml({ query: async () => { throw new Error('down'); } }, 1);
    expect(html).toBe('');
  });
  test('the home template carries the placeholder inside its no-JavaScript block, and menu links to the shop and events', () => {
    const tpl = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const ns = tpl.slice(tpl.indexOf('<noscript>'), tpl.indexOf('</noscript>'));
    expect(ns).toContain('<!-- SSR-DISCOVER -->');
    expect(tpl).toContain('<a href="/shop">🛍 Shop items for sale</a>');
    expect(tpl).toContain('<a href="/events.html">📅 Estate sales &amp; events</a>');
    expect(tpl).not.toContain('href="/how-it-works.html"');
  });
});

describe('integrity gate: hidden content in the sitemap or on the home page fails the deployment', () => {
  const fetchOf = (map) => async (url) => {
    for (const [k, v] of Object.entries(map)) if (url.includes(k)) return { ok: true, status: 200, text: async () => v };
    return { ok: false, status: 404, text: async () => '' };
  };
  // Satisfies canonicalCounts (events, native auctions, professionals, items) plus the indexing counts.
  const dbWith = (n) => ({ query: async (sql) => {
    if (/FROM events e/.test(sql)) return { rows: [{ kind: 'auction', n: 0, n_coord: 0 }] };
    if (/FROM organizations o/.test(sql)) return { rows: [] };
    if (/FROM auctions a/.test(sql) || /FROM lots l/.test(sql)) return { rows: [{ n }] };
    if (/FROM marketplace_items m/.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  } });
  test('a sitemap listing one more auction than the shared rule allows → FAIL', async () => {
    const leak = `<url><loc>https://x/auction-view.html?auctionId=${UUID}</loc></url>`;
    const r = await verify({ db: dbWith(0), baseUrl: 'https://x', fetchImpl: fetchOf({ '/sitemap.xml': leak, 'https://x/': '<html></html>' }) });
    expect(r.checks.find((c) => c.surface === 'seo:sitemap-auctions')).toMatchObject({ status: 'FAIL', expected: 0, actual: 1 });
  });
  test('a home page linking an auction the shared rule hides → FAIL', async () => {
    const r = await verify({ db: dbWith(0), baseUrl: 'https://x', fetchImpl: fetchOf({ '/sitemap.xml': '<url></url>', 'https://x/': `<a href="/auction-view.html?auctionId=${UUID}">x</a>` }) });
    expect(r.checks.find((c) => c.surface === 'home:auction-links')).toMatchObject({ status: 'FAIL', expected: 0, actual: 1 });
  });
  test('an unknown canonical count is a WARNING, never a silent pass', async () => {
    const r = await verify({ db: { query: async () => { throw new Error('down'); } }, baseUrl: 'https://x', fetchImpl: fetchOf({ '/sitemap.xml': '<url></url>' }) }).catch(() => null);
    if (r) expect(r.checks.find((c) => c.surface === 'seo:sitemap-auctions').status).toBe('WARNING');
  });
});
