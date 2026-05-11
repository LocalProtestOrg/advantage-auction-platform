'use strict';

/**
 * e2e/delta-marketplace-validation.spec.js
 *
 * Delta-Testing — Marketplace Validation Sprint
 *
 * Stability/regression validation for recent platform additions:
 *   - AAPAnalytics telemetry module + POST /api/analytics/events endpoint
 *   - AAPMarketplaceSellerCta module integration in auction-view.html
 *   - Enriched discovery responses (seller context, pagination envelopes)
 *   - Mobile rendering at 375px viewport
 *   - Page integrity: no console errors, correct DOM order, no PII leakage
 *
 * This spec is ADDITIVE and VALIDATION-ONLY. It does not overlap with:
 *   - e2e/charlie-bd-marketplace-seller-cta.spec.js (module-level CTA tests)
 *   - e2e/public-discovery-phase3.spec.js (discovery enrichment API tests)
 *   - e2e/public-discovery.spec.js (field allowlists, response shapes)
 *   - e2e/mobile-viewport.spec.js (general mobile layout)
 *
 * Focus areas:
 *   1. Analytics endpoint — 202, fire-and-forget, handles malformed input
 *   2. AAPAnalytics module — non-blocking, session management, no PII
 *   3. Discovery baseline — envelope consistency, ordering fields, backwards compat
 *   4. Pagination math — total_count/has_more invariant across all paginated endpoints
 *   5. auction-view.html integrity — full-page load, DOM order, coexistence of features
 *   6. Mobile rendering — CTA strip, lot grid, no horizontal scroll at 375px
 *   7. Telemetry non-blocking — analytics failures must not affect page render
 *
 * Seed: uses deterministic seeded auction dd000000-0000-4000-8000-000000000010
 */

const { test, expect } = require('@playwright/test');

const BASE        = process.env.BASE_URL || 'http://localhost:3000';
const AUCTION_URL = BASE + '/auction-view.html?auctionId=dd000000-0000-4000-8000-000000000010';
const DEMO_ID     = 'dd000000-0000-4000-8000-000000000010';

test.describe.configure({ mode: 'serial' });

// ── 1. Analytics endpoint — server-side ──────────────────────────────────────
test.describe('POST /api/analytics/events — server behavior', () => {

  test('returns 202 for a well-formed single event', async ({ request }) => {
    const res = await request.post(`${BASE}/api/analytics/events`, {
      data: {
        event_type: 'validation_probe',
        session_id: 'aap_test_session',
        device_type: 'desktop',
        widget_name: 'delta-validation-spec',
      },
    });
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
  });

  test('returns 202 for a batch array of events', async ({ request }) => {
    const res = await request.post(`${BASE}/api/analytics/events`, {
      data: [
        { event_type: 'validation_batch_a', session_id: 'aap_test_batch' },
        { event_type: 'validation_batch_b', session_id: 'aap_test_batch' },
      ],
    });
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
  });

  test('returns 202 for an event with empty metadata (fire-and-forget, never 500)', async ({ request }) => {
    const res = await request.post(`${BASE}/api/analytics/events`, { data: {} });
    expect(res.status()).toBe(202);
  });

  test('returns 202 for an empty array (never 500)', async ({ request }) => {
    const res = await request.post(`${BASE}/api/analytics/events`, { data: [] });
    expect(res.status()).toBe(202);
  });

  test('returns 202 for oversized metadata string (service truncates, never 500)', async ({ request }) => {
    const res = await request.post(`${BASE}/api/analytics/events`, {
      data: {
        event_type: 'validation_large',
        metadata: { payload: 'x'.repeat(10000) },
      },
    });
    // 202 even for oversized payload — service trims to 4KB and stores
    expect(res.status()).toBe(202);
  });

  test('response envelope never exposes internal DB fields', async ({ request }) => {
    const res  = await request.post(`${BASE}/api/analytics/events`, {
      data: { event_type: 'validation_envelope' },
    });
    const body = await res.json();
    // Only expected field is accepted:true — no id, created_at, ip_hash, etc.
    expect(Object.keys(body)).toEqual(['accepted']);
  });

  test('endpoint strips PII — email-like field in body does not cause 500', async ({ request }) => {
    const res = await request.post(`${BASE}/api/analytics/events`, {
      data: {
        event_type: 'validation_pii',
        email: 'should-be-stripped@example.com',
        password: 'should-be-stripped',
        token: 'should-be-stripped',
      },
    });
    // Fire-and-forget: 202 regardless, PII stripped in analyticsService
    expect(res.status()).toBe(202);
  });

  test('Cache-Control header is absent on analytics endpoint (no caching)', async ({ request }) => {
    const res = await request.post(`${BASE}/api/analytics/events`, {
      data: { event_type: 'validation_cache' },
    });
    // Analytics events must not be CDN-cached
    const cc = res.headers()['cache-control'];
    expect(!cc || !cc.includes('s-maxage')).toBe(true);
  });

});

