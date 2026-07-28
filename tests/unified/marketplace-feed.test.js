'use strict';

/**
 * Unified Marketplace Feed — one feed, one search, one card renderer for auctions + estate sales.
 * Source-level guarantees (the SQL is validated live against prod separately).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const pub = read('src', 'routes', 'public.js');
const widget = read('public', 'widgets', 'marketplace-feed.js');

describe('GET /api/public/marketplace/feed — unified, one search implementation', () => {
  const h = pub.slice(pub.indexOf("router.get('/marketplace/feed'"), pub.indexOf("router.get('/auctions'"));
  test('UNIONs auctions AND estate-sale events into one feed', () => {
    expect(h).toContain("'auction'::text AS kind");
    expect(h).toContain("'estate_sale'::text AS kind");
    expect(h).toContain('UNION ALL');
    expect(h).toContain('FROM auctions a');
    expect(h).toContain('FROM events e');
  });
  test('honors marketplace visibility + buyer-privacy on both sources', () => {
    expect(h).toContain("marketplace_status = 'syndicated'"); // auctions never leak hidden
    expect(h).toContain("e.status = 'published'");             // events only published
    expect(h).toContain('${B_NAME} AS company');              // private sellers anonymized
  });
  test('server-side search: q (title/city/company), city, state, zip, type', () => {
    expect(h).toMatch(/feed\.title ILIKE[\s\S]*feed\.city ILIKE[\s\S]*feed\.company ILIKE/);
    expect(h).toContain('feed.city ILIKE');
    expect(h).toContain('upper(feed.state) =');
    expect(h).toContain('feed.zip LIKE');
    expect(h).toMatch(/feed\.kind = \$/); // type filter
  });
  test('paginated + normalized card shape with canonical Railway URLs', () => {
    expect(h).toContain('COUNT(*) OVER() AS total_count');
    expect(h).toContain('LIMIT $');
    expect(h).toContain('/auction-view.html?auctionId=');
    expect(h).toContain('/event.html?slug=');
    expect(h).toContain('has_more');
  });
});

describe('marketplace-feed widget — one card renderer, List|Map continuity', () => {
  test('reads filters from the URL and calls the unified feed API', () => {
    expect(widget).toContain('/api/public/marketplace/feed');
    expect(widget).toContain('function readFilters');
    for (const k of ['q', 'city', 'state', 'zip', 'type']) expect(widget).toContain("'" + k + "'");
  });
  test('renders BOTH auctions and estate sales with the same card()', () => {
    expect(widget).toContain('function card(');
    expect(widget).toContain("it.type === 'estate_sale'");
    expect(widget).toContain('Live auction');
    expect(widget).toContain('Estate Sale');
  });
  test('List|Map toggle hands off to the Railway map, carrying filters', () => {
    expect(widget).toContain('MAP_URL');
    expect(widget).toMatch(/qs\(f, \{ view: 'map' \}\)/);
    expect(widget).toContain("target=\"_top\""); // breaks out of a BD iframe
  });
  test('private-seller anonymity respected on the client (no "by null")', () => {
    expect(widget).toMatch(/it\.company \? \('by ' \+ esc\(it\.company\)\)/);
  });
});

describe('reciprocal List handoff on the Railway map (index.html)', () => {
  const idx = read('public', 'index.html');
  test('the map offers a List view link to the canonical /all-events, preserving filters', () => {
    expect(idx).toContain('id="view-list-link"');
    expect(idx).toContain('https://www.advantage.bid/all-events');
    expect(idx).toMatch(/\['q', 'city', 'state', 'zip', 'type'\]\.forEach/);
  });
});
