'use strict';

// Phase 2 — server-side share-meta middleware.
// Hermetic: the DB module is mocked (no real DB is ever touched).

jest.mock('../src/db', () => ({ query: jest.fn() }));

const db  = require('../src/db');
const svc = require('../src/services/shareMetaService');
const mw  = require('../src/middleware/shareMeta');

const UUID = '11111111-2222-3333-4444-555555555555';

beforeAll(() => { process.env.PUBLIC_BASE_URL = 'https://bid.advantage.bid'; });
beforeEach(() => { db.query.mockReset(); });

describe('escapeHtml', () => {
  test('escapes markup-breaking characters', () => {
    expect(mw.escapeHtml('<b>"x" & \'y\'>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&gt;');
  });
  test('null/undefined → empty string', () => {
    expect(mw.escapeHtml(null)).toBe('');
    expect(mw.escapeHtml(undefined)).toBe('');
  });
  test('prevents attribute breakout', () => {
    expect(mw.escapeHtml('" onload="alert(1)')).toBe('&quot; onload=&quot;alert(1)');
  });
});

describe('absoluteImage', () => {
  test('absolute http(s) passes through', () => {
    expect(mw.absoluteImage('https://res.cloudinary.com/x.jpg')).toBe('https://res.cloudinary.com/x.jpg');
  });
  test('root-relative gets prefixed', () => {
    expect(mw.absoluteImage('/img/foo.png')).toBe('https://bid.advantage.bid/img/foo.png');
  });
  test('null → default social card', () => {
    expect(mw.absoluteImage(null)).toBe('https://bid.advantage.bid/img/social-card.png');
  });
});

describe('getAuctionMeta', () => {
  test('found → mapped OG fields', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      title: 'Grand   Estate\nSale',
      subtitle: '  Fine   art & antiques  ',
      description: 'ignored because subtitle present',
      start_time: '2026-08-01T00:00:00Z',
      end_time: '2026-08-05T00:00:00Z',
      cover_image_url: 'https://res.cloudinary.com/cover.jpg',
      banner_image_url: 'https://res.cloudinary.com/banner.jpg',
      seller_display_name: 'Acme Estates',
    }] });
    const m = await svc.getAuctionMeta(UUID);
    expect(m.title).toBe('Grand Estate Sale');            // whitespace collapsed
    expect(m.description).toBe('Fine art & antiques');    // subtitle wins + trimmed
    expect(m.image).toBe('https://res.cloudinary.com/cover.jpg'); // cover wins
    expect(m.url).toBe('https://bid.advantage.bid/auction-view.html?auctionId=' + UUID);
    expect(m.type).toBe('website');
    expect(m.siteName).toBe('Advantage.Bid');
    expect(m.organizer).toBe('Acme Estates');
  });

  test('description falls back to description then default', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ title: 'T', subtitle: null, description: null,
      cover_image_url: null, banner_image_url: null, seller_display_name: null }] });
    const m = await svc.getAuctionMeta(UUID);
    expect(m.description).toBe('Bid on estate & liquidation lots on Advantage.Bid.');
    expect(m.image).toBeNull();
    expect(m.organizer).toBeNull();
  });

  test('not found → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await svc.getAuctionMeta(UUID)).toBeNull();
  });

  test('invalid uuid → null WITHOUT querying', async () => {
    expect(await svc.getAuctionMeta('not-a-uuid')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('DB error → null (fail-open)', async () => {
    db.query.mockRejectedValueOnce(new Error('boom'));
    expect(await svc.getAuctionMeta(UUID)).toBeNull();
  });
});

describe('getLotMeta', () => {
  test('found → lot title + first image', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      title: 'Tiffany Lamp',
      description: 'A stunning original.',
      thumbnail_url: 'https://x/thumb.jpg',
      lot_number: 12,
      auction_id: UUID,
      auction_title: 'Grand Estate Sale',
      first_image_url: 'https://x/first.jpg',
    }] });
    const m = await svc.getLotMeta(UUID);
    expect(m.title).toBe('Tiffany Lamp');
    expect(m.description).toBe('A stunning original.'); // lot description preferred
    expect(m.image).toBe('https://x/first.jpg');        // first image wins over thumbnail
    expect(m.url).toBe('https://bid.advantage.bid/lot.html?lotId=' + UUID);
    expect(m.auctionTitle).toBe('Grand Estate Sale');
  });

  test('no description → composed fallback + thumbnail', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      title: 'Brass Clock', description: null, thumbnail_url: 'https://x/thumb.jpg',
      lot_number: 3, auction_id: UUID, auction_title: 'Fall Auction', first_image_url: null }] });
    const m = await svc.getLotMeta(UUID);
    expect(m.description).toBe('Brass Clock — Fall Auction on Advantage.Bid');
    expect(m.image).toBe('https://x/thumb.jpg');
  });

  test('not found → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await svc.getLotMeta(UUID)).toBeNull();
  });

  test('invalid uuid → null WITHOUT querying', async () => {
    expect(await svc.getLotMeta('nope')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('clean truncation', () => {
  test('truncates to ~160 chars with ellipsis', () => {
    const long = 'a'.repeat(300);
    const out = svc.clean(long, 160);
    expect(out.length).toBe(160);
    expect(out.endsWith('…')).toBe(true);
  });
});

// Middleware — driven directly with stub req/res (no supertest dependency).
function run(req) {
  return new Promise((resolve) => {
    const res = {
      _headers: {},
      _body: null,
      set(k, v) { this._headers[k] = v; return this; },
      send(b) { this._body = b; resolve({ res, nextCalled: false }); },
    };
    const next = () => resolve({ res, nextCalled: true });
    Promise.resolve(mw(req, res, next));
  });
}

describe('shareMeta middleware', () => {
  test('non-GET → next()', async () => {
    const r = await run({ method: 'POST', path: '/auction-view.html', query: { auctionId: UUID } });
    expect(r.nextCalled).toBe(true);
  });

  test('unhandled path → next()', async () => {
    const r = await run({ method: 'GET', path: '/index.html', query: {} });
    expect(r.nextCalled).toBe(true);
  });

  test('no id → next()', async () => {
    const r = await run({ method: 'GET', path: '/auction-view.html', query: {} });
    expect(r.nextCalled).toBe(true);
  });

  test('entity not found (null) → next(), static fallback serves', async () => {
    jest.spyOn(svc, 'getAuctionMeta').mockResolvedValueOnce(null);
    const r = await run({ method: 'GET', path: '/auction-view.html', query: { auctionId: 'bad' } });
    expect(r.nextCalled).toBe(true);
    svc.getAuctionMeta.mockRestore();
  });

  test('auction found → injected og:title, body untouched', async () => {
    jest.spyOn(svc, 'getAuctionMeta').mockResolvedValueOnce({
      title: 'Grand & "Rare" Estate',
      description: 'Fine art & antiques',
      image: 'https://res.cloudinary.com/cover.jpg',
      url: 'https://bid.advantage.bid/auction-view.html?auctionId=' + UUID,
      type: 'website', siteName: 'Advantage.Bid', organizer: 'Acme',
    });
    const r = await run({ method: 'GET', path: '/auction-view.html', query: { auctionId: UUID } });
    expect(r.nextCalled).toBe(false);
    const html = r.res._body;
    // Escaped entity title present in og:title and <title>.
    expect(html).toContain('<meta property="og:title" content="Grand &amp; &quot;Rare&quot; Estate | Advantage.Bid" />');
    expect(html).toContain('<title>Grand &amp; &quot;Rare&quot; Estate | Advantage.Bid</title>');
    expect(html).toContain('content="https://res.cloudinary.com/cover.jpg"');
    // Exactly one canonical / og:title / og:image (Phase-1 stripped).
    expect((html.match(/property="og:title"/g) || []).length).toBe(1);
    expect((html.match(/rel="canonical"/g) || []).length).toBe(1);
    expect((html.match(/property="og:image"/g) || []).length).toBe(1);
    // og:image:width (non-targeted) preserved.
    expect(html).toContain('property="og:image:width"');
    // Headers set correctly.
    expect(r.res._headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(r.res._headers['Cache-Control']).toBe('public, max-age=300');
    // Body from </head> onward is byte-for-byte identical to the source file.
    const fs = require('fs');
    const path = require('path');
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'public', 'auction-view.html'), 'utf8');
    const tplRest = tpl.slice(tpl.indexOf('</head>'));
    const htmlRest = html.slice(html.indexOf('</head>'));
    expect(htmlRest).toBe(tplRest);
    svc.getAuctionMeta.mockRestore();
  });

  test('lot found via lotId → injected og:title', async () => {
    jest.spyOn(svc, 'getLotMeta').mockResolvedValueOnce({
      title: 'Tiffany Lamp',
      description: 'A stunning original.',
      image: null,
      url: 'https://bid.advantage.bid/lot.html?lotId=' + UUID,
      auctionTitle: 'Grand Estate Sale', siteName: 'Advantage.Bid',
    });
    const r = await run({ method: 'GET', path: '/lot.html', query: { lotId: UUID } });
    expect(r.nextCalled).toBe(false);
    const html = r.res._body;
    expect(html).toContain('<meta property="og:title" content="Tiffany Lamp | Advantage.Bid" />');
    // Null image → default social card (absolute).
    expect(html).toContain('content="https://bid.advantage.bid/img/social-card.png"');
    svc.getLotMeta.mockRestore();
  });
});

// ── Phase 3 — JSON-LD ────────────────────────────────────────────────────────

// Extract and parse the single application/ld+json script from injected HTML.
function extractJsonLd(html) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  // Reverse the </script>-defense escape before parsing.
  return JSON.parse(m[1].replace(/\\u003c/g, '<'));
}

describe('buildAuctionEvent', () => {
  test('found auction → Event with startDate/endDate + organizer', () => {
    const ev = mw.buildAuctionEvent(
      { title: 'Grand Estate', description: 'Fine art', startDate: '2026-08-01T00:00:00Z',
        endDate: '2026-08-05T00:00:00Z', organizer: 'Acme Estates' },
      'https://bid.advantage.bid/auction-view.html?auctionId=' + UUID,
      'https://bid.advantage.bid/img/social-card.png'
    );
    expect(ev['@type']).toBe('Event');
    expect(ev.name).toBe('Grand Estate');
    expect(ev.startDate).toBe('2026-08-01T00:00:00.000Z');
    expect(ev.endDate).toBe('2026-08-05T00:00:00.000Z');
    expect(ev.eventAttendanceMode).toBe('https://schema.org/OnlineEventAttendanceMode');
    expect(ev.eventStatus).toBe('https://schema.org/EventScheduled');
    expect(ev.organizer).toEqual({ '@type': 'Organization', name: 'Acme Estates' });
    expect(ev.location).toEqual({ '@type': 'VirtualLocation', url: ev.url });
  });

  test('null dates + null organizer → omitted / defaulted', () => {
    const ev = mw.buildAuctionEvent(
      { title: 'T', description: null, startDate: null, endDate: null, organizer: null },
      'https://bid.advantage.bid/auction-view.html?auctionId=' + UUID,
      'https://bid.advantage.bid/img/social-card.png'
    );
    expect('startDate' in ev).toBe(false);
    expect('endDate' in ev).toBe(false);
    expect('description' in ev).toBe(false);
    expect(ev.organizer.name).toBe('Advantage.Bid'); // default
  });
});

describe('buildLotProduct', () => {
  test('price present → offers emitted with formatted price', () => {
    const p = mw.buildLotProduct(
      { title: 'Tiffany Lamp', description: 'Original', priceCents: 12500 },
      'https://bid.advantage.bid/lot.html?lotId=' + UUID,
      'https://x/first.jpg'
    );
    expect(p['@type']).toBe('Product');
    expect(p.offers).toEqual({
      '@type': 'Offer', priceCurrency: 'USD', price: '125.00',
      availability: 'https://schema.org/InStock',
      url: 'https://bid.advantage.bid/lot.html?lotId=' + UUID,
    });
  });

  test('no price → offers OMITTED (not fabricated)', () => {
    const p = mw.buildLotProduct(
      { title: 'Brass Clock', description: 'Ticking', priceCents: null },
      'https://bid.advantage.bid/lot.html?lotId=' + UUID,
      'https://x/thumb.jpg'
    );
    expect('offers' in p).toBe(false);
  });
});

describe('buildJsonLd + injection', () => {
  test('auction → @graph has Event + BreadcrumbList Home→Auction', () => {
    const script = mw.buildJsonLd('auction',
      { title: 'Grand Estate', description: 'Fine art', startDate: '2026-08-01T00:00:00Z',
        endDate: '2026-08-05T00:00:00Z', organizer: 'Acme' },
      'https://bid.advantage.bid/auction-view.html?auctionId=' + UUID,
      'https://bid.advantage.bid/img/social-card.png');
    const obj = JSON.parse(script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').replace(/\\u003c/g, '<'));
    expect(obj['@context']).toBe('https://schema.org');
    const event = obj['@graph'].find(g => g['@type'] === 'Event');
    const crumb = obj['@graph'].find(g => g['@type'] === 'BreadcrumbList');
    expect(event.name).toBe('Grand Estate');
    expect(crumb.itemListElement.map(i => i.name)).toEqual(['Home', 'Grand Estate']);
    expect(crumb.itemListElement[0].item).toBe('https://bid.advantage.bid/');
  });

  test('lot → @graph has Product + Breadcrumb Home→Auction→Lot', () => {
    const script = mw.buildJsonLd('lot',
      { title: 'Tiffany Lamp', description: 'Original', priceCents: 5000,
        auctionId: UUID, auctionTitle: 'Grand Estate' },
      'https://bid.advantage.bid/lot.html?lotId=' + UUID,
      'https://x/first.jpg');
    const obj = JSON.parse(script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').replace(/\\u003c/g, '<'));
    const crumb = obj['@graph'].find(g => g['@type'] === 'BreadcrumbList');
    expect(crumb.itemListElement.map(i => i.name)).toEqual(['Home', 'Grand Estate', 'Tiffany Lamp']);
    expect(crumb.itemListElement[1].item).toBe('https://bid.advantage.bid/auction-view.html?auctionId=' + UUID);
  });

  test('</script> in a value is escaped and cannot break out', () => {
    const script = mw.buildJsonLd('lot',
      { title: 'Evil</script><script>alert(1)</script>', description: 'x', priceCents: null,
        auctionId: UUID, auctionTitle: 'A' },
      'https://bid.advantage.bid/lot.html?lotId=' + UUID, 'https://x/i.jpg');
    // No raw </script> before the trailing tag.
    expect(script.slice(0, -'</script>'.length)).not.toContain('</script>');
    expect(script).toContain('\\u003c/script');
    // Still valid JSON once the escape is reversed.
    const obj = JSON.parse(script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').replace(/\\u003c/g, '<'));
    expect(obj['@graph'][0].name).toContain('Evil');
  });

  test('middleware injects exactly one ld+json for a found auction', async () => {
    jest.spyOn(svc, 'getAuctionMeta').mockResolvedValueOnce({
      title: 'Grand Estate', description: 'Fine art',
      image: 'https://res.cloudinary.com/cover.jpg',
      url: 'https://bid.advantage.bid/auction-view.html?auctionId=' + UUID,
      type: 'website', siteName: 'Advantage.Bid', organizer: 'Acme',
      startDate: '2026-08-01T00:00:00Z', endDate: '2026-08-05T00:00:00Z',
    });
    const r = await run({ method: 'GET', path: '/auction-view.html', query: { auctionId: UUID } });
    const html = r.res._body;
    expect((html.match(/application\/ld\+json/g) || []).length).toBe(1);
    const obj = extractJsonLd(html);
    expect(obj['@graph'].find(g => g['@type'] === 'Event').endDate).toBe('2026-08-05T00:00:00.000Z');
    svc.getAuctionMeta.mockRestore();
  });
});

// ── Phase 3 — getSitemapEntries ──────────────────────────────────────────────

describe('getSitemapEntries', () => {
  test('maps auction + lot rows to id/lastmod', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', lastmod: '2026-07-01T00:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'l1', lastmod: '2026-07-02T00:00:00Z' }] });
    const e = await svc.getSitemapEntries();
    expect(e.auctions).toEqual([{ id: 'a1', lastmod: '2026-07-01T00:00:00Z' }]);
    expect(e.lots).toEqual([{ id: 'l1', lastmod: '2026-07-02T00:00:00Z' }]);
  });

  test('DB error → empty arrays (fail-safe, never throws)', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    const e = await svc.getSitemapEntries();
    expect(e).toEqual({ auctions: [], lots: [], events: [] });
  });
});
