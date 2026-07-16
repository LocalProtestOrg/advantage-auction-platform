'use strict';

/**
 * Auction geocoding (PR D) — homepage discovery map.
 *
 * Mocked-db / mocked-provider unit tests: no network, no live server, no token.
 *
 * Priorities under test, in the approved order:
 *   1. Seller Privacy       — the published point is never the property
 *   2. Accurate Discovery   — the marker stays in the right neighborhood
 *   3. Launch Stability     — geocoding can never fail a save or publish
 */

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));

const db = require('../src/db');
const {
  publicCoordinatesFor,
  distanceMeters,
  OFFSET_METERS,
} = require('../src/services/geocoding/publicCoordinates');
const { buildQuery, locationFingerprint, shouldGeocode } = require('../src/services/geocoding');

beforeEach(() => { jest.clearAllMocks(); });

// The real Jersey City auction that exposed this defect (public API: zip 07302,
// lat/lng null). Coordinates below are the verified Nominatim/Census centroid.
const JERSEY_CITY = { lat: 40.7216, lng: -74.0475 };
const AUCTION_ID = '5a000000-0000-4000-8000-000000000099';

describe('Priority #1 — seller privacy: the public point is never the property', () => {
  test('public coordinates are displaced ~0.10mi from the precise location', () => {
    const pub = publicCoordinatesFor({ auctionId: AUCTION_ID, ...JERSEY_CITY, fingerprint: 'fp1' });
    const d = distanceMeters(JERSEY_CITY.lat, JERSEY_CITY.lng, pub.lat, pub.lng);

    // ~161m = 0.10mi. Rounding to 5dp (~1m) must not meaningfully shift it.
    expect(d).toBeGreaterThan(OFFSET_METERS - 3);
    expect(d).toBeLessThan(OFFSET_METERS + 3);
  });

  test('the public point is never equal to the precise point', () => {
    const pub = publicCoordinatesFor({ auctionId: AUCTION_ID, ...JERSEY_CITY, fingerprint: 'fp1' });
    expect(pub.lat).not.toBeCloseTo(JERSEY_CITY.lat, 4);
    expect(pub.lng).not.toBeCloseTo(JERSEY_CITY.lng, 4);
  });

  test('different auctions at the SAME address publish different points', () => {
    // Two lots from one estate must not stack into a single pin that triangulates
    // back to the property.
    const a = publicCoordinatesFor({ auctionId: 'aaaaaaaa-0000-4000-8000-000000000001', ...JERSEY_CITY, fingerprint: 'fp1' });
    const b = publicCoordinatesFor({ auctionId: 'bbbbbbbb-0000-4000-8000-000000000002', ...JERSEY_CITY, fingerprint: 'fp1' });
    expect(a).not.toEqual(b);
  });

  test('a location change re-bearings rather than reusing the old direction', () => {
    const a = publicCoordinatesFor({ auctionId: AUCTION_ID, ...JERSEY_CITY, fingerprint: 'fp-old' });
    const b = publicCoordinatesFor({ auctionId: AUCTION_ID, ...JERSEY_CITY, fingerprint: 'fp-new' });
    expect(a).not.toEqual(b);
  });
});

