'use strict';

/**
 * e2e/charlie-bd-marketplace-config.spec.js
 *
 * Validates the Marketplace Configuration Infrastructure (Charlie-BD cycle 3):
 *
 *   Phase A — DB Schema: platform_settings, widget_settings, marketing_packages
 *   Phase B — Admin Config API: /api/admin/config/*  (role-gated)
 *             Public Config API: /api/public/config  (open, allowlisted keys only)
 *   Phase C — AAPConfig.loadRemote(): cache TTL, local override preservation,
 *             namespace-aware merge, graceful fallback
 *   Phase D — Admin demo page: /admin/marketplace-config.html
 *
 * Validation requirements:
 *   - Role enforcement (401/403 for non-admin)
 *   - Public/private separation (no secret or internal fields in public response)
 *   - No pricing/ranking weights in public config
 *   - Config update persistence (PATCH then GET)
 *   - Widget remote-config loading via AAPConfig.loadRemote()
 *   - Cache TTL behaviour
 *   - Local override preservation across loadRemote()
 *   - XSS safety (malicious values in config remain inert)
 *   - Accessibility (form labels, headings, tablist)
 *   - Fallback behaviour (server down, non-200, bad JSON)
 *   - Mobile rendering
 *   - Multi-widget coexistence
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const ADMIN_CREDS = { email: 'validation-admin@advantage.bid', password: 'ValidationAdmin2025!' };
const BUYER_CREDS = { email: 'validation-buyer@advantage.bid', password: 'ValidationBuyer2025!' };

// Module-level tokens — populated in setup test
let adminToken = null;
let buyerToken  = null;

async function login(request, creds) {
  const res  = await request.post(`${BASE}/api/auth/login`, { data: creds });
  const body = await res.json();
  return body.token || null;
}

// Keys that MUST NOT appear in any public config response
const PRIVATE_KEYS = [
  'marketplace.ranking.priority_weight',
  'marketplace.ranking.recency_weight',
  'stripe',
  'payment',
  'secret',
  'internal',
  'admin_',
];

function assertNoPrivateKeys(obj, label) {
  for (const forbidden of PRIVATE_KEYS) {
    for (const key of Object.keys(obj)) {
      expect(key.toLowerCase(), `${label} must not expose "${key}"`).not.toContain(forbidden.toLowerCase());
    }
  }
}

// ─── Setup (serial) ──────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

test('setup: authenticate tokens', async ({ request }) => {
  [adminToken, buyerToken] = await Promise.all([
    login(request, ADMIN_CREDS),
    login(request, BUYER_CREDS),
  ]);
  expect(adminToken, 'admin token must be present').toBeTruthy();
  expect(buyerToken, 'buyer token must be present').toBeTruthy();
});

// ─── Phase B — Role Enforcement ──────────────────────────────────────────────

test.describe('Role enforcement — admin config endpoints', () => {

  test('GET /api/admin/config/platform returns 401 without token', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/platform`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/admin/config/platform returns 403 for buyer', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    });
    expect(res.status()).toBe(403);
  });

  test('PATCH /api/admin/config/platform returns 401 without token', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/platform`, {
      data: { 'marketplace.badge.live': 'TEST' },
    });
    expect(res.status()).toBe(401);
  });

  test('PATCH /api/admin/config/platform returns 403 for buyer', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
      data: { 'marketplace.badge.live': 'TEST' },
    });
    expect(res.status()).toBe(403);
  });

  test('GET /api/admin/config/packages returns 401 without token', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/packages`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/admin/config/widgets returns 403 for buyer', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/widgets`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    });
    expect(res.status()).toBe(403);
  });

});

// ─── Phase B — GET /api/admin/config/platform ────────────────────────────────

test.describe('GET /api/admin/config/platform', () => {

  test('returns 200 with valid admin token', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeTruthy();
  });

  test('response contains expected marketplace keys', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = await res.json();
    const keys = Object.keys(body.data);
    expect(keys).toContain('marketplace.badge.live');
    expect(keys).toContain('marketplace.badge.upcoming');
    expect(keys).toContain('marketplace.cta.headline');
    expect(keys).toContain('marketplace.homepage.featured_limit');
  });

  test('each entry has value, description, and updated_at fields', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = await res.json();
    const first = body.data['marketplace.badge.live'];
    expect(first).toHaveProperty('value');
    expect(first).toHaveProperty('description');
    expect(first).toHaveProperty('updated_at');
  });

  test('does not expose ranking weights in admin list (they are admin-only, but must be documented)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = await res.json();
    // Ranking weights ARE on the admin allowlist — confirm they appear for admin
    expect(Object.keys(body.data)).toContain('marketplace.ranking.priority_weight');
  });

});

// ─── Phase B — PATCH /api/admin/config/platform ──────────────────────────────

test.describe('PATCH /api/admin/config/platform', () => {

  test('updates a badge label and reflects in subsequent GET', async ({ request }) => {
    const testValue = 'LIVE-TEST-' + Date.now();
    const patch = await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'marketplace.badge.live': testValue },
    });
    expect(patch.status()).toBe(200);
    const patchBody = await patch.json();
    expect(patchBody.success).toBe(true);
    expect(patchBody.updated).toContain('marketplace.badge.live');

    const get = await request.get(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const getBody = await get.json();
    expect(getBody.data['marketplace.badge.live'].value).toBe(testValue);

    // Restore original value
    await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'marketplace.badge.live': 'LIVE NOW' },
    });
  });

  test('returns 400 when body contains no valid keys', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'stripe.secret_key': 'sk_live_xxx', 'internal.foo': 'bar' },
    });
    expect(res.status()).toBe(400);
  });

  test('silently ignores non-allowlisted keys — only writes valid ones', async ({ request }) => {
    const testValue = 'UPCOMING-TEST-' + Date.now();
    const res = await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        'marketplace.badge.upcoming': testValue,
        'internal.secret':           'should-be-ignored',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.updated).toContain('marketplace.badge.upcoming');
    expect(body.updated).not.toContain('internal.secret');

    // Restore
    await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'marketplace.badge.upcoming': 'UPCOMING' },
    });
  });

  test('returns 400 with non-object body', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: ['not', 'an', 'object'],
    });
    expect(res.status()).toBe(400);
  });

});

// ─── Phase B — Widget Settings ────────────────────────────────────────────────

test.describe('Widget settings API', () => {

  test('GET /api/admin/config/widgets returns seeded widget records', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/widgets`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const slugs = body.data.map(w => w.widget_slug);
    expect(slugs).toContain('featured-lots');
    expect(slugs).toContain('featured-near-you');
  });

  test('PATCH /api/admin/config/widgets/:slug merges widget.limit', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/widgets/featured-lots`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'widget.limit': 8 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.settings['widget.limit']).toBe(8);

    // Restore
    await request.patch(`${BASE}/api/admin/config/widgets/featured-lots`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'widget.limit': 6 },
    });
  });

  test('PATCH /api/admin/config/widgets returns 400 for non-widget.* keys', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/widgets/featured-lots`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'marketplace.badge.live': 'HACK' },
    });
    expect(res.status()).toBe(400);
  });

  test('PATCH /api/admin/config/widgets returns 404 for unknown slug', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/widgets/unknown-widget`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'widget.limit': 4 },
    });
    expect(res.status()).toBe(404);
  });

});

// ─── Phase B — Marketing Packages ────────────────────────────────────────────

test.describe('Marketing packages API', () => {

  test('GET /api/admin/config/packages returns seeded packages', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(3);
    const names = body.data.map(p => p.name);
    expect(names).toContain('Basic Listing');
    expect(names).toContain('Featured Placement');
    expect(names).toContain('Premium Marketing');
  });

  test('each package has required fields', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/config/packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = await res.json();
    const pkg = body.data[0];
    expect(pkg).toHaveProperty('id');
    expect(pkg).toHaveProperty('name');
    expect(pkg).toHaveProperty('price_cents');
    expect(pkg).toHaveProperty('features');
    expect(pkg).toHaveProperty('is_active');
    expect(pkg).toHaveProperty('display_order');
    expect(typeof pkg.price_cents).toBe('number');
    expect(Array.isArray(pkg.features)).toBe(true);
  });

  test('POST /api/admin/config/packages creates a new package', async ({ request }) => {
    const res = await request.post(`${BASE}/api/admin/config/packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name:        'Test Package ' + Date.now(),
        price_cents: 4900,
        features:    ['Feature A', 'Feature B'],
        display_order: 99,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBeTruthy();
    expect(body.data.price_cents).toBe(4900);
    expect(body.data.is_active).toBe(true);

    // PATCH the created package to deactivate (cleanup)
    await request.patch(`${BASE}/api/admin/config/packages/${body.data.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { is_active: false },
    });
  });

  test('POST /api/admin/config/packages returns 400 with missing name', async ({ request }) => {
    const res = await request.post(`${BASE}/api/admin/config/packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { price_cents: 4900 },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/admin/config/packages returns 400 with negative price', async ({ request }) => {
    const res = await request.post(`${BASE}/api/admin/config/packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: 'Bad', price_cents: -100 },
    });
    expect(res.status()).toBe(400);
  });

  test('PATCH /api/admin/config/packages/:id updates package name', async ({ request }) => {
    // Create then update
    const create = await request.post(`${BASE}/api/admin/config/packages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: 'Temp Package', price_cents: 0 },
    });
    const id = (await create.json()).data.id;

    const patch = await request.patch(`${BASE}/api/admin/config/packages/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: 'Updated Package', price_cents: 1999 },
    });
    expect(patch.status()).toBe(200);
    const body = await patch.json();
    expect(body.data.name).toBe('Updated Package');
    expect(body.data.price_cents).toBe(1999);

    // Deactivate (cleanup)
    await request.patch(`${BASE}/api/admin/config/packages/${id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { is_active: false },
    });
  });

  test('PATCH /api/admin/config/packages/:id returns 404 for unknown id', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/packages/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: 'Ghost' },
    });
    expect(res.status()).toBe(404);
  });

});

// ─── Phase B — Public Config Endpoint ────────────────────────────────────────

test.describe('GET /api/public/config', () => {

  test('returns 200 without auth token', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeTruthy();
  });

  test('has Cache-Control header', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/config`);
    const cc  = res.headers()['cache-control'] || '';
    expect(cc).toContain('s-maxage');
  });

  test('contains expected public marketplace keys', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/config`);
    const body = await res.json();
    const keys = Object.keys(body.data);
    expect(keys).toContain('marketplace.badge.live');
    expect(keys).toContain('marketplace.badge.upcoming');
    expect(keys).toContain('marketplace.cta.headline');
    expect(keys).toContain('marketplace.homepage.featured_limit');
  });

  test('does NOT expose ranking weights in public response', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/config`);
    const body = await res.json();
    assertNoPrivateKeys(body.data, 'GET /api/public/config');
    expect(Object.keys(body.data)).not.toContain('marketplace.ranking.priority_weight');
    expect(Object.keys(body.data)).not.toContain('marketplace.ranking.recency_weight');
  });

  test('does NOT expose widget slug or internal fields', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/config`);
    const body = await res.json();
    const keys = Object.keys(body.data);
    const forbidden = ['widget.', 'analytics.', 'stripe', 'secret', 'payment'];
    for (const f of forbidden) {
      const leaked = keys.filter(k => k.toLowerCase().includes(f.toLowerCase()));
      expect(leaked, `Public config must not expose keys matching "${f}"`).toHaveLength(0);
    }
  });

  test('config update via admin is reflected in subsequent public response', async ({ request }) => {
    const uniqueLabel = 'Ends-' + Date.now();
    await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'marketplace.badge.ending_soon': uniqueLabel },
    });

    const pub = await request.get(`${BASE}/api/public/config`);
    const body = await pub.json();
    expect(body.data['marketplace.badge.ending_soon']).toBe(uniqueLabel);

    // Restore
    await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'marketplace.badge.ending_soon': 'Ending Soon' },
    });
  });

});

// ─── Phase B — Public Widget Config Endpoint ─────────────────────────────────

test.describe('GET /api/public/config/widgets/:slug', () => {

  test('returns 200 for featured-lots without auth', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/config/widgets/featured-lots`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.widget_slug).toBe('featured-lots');
    expect(body.data.settings).toBeTruthy();
  });

  test('returns 200 for featured-near-you without auth', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/public/config/widgets/featured-near-you`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.widget_slug).toBe('featured-near-you');
  });

  test('returns 404 for unknown widget slug', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/config/widgets/unknown-widget`);
    expect(res.status()).toBe(404);
  });

  test('has Cache-Control header', async ({ request }) => {
    const res = await request.get(`${BASE}/api/public/config/widgets/featured-lots`);
    const cc  = res.headers()['cache-control'] || '';
    expect(cc).toContain('s-maxage');
  });

});

// ─── Phase C — AAPConfig.loadRemote() ────────────────────────────────────────

const CONFIG_JS_URL   = `${BASE}/widgets/shared/config.js`;

function makeRemoteHtml(extraScript) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<script src="${CONFIG_JS_URL}"></script>
<script>${extraScript || ''}</script>
</body></html>`;
}

test.describe('AAPConfig.loadRemote() — basic loading', () => {

  test('loads remote config and merges into store', async ({ page }) => {
    const remoteData = { 'marketplace.badge.live': 'REMOTE-LIVE', 'marketplace.cta.label': 'Remote CTA' };
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: remoteData }) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__result = AAPConfig.get('marketplace.badge.live');
        window.__cta    = AAPConfig.get('marketplace.cta.label');
        window.__done   = true;
      });
    `));

    await page.waitForFunction(() => window.__done === true);
    const result = await page.evaluate(() => ({ r: window.__result, c: window.__cta }));
    expect(result.r).toBe('REMOTE-LIVE');
    expect(result.c).toBe('Remote CTA');
  });

  test('handles { success: true, data: {...} } response envelope', async ({ page }) => {
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { 'marketplace.badge.upcoming': 'ENVELOPED' } }) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__result = AAPConfig.get('marketplace.badge.upcoming');
        window.__done   = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    expect(await page.evaluate(() => window.__result)).toBe('ENVELOPED');
  });

  test('only merges marketplace.*, widget.*, analytics.* keys (namespace guard)', async ({ page }) => {
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            'marketplace.badge.live': 'SAFE',
            'internal.secret':        'LEAKED',
            'stripe.key':             'LEAKED',
          },
        }) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__safe   = AAPConfig.get('marketplace.badge.live');
        window.__leaked = AAPConfig.get('internal.secret');
        window.__done   = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    const { safe, leaked } = await page.evaluate(() => ({ safe: window.__safe, leaked: window.__leaked }));
    expect(safe).toBe('SAFE');
    expect(leaked).toBeNull();
  });

});

test.describe('AAPConfig.loadRemote() — local override preservation', () => {

  test('set() values survive loadRemote() — remote does not clobber them', async ({ page }) => {
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { 'marketplace.badge.live': 'REMOTE' } }) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.set('marketplace.badge.live', 'LOCAL-OVERRIDE');
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__result = AAPConfig.get('marketplace.badge.live');
        window.__done   = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    expect(await page.evaluate(() => window.__result)).toBe('LOCAL-OVERRIDE');
  });

  test('dumpOverrides() returns only explicitly set keys', async ({ page }) => {
    await page.setContent(makeRemoteHtml(`
      AAPConfig.reset();
      AAPConfig.set({ 'marketplace.badge.live': 'OV1', 'marketplace.cta.label': 'OV2' });
      window.__overrides = AAPConfig.dumpOverrides();
    `));
    const overrides = await page.evaluate(() => window.__overrides);
    expect(overrides['marketplace.badge.live']).toBe('OV1');
    expect(overrides['marketplace.cta.label']).toBe('OV2');
    expect(Object.keys(overrides).length).toBe(2);
  });

  test('non-overridden keys ARE updated by remote', async ({ page }) => {
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {
          'marketplace.badge.live':     'REMOTE-LIVE',
          'marketplace.badge.upcoming': 'REMOTE-UPCOMING',
        }}) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.reset();
      AAPConfig.set('marketplace.badge.live', 'LOCAL');  // override only live badge
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__live     = AAPConfig.get('marketplace.badge.live');
        window.__upcoming = AAPConfig.get('marketplace.badge.upcoming');
        window.__done     = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    const res = await page.evaluate(() => ({ live: window.__live, upcoming: window.__upcoming }));
    expect(res.live).toBe('LOCAL');           // local override preserved
    expect(res.upcoming).toBe('REMOTE-UPCOMING'); // remote applied
  });

});

test.describe('AAPConfig.loadRemote() — graceful fallback', () => {

  test('resolves without throwing when server returns 404', async ({ page }) => {
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 404, body: 'Not found' });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__live = AAPConfig.get('marketplace.badge.live');
        window.__done = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    // Should have fallen back to platform default
    expect(await page.evaluate(() => window.__live)).toBe('LIVE NOW');
  });

  test('resolves without throwing when fetch fails (network error)', async ({ page }) => {
    await page.route('**/api/public/config', route => route.abort());

    await page.setContent(makeRemoteHtml(`
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__done = true;
      }).catch(function() {
        window.__caught = true;
        window.__done   = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    // Promise must resolve (not reject)
    expect(await page.evaluate(() => window.__caught)).toBeUndefined();
  });

  test('resolves without throwing when response is invalid JSON', async ({ page }) => {
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: 'not valid json}' });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__done = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    expect(await page.evaluate(() => window.__done)).toBe(true);
  });

  test('widgets continue working with defaults when remote is unavailable', async ({ page }) => {
    await page.route('**/api/public/config', route => route.abort());

    await page.setContent(makeRemoteHtml(`
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__limit = AAPConfig.get('widget.limit');
        window.__live  = AAPConfig.get('marketplace.badge.live');
        window.__done  = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    const res = await page.evaluate(() => ({ limit: window.__limit, live: window.__live }));
    expect(res.limit).toBe(6);
    expect(res.live).toBe('LIVE NOW');
  });

});

