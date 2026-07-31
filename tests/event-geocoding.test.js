'use strict';

// Two-tier event geocoding (migration 102 + eventGeocodingService): precise point → internal_lat/lng,
// public marker → a deterministic ~0.10mi OFFSET in lat/lng. Mirrors the auction model, keyed on the
// event id. These tests prove the privacy properties and the write/skip/failure behavior.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-event-geo';

const fs = require('fs');
const { publicCoordinatesFor, distanceMeters, OFFSET_METERS } =
  require('../src/services/geocoding/publicCoordinates');

// ---- db + provider mocks (control the service's IO). `mock`-prefixed so jest allows the factory. ----
const mockState = { eventRow: null, captured: [] };
jest.mock('../src/db', () => ({
  query: jest.fn((sql) => {
    if (/^\s*SELECT/i.test(sql)) return Promise.resolve({ rows: mockState.eventRow ? [mockState.eventRow] : [] });
    mockState.captured.push(sql.replace(/\s+/g, ' ').trim());
    return Promise.resolve({ rows: [] });
  }),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/geocoding', () => {
  const real = jest.requireActual('../src/services/geocoding');
  return Object.assign({}, real, { geocodeAuctionLocation: jest.fn() });
});
const seam = require('../src/services/geocoding');
const svc = require('../src/services/eventGeocodingService');

const EXACT = { lat: 29.7604, lng: -95.3698 }; // a Houston rooftop

beforeEach(() => { mockState.eventRow =null; mockState.captured.length = 0; seam.geocodeAuctionLocation.mockReset(); });

describe('privacy offset properties (pure)', () => {
  test('offset is ~0.10mi (161m) from the precise point and NOT the precise point', () => {
    const pub = publicCoordinatesFor({ auctionId: 'evt-1', lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp' });
    const d = distanceMeters(EXACT.lat, EXACT.lng, pub.lat, pub.lng);
    expect(d).toBeGreaterThan(OFFSET_METERS - 2);
    expect(d).toBeLessThan(OFFSET_METERS + 2);
    expect(pub.lat).not.toBe(EXACT.lat);
    expect(pub.lng).not.toBe(EXACT.lng);
  });
  test('deterministic: same event + point → identical marker every time', () => {
    const a = publicCoordinatesFor({ auctionId: 'evt-1', lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp' });
    const b = publicCoordinatesFor({ auctionId: 'evt-1', lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp' });
    expect(a).toEqual(b);
  });
  test('different events at the SAME address get different markers (not all shifted identically)', () => {
    const a = publicCoordinatesFor({ auctionId: 'evt-1', lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp' });
    const b = publicCoordinatesFor({ auctionId: 'evt-2', lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp' });
    expect(a).not.toEqual(b);
  });
  test('bounded — always within OFFSET_METERS + slack, never wildly off', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const p = publicCoordinatesFor({ auctionId: id, lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp' });
      expect(distanceMeters(EXACT.lat, EXACT.lng, p.lat, p.lng)).toBeLessThan(OFFSET_METERS + 5);
    }
  });
});

describe('geocodeEvent — two-tier write', () => {
  test('success: precise point → internal_lat/lng, OFFSET → lat/lng (~161m apart)', async () => {
    mockState.eventRow ={ id: 'evt-1', address: '123 Main St', city: 'Houston', state: 'TX', zip: '77002',
      lat: null, lng: null, internal_lat: null, internal_lng: null, location_fingerprint: null, event_format: 'live', status: 'published' };
    seam.geocodeAuctionLocation.mockResolvedValue({ ok: true, lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp1', source: 'mapbox', normalized: '123 Main St, Houston, TX' });

    const r = await svc.geocodeEvent('evt-1');
    expect(r.ok).toBe(true);
    const upd = mockState.captured.find((s) => /UPDATE events SET internal_lat/i.test(s));
    expect(upd).toBeTruthy();
    // the write puts EXACT into internal and the OFFSET into public
    const expected = publicCoordinatesFor({ auctionId: 'evt-1', lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp1' });
    expect(r.public).toEqual(expected);
    expect(distanceMeters(EXACT.lat, EXACT.lng, r.public.lat, r.public.lng)).toBeGreaterThan(OFFSET_METERS - 2);
  });

  test('address-pending (no address) → no request, no invented location', async () => {
    mockState.eventRow ={ id: 'evt-2', address: null, city: null, state: null, zip: null,
      lat: null, lng: null, internal_lat: null, internal_lng: null, location_fingerprint: null, event_format: 'live', status: 'published' };
    const r = await svc.geocodeEvent('evt-2');
    expect(seam.geocodeAuctionLocation).not.toHaveBeenCalled(); // shouldGeocode → insufficient_location
    expect(mockState.captured.find((s) => /UPDATE events SET internal_lat/i.test(s))).toBeFalsy();
    expect(r.geocode !== true);
  });

  test('provider failure → records status, preserves coordinates (no internal/public write)', async () => {
    mockState.eventRow ={ id: 'evt-3', address: '9 Oak', city: 'Austin', state: 'TX', zip: '78701',
      lat: null, lng: null, internal_lat: null, internal_lng: null, location_fingerprint: null, event_format: 'live', status: 'published' };
    seam.geocodeAuctionLocation.mockResolvedValue({ ok: false, status: 'failed', error: 'timeout', source: 'mapbox' });
    const r = await svc.geocodeEvent('evt-3');
    expect(r.ok).toBe(false);
    expect(mockState.captured.find((s) => /UPDATE events SET internal_lat/i.test(s))).toBeFalsy();
    expect(mockState.captured.find((s) => /geocoding_status/i.test(s))).toBeTruthy(); // failure recorded
  });

  test('unchanged location + coords already present → skipped (no re-request)', async () => {
    mockState.eventRow ={ id: 'evt-4', address: '1 A St', city: 'Dallas', state: 'TX', zip: '75201',
      lat: 1, lng: 1, internal_lat: 32.0, internal_lng: -96.0,
      location_fingerprint: require('../src/services/geocoding').locationFingerprint({ street_address: '1 A St', city: 'Dallas', address_state: 'TX', zip: '75201' }),
      event_format: 'live', status: 'published' };
    const r = await svc.geocodeEvent('evt-4');
    expect(r.skipped).toBe(true);
    expect(seam.geocodeAuctionLocation).not.toHaveBeenCalled();
  });
});

describe('deriveAndStorePublicOffset — pure derivation used by the import (in-tx)', () => {
  const client = { query: jest.fn() };
  beforeEach(() => { client.query.mockReset(); });
  test('derives the public offset from the stored internal point (no provider call)', async () => {
    client.query.mockImplementation((sql) => {
      if (/^\s*SELECT/i.test(sql)) return Promise.resolve({ rows: [{ id: 'evt-9', internal_lat: EXACT.lat, internal_lng: EXACT.lng, location_fingerprint: 'fp9' }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await svc.deriveAndStorePublicOffset(client, 'evt-9');
    expect(r.ok).toBe(true);
    expect(r.public).toEqual(publicCoordinatesFor({ auctionId: 'evt-9', lat: EXACT.lat, lng: EXACT.lng, fingerprint: 'fp9' }));
    expect(client.query.mock.calls.some((c) => /UPDATE events SET lat = \$2, lng = \$3/i.test(c[0]))).toBe(true);
  });
  test('no internal point → makes NO change (never invents a location)', async () => {
    client.query.mockImplementation((sql) => {
      if (/^\s*SELECT/i.test(sql)) return Promise.resolve({ rows: [{ id: 'evt-10', internal_lat: null, internal_lng: null, location_fingerprint: null }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await svc.deriveAndStorePublicOffset(client, 'evt-10');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('no_internal_point');
    expect(client.query.mock.calls.some((c) => /UPDATE/i.test(c[0]))).toBe(false);
  });
});

describe('source-level guarantees', () => {
  const svcSrc = fs.readFileSync('src/services/eventGeocodingService.js', 'utf8');
  const pub = fs.readFileSync('src/routes/public.js', 'utf8');
  const writer = fs.readFileSync('src/services/eventImport/writer.js', 'utf8');
  test('backfill/eligibility EXCLUDES online-only events', () => {
    expect(svcSrc).toMatch(/event_format[^\n]*<>\s*'online'/);
  });
  test('the writer stores the precise point in internal_*, never in public lat/lng', () => {
    expect(writer).toMatch(/lat: null, lng: null/);
    expect(writer).toMatch(/internal_lat = \$2, internal_lng = \$3/);
  });
  test('public feed selects event lat/lng but NOT internal_lat/internal_lng', () => {
    expect(pub).toMatch(/e\.lat,\s*e\.lng/);
    expect(pub).not.toMatch(/internal_lat/);
  });
  test('seller/admin event input CANNOT set public coordinates directly; geocoding is wired post-commit', () => {
    const es = fs.readFileSync('src/services/eventsService.js', 'utf8');
    expect(es).not.toMatch(/lat: 'lat', lng: 'lng'/);            // lat/lng removed from the input allowlist
    expect(es).not.toMatch(/num\(input\.lat\), num\(input\.lng\)/); // not inserted from client input
    expect(es).toMatch(/eventGeo\.geocodeEventSafe/);             // address-based geocode wired
  });
});
