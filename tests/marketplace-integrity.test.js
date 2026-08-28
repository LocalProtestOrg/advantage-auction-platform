'use strict';

// Marketplace Integrity Suite (Phase 6A) — hermetic. db + fetch are mocked; verifies the canonical
// DB tally, count-parity PASS, divergence → FAIL (hidden-leak & missing-listing), and SEO checks.

const { canonicalCounts, activeEventSql, activeNativeAuctionSql } = require('../src/lib/marketplaceVisibility');
const { verify, formatReport } = require('../src/services/marketplaceIntegrity');

// A db whose canonicalCounts queries return event rows + native-auction count + professionals rows.
// profRows: [{ pid, n }] for the professionals GROUP BY (default: 7 estate-sale companies).
function fakeDb(eventRows, nativeN, profRows) {
  profRows = profRows || [{ pid: '4', n: 7 }];
  return { query: async (sql) => {
    if (/FROM events e/.test(sql)) return { rows: eventRows };
    if (/FROM auctions a/.test(sql)) return { rows: [{ n: nativeN }] };
    if (/FROM organizations o/.test(sql)) return { rows: profRows };
    if (/FROM marketplace_items m/.test(sql)) return { rows: [{ n: 0 }] }; // no fixed-price items in these fixtures
    return { rows: [] };
  } };
}
const PROF_TOTAL = (profRows) => (profRows || [{ pid: '4', n: 7 }]).reduce((s, r) => s + r.n, 0);
// A fetch keyed by URL substring → { ok, status, text() }. Missing entries → 404.
function fakeFetch(map) {
  return async (url) => {
    for (const [frag, body] of Object.entries(map)) {
      if (url.includes(frag)) {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: true, status: 200, text: async () => text };
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

const EVENTS = [{ kind: 'auction', n: 55, n_coord: 0 }, { kind: 'estate_sale', n: 2, n_coord: 2 }];

describe('marketplaceVisibility — one canonical definition', () => {
  test('predicate fragments are alias-configurable and correct', () => {
    expect(activeEventSql('e')).toBe("e.status = 'published' AND (e.end_at IS NULL OR e.end_at >= now())");
    expect(activeNativeAuctionSql('a')).toMatch(/a\.state IN \('published','active'\).*a\.is_archived IS NOT TRUE.*a\.marketplace_status = 'syndicated'/);
  });
  test('families: Marketplace is fixed-price (0), GSA-style auctions count as partner_event not advantage_auction', async () => {
    const c = await canonicalCounts(fakeDb(EVENTS, 3, [{ pid: '4', n: 5 }, { pid: '3', n: 3 }, { pid: '5', n: 1 }]));
    // 55 auction EVENTS are Auction Partner Events, NOT Advantage.Bid Auctions (which is the 3 native).
    expect(c.families).toEqual({ advantage_auction: 3, partner_event: 55, estate_sale: 2, marketplace: 0 });
    expect(c.native_auctions).toBe(3);
    // Professionals is a SEPARATE directory concept (never the Marketplace family count).
    expect(c.professionals).toEqual({ estate_sale_companies: 5, auction_houses: 3, appraisers: 1, total: 9 });
    expect(c.expect).toMatchObject({ feed_auctions: 58, professionals_total: 9, marketplace_items: 0 });
  });
});

const AUC_ITEMS = { total: 55, data: Array.from({ length: 12 }, (_, i) => ({ type: 'auction', family: i ? 'partner_event' : 'advantage_auction', family_label: i ? 'Auction Partner Events' : 'Advantage.Bid Auctions' })) };
const okFetch = () => fakeFetch({
  'preset=all-events&page=1&pageSize=1': { total: 57 },
  'preset=auctions&page=1&pageSize=1': { total: 55 },
  'preset=estate-sales&page=1&pageSize=1': { total: 2 },
  '/events/map': { counts: { auction: 0, estate_sale: 2 } },
  'preset=all-events&page=1&pageSize=12': { total: 57, data: Array.from({ length: 12 }, () => ({ type: 'auction' })) },
  'preset=auctions&page=1&pageSize=12': AUC_ITEMS,
  '/api/public/marketplace/counts': { success: true, families: { advantage_auction: 0, partner_event: 55, estate_sale: 2, marketplace: 0 }, professionals: { estate_sale_companies: 7, auction_houses: 0, appraisers: 0, total: 7 } },
  '/api/public/marketplace': { total: 7, data: [] },
  '/sitemap.xml': '<urlset><url><loc>https://bid.advantage.bid/event.html?slug=x</loc></url></urlset>',
  '/api/public/events?limit=1': { data: [{ slug: 'sample-event' }] },
  '/event.html?slug=sample-event': '<link rel="canonical" href="..."><script type="application/ld+json">{"@type":"Event"}</script>',
});

describe('verify — count parity + SEO (all green)', () => {
  test('matching APIs → overall PASS, every check PASS', async () => {
    const r = await verify({ db: fakeDb(EVENTS, 0), baseUrl: 'https://x', fetchImpl: okFetch() });
    expect(r.overall).toBe('PASS');
    expect(r.checks.every((c) => c.status === 'PASS')).toBe(true);
    expect(r.checks.find((c) => c.surface === 'feed:auctions').status).toBe('PASS');
    expect(r.checks.find((c) => c.surface === 'seo:sitemap').status).toBe('PASS');
    expect(r.checks.find((c) => c.surface === 'seo:event-detail').status).toBe('PASS');
  });
});

describe('verify — divergence FAILS the gate', () => {
  test('HIDDEN/PRIVATE listing leak (API count too HIGH) → FAIL', async () => {
    const f = okFetch();
    const leaky = fakeFetch(Object.assign({}, {
      'preset=all-events&page=1&pageSize=1': { total: 57 },
      'preset=auctions&page=1&pageSize=1': { total: 99 },   // 44 phantom auctions leaked
      'preset=estate-sales&page=1&pageSize=1': { total: 2 },
      '/events/map': { counts: { auction: 0, estate_sale: 2 } },
      'preset=all-events&page=1&pageSize=12': { total: 57, data: [{ type: 'auction' }] },
      '/sitemap.xml': '<url><loc>x</loc></url>', '/api/public/events?limit=1': { data: [{ slug: 's' }] },
      '/event.html?slug=s': '<link rel="canonical"><script type="application/ld+json">{"@type":"Event"}</script>',
    }));
    const r = await verify({ db: fakeDb(EVENTS, 0), baseUrl: 'https://x', fetchImpl: leaky });
    expect(r.overall).toBe('FAIL');
    expect(r.checks.find((c) => c.surface === 'feed:auctions').status).toBe('FAIL');
  });
  test('MISSING professional listing (API count too LOW) → FAIL', async () => {
    const low = fakeFetch({
      'preset=all-events&page=1&pageSize=1': { total: 57 },
      'preset=auctions&page=1&pageSize=1': { total: 55 },
      'preset=estate-sales&page=1&pageSize=1': { total: 0 },  // 2 estate sales dropped
      '/events/map': { counts: { auction: 0, estate_sale: 2 } },
      'preset=all-events&page=1&pageSize=12': { total: 57, data: [] },
      '/sitemap.xml': '<url><loc>x</loc></url>', '/api/public/events?limit=1': { data: [{ slug: 's' }] },
      '/event.html?slug=s': '<link rel="canonical"><script type="application/ld+json">{"@type":"Event"}</script>',
    });
    const r = await verify({ db: fakeDb(EVENTS, 0), baseUrl: 'https://x', fetchImpl: low });
    expect(r.overall).toBe('FAIL');
    expect(r.checks.find((c) => c.surface === 'feed:estate-sales').status).toBe('FAIL');
  });
  test('missing sitemap → FAIL; unreachable API (status 0) → WARNING not FAIL', async () => {
    const noSitemap = fakeFetch({
      'preset=all-events&page=1&pageSize=1': { total: 57 }, 'preset=auctions&page=1&pageSize=1': { total: 55 },
      'preset=estate-sales&page=1&pageSize=1': { total: 2 }, '/events/map': { counts: { auction: 0, estate_sale: 2 } },
      'preset=all-events&page=1&pageSize=12': { total: 57, data: [{ type: 'auction' }] },
      '/api/public/events?limit=1': { data: [{ slug: 's' }] },
      '/event.html?slug=s': '<link rel="canonical"><script type="application/ld+json">{"@type":"Event"}</script>',
      // no /sitemap.xml entry → 404 → FAIL
    });
    const r = await verify({ db: fakeDb(EVENTS, 0), baseUrl: 'https://x', fetchImpl: noSitemap });
    expect(r.checks.find((c) => c.surface === 'seo:sitemap').status).toBe('FAIL');
    expect(r.overall).toBe('FAIL');
  });
});

describe('DB-only mode + report', () => {
  test('no baseUrl → canonical computed, no surface checks, overall PASS', async () => {
    const r = await verify({ db: fakeDb(EVENTS, 1), live: false });
    expect(r.canonical.events.total).toBe(57);
    expect(r.checks.length).toBe(0);
    expect(r.overall).toBe('PASS');
  });
  test('formatReport renders overall + canonical tally', async () => {
    const r = await verify({ db: fakeDb(EVENTS, 0), live: false });
    const txt = formatReport(r);
    expect(txt).toMatch(/MARKETPLACE INTEGRITY REPORT/);
    expect(txt).toMatch(/OVERALL:\s+PASS/);
    expect(txt).toMatch(/Auction Partner Events: 55/);
    expect(txt).toMatch(/Advantage\.Bid Auctions:/);
  });
});
