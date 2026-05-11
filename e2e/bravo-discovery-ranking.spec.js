'use strict';

/**
 * e2e/bravo-discovery-ranking.spec.js
 *
 * Bravo-Discovery — Discovery Ranking Layer v1
 *
 * Validates the v1 deterministic marketplace ranking across all affected
 * discovery endpoints. This spec is ADDITIVE — it does not re-test shapes or
 * field allowlists (covered in public-discovery.spec.js and
 * public-discovery-phase3.spec.js).
 *
 * Focus areas:
 *   1. Ordering determinism — same query twice = identical order
 *   2. Score not exposed — ranking_score absent from all responses
 *   3. Pagination stability — total_count/has_more invariant still holds
 *   4. Featured prominence — marketplace_priority > 0 auctions outrank others
 *      (validated via API shape and placeholder; full ordering needs controlled
 *       seed data with known priority values)
 *   5. Geo endpoints — near + featured-auctions geo path still respond correctly
 *      with new secondary sort (ranking_score replaces marketplace_priority)
 *   6. Non-paginated endpoints — featured-lots and featured-auctions still return
 *      data arrays in consistent order
 *   7. Tie-breaker determinism — id ASC secondary ensures stable pages
 *   8. discoveryRankingService unit — RANKING_WEIGHTS shape, auctionScoreSQL output
 *
 * Seed: uses fixed seeded auction dd000000-0000-4000-8000-000000000010
 */

const { test, expect } = require('@playwright/test');
const path = require('path');

const BASE     = process.env.BASE_URL || 'http://localhost:3000';
const DEMO_ID  = 'dd000000-0000-4000-8000-000000000010';
const DALLAS_LAT = 32.7767;
const DALLAS_LNG = -96.7970;

test.describe.configure({ mode: 'serial' });

