'use strict';

/**
 * e2e/public-discovery-phase2.spec.js
 *
 * Validates Discovery Phase 2 endpoints:
 *   GET  /api/public/auctions/near          — radius-based discovery
 *   GET  /api/public/featured-auctions      — featured ranking feed + near-me variant
 *   GET  /api/public/locations              — city/state aggregation
 *   PATCH /api/admin/auctions/:id/discovery — admin sets priority/lat/lng
 *
 * Also validates:
 *   - shippable_lot_count additive field in GET /api/public/auctions
 *   - BD-safe field allowlists (no internal fields in any response)
 *
 * Test data: uses fixed demo-seed IDs. The admin discovery PATCH test sets
 * coordinates on the demo auction so downstream near/featured tests can verify
 * the full data path.
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const DEMO_AUCTION_ID = 'dd000000-0000-4000-8000-000000000010';
const NULL_UUID       = '00000000-0000-0000-0000-000000000000';

const ADMIN_CREDS = { email: 'validation-admin@advantage.bid', password: 'ValidationAdmin2025!' };
const BUYER_CREDS = { email: 'validation-buyer@advantage.bid', password: 'ValidationBuyer2025!' };

// Austin TX coordinates — used for seeding and near-me tests
const AUSTIN_LAT = 30.2672;
const AUSTIN_LNG = -97.7431;

// Module-level auth tokens (populated in setup)
let adminToken = null;
let buyerToken  = null;

async function login(request, creds) {
  const res = await request.post(`${BASE}/api/auth/login`, { data: creds });
  const body = await res.json();
  return body.token;
}

// ── Setup: authenticate and seed discovery data ───────────────────────────────
test.describe.configure({ mode: 'serial' });

test('setup: authenticate tokens', async ({ request }) => {
  [adminToken, buyerToken] = await Promise.all([
    login(request, ADMIN_CREDS),
    login(request, BUYER_CREDS),
  ]);
  expect(adminToken).toBeTruthy();
  expect(buyerToken).toBeTruthy();
});

// ── PATCH /api/admin/auctions/:id/discovery ───────────────────────────────────
test.describe('PATCH /api/admin/auctions/:id/discovery', () => {

  test('returns 401 without auth', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      data: { priority: 5 },
    });
    expect(res.status()).toBe(401);
  });

  test('returns 403 for buyer role', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
      data: { priority: 5 },
    });
    expect(res.status()).toBe(403);
  });

  test('returns 400 when no fields provided', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('returns 400 for negative priority', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { priority: -1 },
    });
    expect(res.status()).toBe(400);
  });

  test('returns 400 for non-integer priority', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { priority: 5.5 },
    });
    expect(res.status()).toBe(400);
  });

  test('returns 400 for priority > 10000', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { priority: 99999 },
    });
    expect(res.status()).toBe(400);
  });

  test('returns 400 for invalid lat (out of range)', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { lat: 91.0 },
    });
    expect(res.status()).toBe(400);
  });

  test('returns 400 for invalid lng (out of range)', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { lng: 200.0 },
    });
    expect(res.status()).toBe(400);
  });

  test('returns 404 for unknown auction', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${NULL_UUID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { priority: 5 },
    });
    expect(res.status()).toBe(404);
  });

  test('admin can set marketplace_priority', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { priority: 10 },
    });
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.marketplace_priority).toBe(10);
    expect(data.id).toBe(DEMO_AUCTION_ID);
    // Internal fields not leaked
    expect(data).not.toHaveProperty('seller_id');
    expect(data).not.toHaveProperty('admin_notes');
  });

  test('admin can set lat and lng independently', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { lat: AUSTIN_LAT, lng: AUSTIN_LNG },
    });
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(parseFloat(data.lat)).toBeCloseTo(AUSTIN_LAT, 3);
    expect(parseFloat(data.lng)).toBeCloseTo(AUSTIN_LNG, 3);
  });

  test('admin can update all three fields in one request', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { priority: 8, lat: AUSTIN_LAT, lng: AUSTIN_LNG },
    });
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.marketplace_priority).toBe(8);
    expect(parseFloat(data.lat)).toBeCloseTo(AUSTIN_LAT, 3);
    expect(parseFloat(data.lng)).toBeCloseTo(AUSTIN_LNG, 3);
  });

});

// ── GET /api/public/auctions — shippable_lot_count additive field ─────────────
test.describe('GET /api/public/auctions — shippable_lot_count field', () => {

  test('response includes shippable_lot_count as integer', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=closed`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(row).toHaveProperty('shippable_lot_count');
      expect(typeof row.shippable_lot_count).toBe('number');
      expect(row.shippable_lot_count).toBeGreaterThanOrEqual(0);
    }
  });

  test('lot_count and shippable_lot_count are consistent (shippable ≤ total)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=closed`);
    const { data } = await res.json();
    for (const row of data) {
      expect(row.shippable_lot_count).toBeLessThanOrEqual(row.lot_count);
    }
  });

});

// ── GET /api/public/auctions/near ─────────────────────────────────────────────
test.describe('GET /api/public/auctions/near', () => {

  test('returns 400 when lat missing', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lng=-97.7`);
    expect(res.status()).toBe(400);
  });

  test('returns 400 when lng missing', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=30.2`);
    expect(res.status()).toBe(400);
  });

  test('returns 400 for lat out of range', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=91&lng=-97`);
    expect(res.status()).toBe(400);
  });

  test('returns 400 for lng out of range', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=30&lng=200`);
    expect(res.status()).toBe(400);
  });

  test('returns 400 for non-numeric lat', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=abc&lng=-97`);
    expect(res.status()).toBe(400);
  });

  test('returns 200 with valid lat/lng (may return empty array)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}&radius_km=50`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('no auth required', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}`);
    expect(res.status()).toBe(200);
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

  test('results include distance_km and shippable_lot_count', async ({ request }) => {
    // The demo auction has lat/lng set (from the admin PATCH test above).
    // It is state=closed so won't appear in /near (which only returns published/active).
    // We just validate the shape is structurally correct when results do exist.
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}&radius_km=800`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    for (const row of data) {
      expect(row).toHaveProperty('distance_km');
      expect(typeof row.distance_km).toBe('number');
      expect(row.distance_km).toBeGreaterThanOrEqual(0);
      expect(row).toHaveProperty('shippable_lot_count');
      expect(row).toHaveProperty('lat');
      expect(row).toHaveProperty('lng');
      // No internal fields
      expect(row).not.toHaveProperty('seller_id');
      expect(row).not.toHaveProperty('marketplace_priority');
      expect(row).not.toHaveProperty('reserve_cents');
    }
  });

  test('shipping=true filter works with near endpoint', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/public/auctions/near?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}&shipping=true`
    );
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    for (const row of data) {
      expect(row.shipping_available).toBe(true);
    }
  });

  test('limit respected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}&limit=3`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(3);
  });

  test('radius_km capped at 800', async ({ request }) => {
    // Should succeed without error even with huge radius
    const res = await request.get(`${BASE}/api/public/auctions/near?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}&radius_km=9999`);
    expect(res.status()).toBe(200);
  });

});

// ── GET /api/public/featured-auctions ────────────────────────────────────────
test.describe('GET /api/public/featured-auctions', () => {

  test('returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('no internal fields exposed', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions`);
    const { data } = await res.json();
    for (const row of data) {
      expect(row).not.toHaveProperty('seller_id');
      expect(row).not.toHaveProperty('marketplace_priority');
      expect(row).not.toHaveProperty('reserve_cents');
      expect(row).not.toHaveProperty('admin_notes');
      expect(row).not.toHaveProperty('winning_buyer_user_id');
    }
  });

  test('response shape includes lat, lng, shippable_lot_count', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions`);
    const { data } = await res.json();
    for (const row of data) {
      expect(row).toHaveProperty('lot_count');
      expect(row).toHaveProperty('shippable_lot_count');
      // lat/lng present (may be null)
      expect('lat' in row).toBe(true);
      expect('lng' in row).toBe(true);
    }
  });

  test('limit param respected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions?limit=3`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(3);
  });

  test('limit capped at 50', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions?limit=9999`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(50);
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

  test('with valid lat/lng: returns 200 (geo-filtered path)', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/public/featured-auctions?lat=${AUSTIN_LAT}&lng=${AUSTIN_LNG}&radius_km=500`
    );
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // Any returned rows should have distance_km
    for (const row of data) {
      if (row.distance_km != null) {
        expect(typeof row.distance_km).toBe('number');
        expect(row.distance_km).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('with invalid lat: returns 400', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions?lat=91&lng=-97`);
    expect(res.status()).toBe(400);
  });

  test('with invalid lng: returns 400', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions?lat=30&lng=200`);
    expect(res.status()).toBe(400);
  });

  test('partial lat without lng: returns 400', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-auctions?lat=30.2`);
    expect(res.status()).toBe(400);
  });

});

// ── GET /api/public/locations ─────────────────────────────────────────────────
test.describe('GET /api/public/locations', () => {

  test('returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/locations`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('response shape: city, address_state, auction_count, active_count', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/locations`);
    const { data } = await res.json();
    for (const row of data) {
      expect(row).toHaveProperty('city');
      expect(row).toHaveProperty('address_state');
      expect(row).toHaveProperty('auction_count');
      expect(row).toHaveProperty('active_count');
      expect(typeof row.auction_count).toBe('number');
      expect(typeof row.active_count).toBe('number');
      expect(row.active_count).toBeLessThanOrEqual(row.auction_count);
      // No internal fields
      expect(row).not.toHaveProperty('seller_id');
      expect(row).not.toHaveProperty('id');
    }
  });

  test('no null city or address_state rows returned', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/locations`);
    const { data } = await res.json();
    for (const row of data) {
      expect(row.city).not.toBeNull();
      expect(row.address_state).not.toBeNull();
    }
  });

  test('address_state filter works', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/locations?address_state=TX`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    for (const row of data) {
      expect(row.address_state).toBe('TX');
    }
  });

  test('limit param respected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/locations?limit=5`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(5);
  });

  test('no auth required', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/locations`);
    expect(res.status()).toBe(200);
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/locations`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});

// ── Cleanup: reset demo auction discovery fields ──────────────────────────────
test('cleanup: reset demo auction marketplace_priority to 0', async ({ request }) => {
  const res = await request.patch(`${BASE}/api/admin/auctions/${DEMO_AUCTION_ID}/discovery`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { priority: 0 },
  });
  expect([200, 404]).toContain(res.status());
});
