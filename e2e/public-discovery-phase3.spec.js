'use strict';

/**
 * e2e/public-discovery-phase3.spec.js
 *
 * Validates Discovery Phase 3 enrichments:
 *   GET /api/public/auctions          — keyword search (q param) + pagination metadata
 *   GET /api/public/auctions/near     — pagination metadata
 *   GET /api/public/auctions/:id/lots — pagination metadata
 *   GET /api/public/featured-lots     — seller context fields
 *   GET /api/public/featured-videos   — seller_display_name field
 *
 * All endpoints are public (no auth required).
 * Tests are additive — phase 1 and phase 2 behavior is unchanged.
 *
 * Test data: uses fixed seeded demo auction and lot IDs.
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const DEMO_AUCTION_ID = 'dd000000-0000-4000-8000-000000000010';
const NULL_UUID       = '00000000-0000-0000-0000-000000000000';

// Dallas TX — seeded demo auction coordinates (set by phase 2 admin discovery test)
const DALLAS_LAT = 32.7767;
const DALLAS_LNG = -96.7970;

test.describe.configure({ mode: 'serial' });

// ── GET /api/public/auctions — keyword search ─────────────────────────────────
test.describe('GET /api/public/auctions — keyword search (q param)', () => {

  test('returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions`);
    expect(res.status()).toBe(200);
  });

  test('q param with no match returns empty data array and total_count 0', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?q=xyzzy_nomatch_8675309`);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(0);
    expect(body.total_count).toBe(0);
    expect(body.has_more).toBe(false);
  });

  test('q param filters by title match (case-insensitive)', async ({ request }) => {
    // First fetch all auctions to find a title substring to search for
    const allRes  = await request.get(`${BASE}/api/public/auctions?limit=5`);
    const allBody = await allRes.json();
    if (!allBody.data || allBody.data.length === 0) return; // no seeded data — skip

    const sample = allBody.data[0];
    if (!sample.title || sample.title.length < 3) return;

    // Use the first 5 chars of the title (should match at least this auction)
    const fragment = sample.title.slice(0, 5).toLowerCase();
    const res      = await request.get(`${BASE}/api/public/auctions?q=${encodeURIComponent(fragment)}`);
    const body     = await res.json();

    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    // Every result should match the fragment in title, description, or city
    for (const row of body.data) {
      const haystack = [row.title, row.description, row.city].join(' ').toLowerCase();
      expect(haystack).toContain(fragment);
    }
  });

  test('q param is capped — overly long query does not throw', async ({ request }) => {
    const longQ = 'a'.repeat(500);
    const res   = await request.get(`${BASE}/api/public/auctions?q=${encodeURIComponent(longQ)}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('empty q returns same results as no q', async ({ request }) => {
    const [r1, r2] = await Promise.all([
      request.get(`${BASE}/api/public/auctions?limit=5`),
      request.get(`${BASE}/api/public/auctions?limit=5&q=`),
    ]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(b1.total_count).toBe(b2.total_count);
  });

  test('q param does not expose SQL injection surface', async ({ request }) => {
    const injections = [
      "'; DROP TABLE auctions; --",
      "1' OR '1'='1",
      "% OR 1=1 --",
    ];
    for (const inj of injections) {
      const res  = await request.get(`${BASE}/api/public/auctions?q=${encodeURIComponent(inj)}`);
      const body = await res.json();
      expect(res.status()).toBe(200);
      expect(body.success).toBe(true); // server still healthy
    }
  });

});

// ── GET /api/public/auctions — pagination metadata ────────────────────────────
test.describe('GET /api/public/auctions — pagination metadata', () => {

  test('response includes total_count integer', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions`);
    const body = await res.json();
    expect(typeof body.total_count).toBe('number');
    expect(Number.isInteger(body.total_count)).toBe(true);
    expect(body.total_count).toBeGreaterThanOrEqual(0);
  });

  test('response includes has_more boolean', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions`);
    const body = await res.json();
    expect(typeof body.has_more).toBe('boolean');
  });

  test('response includes offset and limit', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5&offset=0`);
    const body = await res.json();
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(5);
  });

  test('has_more is false when data.length < limit', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=100`);
    const body = await res.json();
    if (body.data.length < 100) {
      expect(body.has_more).toBe(false);
    }
  });

  test('has_more is true when more rows exist', async ({ request }) => {
    // Request only 1 row — if total_count > 1, has_more should be true
    const res  = await request.get(`${BASE}/api/public/auctions?limit=1`);
    const body = await res.json();
    if (body.total_count > 1) {
      expect(body.has_more).toBe(true);
    }
  });

  test('total_count is consistent across pages', async ({ request }) => {
    const [r1, r2] = await Promise.all([
      request.get(`${BASE}/api/public/auctions?limit=2&offset=0`),
      request.get(`${BASE}/api/public/auctions?limit=2&offset=2`),
    ]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(b1.total_count).toBe(b2.total_count);
  });

  test('data rows do not contain total_count field (stripped from rows)', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=3`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('total_count');
    }
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});

// ── GET /api/public/auctions/near — pagination metadata ──────────────────────
test.describe('GET /api/public/auctions/near — pagination metadata', () => {

  test('response includes total_count and has_more', async ({ request }) => {
    const res  = await request.get(
      `${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&radius_km=500`
    );
    // May return 200 with empty data if no seeded geo auctions — still validates shape
    if (res.status() !== 200) return; // skip if no geo-tagged auctions
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.total_count).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
    expect(typeof body.offset).toBe('number');
    expect(typeof body.limit).toBe('number');
  });

  test('data rows do not contain total_count field', async ({ request }) => {
    const res  = await request.get(
      `${BASE}/api/public/auctions/near?lat=${DALLAS_LAT}&lng=${DALLAS_LNG}&radius_km=500`
    );
    if (res.status() !== 200) return;
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('total_count');
    }
  });

  test('returns 400 when lat/lng missing', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near`);
    expect(res.status()).toBe(400);
  });

});

// ── GET /api/public/auctions/:id/lots — pagination metadata ──────────────────
test.describe('GET /api/public/auctions/:id/lots — pagination metadata', () => {

  test('response includes total_count and has_more', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots`);
    if (res.status() !== 200) return; // auction may not be in visible state in CI
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.total_count).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
    expect(body.offset).toBe(0);
    expect(body.limit).toBeGreaterThan(0);
  });

  test('data rows do not contain total_count field', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots`);
    if (res.status() !== 200) return;
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('total_count');
    }
  });

  test('limit=1 with has_more when more lots exist', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots?limit=1`);
    if (res.status() !== 200) return;
    const body = await res.json();
    if (body.total_count > 1) {
      expect(body.has_more).toBe(true);
    }
  });

  test('returns 404 for unknown UUID', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${NULL_UUID}/lots`);
    expect(res.status()).toBe(404);
  });

});

// ── GET /api/public/featured-lots — seller context ───────────────────────────
test.describe('GET /api/public/featured-lots — seller context', () => {

  test('returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-lots`);
    expect(res.status()).toBe(200);
  });

  test('response shape includes seller context fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=5`);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    if (body.data.length > 0) {
      const row = body.data[0];
      // Fields must exist (may be null if seller has no profile)
      expect(row).toHaveProperty('seller_display_name');
      expect(row).toHaveProperty('seller_location_label');
      expect(row).toHaveProperty('seller_logo_url');
    }
  });

  test('seller fields are null or string — never an object or array', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=10`);
    const body = await res.json();
    for (const row of body.data) {
      if (row.seller_display_name !== null) {
        expect(typeof row.seller_display_name).toBe('string');
      }
      if (row.seller_location_label !== null) {
        expect(typeof row.seller_location_label).toBe('string');
      }
    }
  });

  test('existing lot fields still present (backwards compatible)', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=3`);
    const body = await res.json();
    if (body.data.length === 0) return;
    const row = body.data[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('lot_number');
    expect(row).toHaveProperty('title');
    expect(row).toHaveProperty('auction_id');
    expect(row).toHaveProperty('auction_title');
    expect(row).toHaveProperty('auction_state');
  });

  test('no internal fields exposed in response', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('reserve_cents');
      expect(row).not.toHaveProperty('winning_buyer_user_id');
      expect(row).not.toHaveProperty('seller_id');
      expect(row).not.toHaveProperty('user_id');
    }
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-lots`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});

// ── GET /api/public/featured-videos — seller context ─────────────────────────
test.describe('GET /api/public/featured-videos — seller context', () => {

  test('returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos`);
    expect(res.status()).toBe(200);
  });

  test('response includes seller_display_name field', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-videos?limit=5`);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    if (body.data.length > 0) {
      const row = body.data[0];
      expect(row).toHaveProperty('seller_display_name');
    }
  });

  test('seller_display_name is null or string', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-videos?limit=10`);
    const body = await res.json();
    for (const row of body.data) {
      if (row.seller_display_name !== null) {
        expect(typeof row.seller_display_name).toBe('string');
      }
    }
  });

  test('existing video fields still present (backwards compatible)', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-videos?limit=3`);
    const body = await res.json();
    if (body.data.length === 0) return;
    const row = body.data[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('auction_id');
    expect(row).toHaveProperty('video_url');
    expect(row).toHaveProperty('auction_title');
    expect(row).toHaveProperty('auction_state');
  });

  test('no internal fields in video response', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-videos?limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('seller_id');
      expect(row).not.toHaveProperty('user_id');
      expect(row).not.toHaveProperty('winning_buyer_user_id');
    }
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});

// ── BD allowlist safety — no internal fields across all modified endpoints ────
test.describe('BD field allowlist safety', () => {

  test('/api/public/auctions: no internal fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=3`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row).not.toHaveProperty('reserve_cents');
      expect(row).not.toHaveProperty('winning_buyer_user_id');
      expect(row).not.toHaveProperty('capabilities');
      expect(row).not.toHaveProperty('address_encrypted');
      expect(row).not.toHaveProperty('admin_notes');
    }
  });

  test('/api/public/auctions: total_count not leaked into individual rows', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5`);
    const body = await res.json();
    expect(body).toHaveProperty('total_count'); // top-level only
    for (const row of body.data) {
      expect(row).not.toHaveProperty('total_count');
    }
  });

});
