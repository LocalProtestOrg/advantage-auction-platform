'use strict';

/**
 * Public Marketplace Event page (Increment 6) — the auction-twin page + shared platform components.
 *
 * Part 1 unit-tests the privacy-safe structured data: the Marketplace-Event JSON-LD must never
 * expose the street address or precise geo while the address is hidden. Part 2 verifies the page
 * reuses shared components (gallery, pin-map, buyer-nav, design tokens) rather than event-specific
 * implementations, and that the SEO middleware is wired for events.
 */

const fs = require('fs');
const path = require('path');
const sm = require('../../src/middleware/shareMeta');

const BASE = { title: 'Highland Estate Sale', description: 'Fine antiques', startDate: '2026-09-05T16:00:00Z', endDate: null, organizer: 'Advantage Estate Auctions', city: 'Houston', state: 'TX', zip: '77002' };

describe('buildMarketplaceEvent JSON-LD is privacy-safe', () => {
  test('physical event uses OfflineEventAttendanceMode (not the auction VirtualLocation)', () => {
    const ev = sm.buildMarketplaceEvent(BASE, 'http://u', 'http://i');
    expect(ev['@type']).toBe('Event');
    expect(ev.eventAttendanceMode).toContain('OfflineEventAttendanceMode');
  });
  test('hidden address: general area only, NO streetAddress, NO geo', () => {
    const ev = sm.buildMarketplaceEvent(Object.assign({}, BASE, { addressHidden: true, address: null, lat: null, lng: null }), 'http://u', 'http://i');
    expect(ev.location['@type']).toBe('Place');
    expect(ev.location.address.addressLocality).toBe('Houston');
    expect(ev.location.address.addressRegion).toBe('TX');
    expect(ev.location.address.streetAddress).toBeUndefined();
    expect(ev.location.geo).toBeUndefined();
  });
  test('revealed address: streetAddress + geo present', () => {
    const ev = sm.buildMarketplaceEvent(Object.assign({}, BASE, { addressHidden: false, address: '123 Main St', lat: 29.5, lng: -95.1 }), 'http://u', 'http://i');
    expect(ev.location.address.streetAddress).toBe('123 Main St');
    expect(ev.location.geo['@type']).toBe('GeoCoordinates');
    expect(ev.location.geo.latitude).toBe(29.5);
  });
});

describe('buildJsonLd event branch', () => {
  test('emits an Event node + an Events breadcrumb', () => {
    const s = sm.buildJsonLd('event', Object.assign({}, BASE, { addressHidden: true }), 'http://u', 'http://i');
    const inner = s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    const json = JSON.parse(inner); // JSON.parse natively resolves the < escaping
    const types = json['@graph'].map(function (g) { return g['@type']; });
    expect(types).toContain('Event');
    expect(types).toContain('BreadcrumbList');
    const crumbs = json['@graph'].find(function (g) { return g['@type'] === 'BreadcrumbList'; }).itemListElement.map(function (i) { return i.name; });
    expect(crumbs).toContain('Events');
  });
});

// ── Part 2: wiring ──────────────────────────────────────────────────────────
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const eventHtml = read('public', 'event.html');
const gallery = read('public', 'widgets', 'shared', 'gallery.js');
const pinmap = read('public', 'widgets', 'shared', 'pin-map.js');
const smSrc = read('src', 'middleware', 'shareMeta.js');
const svcSrc = read('src', 'services', 'shareMetaService.js');

describe('event page is the auction twin (shared components, not event-specific)', () => {
  test('includes shared chrome + gallery + map components', () => {
    expect(eventHtml).toContain('/widgets/shared/buyer-nav.js');
    expect(eventHtml).toContain('/widgets/shared/gallery.js');
    expect(eventHtml).toContain('/widgets/shared/pin-map.js');
    expect(eventHtml).toMatch(/AdvantageGallery\.mount/);
    expect(eventHtml).toMatch(/AdvantagePinMap\.mount/);
  });
  test('map renders only when the address is revealed; a notice shows when hidden', () => {
    expect(eventHtml).toMatch(/revealed && e\.lat != null && e\.lng != null/);
    expect(eventHtml).toContain('reveal_notice');
  });
  test('uses the shared Living-Map tokens + Fraunces (same visual language as auctions)', () => {
    expect(eventHtml).toContain('--live:#B5273B');
    expect(eventHtml).toContain('Fraunces');
  });
});

describe('shared platform components expose stable globals', () => {
  test('AdvantageGallery + AdvantagePinMap are platform globals', () => {
    expect(gallery).toMatch(/window\.AdvantageGallery\s*=/);
    expect(pinmap).toMatch(/window\.AdvantagePinMap\s*=/);
  });
  test('pin-map self-loads MapLibre and drops the Advantage-red pin', () => {
    expect(pinmap).toContain('maplibre-gl');
    expect(pinmap).toContain('#B5273B');
    expect(pinmap).toMatch(/setLngLat\(\[lng, lat\]\)/);
  });
});

describe('event SEO reuses the existing share-meta + JSON-LD pipeline', () => {
  test('shareMeta registers /event.html and branches on kind event', () => {
    expect(smSrc).toContain("'/event.html'");
    expect(smSrc).toMatch(/kind === 'event'/);
  });
  test('getEventMeta routes location through the reveal engine (privacy-safe SEO)', () => {
    expect(svcSrc).toContain('eventAddressPrivacy');
    expect(svcSrc).toMatch(/publicLocationView\(r\)/);
  });
  test('sitemap inventory includes published events', () => {
    expect(svcSrc).toMatch(/out\.events\s*=/);
  });
});