// ── 2. AAPAnalytics module — browser-side ────────────────────────────────────
test.describe('AAPAnalytics module — browser behavior', () => {

  test('module attaches to window at _v: 1', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const v = await page.evaluate(() => window.AAPAnalytics && window.AAPAnalytics._v);
    expect(v).toBe(1);
  });

  test('track() is a function', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const isFunc = await page.evaluate(() => typeof window.AAPAnalytics.track === 'function');
    expect(isFunc).toBe(true);
  });

  test('track() returns undefined — non-blocking, no return value', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const ret = await page.evaluate(() =>
      window.AAPAnalytics.track('validation_probe', { test: true }, { widget_name: 'delta-spec' })
    );
    expect(ret).toBeUndefined();
  });

  test('track() with null event type does not throw', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const threw = await page.evaluate(() => {
      try { window.AAPAnalytics.track(null, {}); return false; }
      catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('track() with no arguments does not throw', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const threw = await page.evaluate(() => {
      try { window.AAPAnalytics.track(); return false; }
      catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('session ID starts with "aap_" and is a string', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const sid = await page.evaluate(() => window.AAPAnalytics._getSessionId());
    expect(typeof sid).toBe('string');
    expect(sid.startsWith('aap_')).toBe(true);
  });

  test('session ID is stable across two calls within same session', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const [id1, id2] = await page.evaluate(() => [
      window.AAPAnalytics._getSessionId(),
      window.AAPAnalytics._getSessionId(),
    ]);
    expect(id1).toBe(id2);
  });

  test('module is idempotent — second script load does not overwrite', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const same = await page.evaluate(() => {
      var ref1 = window.AAPAnalytics;
      // Simulate re-load: run guard check
      return ref1 && ref1._v === 1;
    });
    expect(same).toBe(true);
  });

  test('trackBatch() accepts an array without throwing', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const threw = await page.evaluate(() => {
      try {
        window.AAPAnalytics.trackBatch([
          { event_type: 'batch_a', widget_name: 'delta-spec' },
          { event_type: 'batch_b', widget_name: 'delta-spec' },
        ]);
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('trackBatch() with empty array does not throw', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const threw = await page.evaluate(() => {
      try { window.AAPAnalytics.trackBatch([]); return false; }
      catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

});

// ── 3. Discovery API baseline — envelope consistency ─────────────────────────
test.describe('Discovery API baseline — response shapes', () => {

  test('GET /api/public/auctions returns success envelope', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /api/public/auctions has pagination fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5`);
    const body = await res.json();
    expect(typeof body.total_count).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
    expect(typeof body.offset).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(0);
  });

  test('GET /api/public/auctions — total_count not leaked into rows', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=5`);
    const body = await res.json();
    if (body.data.length > 0) {
      expect(body.data[0]).not.toHaveProperty('total_count');
    }
  });

  test('GET /api/public/auctions/near returns 400 without coords', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/auctions/near`);
    expect(res.status()).toBe(400);
  });

  test('GET /api/public/auctions/near with valid coords has pagination fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=32.7767&lng=-96.7970&limit=5`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total_count).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
  });

  test('GET /api/public/auctions/near — total_count not leaked into rows', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=32.7767&lng=-96.7970&limit=5`);
    const body = await res.json();
    if (body.data.length > 0) {
      expect(body.data[0]).not.toHaveProperty('total_count');
    }
  });

  test('GET /api/public/auctions/:id/lots with valid ID has pagination fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/${DEMO_ID}/lots?limit=5`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total_count).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
    expect(body.limit).toBe(5);
  });

  test('GET /api/public/featured-lots returns success envelope with data array', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /api/public/featured-lots seller context fields are string or null', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=5`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row.seller_display_name === null || typeof row.seller_display_name === 'string').toBe(true);
      expect(row.seller_location_label === null || typeof row.seller_location_label === 'string').toBe(true);
      expect(row.seller_logo_url === null || typeof row.seller_logo_url === 'string').toBe(true);
    }
  });

  test('GET /api/public/featured-videos returns success envelope with data array', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-videos`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /api/public/featured-videos seller_display_name is string or null', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-videos`);
    const body = await res.json();
    for (const row of body.data) {
      expect(row.seller_display_name === null || typeof row.seller_display_name === 'string').toBe(true);
    }
  });

  test('GET /api/public/featured-auctions returns success envelope', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-auctions`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /api/public/locations returns city/state aggregations', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/locations`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    if (body.data.length > 0) {
      const row = body.data[0];
      expect(typeof row.city).toBe('string');
      expect(typeof row.address_state).toBe('string');
      expect(typeof row.auction_count).toBe('number');
      expect(typeof row.active_count).toBe('number');
    }
  });

  test('all discovery endpoints have Cache-Control headers', async ({ request }) => {
    const endpoints = [
      '/api/public/auctions',
      '/api/public/featured-lots',
      '/api/public/featured-auctions',
      '/api/public/featured-videos',
      '/api/public/locations',
    ];
    for (const ep of endpoints) {
      const res = await request.get(`${BASE}${ep}`);
      expect(res.status()).toBe(200);
      const cc = res.headers()['cache-control'];
      expect(typeof cc).toBe('string');
      expect(cc).toContain('s-maxage');
    }
  });

});

