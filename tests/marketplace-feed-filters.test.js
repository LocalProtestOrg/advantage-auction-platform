'use strict';

// Regression tests for the two event-feed filter bugs.
// Bug 2 (type): the All Events widget sends preset=all-events + a type chip; the API must honor the
//   chip while keeping type-specific presets server-locked.
// Bug 1 (distance): the radius resolution must send a numeric radius and treat nationwide/absent as
//   "no distance filter" — and the widget must send lat/lng/radius on every (paginated) request.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const fs = require('fs');
const feed = require('../src/routes/public');
const { resolveFeedType, resolveFeedGeo } = feed;
const widget = fs.readFileSync('public/widgets/marketplace-feed.js', 'utf8');

describe('resolveFeedType — event-type filter (Bug 2)', () => {
  test('1. All Events default → all (both types)', () => {
    expect(resolveFeedType({ preset: 'all-events' })).toBe('all');
    expect(resolveFeedType({ preset: 'all-events', type: 'all' })).toBe('all');
  });
  test('2. Estate Sales chip on All Events → estate_sale (was ignored → all)', () => {
    expect(resolveFeedType({ preset: 'all-events', type: 'estate_sale' })).toBe('estate_sale');
  });
  test('3. Auctions chip on All Events → auction (was ignored → all)', () => {
    expect(resolveFeedType({ preset: 'all-events', type: 'auction' })).toBe('auction');
  });
  test('type-specific presets stay SERVER-LOCKED (cannot be widened by a tampered type param)', () => {
    expect(resolveFeedType({ preset: 'estate-sales', type: 'auction' })).toBe('estate_sale'); // /events never shows auctions
    expect(resolveFeedType({ preset: 'auctions', type: 'estate_sale' })).toBe('auction');      // /auctions never shows estate sales
    expect(resolveFeedType({ preset: 'estate-sales' })).toBe('estate_sale');
    expect(resolveFeedType({ preset: 'auctions' })).toBe('auction');
  });
  test('15. page defaults: /all-events→all, /events→estate_sale, /auctions→auction', () => {
    expect(resolveFeedType({ preset: 'all-events' })).toBe('all');
    expect(resolveFeedType({ preset: 'estate-sales' })).toBe('estate_sale');
    expect(resolveFeedType({ preset: 'auctions' })).toBe('auction');
  });
  test('no preset: honors ?type, defaults to all for unknown/absent', () => {
    expect(resolveFeedType({ type: 'auction' })).toBe('auction');
    expect(resolveFeedType({ type: 'estate_sale' })).toBe('estate_sale');
    expect(resolveFeedType({ type: 'estate-sales' })).toBe('all'); // wrong canonical value → safe default
    expect(resolveFeedType({})).toBe('all');
  });
});

describe('resolveFeedGeo — distance/radius (Bug 1 mechanism)', () => {
  test('4. valid location + radius=25 → numeric radiusMi 25', () => {
    const g = resolveFeedGeo({ lat: '29.76', lng: '-95.36', radius: '25' });
    expect(g.hasGeo).toBe(true);
    expect(g.radiusMi).toBe(25);
    expect(typeof g.radiusMi).toBe('number');
  });
  test('5. nationwide → no distance filter (radiusMi null)', () => {
    expect(resolveFeedGeo({ lat: '29.76', lng: '-95.36', radius: 'nationwide' }).radiusMi).toBeNull();
    expect(resolveFeedGeo({ lat: '29.76', lng: '-95.36', radius: 'NATIONWIDE' }).radiusMi).toBeNull();
  });
  test('no location → hasGeo false and radiusMi null (radius meaningless without a center)', () => {
    const g = resolveFeedGeo({ radius: '25' });
    expect(g.hasGeo).toBe(false);
    expect(g.radiusMi).toBeNull();
  });
  test('radius accepts string, ignores non-positive, caps at 3000', () => {
    expect(resolveFeedGeo({ lat: '1', lng: '1', radius: '50' }).radiusMi).toBe(50);
    expect(resolveFeedGeo({ lat: '1', lng: '1', radius: '0' }).radiusMi).toBeNull();
    expect(resolveFeedGeo({ lat: '1', lng: '1', radius: '99999' }).radiusMi).toBe(3000);
  });
  test('out-of-range coords are rejected (no geo)', () => {
    expect(resolveFeedGeo({ lat: '999', lng: '0', radius: '25' }).hasGeo).toBe(false);
  });
});

describe('widget client behavior (marketplace-feed.js source)', () => {
  test('6. any filter change resets to page 1', () => {
    expect(widget).toMatch(/function apply\(\)\s*{\s*state\.page = 1/);
  });
  test('type chip values are the canonical API values (all / auction / estate_sale)', () => {
    expect(widget).toContain('data-type="all"');
    expect(widget).toContain('data-type="auction"');
    expect(widget).toContain('data-type="estate_sale"');
    expect(widget).not.toMatch(/data-type="estate-sales?"/); // never the label/slug form
  });
  test('7-8. apiParams sends the active type + lat/lng/radius (preserved across pagination)', () => {
    // apiParams builds every request incl. paginated ones (page passed as extra) so filters persist.
    expect(widget).toMatch(/p\.set\('type', state\.type\)/);
    expect(widget).toMatch(/p\.set\('lat', state\.loc\.lat\)/);
    expect(widget).toMatch(/p\.set\('lng', state\.loc\.lng\)/);
    expect(widget).toMatch(/p\.set\('radius'/);
    expect(widget).toMatch(/apiParams\(\{ *page/); // pagination reuses apiParams (keeps filters)
  });
  test('radius change triggers a re-fetch (change handler → apply)', () => {
    expect(widget).toMatch(/radius_changed'[\s\S]{0,80}apply\(\)/);
  });
});

describe('9-10. cache correctness (URL-keyed CDN cache)', () => {
  const src = fs.readFileSync('src/routes/public.js', 'utf8');
  test('feed sets a public Cache-Control and all result-changing inputs live in the query string', () => {
    // The feed has no separate server cache; the CDN keys by full URL, and every result-changing input
    // (preset, type, lat, lng, radius, page) is a query param — so an All-Events response is never
    // reused for Estate-Sales/Auctions, nor a nationwide response for a 25-mile request.
    const route = src.slice(src.indexOf("router.get('/marketplace/feed'"), src.indexOf("router.get('/auctions'"));
    expect(route).toMatch(/res\.set\('Cache-Control'/);
    ['type', 'lat', 'lng', 'radius', 'page'].forEach((k) => expect(widget).toContain("'" + k + "'"));
  });
});
