'use strict';

/**
 * Marketplace Feed engine — unified feed (auctions + estate sales), server-enforced presets,
 * location/geocode + radius search, one card renderer. Source-level guarantees; the SQL + geocode
 * are validated live against prod separately.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const pub = read('src', 'routes', 'public.js');
const widget = read('public', 'widgets', 'marketplace-feed.js');

describe('GET /api/public/marketplace/feed — unified + server-enforced presets + radius', () => {
  const h = pub.slice(pub.indexOf("router.get('/marketplace/feed'"), pub.indexOf("router.get('/auctions'"));
  test('UNIONs auctions AND estate-sale events; visibility + privacy enforced server-side', () => {
    expect(h).toContain("'auction'::text AS kind");
    expect(h).toContain("'estate_sale'::text AS kind");
    expect(h).toContain('UNION ALL');
    expect(h).toContain("marketplace_status = 'syndicated'");
    expect(h).toContain("e.status = 'published'");
    expect(h).toContain('${B_NAME} AS company'); // private-seller anonymity
  });
  test('preset LOCKS the type server-side (client cannot widen auctions↔estate-sales)', () => {
    expect(h).toContain("PRESET_TYPE = { 'all-events': 'all', auctions: 'auction', 'estate-sales': 'estate_sale' }");
    expect(h).toMatch(/q\.preset[\s\S]*PRESET_TYPE\[String\(q\.preset\)\]/);
  });
  test('radius search: Haversine miles from a lat/lng search point, radius filter + nearest sort', () => {
    expect(h).toContain('3959.0 * acos');           // miles
    expect(h).toContain('radians');
    expect(h).toContain('distance_mi');
    expect(h).toMatch(/x\.distance_mi <= \$/);       // radius filter
    expect(h).toContain("q.sort === 'nearest'");
    expect(h).toMatch(/nationwide/);                 // nationwide = no distance filter
  });
});

describe('GET /api/public/geocode — server-side proxy, token never exposed', () => {
  const g = pub.slice(pub.indexOf("router.get('/geocode'"), pub.indexOf("// ── GET /api/public/marketplace/feed"));
  test('proxies the platform geocoder and returns only {ok,lat,lng,label}', () => {
    expect(g).toContain('geocodeProvider.geocode');
    expect(g).toContain('lat: r.lat');
    expect(g).toContain('label: r.normalized');
  });
  test('never leaks provider/vendor names or raw errors; degrades to unavailable', () => {
    expect(g).not.toMatch(/mapbox/i);
    expect(g).toContain("reason: 'unavailable'");
    expect(g).toContain('normalLimiter'); // rate limited
  });
});

describe('the Feed WIDGET engine — one renderer, three presets, location + radius', () => {
  test('reads a server-enforced preset from data-preset / URL', () => {
    expect(widget).toContain("data-preset");
    expect(widget).toContain("PRESET_TYPE = { 'all-events': 'all', 'auctions': 'auction', 'estate-sales': 'estate_sale' }");
    expect(widget).toContain("p.set('preset', state.preset)");
  });
  test('Location field (labeled "Location", not City/ZIP) + geocode + resolved label shown back', () => {
    expect(widget).toContain('Location</label>');
    expect(widget).toContain("placeholder=\"Enter a location\"");
    expect(widget).toContain('/api/public/geocode?q=');
    expect(widget).toContain('Showing events near');
    for (const bad of ['>City</label', '>ZIP</label', '>State</label']) expect(widget).not.toContain(bad);
  });
  test('radius slider (miles, default 50, nationwide) with debounced apply on release', () => {
    expect(widget).toContain('type="range"');
    expect(widget).toContain('Within ');
    expect(widget).toContain("'nationwide'");
    expect(widget).toMatch(/addEventListener\('change'[\s\S]{0,120}apply\(\)/); // apply on release, not while dragging
    expect(widget).toMatch(/addEventListener\('input'/);                       // live label while dragging
  });
  test('Use-My-Location only requests permission on click; typed field works if denied', () => {
    expect(widget).toContain('Use my location');
    expect(widget).toContain('navigator.geolocation');
    expect(widget).toMatch(/useMyLocation/);
  });
  test('cross-preset persistence of location + radius (shared key)', () => {
    expect(widget).toContain("LOC_KEY  = 'ab_feed_loc'");
    expect(widget).toContain('function persist');
  });
  test('one card renderer, private-seller anonymity, distance + type-aware CTA', () => {
    expect(widget).toContain('function card(');
    expect(widget).toMatch(/it\.company \? \('<div>by ' \+ esc\(it\.company\)/); // guarded → no "by null"
    expect(widget).toContain('mi away');
    expect(widget).toContain('Bid now');
    expect(widget).toContain('View estate sale');
  });
  test('accessibility + no injected H1 (BD owns the page H1)', () => {
    expect(widget).toContain('aria-live');
    expect(widget).toContain('aria-pressed');
    expect(widget).toContain('<h3 class="amf-title">'); // headings start at h3, no h1/h2 conflict
    expect(widget).not.toMatch(/<h1/);
  });
  test('analytics events fire without precise/typed address', () => {
    for (const e of ['loaded', 'location_submitted', 'location_resolved', 'location_resolution_failed',
      'use_my_location', 'radius_changed', 'type_filter_changed', 'sort_changed', 'card_opened', 'no_results'])
      expect(widget).toContain("'" + e + "'");
    expect(widget).toContain('length: query.length'); // submits length, not the address text
    expect(widget).not.toMatch(/track\([^)]*query\s*[,)]/); // never passes the raw query into a payload
  });
  test('List|Map continuity carries location + filters', () => {
    expect(widget).toContain('function mapHref');
    expect(widget).toContain("target=\"_top\"");
  });
});