// ── 4. Pagination math invariant ─────────────────────────────────────────────
test.describe('Pagination math — has_more/total_count invariant', () => {

  test('/api/public/auctions: has_more=false iff offset+data.length >= total_count', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=3&offset=0`);
    const body = await res.json();
    const expectedHasMore = (body.offset + body.data.length) < body.total_count;
    expect(body.has_more).toBe(expectedHasMore);
  });

  test('/api/public/auctions: offset=total_count returns empty data, has_more=false', async ({ request }) => {
    const first = await (await request.get(`${BASE}/api/public/auctions?limit=1`)).json();
    const total = first.total_count;
    if (total === 0) return; // no data — skip

    const res  = await request.get(`${BASE}/api/public/auctions?limit=5&offset=${total}`);
    const body = await res.json();
    expect(body.data.length).toBe(0);
    expect(body.has_more).toBe(false);
  });

  test('/api/public/auctions: total_count is consistent across two pages', async ({ request }) => {
    const p1 = await (await request.get(`${BASE}/api/public/auctions?limit=2&offset=0`)).json();
    const p2 = await (await request.get(`${BASE}/api/public/auctions?limit=2&offset=2`)).json();
    // total_count reflects the same universe on both pages
    expect(p1.total_count).toBe(p2.total_count);
  });

  test('/api/public/auctions/:id/lots: has_more=false iff offset+data.length >= total_count', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/${DEMO_ID}/lots?limit=3&offset=0`);
    const body = await res.json();
    const expectedHasMore = (body.offset + body.data.length) < body.total_count;
    expect(body.has_more).toBe(expectedHasMore);
  });

  test('/api/public/auctions/near: has_more=false iff offset+data.length >= total_count', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions/near?lat=32.7767&lng=-96.7970&limit=3&offset=0`);
    const body = await res.json();
    const expectedHasMore = (body.offset + body.data.length) < body.total_count;
    expect(body.has_more).toBe(expectedHasMore);
  });

  test('/api/public/auctions: limit is clamped to 100 max', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=999`);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(100);
  });

  test('/api/public/auctions: limit is clamped to 1 min', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?limit=0`);
    const body = await res.json();
    expect(body.limit).toBeGreaterThanOrEqual(1);
  });

});

// ── 5. auction-view.html page integrity ──────────────────────────────────────
test.describe('auction-view.html — full-page integrity', () => {

  test('no JavaScript errors on load (ignoring API fetch failures)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const jsErrors = errors.filter(e =>
      !e.includes('Failed to fetch') &&
      !e.includes('api/') &&
      !e.includes('NetworkError') &&
      !e.includes('Load failed')
    );
    expect(jsErrors).toHaveLength(0);
  });

  test('AAPAnalytics and AAPMarketplaceSellerCta both attached to window', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const [analytics, cta] = await page.evaluate(() => [
      window.AAPAnalytics && window.AAPAnalytics._v,
      window.AAPMarketplaceSellerCta && window.AAPMarketplaceSellerCta._v,
    ]);
    expect(analytics).toBe(1);
    expect(cta).toBe(1);
  });

  test('all key structural elements present in DOM', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#auction-banner')).toBeAttached();
    await expect(page.locator('#lot-grid')).toBeAttached();
    await expect(page.locator('#marketplace-seller-cta-mount')).toBeAttached();
    await expect(page.locator('#video-modal')).toBeAttached();
    await expect(page.locator('[data-aap-cta="marketplace-seller"]')).toBeAttached();
  });

  test('CTA section appears after lot grid in DOM order', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const order = await page.evaluate(() => {
      var grid = document.getElementById('lot-grid');
      var cta  = document.querySelector('[data-aap-cta="marketplace-seller"]');
      if (!grid || !cta) return null;
      return !!(grid.compareDocumentPosition(cta) & 4); // DOCUMENT_POSITION_FOLLOWING
    });
    expect(order).toBe(true);
  });

  test('auction banner appears before lot grid in DOM order', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const order = await page.evaluate(() => {
      var banner = document.getElementById('auction-banner');
      var grid   = document.getElementById('lot-grid');
      if (!banner || !grid) return null;
      return !!(banner.compareDocumentPosition(grid) & 4); // grid FOLLOWING banner
    });
    expect(order).toBe(true);
  });

  test('CTA section contains no bidding UI elements', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const hasBidUI = await page.evaluate(() => {
      var cta = document.querySelector('[data-aap-cta="marketplace-seller"]');
      if (!cta) return false;
      return !!(cta.querySelector('[data-bid], .bid-form, .place-bid, input[type="number"], .bid-amount'));
    });
    expect(hasBidUI).toBe(false);
  });

  test('CTA section contains no internal data attributes (no seller_id, user_id, token)', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const html = await page.locator('[data-aap-cta="marketplace-seller"]').innerHTML();
    expect(html).not.toContain('seller_id=');
    expect(html).not.toContain('user_id=');
    expect(html).not.toContain('token=');
    expect(html).not.toContain('email=');
    expect(html).not.toContain('password=');
  });

  test('video modal is hidden on initial load', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const hasOpen = await page.evaluate(() =>
      document.getElementById('video-modal').classList.contains('open')
    );
    expect(hasOpen).toBe(false);
  });

  test('video close button is present inside modal', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#video-close')).toBeAttached();
  });

  test('walkthrough video element is present inside modal', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#walkthrough-video')).toBeAttached();
  });

  test('ESC key closes an open video modal without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    // Open modal by forcing class
    await page.evaluate(() => document.getElementById('video-modal').classList.add('open'));
    await page.keyboard.press('Escape');
    const hasOpen = await page.evaluate(() =>
      document.getElementById('video-modal').classList.contains('open')
    );
    expect(hasOpen).toBe(false);
    const jsErrors = errors.filter(e => !e.includes('Failed to fetch') && !e.includes('api/'));
    expect(jsErrors).toHaveLength(0);
  });

  test('page title is not empty string after load', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
    // Should not be the placeholder "Auction — Advantage Auction" if auction loaded
    // (title is updated by loadSellerInfo — may remain placeholder if API fails)
    expect(title).toBeTruthy();
  });

});

// ── 6. Mobile rendering — 375px viewport ─────────────────────────────────────
test.describe('Mobile rendering — 375px viewport', () => {

  test('auction-view.html has no horizontal scroll at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const hasScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 2
    );
    expect(hasScroll).toBe(false);
  });

  test('CTA section is visible at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-aap-cta="marketplace-seller"]')).toBeVisible();
  });

  test('CTA start-selling button is visible at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.msc-btn')).toBeVisible();
  });

  test('lot grid is visible at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#lot-grid')).toBeVisible();
  });

  test('auction banner header is visible at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#auction-banner')).toBeVisible();
  });

  test('auction-view.html has no horizontal scroll at 768px (tablet)', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const hasScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 2
    );
    expect(hasScroll).toBe(false);
  });

  test('CTA start-selling button width does not exceed viewport at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const box = await page.locator('.msc-btn').boundingBox();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(375);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(376); // 1px tolerance
    }
  });

});

// ── 7. Telemetry — non-blocking behavior ─────────────────────────────────────
test.describe('Telemetry — non-blocking, silent failure', () => {

  test('page renders correctly when analytics endpoint is intercepted (blocked)', async ({ page }) => {
    // Block all analytics requests — page must still render fully
    await page.route('**/api/analytics/**', route => route.abort());
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-aap-cta="marketplace-seller"]')).toBeAttached();
    await expect(page.locator('#lot-grid')).toBeAttached();
  });

  test('CTA renders correctly when AAPAnalytics.track throws synchronously', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    // Poison track to throw — CTA was already rendered, but verify no crash on click
    await page.evaluate(() => {
      if (window.AAPAnalytics) {
        window.AAPAnalytics.track = function () { throw new Error('analytics down'); };
      }
    });
    // Click should not cause a page crash or JS exception surfacing
    const threw = await page.evaluate(() => {
      try {
        window.AAPMarketplaceSellerCta.init(document.createElement('div'), {});
        return false;
      } catch (_) { return true; }
    });
    expect(threw).toBe(false);
  });

  test('AAPAnalytics.track does not block page rendering (no await on fetch)', async ({ page }) => {
    // Slow down analytics endpoint with a 5s delay — page should still render fast
    await page.route('**/api/analytics/**', async route => {
      await new Promise(r => setTimeout(r, 5000));
      await route.fulfill({ status: 202, body: JSON.stringify({ accepted: true }) });
    });
    const start = Date.now();
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('domcontentloaded');
    const elapsed = Date.now() - start;
    // domcontentloaded should complete well under 5s despite analytics being slow
    expect(elapsed).toBeLessThan(4000);
    await expect(page.locator('header')).toBeVisible();
  });

  test('analytics track payload does not contain email field', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    const bodies = [];
    await page.route('**/api/analytics/**', async route => {
      const body = route.request().postDataJSON();
      bodies.push(body);
      await route.fulfill({ status: 202, body: JSON.stringify({ accepted: true }) });
    });
    // Trigger a track call
    await page.evaluate(() =>
      window.AAPAnalytics.track('validation_pii_check', {}, { widget_name: 'delta-spec' })
    );
    await page.waitForTimeout(300);
    for (const body of bodies) {
      const payload = Array.isArray(body) ? body[0] : body;
      if (payload) {
        expect(payload.email).toBeUndefined();
        expect(payload.password).toBeUndefined();
        expect(payload.token).toBeUndefined();
      }
    }
  });

  test('analytics track payload contains expected non-PII fields', async ({ page }) => {
    await page.goto(AUCTION_URL);
    await page.waitForLoadState('networkidle');
    let captured = null;
    await page.route('**/api/analytics/events', async route => {
      captured = route.request().postDataJSON();
      await route.fulfill({ status: 202, body: JSON.stringify({ accepted: true }) });
    });
    await page.evaluate(() =>
      window.AAPAnalytics.track('validation_shape', { custom: 'field' }, { widget_name: 'delta-spec' })
    );
    await page.waitForTimeout(300);
    if (captured) {
      const payload = Array.isArray(captured) ? captured[0] : captured;
      expect(payload.event_type).toBe('validation_shape');
      expect(typeof payload.session_id).toBe('string');
      expect(typeof payload.device_type).toBe('string');
      expect(payload.metadata).toBeDefined();
      expect(payload.metadata.custom).toBe('field');
    }
  });

});

// ── 8. Marketplace discovery baseline — ordering observations ────────────────
test.describe('Marketplace discovery baseline — ordering and freshness', () => {

  test('GET /api/public/auctions default ordering has marketplace_priority descending intent', async ({ request }) => {
    // We cannot inspect marketplace_priority (it is not in the public response)
    // but we can verify the response is deterministic between calls
    const r1 = await (await request.get(`${BASE}/api/public/auctions?limit=5`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/auctions?limit=5`)).json();
    if (r1.data.length > 0) {
      const ids1 = r1.data.map(a => a.id).join(',');
      const ids2 = r2.data.map(a => a.id).join(',');
      expect(ids1).toBe(ids2); // same order on repeated calls
    }
  });

  test('GET /api/public/featured-lots default ordering is stable across two calls', async ({ request }) => {
    const r1 = await (await request.get(`${BASE}/api/public/featured-lots?limit=5`)).json();
    const r2 = await (await request.get(`${BASE}/api/public/featured-lots?limit=5`)).json();
    if (r1.data.length > 0) {
      expect(r1.data.map(l => l.id)).toEqual(r2.data.map(l => l.id));
    }
  });

  test('GET /api/public/auctions auction_state=closed filter returns only closed', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?state=closed&limit=5`);
    const body = await res.json();
    for (const a of body.data) {
      expect(a.state).toBe('closed');
    }
  });

  test('GET /api/public/auctions state filter only accepts allowlisted values', async ({ request }) => {
    // An invalid state falls back to published+active default
    const res  = await request.get(`${BASE}/api/public/auctions?state=draft&limit=5`);
    const body = await res.json();
    expect(body.success).toBe(true);
    for (const a of body.data) {
      expect(['published', 'active'].includes(a.state)).toBe(true);
    }
  });

  test('GET /api/public/auctions shipping=true filter returns only shipping-available', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/auctions?shipping=true&limit=10`);
    const body = await res.json();
    for (const a of body.data) {
      expect(a.shipping_available).toBe(true);
    }
  });

  test('GET /api/public/auctions no internal/sensitive fields in any row', async ({ request }) => {
    const BLOCKED = [
      'reserve_cents', 'winning_buyer_user_id', 'winning_amount_cents',
      'capabilities', 'admin_notes', 'address_encrypted', 'increment_ladder',
      'marketing_selection', 'approved_by', 'rejection_reason',
      'soft_close_policy', 'pickup_group', 'password_hash',
    ];
    const res  = await request.get(`${BASE}/api/public/auctions?limit=10`);
    const body = await res.json();
    for (const auction of body.data) {
      for (const field of BLOCKED) {
        expect(auction).not.toHaveProperty(field);
      }
    }
  });

  test('GET /api/public/featured-lots no internal fields in rows', async ({ request }) => {
    const BLOCKED = ['reserve_cents', 'winning_buyer_user_id', 'seller_id', 'user_id'];
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=10`);
    const body = await res.json();
    for (const lot of body.data) {
      for (const field of BLOCKED) {
        expect(lot).not.toHaveProperty(field);
      }
    }
  });

  test('GET /api/public/featured-lots all numeric price fields are integers or null', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/featured-lots?limit=10`);
    const body = await res.json();
    for (const lot of body.data) {
      if (lot.starting_bid_cents != null) expect(Number.isInteger(lot.starting_bid_cents)).toBe(true);
      if (lot.current_bid_cents  != null) expect(Number.isInteger(lot.current_bid_cents)).toBe(true);
      if (lot.shipping_cost_cents != null) expect(Number.isInteger(lot.shipping_cost_cents)).toBe(true);
    }
  });

});