test.describe('AAPConfig.loadRemote() — cache TTL', () => {

  test('cache is used on second call (request only made once)', async ({ page }) => {
    let fetchCount = 0;
    await page.route('**/api/public/config', route => {
      fetchCount++;
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { 'marketplace.badge.live': 'CACHED' } }) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.reset();
      AAPConfig.loadRemote('/api/public/config', { cacheTtlSeconds: 60 }).then(function() {
        // Second call — should use cache
        return AAPConfig.loadRemote('/api/public/config', { cacheTtlSeconds: 60 });
      }).then(function() {
        window.__done = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    expect(fetchCount).toBe(1);
  });

  test('bypassCache: true forces a fresh fetch even if cache is warm', async ({ page }) => {
    let fetchCount = 0;
    await page.route('**/api/public/config', route => {
      fetchCount++;
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { 'marketplace.badge.live': 'FRESH' } }) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.reset();
      AAPConfig.loadRemote('/api/public/config', { cacheTtlSeconds: 3600 }).then(function() {
        return AAPConfig.loadRemote('/api/public/config', { cacheTtlSeconds: 3600, bypassCache: true });
      }).then(function() {
        window.__done = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    expect(fetchCount).toBe(2);
  });

  test('invalidateCache() clears the localStorage cache', async ({ page }) => {
    let fetchCount = 0;
    await page.route('**/api/public/config', route => {
      fetchCount++;
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { 'marketplace.badge.live': 'INV' } }) });
    });

    await page.setContent(makeRemoteHtml(`
      AAPConfig.reset();
      AAPConfig.loadRemote('/api/public/config', { cacheTtlSeconds: 3600 }).then(function() {
        AAPConfig.invalidateCache();
        return AAPConfig.loadRemote('/api/public/config', { cacheTtlSeconds: 3600 });
      }).then(function() {
        window.__done = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    expect(fetchCount).toBe(2);
  });

});

// ─── Phase D — Admin Demo Page ────────────────────────────────────────────────

test.describe('Admin demo page — /admin/marketplace-config.html', () => {

  async function loadAdminPage(page) {
    // Mock auth check — inject token into page context before navigation
    await page.addInitScript(token => {
      localStorage.setItem('token', token);
    }, adminToken);

    // Mock API responses to avoid dependency on live DB state for UI tests
    await page.route('**/api/admin/config/platform', route => {
      if (route.request().method() === 'GET') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          success: true,
          data: {
            'marketplace.badge.live':           { value: 'LIVE NOW', description: 'Status badge for active auctions', updated_at: new Date().toISOString() },
            'marketplace.badge.upcoming':       { value: 'UPCOMING', description: '', updated_at: new Date().toISOString() },
            'marketplace.badge.ships':          { value: 'Ships nationwide', description: '', updated_at: new Date().toISOString() },
            'marketplace.badge.ending_soon':    { value: 'Ending Soon', description: '', updated_at: new Date().toISOString() },
            'marketplace.badge.ending_soon_threshold_min': { value: 120, description: '', updated_at: new Date().toISOString() },
            'marketplace.cta.url':              { value: null, description: '', updated_at: new Date().toISOString() },
            'marketplace.cta.headline':         { value: 'Consigning an Estate?', description: '', updated_at: new Date().toISOString() },
            'marketplace.cta.label':            { value: 'Learn More', description: '', updated_at: new Date().toISOString() },
            'marketplace.cta.subtext':          { value: 'We auction...', description: '', updated_at: new Date().toISOString() },
            'marketplace.card.image_height_px': { value: 168, description: '', updated_at: new Date().toISOString() },
            'marketplace.card.show_seller':     { value: true, description: '', updated_at: new Date().toISOString() },
            'marketplace.card.show_lot_count':  { value: true, description: '', updated_at: new Date().toISOString() },
            'marketplace.card.show_bid':        { value: true, description: '', updated_at: new Date().toISOString() },
            'marketplace.shipping.show_badge':  { value: true, description: '', updated_at: new Date().toISOString() },
            'marketplace.homepage.featured_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
            'marketplace.homepage.near_you_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
            'marketplace.ranking.priority_weight': { value: 1.0, description: '', updated_at: new Date().toISOString() },
            'marketplace.ranking.recency_weight':  { value: 0.3, description: '', updated_at: new Date().toISOString() },
          },
        })});
      } else { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, updated: [] }) }); }
    });
    await page.route('**/api/admin/config/widgets', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true,
        data: [
          { widget_slug: 'featured-lots', settings: { 'widget.limit': 6 }, description: 'Featured Lots defaults', updated_at: new Date().toISOString() },
          { widget_slug: 'featured-near-you', settings: { 'widget.limit': 6, 'widget.radius_km': 200 }, description: 'Featured Near You defaults', updated_at: new Date().toISOString() },
        ],
      })});
    });
    await page.route('**/api/admin/config/packages**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true,
        data: [
          { id: 'pkg-1', name: 'Basic Listing', description: 'Standard listing.', price_cents: 0, features: ['Search listing'], is_active: true, display_order: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          { id: 'pkg-2', name: 'Featured Placement', description: 'Widget placement.', price_cents: 9900, features: ['Widget placement', 'Priority boost'], is_active: true, display_order: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        ],
      })});
    });

    await page.goto(`${BASE}/admin/marketplace-config.html`);
    await page.waitForSelector('#platform-content', { state: 'visible' });
  }

  test('page loads and shows Platform Settings tab by default', async ({ page }) => {
    await loadAdminPage(page);
    await expect(page.locator('#panel-platform')).toBeVisible();
    await expect(page.locator('#panel-widgets')).not.toBeVisible();
  });

  test('has tab navigation for all three sections', async ({ page }) => {
    await loadAdminPage(page);
    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(3);
    const labels = await tabs.allTextContents();
    expect(labels.some(t => t.includes('Platform'))).toBe(true);
    expect(labels.some(t => t.includes('Widget'))).toBe(true);
    expect(labels.some(t => t.includes('Package'))).toBe(true);
  });

  test('switching to Packages tab shows packages table', async ({ page }) => {
    await loadAdminPage(page);
    await page.click('[data-tab="packages"]');
    await page.waitForSelector('#packages-content', { state: 'visible' });
    const rows = page.locator('#packages-tbody tr');
    await expect(rows).toHaveCount(2);
  });

  test('form fields are populated with config values', async ({ page }) => {
    await loadAdminPage(page);
    const liveInput = page.locator('[data-key="marketplace.badge.live"]');
    await expect(liveInput).toHaveValue('LIVE NOW');
    const headlineInput = page.locator('[data-key="marketplace.cta.headline"]');
    await expect(headlineInput).toHaveValue('Consigning an Estate?');
  });

  test('packages table shows name, price, and status', async ({ page }) => {
    await loadAdminPage(page);
    await page.click('[data-tab="packages"]');
    await page.waitForSelector('#packages-content', { state: 'visible' });
    const firstRow = page.locator('#packages-tbody tr').first();
    await expect(firstRow).toContainText('Basic Listing');
    await expect(firstRow).toContainText('Free');
    await expect(firstRow).toContainText('Active');
  });

  test('Add Package button opens modal', async ({ page }) => {
    await loadAdminPage(page);
    await page.click('[data-tab="packages"]');
    await page.waitForSelector('#packages-content', { state: 'visible' });
    await page.click('#btn-add-package');
    await expect(page.locator('#pkg-modal')).toHaveClass(/open/);
    await expect(page.locator('#pkg-modal-title')).toContainText('Add Package');
  });

  test('modal closes on Cancel', async ({ page }) => {
    await loadAdminPage(page);
    await page.click('[data-tab="packages"]');
    await page.waitForSelector('#packages-content', { state: 'visible' });
    await page.click('#btn-add-package');
    await page.click('#pkg-modal-cancel');
    await expect(page.locator('#pkg-modal')).not.toHaveClass(/open/);
  });

});

// ─── Security ─────────────────────────────────────────────────────────────────

test.describe('Security — XSS and injection', () => {

  test('malicious badge label stored as text does not execute on admin page', async ({ page }) => {
    const xssLabel = '<img src=x onerror="window.__xss=true">';
    await page.addInitScript(token => { localStorage.setItem('token', token); }, adminToken);
    await page.route('**/api/admin/config/platform', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true,
        data: {
          'marketplace.badge.live': { value: xssLabel, description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.upcoming': { value: 'UPCOMING', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ships':    { value: 'Ships', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ending_soon': { value: 'Ending Soon', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ending_soon_threshold_min': { value: 120, description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.url':       { value: null, description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.headline':  { value: 'CTA', description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.label':     { value: 'Go', description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.subtext':   { value: 'text', description: '', updated_at: new Date().toISOString() },
          'marketplace.card.image_height_px': { value: 168, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_seller':     { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_lot_count':  { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_bid':        { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.shipping.show_badge':  { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.homepage.featured_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
          'marketplace.homepage.near_you_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
          'marketplace.ranking.priority_weight': { value: 1.0, description: '', updated_at: new Date().toISOString() },
          'marketplace.ranking.recency_weight':  { value: 0.3, description: '', updated_at: new Date().toISOString() },
        },
      })});
    });
    await page.route('**/api/admin/config/widgets', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.route('**/api/admin/config/packages**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.goto(`${BASE}/admin/marketplace-config.html`);
    await page.waitForSelector('#platform-content', { state: 'visible' });
    const xssTriggered = await page.evaluate(() => window.__xss);
    expect(xssTriggered).toBeUndefined();
  });

  test('AAPConfig.loadRemote() namespace guard blocks injection attempt', async ({ page }) => {
    await page.route('**/api/public/config', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true,
        data: {
          'marketplace.badge.live': 'SAFE',
          'internal.secret':        'INJECT',
          'admin.password':         'INJECT',
          'stripe.publishable_key': 'INJECT',
        },
      })});
    });
    await page.setContent(makeRemoteHtml(`
      AAPConfig.reset();
      AAPConfig.loadRemote('/api/public/config').then(function() {
        window.__safe    = AAPConfig.get('marketplace.badge.live');
        window.__inject1 = AAPConfig.get('internal.secret');
        window.__inject2 = AAPConfig.get('admin.password');
        window.__inject3 = AAPConfig.get('stripe.publishable_key');
        window.__done    = true;
      });
    `));
    await page.waitForFunction(() => window.__done === true);
    const r = await page.evaluate(() => ({
      safe: window.__safe, i1: window.__inject1, i2: window.__inject2, i3: window.__inject3,
    }));
    expect(r.safe).toBe('SAFE');
    expect(r.i1).toBeNull();
    expect(r.i2).toBeNull();
    expect(r.i3).toBeNull();
  });

  test('PATCH /api/admin/config/platform rejects non-allowlisted keys', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/admin/config/platform`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { 'stripe.secret': 'sk_live_xxx', 'internal.db_password': 'hunter2' },
    });
    expect(res.status()).toBe(400);
  });

});