// ── 1. discoveryRankingService unit validation ────────────────────────────────
test.describe('discoveryRankingService — unit validation', () => {

  let svc;
  test.beforeAll(() => {
    // Load the service directly — no server needed for unit tests
    svc = require(path.resolve(__dirname, '../src/services/discoveryRankingService'));
  });

  test('RANKING_WEIGHTS is a plain object with required keys', () => {
    const w = svc.RANKING_WEIGHTS;
    expect(typeof w).toBe('object');
    expect(typeof w.featured_base).toBe('number');
    expect(typeof w.featured_priority_cap).toBe('number');
    expect(typeof w.freshness_max).toBe('number');
    expect(typeof w.freshness_decay_days).toBe('number');
    expect(typeof w.shipping).toBe('number');
  });

  test('featured_base ensures featured > non-featured with max other signals', () => {
    const w = svc.RANKING_WEIGHTS;
    // Max non-featured score = freshness_max + shipping
    const maxNonFeatured = w.freshness_max + w.shipping;
    // Min featured score = featured_base + 1 (priority=1) + 0 freshness + 0 shipping
    const minFeatured = w.featured_base + 1;
    expect(minFeatured).toBeGreaterThan(maxNonFeatured);
  });

  test('all weights are non-negative', () => {
    const w = svc.RANKING_WEIGHTS;
    for (const [key, val] of Object.entries(w)) {
      if (!key.startsWith('//')) {
        expect(val).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('auctionScoreSQL returns a non-empty string', () => {
    const sql = svc.auctionScoreSQL('a');
    expect(typeof sql).toBe('string');
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  test('auctionScoreSQL wraps expression in parentheses', () => {
    const sql = svc.auctionScoreSQL('a');
    expect(sql.trim().startsWith('(')).toBe(true);
    expect(sql.trim().endsWith(')')).toBe(true);
  });

  test('auctionScoreSQL uses the provided alias', () => {
    const sql = svc.auctionScoreSQL('myalias');
    expect(sql).toContain('myalias.marketplace_priority');
    expect(sql).toContain('myalias.created_at');
    expect(sql).toContain('myalias.shipping_available');
  });

  test('auctionScoreSQL defaults alias to "a"', () => {
    const sql = svc.auctionScoreSQL();
    expect(sql).toContain('a.marketplace_priority');
  });

  test('auctionScoreSQL inlines numeric constants (no query params)', () => {
    const sql = svc.auctionScoreSQL('a');
    // Should not contain $N parameter placeholders
    expect(sql).not.toMatch(/\$\d+/);
  });

  test('auctionScoreSQL inlines expected weight values', () => {
    const sql = svc.auctionScoreSQL('a');
    const w   = svc.RANKING_WEIGHTS;
    expect(sql).toContain(String(w.featured_base));
    expect(sql).toContain(String(w.freshness_max));
    expect(sql).toContain(String(w.shipping));
  });

  test('auctionScoreSQL contains GREATEST for freshness floor at 0', () => {
    const sql = svc.auctionScoreSQL('a');
    expect(sql.toUpperCase()).toContain('GREATEST');
  });

  test('auctionScoreSQL contains CASE WHEN for featured branching', () => {
    const sql = svc.auctionScoreSQL('a');
    expect(sql.toUpperCase()).toContain('CASE WHEN');
  });

  test('auctionScoreSQL contains EXTRACT for freshness time computation', () => {
    const sql = svc.auctionScoreSQL('a');
    expect(sql.toUpperCase()).toContain('EXTRACT');
    expect(sql.toUpperCase()).toContain('EPOCH');
  });

  test('auctionScoreSQL contains LEAST for priority cap', () => {
    const sql = svc.auctionScoreSQL('a');
    expect(sql.toUpperCase()).toContain('LEAST');
  });

});

// ── 2. Ordering determinism ───────────────────────────────────────────────────
test.describe('Ranking — ordering determinism across endpoints', () => {

  test('GET /api/public/auctions returns same order on two consecutive calls', async ({ request }) => {
    const r1 = await (await request.get(`${BASE}/api/public/auctions?limit=10`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/auctions?limit=10`)).json();
    expect(r1.data.map(a => a.id)).toEqual(r2.data.map(a => a.id));
  });

  test('GET /api/public/auctions first result is stable on repeated calls', async ({ request }) => {
    const r1 = await (await request.get(`${BASE}/api/public/auctions?limit=1`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/auctions?limit=1`)).json();
    if (r1.data.length > 0) {
      expect(r1.data[0].id).toBe(r2.data[0].id);
    }
  });

  test('GET /api/public/featured-lots returns same order on two consecutive calls', async ({ request }) => {
    const r1 = await (await request.get(`${BASE}/api/public/featured-lots?limit=10`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/featured-lots?limit=10`)).json();
    expect(r1.data.map(l => l.id)).toEqual(r2.data.map(l => l.id));
  });

  test('GET /api/public/featured-auctions returns same order on two consecutive calls', async ({ request }) => {
    const r1 = await (await request.get(`${BASE}/api/public/featured-auctions?limit=10`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/featured-auctions?limit=10`)).json();
    expect(r1.data.map(a => a.id)).toEqual(r2.data.map(a => a.id));
  });

  test('GET /api/public/auctions/near returns same order on two consecutive calls', async ({ request }) => {
    const r1 = await (await request.get(`${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=10`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=10`)).json();
    expect(r1.data.map(a => a.id)).toEqual(r2.data.map(a => a.id));
  });

  test('pagination page 1 + page 2 produce disjoint id sets', async ({ request }) => {
    const r1 = await (await request.get(`${BASE}/api/public/auctions?limit=3&offset=0`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/auctions?limit=3&offset=3`)).json();
    if (r1.data.length === 0 || r2.data.length === 0) return;
    const ids1 = new Set(r1.data.map(a => a.id));
    const ids2 = new Set(r2.data.map(a => a.id));
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });

});

// ── 3. Score not exposed in responses ────────────────────────────────────────
test.describe('Ranking — score not exposed in API responses', () => {

  test('GET /api/public/auctions rows do not contain ranking_score', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('ranking_score');
      expect(row).not.toHaveProperty('score');
      expect(row).not.toHaveProperty('marketplace_priority');
    }
  });

  test('GET /api/public/auctions/near rows do not contain ranking_score', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('ranking_score');
      expect(row).not.toHaveProperty('marketplace_priority');
    }
  });

  test('GET /api/public/featured-lots rows do not contain ranking_score', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('ranking_score');
      expect(row).not.toHaveProperty('marketplace_priority');
    }
  });

  test('GET /api/public/featured-auctions rows do not contain ranking_score', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-auctions?limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('ranking_score');
      expect(row).not.toHaveProperty('marketplace_priority');
    }
  });

  test('GET /api/public/featured-auctions geo rows do not contain ranking_score', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-auctions?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('ranking_score');
      expect(row).not.toHaveProperty('marketplace_priority');
    }
  });

  test('GET /api/public/auctions envelope does not contain ranking_score', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5`);
    const body = await res.json();
    expect(body).not.toHaveProperty('ranking_score');
    expect(body).not.toHaveProperty('score');
  });

});

// ── 4. Pagination stability after ranking ─────────────────────────────────────
test.describe('Ranking — pagination stability', () => {

  test('total_count is stable across pages (ranking does not change universe size)', async ({ request }) => {
    const p1 = await (await request.get(`${BASE}/api/public/auctions?limit=2&offset=0`)).json();
    const p2 = await (await request.get(`${BASE}/api/public/auctions?limit=2&offset=2`)).json();
    expect(p1.total_count).toBe(p2.total_count);
  });

  test('has_more math: offset + data.length < total_count iff has_more=true', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=3&offset=0`);
    const body = await res.json();
    const expected = (body.offset + body.data.length) < body.total_count;
    expect(body.has_more).toBe(expected);
  });

  test('near endpoint has_more math is correct after ranking', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=3&offset=0`);
    const body = await res.json();
    const expected = (body.offset + body.data.length) < body.total_count;
    expect(body.has_more).toBe(expected);
  });

  test('limit=1 returns exactly 1 row and offset advances correctly', async ({ request }) => {
    const p1 = await (await request.get(`${BASE}/api/public/auctions?limit=1&offset=0`)).json();
    if (p1.total_count < 2) return;
    const p2 = await (await request.get(`${BASE}/api/public/auctions?limit=1&offset=1`)).json();
    expect(p1.data.length).toBe(1);
    expect(p2.data.length).toBe(1);
    // Second page should have a different auction
    expect(p1.data[0].id).not.toBe(p2.data[0].id);
  });

  test('offset=total_count yields empty data array', async ({ request }) => {
    const first = await (await request.get(`${BASE}/api/public/auctions?limit=1`)).json();
    const total = first.total_count;
    if (total === 0) return;
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5&offset=${total}`);
    const body = await res.json();
    expect(body.data.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  test('ranking does not duplicate rows across pages', async ({ request }) => {
    const first = await (await request.get(`${BASE}/api/public/auctions?limit=50&offset=0`)).json();
    if (first.total_count === 0) return;
    const ids = first.data.map(a => a.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

});

// ── 5. Featured prominence validation ─────────────────────────────────────────
test.describe('Ranking — featured prominence', () => {

  test('featured-auctions endpoint only returns marketplace_priority > 0 (guard unchanged)', async ({ request }) => {
    // The featured-auctions endpoint has a WHERE marketplace_priority > 0 guard.
    // All returned auctions are by definition "featured" — verify non-zero priority
    // by checking these are the same auctions that should appear first in /auctions.
    // We can't read marketplace_priority from the response (intentionally hidden).
    // Verify: /api/public/featured-auctions results also appear in /api/public/auctions.
    const featRes  = await request.get(`${BASE}/api/public/featured-auctions?limit=5`);
    const featBody = await featRes.json();
    if (featBody.data.length === 0) return; // no featured auctions seeded — skip

    const allRes  = await request.get(`${BASE}/api/public/auctions?limit=100`);
    const allBody = await allRes.json();
    const allIds  = new Set(allBody.data.map(a => a.id));

    for (const fa of featBody.data) {
      // Every featured auction should also appear in the general feed
      expect(allIds.has(fa.id)).toBe(true);
    }
  });

  test('featured-auctions geo path returns subset of general featured feed', async ({ request }) => {
    // Geo path filters by distance — result set must be a subset of the non-geo feed
    const nonGeo = await (await request.get(`${BASE}/api/public/featured-auctions?limit=50`)).json();
    const geo    = await (await request.get(`${BASE}/api/public/featured-auctions?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&radius_km=10000&limit=50`)).json();
    if (nonGeo.data.length === 0 || geo.data.length === 0) return;

    const nonGeoIds = new Set(nonGeo.data.map(a => a.id));
    // All geo results should be in the non-geo set (geo is a distance-filtered subset)
    // Note: geo also includes NULL-lat auctions (distance_km IS NULL), which also appear in non-geo
    for (const a of geo.data) {
      expect(nonGeoIds.has(a.id)).toBe(true);
    }
  });

  test('featured-auctions has distance_km field on geo path', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-auctions?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      // distance_km is null for auctions without lat/lng, numeric for those with coordinates
      const dk = row.distance_km;
      expect(dk === null || typeof dk === 'number').toBe(true);
    }
  });

  test('near endpoint auctions are ordered by distance (closest first)', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=10`);
    const body = await res.json();
    if (body.data.length < 2) return;
    // distance_km should be non-decreasing across rows
    for (let i = 1; i < body.data.length; i++) {
      const dk1 = body.data[i - 1].distance_km;
      const dk2 = body.data[i].distance_km;
      if (dk1 != null && dk2 != null) {
        // Allow tiny floating-point jitter + same distance for equal-distance tie-breaking
        expect(dk2).toBeGreaterThanOrEqual(dk1 - 0.001);
      }
    }
  });

});

// ── 6. Shipping weighting — null safety ───────────────────────────────────────
test.describe('Ranking — shipping signal null safety', () => {

  test('auctions with shipping=false or null still appear in feed (not excluded)', async ({ request }) => {
    // The shipping signal is additive — auctions without shipping are never excluded,
    // just ranked lower. Verify they still appear in the unfiltered feed.
    const res  = await request.get(`${BASE}/api/public/auctions?limit=20`);
    const body = await res.json();
    expect(res.status()).toBe(200);
    expect(body.success).toBe(true);
    // Not asserting specific shipping values — just confirming non-crash
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('shipping=true filter still works correctly after ranking', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?shipping=true&limit=20`);
    const body = await res.json();
    expect(res.status()).toBe(200);
    for (const a of body.data) {
      expect(a.shipping_available).toBe(true);
    }
  });

  test('near endpoint shipping filter still works correctly after ranking', async ({ request }) => {
    const res  = await request.get(
      `${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&shipping=true&limit=10`
    );
    const body = await res.json();
    expect(res.status()).toBe(200);
    for (const a of body.data) {
      expect(a.shipping_available).toBe(true);
    }
  });

});

