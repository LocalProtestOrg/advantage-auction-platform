'use strict';

/**
 * Hide Address Until (Increment 5).
 *
 * Part 1 is a REAL unit test of the reveal engine (pure logic, no DB): the exact address and any
 * precise coordinates must be withheld until the reveal fires, and internal_lat/lng must never
 * appear in a public view. Part 2 is source-level wiring: the public serializer routes through the
 * engine and never selects internal coordinates; geocoding is enrichment hooked at publish.
 */

const fs = require('fs');
const path = require('path');
const P = require('../../src/services/eventAddressPrivacy');

const START = '2026-09-05T16:00:00Z';
function ev(extra) {
  return Object.assign({
    address: '123 Main St', venue_name: 'The Estate', city: 'Houston', state: 'TX', zip: '77002',
    lat: 29.5, lng: -95.1, internal_lat: 29.517777, internal_lng: -95.113333, start_at: START,
  }, extra);
}
const HIDDEN = { address_privacy_mode: 'hidden_until', address_reveal_trigger: 'hours_before_start', address_reveal_hours_before: 24 };

describe('reveal timing', () => {
  test('exact mode is always revealed', () => {
    expect(P.isRevealed(ev({ address_privacy_mode: 'exact' }), '2000-01-01T00:00:00Z')).toBe(true);
  });
  test('approximate mode never reveals the exact address', () => {
    expect(P.isRevealed(ev({ address_privacy_mode: 'approximate' }), '2100-01-01T00:00:00Z')).toBe(false);
  });
  test('hidden_until (24h before start): hidden earlier, revealed within the window', () => {
    const e = ev(HIDDEN);
    expect(P.isRevealed(e, '2026-09-04T00:00:00Z')).toBe(false); // ~40h before
    expect(P.isRevealed(e, '2026-09-04T16:00:00Z')).toBe(true);  // exactly 24h before start
    expect(P.isRevealed(e, '2026-09-05T12:00:00Z')).toBe(true);  // inside the window
  });
  test('hidden_until on_date reveals at the configured date', () => {
    const e = ev({ address_privacy_mode: 'hidden_until', address_reveal_trigger: 'on_date', address_reveal_at: '2026-09-01T00:00:00Z' });
    expect(P.isRevealed(e, '2026-08-31T00:00:00Z')).toBe(false);
    expect(P.isRevealed(e, '2026-09-02T00:00:00Z')).toBe(true);
  });
  test('hidden_until with nothing to compute from stays hidden (fail-safe)', () => {
    expect(P.isRevealed({ address_privacy_mode: 'hidden_until', address_reveal_trigger: 'hours_before_start' }, START)).toBe(false);
    expect(P.isRevealed({ address_privacy_mode: 'hidden_until', address_reveal_trigger: 'on_registration', start_at: START }, START)).toBe(false);
  });
});

describe('publicLocationView withholds precise location until reveal', () => {
  test('hidden: no address, no coordinates, area + BD-style notice present', () => {
    const v = P.publicLocationView(ev(HIDDEN), '2026-09-01T00:00:00Z');
    expect(v.address).toBeNull();
    expect(v.lat).toBeNull();
    expect(v.lng).toBeNull();
    expect(v.address_hidden).toBe(true);
    expect(v.city).toBe('Houston');
    expect(v.zip).toBe('77002');
    expect(v.reveal_notice).toMatch(/24 hours prior to the sale start time/);
    expect(v.address_reveal_at).toBeTruthy();
  });
  test('revealed: full address + PUBLIC OFFSET marker (never the internal point)', () => {
    const v = P.publicLocationView(ev(HIDDEN), '2026-09-05T12:00:00Z');
    expect(v.address).toBe('123 Main St');
    expect(v.lat).toBe(29.5);   // the public offset, not internal 29.517777
    expect(v.lng).toBe(-95.1);
  });
  test('internal coordinates NEVER appear in any mode or state', () => {
    ['exact', 'approximate', 'hidden_until'].forEach(function (m) {
      [START, '2026-01-01T00:00:00Z', '2026-09-05T12:00:00Z'].forEach(function (now) {
        const v = P.publicLocationView(ev({ address_privacy_mode: m, address_reveal_trigger: 'hours_before_start', address_reveal_hours_before: 24 }), now);
        const json = JSON.stringify(v);
        expect(json).not.toContain('internal');
        expect(json).not.toContain('29.517777'); // the precise internal lat must never leak
      });
    });
  });
});

// ── Part 2: wiring guards ──────────────────────────────────────────────────────
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const publicEvents = read('src', 'routes', 'publicEvents.js');
const geo = read('src', 'services', 'eventGeocodingService.js');
const admin = read('src', 'routes', 'adminEvents.js');
const migration = read('db', 'migrations', '093_marketplace_events_foundation.sql');
const newHtml = read('public', 'org', 'event-new.html');
const editHtml = read('public', 'org', 'event-edit.html');

describe('public serializer routes through the privacy engine and leaks no precise data', () => {
  test('serialize() uses publicLocationView', () => {
    expect(publicEvents).toContain("require('../services/eventAddressPrivacy')");
    expect(publicEvents).toMatch(/addressPrivacy\.publicLocationView\(r\)/);
  });
  test('the public feed never SELECTs internal_lat/lng', () => {
    expect(publicEvents).not.toMatch(/internal_lat|internal_lng/);
  });
});

describe('event geocoding reuses the auction two-tier model as enrichment', () => {
  test('writes precise internal_* + public offset lat/lng and never throws into publish', () => {
    expect(geo).toContain("require('./geocoding')");
    expect(geo).toContain('internal_lat=$4');
    expect(geo).toMatch(/geocodeEventSafe/);
    expect(geo).toContain('publicCoordinatesFor');
  });
  test('publish hooks geocoding fire-and-forget (never blocks)', () => {
    expect(admin).toMatch(/geocodeEventSafe\(ev\.id\)\.catch/);
  });
  test('migration 093 carries the privacy + geocoding columns', () => {
    ['address_privacy_mode', 'address_reveal_hours_before', 'internal_lat', 'internal_lng', 'geocoding_error', 'geocoded_at']
      .forEach(function (c) { expect(migration).toContain(c); });
  });
});

describe('seller controls the address visibility (default = hide until 24h before)', () => {
  test('create + edit expose an address-visibility control that defaults to hidden_until', () => {
    expect(newHtml).toContain('id="addressPrivacy"');
    expect(editHtml).toContain('id="addressPrivacy"');
    expect(newHtml).toMatch(/addressPrivacyMode:\s*\$\('addressPrivacy'\)\.value/);
    expect(editHtml).toMatch(/addressRevealTrigger:.*hours_before_start/);
  });
});
