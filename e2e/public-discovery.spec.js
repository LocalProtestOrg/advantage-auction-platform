'use strict';

/**
 * e2e/public-discovery.spec.js
 *
 * Validates the /api/public/* discovery layer:
 *   - No auth required on any endpoint
 *   - Correct response shapes and field allowlists
 *   - Sensitive fields absent (reserve_cents, winning_buyer_user_id,
 *     seller_id FK, user_id FK, capabilities, admin flags, etc.)
 *   - Filtering and pagination work
 *   - Cache-Control headers present
 *
 * Uses fixed demo-seed data (state=closed) for shape assertions.
 * Tests are query-only — no mutations, no cleanup needed.
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Fixed demo-seed IDs (from scripts/seed-demo-data.js)
const DEMO_AUCTION_ID  = 'dd000000-0000-4000-8000-000000000010'; // Fine Jewelry & Watches
const DEMO_SELLER_SP   = 'dd000000-0000-4000-8000-000000000003'; // seller_profile id
const NULL_UUID        = '00000000-0000-0000-0000-000000000000';

// Fields that MUST NOT appear in any public API response
const BLOCKED_FIELDS = [
  'seller_id',
  'user_id',
  'reserve_cents',
  'winning_buyer_user_id',
  'winning_amount_cents',
  'capabilities',
  'metadata',
  'admin_notes',
  'address_encrypted',
  'increment_ladder',
  'marketing_selection',
  'approved_by',
  'rejection_reason',
  'visible_public',
  'featured_for_marketing',
  'soft_close_policy',
  'pickup_group',
  'password_hash',
];

function assertNoBlockedFields(obj, label) {
  for (const field of BLOCKED_FIELDS) {
    expect(obj, `${label} must not expose ${field}`).not.toHaveProperty(field);
  }
}

// ── /api/public/auctions ──────────────────────────────────────────────────────
test.describe('GET /api/public/auctions', () => {

  test('returns 200 without auth token', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('state=closed finds demo auctions', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=closed`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(3);

    const row = data[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('title');
    expect(row).toHaveProperty('state', 'closed');
    expect(row).toHaveProperty('lot_count');
    expect(row).toHaveProperty('shipping_available');
    expect(row).toHaveProperty('seller_display_name');
    expect(row).toHaveProperty('seller_location_label');
    expect(row).toHaveProperty('seller_logo_url');
    assertNoBlockedFields(row, 'auction list row');
  });

  test('no internal auction fields present in list', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=closed`);
    const { data } = await res.json();
    for (const row of data) {
      // FK that leaks internal structure
      expect(row).not.toHaveProperty('seller_id');
      expect(row).not.toHaveProperty('address_encrypted');
      expect(row).not.toHaveProperty('increment_ladder');
      expect(row).not.toHaveProperty('marketing_selection');
      expect(row).not.toHaveProperty('admin_notes');
      expect(row).not.toHaveProperty('marketplace_priority');
      expect(row).not.toHaveProperty('version');
      expect(row).not.toHaveProperty('default_starting_bid_cents');
    }
  });

  test('pagination: limit respected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=closed&limit=2`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(2);
  });

  test('pagination: offset shifts results', async ({ request }) => {
    const p1 = await request.get(`${BASE}/api/public/auctions?state=closed&limit=2&offset=0`);
    const p2 = await request.get(`${BASE}/api/public/auctions?state=closed&limit=2&offset=2`);
    const { data: d1 } = await p1.json();
    const { data: d2 } = await p2.json();
    // page 1 and page 2 should not overlap (if enough rows)
    if (d1.length > 0 && d2.length > 0) {
      const ids1 = new Set(d1.map(r => r.id));
      for (const row of d2) {
        expect(ids1.has(row.id)).toBe(false);
      }
    }
  });

  test('shipping=true filter returns only shippable auctions', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=closed&shipping=true`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    for (const row of data) {
      expect(row.shipping_available).toBe(true);
    }
  });

  test('invalid state is ignored — defaults to published+active', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=draft`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    // draft state is not in allowlist so query falls back to published+active
    // All returned rows (if any) should not be draft
    for (const row of data) {
      expect(['published', 'active']).toContain(row.state);
    }
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions`);
    const cc = res.headers()['cache-control'];
    expect(cc).toBeTruthy();
    expect(cc).toContain('s-maxage');
  });

  test('limit capped at 100', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions?state=closed&limit=9999`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(100);
  });

});

// ── /api/public/auctions/:id ──────────────────────────────────────────────────
test.describe('GET /api/public/auctions/:id', () => {

  test('returns sanitized auction detail for demo auction', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(DEMO_AUCTION_ID);
    expect(data).toHaveProperty('title');
    expect(data).toHaveProperty('state', 'closed');
    expect(data).toHaveProperty('lot_count');
    expect(data).toHaveProperty('auction_terms');
    expect(data).toHaveProperty('seller_profile_id');
    expect(data).toHaveProperty('seller_display_name');
    expect(data).toHaveProperty('seller_bio');
    expect(data).toHaveProperty('seller_location_label');
    expect(data).toHaveProperty('seller_logo_url');
    expect(data).toHaveProperty('seller_type');
    assertNoBlockedFields(data, 'auction detail');
  });

  test('seller_id FK not present in single auction response', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}`);
    const { data } = await res.json();
    expect(data).not.toHaveProperty('seller_id');
    expect(data).not.toHaveProperty('address_encrypted');
    expect(data).not.toHaveProperty('increment_ladder');
    expect(data).not.toHaveProperty('marketing_selection');
    expect(data).not.toHaveProperty('admin_notes');
  });

  test('returns 404 for unknown auction', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${NULL_UUID}`);
    expect(res.status()).toBe(404);
  });

  test('returns 404 for non-UUID id', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/not-a-uuid`);
    expect(res.status()).toBe(404);
  });

  test('no auth required', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}`, {
      headers: { Authorization: '' },
    });
    expect(res.status()).toBe(200);
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});

// ── /api/public/auctions/:id/lots ─────────────────────────────────────────────
test.describe('GET /api/public/auctions/:id/lots', () => {

  test('returns lot list for demo auction', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(4);
  });

  test('lot field allowlist correct', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots`);
    const { data } = await res.json();
    const lot = data[0];
    expect(lot).toHaveProperty('id');
    expect(lot).toHaveProperty('lot_number');
    expect(lot).toHaveProperty('title');
    expect(lot).toHaveProperty('state');
    expect(lot).toHaveProperty('starting_bid_cents');
    expect(lot).toHaveProperty('current_bid_cents');
    expect(lot).toHaveProperty('bid_count');
    expect(lot).toHaveProperty('is_featured');
    expect(lot).toHaveProperty('shippable');
    assertNoBlockedFields(lot, 'lot row');
  });

  test('critical fields absent: reserve_cents and winning_buyer_user_id', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots`);
    const { data } = await res.json();
    for (const lot of data) {
      expect(lot).not.toHaveProperty('reserve_cents');
      expect(lot).not.toHaveProperty('reserve_visible');
      expect(lot).not.toHaveProperty('winning_buyer_user_id');
      expect(lot).not.toHaveProperty('winning_amount_cents');
      expect(lot).not.toHaveProperty('pickup_group');
      expect(lot).not.toHaveProperty('soft_close_policy');
    }
  });

  test('lots ordered by lot_number ascending', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots`);
    const { data } = await res.json();
    for (let i = 1; i < data.length; i++) {
      expect(data[i].lot_number).toBeGreaterThanOrEqual(data[i - 1].lot_number);
    }
  });

  test('pagination limit respected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots?limit=2`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(2);
  });

  test('returns 404 for unknown auction', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${NULL_UUID}/lots`);
    expect(res.status()).toBe(404);
  });

  test('returns 404 for non-UUID auction id', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/not-a-uuid/lots`);
    expect(res.status()).toBe(404);
  });

  test('no auth required', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/${DEMO_AUCTION_ID}/lots`);
    expect(res.status()).toBe(200);
  });

});

// ── /api/public/featured-lots ─────────────────────────────────────────────────
test.describe('GET /api/public/featured-lots', () => {

  test('returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-lots`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('returned lots have expected auction context fields', async ({ request }) => {
    // Use auction_state=closed to include demo data (if any lots are featured)
    const res = await request.get(`${BASE}/api/public/featured-lots?auction_state=closed`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    // May be empty if no featured lots are seeded — validate shape for any returned rows
    for (const lot of data) {
      expect(lot).toHaveProperty('auction_title');
      expect(lot).toHaveProperty('auction_state');
      expect(lot).toHaveProperty('auction_city');
      expect(lot).toHaveProperty('lot_state');
      assertNoBlockedFields(lot, 'featured lot');
      expect(lot).not.toHaveProperty('reserve_cents');
      expect(lot).not.toHaveProperty('winning_buyer_user_id');
    }
  });

  test('limit param respected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-lots?limit=5`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(5);
  });

  test('limit capped at 100', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-lots?limit=9999`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(100);
  });

  test('invalid auction_state is ignored — defaults to published+active', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-lots?auction_state=draft`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    for (const lot of data) {
      expect(['published', 'active']).toContain(lot.auction_state);
    }
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-lots`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});

// ── /api/public/featured-videos ───────────────────────────────────────────────
test.describe('GET /api/public/featured-videos', () => {

  test('returns 200 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('internal video moderation fields absent', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos`);
    const { data } = await res.json();
    for (const v of data) {
      expect(v).not.toHaveProperty('review_status');
      expect(v).not.toHaveProperty('approved_by');
      expect(v).not.toHaveProperty('approved_at');
      expect(v).not.toHaveProperty('visible_public');
      expect(v).not.toHaveProperty('featured_for_marketing');
      expect(v).not.toHaveProperty('rejection_reason');
    }
  });

  test('limit param respected', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos?limit=3`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(3);
  });

  test('limit capped at 50', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos?limit=9999`);
    const { data } = await res.json();
    expect(data.length).toBeLessThanOrEqual(50);
  });

  test('returned videos have auction context', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos`);
    const { data } = await res.json();
    for (const v of data) {
      expect(v).toHaveProperty('video_url');
      expect(v).toHaveProperty('auction_id');
      expect(v).toHaveProperty('auction_title');
      expect(v).toHaveProperty('auction_state');
    }
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/featured-videos`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});

// ── /api/public/sellers/:sellerId/profile ─────────────────────────────────────
test.describe('GET /api/public/sellers/:sellerId/profile', () => {

  test('returns public seller profile for demo seller', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/sellers/${DEMO_SELLER_SP}/profile`);
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(DEMO_SELLER_SP);
    expect(data).toHaveProperty('display_name');
    expect(data).toHaveProperty('bio');
    expect(data).toHaveProperty('location_label');
    expect(data).toHaveProperty('logo_url');
    expect(data).toHaveProperty('seller_type');
    expect(data).toHaveProperty('auction_count');
    expect(data).toHaveProperty('active_auction_count');
    expect(typeof data.auction_count).toBe('number');
    expect(typeof data.active_auction_count).toBe('number');
  });

  test('internal seller fields absent', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/sellers/${DEMO_SELLER_SP}/profile`);
    const { data } = await res.json();
    expect(data).not.toHaveProperty('user_id');
    expect(data).not.toHaveProperty('capabilities');
    expect(data).not.toHaveProperty('metadata');
    expect(data).not.toHaveProperty('created_at');
  });

  test('demo seller has auction_count >= 3 (3 closed demo auctions)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/sellers/${DEMO_SELLER_SP}/profile`);
    const { data } = await res.json();
    expect(data.auction_count).toBeGreaterThanOrEqual(3);
  });

  test('returns 404 for unknown seller', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/sellers/${NULL_UUID}/profile`);
    expect(res.status()).toBe(404);
  });

  test('returns 404 for non-UUID seller id', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/sellers/not-a-uuid/profile`);
    expect(res.status()).toBe(404);
  });

  test('no auth required', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/sellers/${DEMO_SELLER_SP}/profile`, {
      headers: { Authorization: '' },
    });
    expect(res.status()).toBe(200);
  });

  test('Cache-Control header present', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/sellers/${DEMO_SELLER_SP}/profile`);
    expect(res.headers()['cache-control']).toBeTruthy();
  });

});