describe('Priority #2 — accurate discovery: stable and in the right neighborhood', () => {
  test('DETERMINISM: identical inputs always yield the identical point', () => {
    const runs = Array.from({ length: 50 }, () =>
      publicCoordinatesFor({ auctionId: AUCTION_ID, ...JERSEY_CITY, fingerprint: 'fp1' })
    );
    runs.forEach((r) => expect(r).toEqual(runs[0]));
  });

  test('the marker stays well inside the immediate neighborhood', () => {
    // 161m cannot cross a city into another neighborhood; assert the bound holds for
    // many bearings so no auction id can produce a wild placement.
    for (let i = 0; i < 200; i++) {
      const pub = publicCoordinatesFor({
        auctionId: 'auction-' + i, ...JERSEY_CITY, fingerprint: 'fp' + i,
      });
      const d = distanceMeters(JERSEY_CITY.lat, JERSEY_CITY.lng, pub.lat, pub.lng);
      expect(d).toBeLessThan(OFFSET_METERS + 3);
    }
  });

  test('offset math holds at high latitude (longitude convergence)', () => {
    // Naive degree-offsets break near the poles; the geodesic projection must not.
    const anchorage = { lat: 61.2181, lng: -149.9003 };
    const pub = publicCoordinatesFor({ auctionId: AUCTION_ID, ...anchorage, fingerprint: 'fp1' });
    const d = distanceMeters(anchorage.lat, anchorage.lng, pub.lat, pub.lng);
    expect(d).toBeGreaterThan(OFFSET_METERS - 3);
    expect(d).toBeLessThan(OFFSET_METERS + 3);
  });

  test('longitude stays normalized across the antimeridian', () => {
    const pub = publicCoordinatesFor({ auctionId: AUCTION_ID, lat: 51.9, lng: 179.9995, fingerprint: 'fp1' });
    expect(pub.lng).toBeGreaterThanOrEqual(-180);
    expect(pub.lng).toBeLessThanOrEqual(180);
  });

  test('unusable input yields null rather than a bogus marker', () => {
    expect(publicCoordinatesFor({ auctionId: AUCTION_ID, lat: null, lng: null })).toBeNull();
    expect(publicCoordinatesFor({ auctionId: AUCTION_ID, lat: 999, lng: 0 })).toBeNull();
    expect(publicCoordinatesFor({ auctionId: '', ...JERSEY_CITY })).toBeNull();
  });
});

describe('precision ladder — most precise available input', () => {
  test('1. street, city, state, zip', () => {
    expect(buildQuery({
      street_address: '400 W Church Ave', city: 'Knoxville', address_state: 'TN', zip: '37902',
    })).toBe('400 W Church Ave, Knoxville, TN, 37902');
  });

  test('2. city, state, zip when no street', () => {
    expect(buildQuery({ city: 'Jersey City', address_state: 'NJ', zip: '07302' }))
      .toBe('Jersey City, NJ 07302');
  });

  test('3. zip alone', () => {
    expect(buildQuery({ zip: '07302' })).toBe('07302');
  });

  test('4. city and state alone', () => {
    expect(buildQuery({ city: 'Jersey City', address_state: 'NJ' })).toBe('Jersey City, NJ');
  });

  test('no usable location yields an empty query', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ street_address: '  ' })).toBe('');
  });
});

describe('duplicate-request rule', () => {
  const base = {
    city: 'Jersey City', address_state: 'NJ', zip: '07302',
    lat: 40.72, lng: -74.04,
  };

  test('unchanged location + valid coordinates does NOT re-request', () => {
    const auction = { ...base, location_fingerprint: locationFingerprint(base) };
    expect(shouldGeocode(auction)).toEqual({ geocode: false, reason: 'unchanged' });
  });

  test('an unrelated edit does not disturb the fingerprint', () => {
    // Title/times/photos are not part of the location, so they cannot trigger a bill.
    const before = locationFingerprint(base);
    const after = locationFingerprint({ ...base, title: 'New title', end_time: 'later' });
    expect(after).toBe(before);
  });

  test('a real location change DOES re-request', () => {
    const auction = { ...base, location_fingerprint: locationFingerprint(base), zip: '07307' };
    expect(shouldGeocode(auction)).toEqual({ geocode: true, reason: 'location_changed' });
  });

  test('missing coordinates re-requests even when the fingerprint matches', () => {
    // The publish-time recovery attempt.
    const auction = { ...base, lat: null, lng: null, location_fingerprint: locationFingerprint(base) };
    expect(shouldGeocode(auction)).toEqual({ geocode: true, reason: 'missing_coordinates' });
  });

  test('fingerprint is case- and whitespace-insensitive', () => {
    expect(locationFingerprint({ city: 'Jersey City', address_state: 'NJ', zip: '07302' }))
      .toBe(locationFingerprint({ city: '  jersey   city ', address_state: 'nj', zip: ' 07302 ' }));
  });
});

describe('manual override is never automatically overwritten', () => {
  const manual = {
    city: 'Jersey City', address_state: 'NJ', zip: '07302',
    lat: 40.7, lng: -74.0,
    coordinates_manually_overridden: true,
    location_fingerprint: 'stale-on-purpose',
  };

  test('an automatic pass skips a manually overridden auction', () => {
    expect(shouldGeocode(manual)).toEqual({ geocode: false, reason: 'manual_override' });
  });

  test('even a genuine location change does not clobber a manual pin', () => {
    expect(shouldGeocode({ ...manual, zip: '99999' }))
      .toEqual({ geocode: false, reason: 'manual_override' });
  });

  test('an explicit admin re-geocode is the ONLY way past a manual pin', () => {
    expect(shouldGeocode(manual, { force: true })).toEqual({ geocode: true, reason: 'admin_forced' });
  });
});