// ─── Accessibility ────────────────────────────────────────────────────────────

test.describe('Accessibility — admin demo page', () => {

  async function loadPageForA11y(page) {
    await page.addInitScript(token => { localStorage.setItem('token', token); }, adminToken);
    await page.route('**/api/admin/config/platform', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true,
        data: {
          'marketplace.badge.live': { value: 'LIVE NOW', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.upcoming': { value: 'UPCOMING', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ships':    { value: 'Ships', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ending_soon': { value: 'Ending Soon', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ending_soon_threshold_min': { value: 120, description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.url':       { value: null, description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.headline':  { value: 'CTA', description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.label':     { value: 'Go', description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.subtext':   { value: 'text', description: '', updated_at: new Date().toISOString() },
          'marketplace.card.image_height_px': { value: 168, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_seller':     { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_lot_count':  { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_bid':        { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.shipping.show_badge':  { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.homepage.featured_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
          'marketplace.homepage.near_you_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
          'marketplace.ranking.priority_weight': { value: 1.0, description: '', updated_at: new Date().toISOString() },
          'marketplace.ranking.recency_weight':  { value: 0.3, description: '', updated_at: new Date().toISOString() },
        },
      })});
    });
    await page.route('**/api/admin/config/widgets', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.route('**/api/admin/config/packages**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.goto(`${BASE}/admin/marketplace-config.html`);
    await page.waitForSelector('#platform-content', { state: 'visible' });
  }

  test('page has a visible h1 heading', async ({ page }) => {
    await loadPageForA11y(page);
    const h1 = page.locator('h1');
    await expect(h1).toBeVisible();
    await expect(h1).not.toBeEmpty();
  });

  test('tab buttons have role="tab" and aria-selected attributes', async ({ page }) => {
    await loadPageForA11y(page);
    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(3);
    const selected = await tabs.first().getAttribute('aria-selected');
    expect(selected).toBe('true');
  });

  test('tab panels have role="tabpanel"', async ({ page }) => {
    await loadPageForA11y(page);
    const panels = page.locator('[role="tabpanel"]');
    await expect(panels).toHaveCount(3);
  });

  test('all form inputs have associated labels', async ({ page }) => {
    await loadPageForA11y(page);
    const inputs = page.locator('#platform-content input[id]');
    const count  = await inputs.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const id    = await inputs.nth(i).getAttribute('id');
      const label = page.locator(`label[for="${id}"]`);
      await expect(label, `Input #${id} must have an associated label`).toBeVisible();
    }
  });

  test('modal has role="dialog" and aria-modal', async ({ page }) => {
    await loadPageForA11y(page);
    await page.click('[data-tab="packages"]');
    const modal = page.locator('[role="dialog"]');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
  });

  test('toast notification uses aria-live="polite"', async ({ page }) => {
    await loadPageForA11y(page);
    const toast = page.locator('#toast');
    await expect(toast).toHaveAttribute('aria-live', 'polite');
  });

});

// ─── Mobile rendering ─────────────────────────────────────────────────────────

test.describe('Mobile rendering — admin demo page', () => {

  test('renders correctly at 375px width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript(token => { localStorage.setItem('token', token); }, adminToken);
    await page.route('**/api/admin/config/platform', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true, data: {
          'marketplace.badge.live': { value: 'LIVE NOW', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.upcoming': { value: 'UPCOMING', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ships':    { value: 'Ships', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ending_soon': { value: 'Ending Soon', description: '', updated_at: new Date().toISOString() },
          'marketplace.badge.ending_soon_threshold_min': { value: 120, description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.url':       { value: null, description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.headline':  { value: 'CTA', description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.label':     { value: 'Go', description: '', updated_at: new Date().toISOString() },
          'marketplace.cta.subtext':   { value: 'text', description: '', updated_at: new Date().toISOString() },
          'marketplace.card.image_height_px': { value: 168, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_seller':     { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_lot_count':  { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.card.show_bid':        { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.shipping.show_badge':  { value: true, description: '', updated_at: new Date().toISOString() },
          'marketplace.homepage.featured_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
          'marketplace.homepage.near_you_limit': { value: 6, description: '', updated_at: new Date().toISOString() },
          'marketplace.ranking.priority_weight': { value: 1.0, description: '', updated_at: new Date().toISOString() },
          'marketplace.ranking.recency_weight':  { value: 0.3, description: '', updated_at: new Date().toISOString() },
        },
      })});
    });
    await page.route('**/api/admin/config/widgets', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.route('**/api/admin/config/packages**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.goto(`${BASE}/admin/marketplace-config.html`);
    await page.waitForSelector('#platform-content', { state: 'visible' });
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.tabs')).toBeVisible();
  });

});

// ─── Multi-widget coexistence — AAPConfig shared across widget instances ──────

test.describe('AAPConfig multi-widget coexistence', () => {

  const FL_URL  = `${BASE}/widgets/featured-lots.js`;
  const FNY_URL = `${BASE}/widgets/featured-near-you.js`;

  test('AAPConfig is shared between two widget instances — set() affects both', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.route('**/api/public/featured-auctions**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
    });

    await page.setContent(`<!DOCTYPE html><html><body>
      <script src="${CONFIG_JS_URL}"></script>
      <script>AAPConfig.set('marketplace.badge.live', 'SHARED-LIVE');</script>
      <div id="aap-featured-lots" data-api-base="" data-limit="3"></div>
      <div id="aap-featured-near-you" data-api-base="" data-limit="3"></div>
      <script src="${FL_URL}"></script>
      <script src="${FNY_URL}"></script>
      <script>window.__shared = AAPConfig.get('marketplace.badge.live');</script>
    </body></html>`);

    await page.waitForFunction(() => typeof window.__shared === 'string');
    expect(await page.evaluate(() => window.__shared)).toBe('SHARED-LIVE');
  });

  test('AAPConfig._v sentinel prevents double-initialisation', async ({ page }) => {
    await page.setContent(`<!DOCTYPE html><html><body>
      <script src="${CONFIG_JS_URL}"></script>
      <script>AAPConfig.set('marketplace.badge.live', 'FIRST');</script>
      <script src="${CONFIG_JS_URL}"></script>
      <script>window.__live = AAPConfig.get('marketplace.badge.live');</script>
    </body></html>`);
    await page.waitForFunction(() => typeof window.__live === 'string');
    // Second load must not reset the store — value set before second load is preserved
    expect(await page.evaluate(() => window.__live)).toBe('FIRST');
  });

});