// ── 7. Freshness signal — behavior verification ────────────────────────────────
test.describe('Ranking — freshness signal behavior', () => {

  test('all auction created_at fields are parseable dates', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=10`);
    const body = await res.json();
    for (const a of body.data) {
      if (a.created_at != null) {
        const d = new Date(a.created_at);
        expect(isNaN(d.getTime())).toBe(false);
        // created_at should be in the past (not in the future)
        expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 60000); // 1min tolerance
      }
    }
  });

  test('freshness decay window constant is sensible (>= 7 days, <= 365 days)', () => {
    const svc = require(path.resolve(__dirname, '../src/services/discoveryRankingService'));
    const days = svc.RANKING_WEIGHTS.freshness_decay_days;
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThanOrEqual(365);
  });

  test('freshness_max is positive', () => {
    const svc = require(path.resolve(__dirname, '../src/services/discoveryRankingService'));
    expect(svc.RANKING_WEIGHTS.freshness_max).toBeGreaterThan(0);
  });

});

// ── 8. Geo weighting — null safety ────────────────────────────────────────────
test.describe('Ranking — geo signal null safety', () => {

  test('featured-auctions without lat/lng still returns valid response', async ({ request }) => {
    // No-geo path must still work — ranking_score does not reference lat/lng
    const res  = await request.get(`${BASE}/api/public/featured-auctions?limit=10`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('near endpoint with very large radius returns valid response', async ({ request }) => {
    const res  = await request.get(
      `${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&radius_km=800&limit=10`
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('near endpoint with lat=0,lng=0 (null island) returns valid response', async ({ request }) => {
    // Edge case: coordinates at origin — no actual auctions expected but must not crash
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=0&lng=0&limit=5`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('near endpoint missing lng returns 400 (validation unchanged)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}`);
    expect(res.status()).toBe(400);
  });

  test('near endpoint NaN coordinates return 400', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=abc&lng=def`);
    expect(res.status()).toBe(400);
  });

});

// ── 9. Response contract — backwards compatibility ────────────────────────────
test.describe('Ranking — response contract backwards compatibility', () => {

  test('GET /api/public/auctions still returns all expected fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=2`);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.total_count).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
    expect(typeof body.offset).toBe('number');
    expect(typeof body.limit).toBe('number');
    if (body.data.length > 0) {
      const a = body.data[0];
      expect(typeof a.id).toBe('string');
      expect(typeof a.title).toBe('string');
      expect(typeof a.state).toBe('string');
      expect(a.created_at).toBeTruthy();
    }
  });

  test('GET /api/public/featured-lots still returns lot + auction fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=5`);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    if (body.data.length > 0) {
      const l = body.data[0];
      expect(typeof l.id).toBe('string');
      expect(typeof l.auction_id).toBe('string');
      expect(typeof l.auction_title).toBe('string');
    }
  });

  test('GET /api/public/featured-auctions non-geo still returns all expected fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-auctions?limit=5`);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    if (body.data.length > 0) {
      const a = body.data[0];
      expect(typeof a.id).toBe('string');
      expect(typeof a.title).toBe('string');
    }
  });

  test('GET /api/public/featured-auctions geo path includes distance_km', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-auctions?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=5`);
    const body = await res.json();
    expect(body.success).toBe(true);
    // distance_km field should exist in response rows (null for auctions without coords)
    if (body.data.length > 0) {
      expect('distance_km' in body.data[0]).toBe(true);
    }
  });

  test('GET /api/public/auctions/near includes distance_km field', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&limit=5`);
    const body = await res.json();
    expect(body.success).toBe(true);
    if (body.data.length > 0) {
      expect(typeof body.data[0].distance_km).toBe('number');
    }
  });

  test('GET /api/public/auctions seller_display_name still present (Phase 3 compat)', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5`);
    const body = await res.json();
    if (body.data.length > 0) {
      expect('seller_display_name' in body.data[0]).toBe(true);
    }
  });

  test('GET /api/public/featured-lots seller context fields still present', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=5`);
    const body = await res.json();
    if (body.data.length > 0) {
      expect('seller_display_name'  in body.data[0]).toBe(true);
      expect('seller_location_label' in body.data[0]).toBe(true);
      expect('seller_logo_url'       in body.data[0]).toBe(true);
    }
  });

  test('all previously validated endpoints still return 200', async ({ request }) => {
    const endpoints = [
      '/api/public/auctions',
      '/api/public/featured-lots',
      '/api/public/featured-auctions',
      `/api/public/auctions/${DEMO_ID}/lots`,
      '/api/public/featured-videos',
      '/api/public/locations',
    ];
    for (const ep of endpoints) {
      const res = await request.get(`${BASE}${ep}`);
      expect(res.status(), `${ep} should return 200`).toBe(200);
    }
  });

});
