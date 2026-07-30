'use strict';

const mr = require('../../src/services/eventImport/marketResolver');

const MARKETS = [
  { slug: 'houston', center_lat: 29.7604, center_lng: -95.3698, radius_km: 120 },
  { slug: 'nyc_tristate', center_lat: 40.7128, center_lng: -74.0060, radius_km: 140 },
  { slug: 'nocenter', center_lat: null, center_lng: null, radius_km: null }, // must be ignored by radius
];
const ZIP_RULES = [
  { zip_prefix: '770', market_slug: 'houston' },
  { zip_prefix: '77024', market_slug: 'houston' }, // more specific
  { zip_prefix: '100', market_slug: 'nyc_tristate' },
];
const CITY_RULES = [{ city: 'Houston', state: 'TX', market_slug: 'houston' }];
const RULES = { markets: MARKETS, zipRules: ZIP_RULES, cityRules: CITY_RULES, fallback: 'national' };

describe('haversineKm', () => {
  test('Houston↔NYC ≈ 2280 km', () => {
    const d = mr.haversineKm(29.7604, -95.3698, 40.7128, -74.0060);
    expect(d).toBeGreaterThan(2200);
    expect(d).toBeLessThan(2360);
  });
  test('zero distance', () => { expect(mr.haversineKm(30, -95, 30, -95)).toBeCloseTo(0, 5); });
});

describe('resolve — radius', () => {
  test('point inside Houston radius → houston via radius', () => {
    expect(mr.resolve({ lat: 29.80, lng: -95.40 }, RULES)).toEqual({ marketSlug: 'houston', via: 'radius' });
  });
  test('far point (Denver) → no radius match → national fallback', () => {
    expect(mr.resolve({ lat: 39.74, lng: -104.99 }, RULES)).toEqual({ marketSlug: 'national', via: 'fallback' });
  });
  test('picks the NEAREST qualifying market', () => {
    // near NYC — inside nyc radius, far from houston
    expect(mr.resolve({ lat: 40.75, lng: -73.99 }, RULES)).toEqual({ marketSlug: 'nyc_tristate', via: 'radius' });
  });
  test('markets with null center are ignored (no crash)', () => {
    expect(mr.resolve({ lat: 0, lng: 0 }, { markets: [{ slug: 'nocenter', center_lat: null, center_lng: null, radius_km: null }] }))
      .toEqual({ marketSlug: 'national', via: 'fallback' });
  });
});

describe('resolve — zip (longest prefix wins)', () => {
  test('77004 → houston via zip (prefix 770)', () => {
    expect(mr.resolve({ zip: '77004' }, RULES)).toEqual({ marketSlug: 'houston', via: 'zip' });
  });
  test('77024-1234 → houston via the more specific 77024 rule', () => {
    // both '770' and '77024' match; longest prefix chosen (both houston here, but proves selection)
    const rules = { ...RULES, zipRules: [{ zip_prefix: '770', market_slug: 'nyc_tristate' }, { zip_prefix: '77024', market_slug: 'houston' }] };
    expect(mr.resolve({ zip: '77024' }, rules)).toEqual({ marketSlug: 'houston', via: 'zip' });
  });
  test('unknown zip → fallback', () => {
    expect(mr.resolve({ zip: '90210' }, RULES)).toEqual({ marketSlug: 'national', via: 'fallback' });
  });
});

describe('resolve — city_state (case-insensitive)', () => {
  test('houston / tx (lowercase) → houston via city_state', () => {
    expect(mr.resolve({ city: 'houston', state: 'tx' }, RULES)).toEqual({ marketSlug: 'houston', via: 'city_state' });
  });
  test('unknown city → fallback', () => {
    expect(mr.resolve({ city: 'Phoenix', state: 'AZ' }, RULES)).toEqual({ marketSlug: 'national', via: 'fallback' });
  });
});

describe('resolve — precedence radius > zip > city_state > fallback', () => {
  test('radius wins over a conflicting zip', () => {
    // near Houston by lat/lng, but zip maps to NYC → radius (houston) wins
    expect(mr.resolve({ lat: 29.80, lng: -95.40, zip: '10001' }, RULES)).toEqual({ marketSlug: 'houston', via: 'radius' });
  });
  test('zip wins over a conflicting city_state (no lat/lng)', () => {
    // zip → nyc, city → houston → zip wins
    expect(mr.resolve({ zip: '10001', city: 'Houston', state: 'TX' }, RULES)).toEqual({ marketSlug: 'nyc_tristate', via: 'zip' });
  });
  test('empty input → national fallback', () => {
    expect(mr.resolve({}, RULES)).toEqual({ marketSlug: 'national', via: 'fallback' });
  });
});

describe('candidateKey normalization', () => {
  test('trims + lowercases city, uppercases state', () => {
    expect(mr.candidateKey('  Phoenix ', ' az ')).toBe('phoenix|AZ');
  });
  test('empty when no city/state', () => { expect(mr.candidateKey('', '')).toBe(''); });
});

describe('resolveWithDb — records a fallback in market_candidates', () => {
  function fakeDb(rows) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM event_markets/.test(sql)) return { rows: rows.markets };
        if (/FROM event_market_zips/.test(sql)) return { rows: rows.rules };
        if (/INSERT INTO market_candidates/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    };
  }
  test('a match does NOT touch market_candidates', async () => {
    const db = fakeDb({ markets: MARKETS, rules: [] });
    const out = await mr.resolveWithDb(db, { lat: 29.80, lng: -95.40 });
    expect(out).toEqual({ marketSlug: 'houston', via: 'radius' });
    expect(db.calls.some((c) => /INSERT INTO market_candidates/.test(c.sql))).toBe(false);
  });
  test('a fallback with city/state upserts market_candidates', async () => {
    const db = fakeDb({ markets: MARKETS, rules: [] });
    const out = await mr.resolveWithDb(db, { city: 'Phoenix', state: 'AZ' });
    expect(out.via).toBe('fallback');
    const ins = db.calls.find((c) => /INSERT INTO market_candidates/.test(c.sql));
    expect(ins).toBeTruthy();
    expect(ins.params[0]).toBe('phoenix|AZ');
  });
  test('DB error → fail-open national', async () => {
    const bad = { query: async () => { throw new Error('boom'); } };
    expect(await mr.resolveWithDb(bad, { city: 'X', state: 'YZ' })).toEqual({ marketSlug: 'national', via: 'fallback' });
  });
});