describe('Priority #3 — launch stability: geocoding never blocks save or publish', () => {
  const svc = require('../src/services/auctionGeocodingService');
  const auctionRow = {
    id: AUCTION_ID, city: 'Jersey City', address_state: 'NJ', zip: '07302',
    lat: null, lng: null, location_fingerprint: null,
    coordinates_manually_overridden: false,
  };

  test('a missing token records unconfigured and never throws', async () => {
    delete process.env.MAPBOX_GEOCODING_TOKEN;
    db.query
      .mockResolvedValueOnce({ rows: [auctionRow] })  // load
      .mockResolvedValueOnce({ rows: [] });           // recordFailure

    const r = await svc.geocodeAuctionSafe(AUCTION_ID);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('unconfigured');
  });

  test('a failed attempt PRESERVES existing coordinates (never blanks a marker)', async () => {
    delete process.env.MAPBOX_GEOCODING_TOKEN;
    db.query
      .mockResolvedValueOnce({ rows: [{ ...auctionRow, lat: 40.72, lng: -74.04 }] })
      .mockResolvedValueOnce({ rows: [] });

    await svc.geocodeAuctionSafe(AUCTION_ID);

    const writes = db.query.mock.calls.filter(([sql]) => /UPDATE auctions/.test(sql));
    expect(writes).toHaveLength(1);
    // The failure write must not touch any coordinate column.
    const sql = writes[0][0];
    expect(sql).not.toMatch(/SET[\s\S]*\blat\s*=/);
    expect(sql).not.toMatch(/\binternal_lat\s*=/);
    expect(sql).toMatch(/geocoding_status/);
  });

  test('an unexpected db/provider throw is swallowed, not propagated', async () => {
    db.query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(svc.geocodeAuctionSafe(AUCTION_ID)).resolves.toMatchObject({ ok: false });
  });

  test('a skipped auction is not an error', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ ...auctionRow, lat: 40.72, lng: -74.04, location_fingerprint: locationFingerprint(auctionRow) }],
    });
    const r = await svc.geocodeAuction(AUCTION_ID);
    expect(r).toMatchObject({ ok: true, skipped: true, status: 'unchanged' });
  });
});

describe('admin manual coordinate override', () => {
  const svc = require('../src/services/auctionGeocodingService');

  test('valid coordinates are accepted and flagged as manual', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: AUCTION_ID, lat: 40.7216, lng: -74.0475, geocoding_status: 'manual', coordinates_manually_overridden: true }],
    });
    const r = await svc.setManualCoordinates(AUCTION_ID, 40.7216, -74.0475);
    expect(r.ok).toBe(true);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/coordinates_manually_overridden = true/);
    expect(params).toEqual([AUCTION_ID, 40.7216, -74.0475]);
  });

  test('out-of-range coordinates are rejected before any write', async () => {
    for (const [la, ln] of [[91, 0], [-91, 0], [0, 181], [0, -181], ['abc', 0], [null, null]]) {
      const r = await svc.setManualCoordinates(AUCTION_ID, la, ln);
      expect(r.ok).toBe(false);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('boundary coordinates are accepted', async () => {
    db.query.mockResolvedValue({ rows: [{ id: AUCTION_ID }] });
    for (const [la, ln] of [[90, 180], [-90, -180], [0, 0]]) {
      expect((await svc.setManualCoordinates(AUCTION_ID, la, ln)).ok).toBe(true);
    }
  });
});

describe('backfill targets only auctions missing a public marker', () => {
  const svc = require('../src/services/auctionGeocodingService');

  test('query excludes rows with coordinates and manual overrides', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await svc.findMissingPublicCoordinates();

    const sql = db.query.mock.calls[0][0].replace(/\s+/g, ' ');
    // Idempotent: valid Knoxville coordinates can never be selected.
    expect(sql).toMatch(/lat IS NULL OR lng IS NULL/);
    expect(sql).toMatch(/coordinates_manually_overridden IS NOT TRUE/);
    // Requires something to geocode with.
    expect(sql).toMatch(/zip/);
  });
});
