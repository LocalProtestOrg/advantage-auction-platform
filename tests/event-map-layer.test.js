'use strict';

/**
 * Imported/native events on the marketplace map: the public /events/map endpoint + the client event
 * marker layer, legend (EVENT TYPE), preview card, and drawer. Source-level assertions (the codebase's
 * pattern for endpoint contracts + map wiring).
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const pub = read('src', 'routes', 'publicEvents.js');
const index = read('public', 'index.html');

describe('GET /api/public/events/map — eligible physical events with coordinates', () => {
  const h = pub.slice(pub.indexOf("router.get('/events/map'"), pub.indexOf("// GET /api/public/events/:slug"));
  test('is registered BEFORE /events/:slug (no route shadowing)', () => {
    expect(pub.indexOf("router.get('/events/map'")).toBeGreaterThan(-1);
    expect(pub.indexOf("router.get('/events/map'")).toBeLessThan(pub.indexOf("router.get('/events/:slug'"));
  });
  test('returns only published, non-expired events WITH coordinates (online → null coords → excluded)', () => {
    expect(h).toMatch(/e\.status = 'published'/);
    expect(h).toMatch(/e\.end_at IS NULL OR e\.end_at >= now\(\)/);
    expect(h).toMatch(/e\.lat IS NOT NULL/);
    expect(h).toMatch(/e\.lng IS NOT NULL/);
  });
  test('supports ?type=auction | estate_sale', () => {
    expect(h).toMatch(/e\.sale_type = 'auction'/);
    expect(h).toMatch(/e\.sale_type IS DISTINCT FROM 'auction'/);
  });
  test('normalizes to auction / estate_sale and a customer type label (never "Imported")', () => {
    expect(h).toMatch(/sale_type === 'auction' \? 'auction' : 'estate_sale'/);
    expect(h).toMatch(/eventsService\.eventTypeLabel\(r\)/);
    expect(h).not.toMatch(/Imported/);
  });
  test('host = the real organizer for imported; org-authored ONLY for a professional organizer (individual privacy)', () => {
    expect(h).toMatch(/r\.source === 'imported' \? \(r\.organizer_name \|\| undefined\) : \(isPublicOrganizer\(r\.org_type\)/);
    expect(h).toMatch(/url: '\/event\.html\?slug='/);
  });
  test('never exposes the discovery source / external_url / attribution', () => {
    expect(h).not.toMatch(/attribution_source|attribution_url|external_url/);
  });
  test('returns counts by type', () => {
    expect(h).toMatch(/counts = data\.reduce/);
    expect(h).toMatch(/\{ auction: 0, estate_sale: 0 \}/);
  });
});

// Regression for the Phase-5C map-visibility investigation: an ACTIVE event with no coordinates
// (an online auction) must be EXCLUDED from the geographic map but still eligible for the list/feed.
// Map and list share the SAME active-eligibility gate (published + not expired); the map only ADDS a
// coordinate requirement on top of it. This is expected behavior, not a bug — locking it here so a
// future change can neither leak coordless/expired events onto the map nor drop them from the list.
describe('map vs. list eligibility parity — coordless (online) events are listed but not mapped', () => {
  const list = pub.slice(pub.indexOf("router.get('/events'"), pub.indexOf("// GET /api/public/events/map"));
  const map = pub.slice(pub.indexOf("router.get('/events/map'"), pub.indexOf("// GET /api/public/events/:slug"));
  const ACTIVE_STATUS = /e\.status = 'published'/;
  const ACTIVE_NOTEXPIRED = /e\.end_at IS NULL OR e\.end_at >= now\(\)/;

  test('the LIST endpoint gates on active (published + not expired) and does NOT require coordinates', () => {
    expect(list).toMatch(ACTIVE_STATUS);
    expect(list).toMatch(ACTIVE_NOTEXPIRED);
    expect(list).not.toMatch(/e\.lat IS NOT NULL/);   // coordless active events REMAIN in the list
    expect(list).not.toMatch(/e\.lng IS NOT NULL/);
  });
  test('the MAP endpoint uses the SAME active gate PLUS a coordinate requirement', () => {
    expect(map).toMatch(ACTIVE_STATUS);               // identical active-eligibility as the list
    expect(map).toMatch(ACTIVE_NOTEXPIRED);
    expect(map).toMatch(/e\.lat IS NOT NULL/);         // ...map ADDS coords (online → excluded)
    expect(map).toMatch(/e\.lng IS NOT NULL/);
  });
  test('EXPIRED events are excluded from BOTH map and list (no republish-onto-map path)', () => {
    // Both slices carry the not-expired predicate; neither drops it.
    expect((list.match(/end_at >= now\(\)/g) || []).length).toBeGreaterThan(0);
    expect((map.match(/end_at >= now\(\)/g) || []).length).toBeGreaterThan(0);
  });
  test('map counts are computed from the SAME returned rows the markers use (no phantom counts)', () => {
    // counts reduce over `data` — the exact array serialized to markers — so a badge can never
    // claim events that were not returned (and vice-versa).
    expect(map).toMatch(/counts = data\.reduce/);
  });
});

describe('map client — event markers on the shared mp layer', () => {
  test('defines event marker categories (Auction Partner Events / Estate Sales) distinct from company pins', () => {
    expect(index).toMatch(/MP_EVENT_CATS = \[/);
    expect(index).toMatch(/event_auction[\s\S]{0,60}Auction Partner Events/);
    expect(index).toMatch(/event_estate_sale[\s\S]{0,40}Estate Sales/);
    expect(index).toMatch(/MP_ALL_CATS = MP_CATS\.concat\(MP_EVENT_CATS\)/);
  });
  test('loads /api/public/events/map and adds event records to the map source', () => {
    expect(index).toMatch(/\/api\/public\/events\/map/);
    expect(index).toMatch(/function evToMp/);
    expect(index).toMatch(/isEvent:true/);
    expect(index).toMatch(/EVENTS_MAP=eventRecs/);
  });
  test('legend exposes the five owner-locked sections with canonical inventory counts', () => {
    expect(index).toMatch(/legendSec\('Advantage\.Bid Auctions'/);
    expect(index).toMatch(/legendSec\('Auction Partner Events'/);
    expect(index).toMatch(/legendSec\('Estate Sales'/);
    expect(index).toMatch(/legendSec\('Marketplace'/);
    expect(index).toMatch(/legendSec\('Professionals'/);
    // Auction Partner Events count comes from the CANONICAL family total, never map pins.
    expect(index).toMatch(/'Auction Partner Events',f\.partner_event\|\|0/);
  });
  test('event marker opens an event preview → canonical event page (View Event), not the discovery source', () => {
    expect(index).toMatch(/function mpEventCardHTML/);
    expect(index).toMatch(/rec && rec\.isEvent/);
    expect(index).toMatch(/>View Event</);
    expect(index).toMatch(/href="'\+mpEsc\(r\.url\)/);
  });
  test('the right drawer reads "Events Near You" and uses the event dataset', () => {
    expect(index).toMatch(/near:'Events Near You'/);
    expect(index).toMatch(/activeEvents\(\)\.map\(evToDrawer\)/);
    expect(index).not.toMatch(/near:'Auctions near you'/);
  });
});
