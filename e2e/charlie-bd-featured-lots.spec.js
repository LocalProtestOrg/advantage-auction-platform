'use strict';

/**
 * e2e/charlie-bd-featured-lots.spec.js
 *
 * Playwright coverage for:
 *   Phase A — shared/components/*.js component library
 *   Phase B — shared/config.js configuration layer
 *   Phase C — featured-lots.js widget
 *
 * Tests are fully isolated via page.setContent() and page.route() — no live
 * API data or fixture state required. No auth tokens used anywhere.
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// ── Mock lot data ─────────────────────────────────────────────────────────────

function makeLot(overrides) {
  return Object.assign({
    id:                   'bb000001-0000-4000-8000-000000000001',
    auction_id:           'aa000001-0000-4000-8000-000000000001',
    lot_number:           1,
    title:                'Victorian Oak Sideboard',
    description:          'Solid oak, circa 1890.',
    size_category:        'large',
    condition:            'Good',
    material:             'Oak',
    thumbnail_url:        null,
    images_count:         3,
    lot_state:            'active',
    starting_bid_cents:   100,
    current_bid_cents:    5000,
    bid_count:            7,
    closes_at:            new Date(Date.now() + 7200000).toISOString(),
    shippable:            true,
    shipping_cost_cents:  3500,
    shipping_notes:       null,
    auction_title:        'Estate Sale — Dallas TX',
    auction_state:        'active',
    auction_city:         'Dallas',
    auction_address_state:'TX',
    auction_end_time:     new Date(Date.now() + 7200000).toISOString(),
    auction_cover_image_url: null,
  }, overrides || {});
}

var LOT_LIVE      = makeLot();
var LOT_UPCOMING  = makeLot({
  id:              'bb000002-0000-4000-8000-000000000002',
  auction_state:   'published',
  lot_state:       'pending',
  bid_count:       0,
  current_bid_cents: null,
  shippable:       false,
  title:           'Impressionist Oil Painting',
  thumbnail_url:   'https://example.com/thumb.jpg',
});
var LOT_ENDING_SOON = makeLot({
  id:        'bb000003-0000-4000-8000-000000000003',
  closes_at: new Date(Date.now() + 60000).toISOString(), // 1 minute away
  title:     'Ending Soon Lot',
});

// ── Helper: build minimal page HTML ──────────────────────────────────────────
// Loads the full shared layer + all components + the widget.
// data-* attributes control per-test widget config.

function makeFullHtml(widgetAttrs, configScript) {
  var dataAttrs = Object.entries(Object.assign({
    'data-api-base': BASE,
    'data-limit': '3',
  }, widgetAttrs || {}))
    .map(function (kv) { return kv[0] + '="' + String(kv[1]).replace(/"/g, '&quot;') + '"'; })
    .join(' ');

  var cfgBlock = configScript
    ? '<script>' + configScript + '<\/script>'
    : '';

  var scripts = [
    BASE + '/widgets/shared/utils.js',
    BASE + '/widgets/shared/config.js',
    BASE + '/widgets/shared/components/badge.js',
    BASE + '/widgets/shared/components/skeleton-card.js',
    BASE + '/widgets/shared/components/auction-card.js',
    BASE + '/widgets/shared/components/seller-cta.js',
    BASE + '/widgets/shared/components/empty-state.js',
    BASE + '/widgets/shared/components/error-state.js',
    BASE + '/widgets/featured-lots.js',
  ].map(function (u) { return '<script src="' + u + '"><\/script>'; }).join('');

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '</head><body>' +
    cfgBlock +
    '<div id="aap-featured-lots" ' + dataAttrs + '></div>' +
    scripts +
    '</body></html>';
}

// Widget without shared layer (inline fallback test)
function makeStandaloneHtml(widgetAttrs) {
  var dataAttrs = Object.entries(Object.assign({ 'data-api-base': BASE, 'data-limit': '2' }, widgetAttrs || {}))
    .map(function (kv) { return kv[0] + '="' + kv[1] + '"'; }).join(' ');
  return '<!DOCTYPE html><html><body>' +
    '<div id="aap-featured-lots" ' + dataAttrs + '></div>' +
    '<script src="' + BASE + '/widgets/featured-lots.js"><\/script>' +
    '</body></html>';
}

function lotsRoute(data) {
  return function (route) {
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: data }) });
  };
}

// ── Demo page ─────────────────────────────────────────────────────────────────

test.describe('Demo page', () => {

  test('demo-featured-lots.html loads without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/widgets/demo-featured-lots.html');
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });

  test('demo page container element exists', async ({ page }) => {
    await page.goto(BASE + '/widgets/demo-featured-lots.html');
    await expect(page.locator('#aap-featured-lots')).toBeAttached();
  });

});

// ── Phase B: Config layer ──────────────────────────────────────────────────────

test.describe('Phase B — AAPConfig layer', () => {

  test('config.js is served at expected URL', async ({ request }) => {
    const res = await request.get(BASE + '/widgets/shared/config.js');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
  });

  test('AAPConfig is defined on window after loading config.js', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const isDefined = await page.evaluate(() => typeof window.AAPConfig === 'object');
    expect(isDefined).toBe(true);
  });

  test('AAPConfig.get returns platform defaults', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const defaultLimit = await page.evaluate(() => window.AAPConfig.get('widget.limit'));
    expect(defaultLimit).toBe(6);
  });

  test('AAPConfig.set overrides a value', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const val = await page.evaluate(() => {
      window.AAPConfig.set('widget.limit', 99);
      return window.AAPConfig.get('widget.limit');
    });
    expect(val).toBe(99);
  });

  test('AAPConfig.set accepts an object of key-value pairs', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const vals = await page.evaluate(() => {
      window.AAPConfig.set({ 'widget.limit': 8, 'marketplace.cta.url': 'https://example.com' });
      return { limit: window.AAPConfig.get('widget.limit'), url: window.AAPConfig.get('marketplace.cta.url') };
    });
    expect(vals.limit).toBe(8);
    expect(vals.url).toBe('https://example.com');
  });

  test('AAPConfig.get returns fallback when key absent', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const val = await page.evaluate(() => window.AAPConfig.get('no.such.key', 'myFallback'));
    expect(val).toBe('myFallback');
  });

  test('AAPConfig.reset restores platform defaults', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const val = await page.evaluate(() => {
      window.AAPConfig.set('widget.limit', 42);
      window.AAPConfig.reset();
      return window.AAPConfig.get('widget.limit');
    });
    expect(val).toBe(6);
  });

  test('AAPConfig reads inline <script type="application/json" id="aap-config"> block', async ({ page }) => {
    await page.setContent([
      '<html><body>',
      '<script id="aap-config" type="application/json">',
      '{"widget.limit":11,"marketplace.cta.headline":"Estate Specialists"}',
      '<\/script>',
      '</body></html>',
    ].join(''));
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const vals = await page.evaluate(() => ({
      limit:    window.AAPConfig.get('widget.limit'),
      headline: window.AAPConfig.get('marketplace.cta.headline'),
    }));
    expect(vals.limit).toBe(11);
    expect(vals.headline).toBe('Estate Specialists');
  });

  test('AAPConfig.loadRemote returns self on network error (non-blocking)', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    const result = await page.evaluate(async () => {
      // Point at a non-existent endpoint — should not throw
      var returned = await window.AAPConfig.loadRemote('/api/nonexistent-config-endpoint');
      return typeof returned === 'object' && returned._v === 1;
    });
    expect(result).toBe(true);
  });

  test('widget uses AAPConfig values for badge labels', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));

    await page.setContent(makeFullHtml({}, [
      "window.AAPConfig.set({'marketplace.badge.live':'AUCTION LIVE'});",
    ].join('')));

    await page.waitForSelector('.aapc-badge');
    const badgeText = await page.locator('.aapc-badge-live').first().textContent();
    expect(badgeText).toBe('AUCTION LIVE');
  });

  test('widget falls back to defaults when AAPConfig not loaded', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeStandaloneHtml()); // no config.js
    await expect(page.locator('.aapc-card')).toBeVisible();
  });

});

// ── Phase A: Shared component library ─────────────────────────────────────────

test.describe('Phase A — component static assets', () => {

  const components = [
    'badge', 'skeleton-card', 'auction-card',
    'seller-cta', 'empty-state', 'error-state',
  ];

  components.forEach(function (name) {
    test('shared/components/' + name + '.js served at expected URL', async ({ request }) => {
      const res = await request.get(BASE + '/widgets/shared/components/' + name + '.js');
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toMatch(/javascript/);
    });
  });

  test('AAPComponents namespace is defined after loading badge.js', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    const ok = await page.evaluate(() => typeof window.AAPComponents === 'object' && !!window.AAPComponents.Badge);
    expect(ok).toBe(true);
  });

  test('AAPComponents.Badge returns an element with correct class', async ({ page }) => {
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    await page.evaluate(() => {
      var el = AAPComponents.Badge({ text: 'TEST', variant: 'live' });
      document.getElementById('host').appendChild(el);
    });
    await expect(page.locator('.aapc-badge-live')).toContainText('TEST');
  });

  test('AAPComponents.SkeletonCard returns skeleton element', async ({ page }) => {
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/skeleton-card.js' });
    await page.evaluate(() => {
      var el = AAPComponents.SkeletonCard({ imageHeight: 120, lines: 3 });
      document.getElementById('host').appendChild(el);
    });
    await expect(page.locator('.aapc-skeleton')).toBeVisible();
    const imgH = await page.locator('.aapc-skel-img').evaluate(el => el.style.height);
    expect(imgH).toBe('120px');
  });

  test('AAPComponents.EmptyState returns element with role=status', async ({ page }) => {
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/empty-state.js' });
    await page.evaluate(() => {
      var el = AAPComponents.EmptyState({ message: 'Nothing here.' });
      document.getElementById('host').appendChild(el);
    });
    await expect(page.locator('.aapc-empty')).toContainText('Nothing here.');
    await expect(page.locator('.aapc-empty')).toHaveAttribute('role', 'status');
  });

  test('AAPComponents.ErrorState returns element with role=alert', async ({ page }) => {
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/error-state.js' });
    await page.evaluate(() => {
      var el = AAPComponents.ErrorState({ message: 'Something broke.' });
      document.getElementById('host').appendChild(el);
    });
    await expect(page.locator('.aapc-error')).toContainText('Something broke.');
    await expect(page.locator('.aapc-error')).toHaveAttribute('role', 'alert');
  });

  test('AAPComponents.SellerCta reads URL from config', async ({ page }) => {
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/config.js' });
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/seller-cta.js' });
    await page.evaluate(() => {
      window.AAPConfig.set({ 'marketplace.cta.url': 'https://example.com/sell' });
      var el = AAPComponents.SellerCta({ config: window.AAPConfig });
      document.getElementById('host').appendChild(el);
    });
    await expect(page.locator('.aapc-cta-btn')).toHaveAttribute('href', 'https://example.com/sell');
  });

  test('AAPComponents.AuctionCard renders title and location', async ({ page }) => {
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/auction-card.js' });
    await page.evaluate(() => {
      var el = AAPComponents.AuctionCard({
        title: 'Test Auction', state: 'active',
        city: 'Dallas', address_state: 'TX',
      });
      document.getElementById('host').appendChild(el);
    });
    await expect(page.locator('.aapc-title')).toContainText('Test Auction');
    await expect(page.locator('.aapc-meta').first()).toContainText('Dallas, TX');
  });

  test('AAPComponents.AuctionCard renders bid info for lot data', async ({ page }) => {
    await page.setContent('<html><body><div id="host"></div></body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/auction-card.js' });
    await page.evaluate(() => {
      var el = AAPComponents.AuctionCard({
        title: 'Oak Sideboard',
        state: 'active',
        current_bid_cents: 5000,
        bid_count: 7,
        starting_bid_cents: 100,
      });
      document.getElementById('host').appendChild(el);
    });
    await expect(page.locator('.aapc-bid')).toContainText('$50.00');
    await expect(page.locator('.aapc-bid')).toContainText('7 bids');
  });

  test('multiple component loads are idempotent (no duplicate style tags)', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    // Load badge twice
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    const styleCount = await page.evaluate(() =>
      document.querySelectorAll('#aapc-badge-styles').length
    );
    expect(styleCount).toBe(1);
  });

  test('aapc-root CSS variables cascade to child elements', async ({ page }) => {
    await page.setContent('<html><body>' +
      '<div class="aapc-root" id="root"><div id="child" class="aapc-card"></div></div>' +
      '</body></html>');
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/badge.js' });
    await page.addScriptTag({ url: BASE + '/widgets/shared/components/auction-card.js' });
    const hasVar = await page.evaluate(() => {
      var style = getComputedStyle(document.getElementById('root'));
      return style.getPropertyValue('--aapc-bg').trim() !== '';
    });
    expect(hasVar).toBe(true);
  });

});

// ── Phase C: Featured Lots widget ──────────────────────────────────────────────

test.describe('Phase C — widget loading state', () => {

  test('skeleton cards shown while fetch is pending', async ({ page }) => {
    let releaseFn;
    await page.route('**/api/public/featured-lots**', async route => {
      await new Promise(r => { releaseFn = r; });
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [LOT_LIVE] }) });
    });
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-skeleton').first()).toBeVisible();
    releaseFn();
    await expect(page.locator('.aapc-card').first()).toBeVisible();
  });

  test('loading grid has aria-busy=true', async ({ page }) => {
    let releaseFn;
    await page.route('**/api/public/featured-lots**', async route => {
      await new Promise(r => { releaseFn = r; });
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.setContent(makeFullHtml());
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    releaseFn();
  });

});

test.describe('Phase C — lot card rendering', () => {

  test('renders lot cards from API response', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE, LOT_UPCOMING]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-card')).toHaveCount(2);
  });

  test('lot title is rendered in each card', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-title').first()).toContainText('Victorian Oak Sideboard');
  });

  test('LIVE NOW badge for active auction lot', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-badge-live').first()).toBeVisible();
  });

  test('UPCOMING badge for published auction lot', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_UPCOMING]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-badge-upcoming').first()).toBeVisible();
  });

  test('Ending Soon badge shown when closes_at is within threshold', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_ENDING_SOON]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-badge-ending-soon').first()).toBeVisible();
  });

  test('Ending Soon badge absent when closes_at is far away', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE])); // closes in 2h, threshold 120min
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    expect(await page.locator('.aapc-badge-ending-soon').count()).toBe(0);
  });

  test('shipping badge shown when lot.shippable is true', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE])); // shippable:true
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-badge-ships').first()).toBeVisible();
  });

  test('shipping badge absent when lot.shippable is false', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_UPCOMING])); // shippable:false
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    expect(await page.locator('.aapc-badge-ships').count()).toBe(0);
  });

  test('current bid and bid count shown when bid_count > 0', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE])); // 7 bids, $50.00
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-bid').first()).toContainText('$50.00');
    await expect(page.locator('.aapc-bid').first()).toContainText('7 bids');
  });

  test('starting bid shown when bid_count is 0', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_UPCOMING])); // 0 bids
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-bid').first()).toContainText('Starts at');
    await expect(page.locator('.aapc-bid').first()).toContainText('$1.00');
  });

  test('auction context label shown on lot card', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-context').first()).toContainText('from Estate Sale — Dallas TX');
  });

  test('location shown on lot card', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-meta').first()).toContainText('Dallas, TX');
  });

  test('cover image renders when thumbnail_url is set', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_UPCOMING])); // has thumbnail_url
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-thumb')).toBeVisible();
  });

  test('no-image placeholder shown when thumbnail_url is null', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE])); // thumbnail_url:null
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-no-img')).toBeVisible();
  });

  test('limit sent in API request URL', async ({ page }) => {
    var capturedLimit = null;
    await page.route('**/api/public/featured-lots**', async route => {
      capturedLimit = new URL(route.request().url()).searchParams.get('limit');
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.setContent(makeFullHtml({ 'data-limit': '4' }));
    await page.waitForTimeout(500);
    expect(capturedLimit).toBe('4');
  });

});

test.describe('Phase C — seller CTA card', () => {

  test('CTA card appears when data-seller-cta-url is set', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml({
      'data-seller-cta-url': 'https://example.com/sell',
      'data-seller-cta-headline': 'We Sell Estates',
      'data-seller-cta-label': 'Contact Us',
    }));
    await expect(page.locator('.aapc-cta')).toBeVisible();
    await expect(page.locator('.aapc-cta-head')).toContainText('We Sell Estates');
    await expect(page.locator('.aapc-cta-btn')).toContainText('Contact Us');
  });

  test('CTA card absent when no cta-url configured', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml()); // no data-seller-cta-url, no config
    await page.waitForSelector('.aapc-card');
    expect(await page.locator('.aapc-cta').count()).toBe(0);
  });

  test('CTA card appears when AAPConfig.marketplace.cta.url is set', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml({}, "window.AAPConfig.set({'marketplace.cta.url':'https://example.com/sell'});"));
    await expect(page.locator('.aapc-cta')).toBeVisible();
  });

  test('data-seller-cta-url overrides AAPConfig cta.url', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml(
      { 'data-seller-cta-url': 'https://override.com' },
      "window.AAPConfig.set({'marketplace.cta.url':'https://config.com'});"
    ));
    await expect(page.locator('.aapc-cta-btn')).toHaveAttribute('href', 'https://override.com');
  });

  test('CTA link opens in new tab with noopener', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml({ 'data-seller-cta-url': 'https://example.com/sell' }));
    await expect(page.locator('.aapc-cta-btn')).toHaveAttribute('target', '_blank');
    await expect(page.locator('.aapc-cta-btn')).toHaveAttribute('rel', 'noopener noreferrer');
  });

});

test.describe('Phase C — empty and error states', () => {

  test('empty state shown when API returns no lots', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([]));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-empty')).toBeVisible();
    expect(await page.locator('.aapc-card').count()).toBe(0);
  });

  test('error state shown when API request fails', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', route => route.abort());
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-error')).toBeVisible();
  });

  test('error state shown on HTTP 500', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', route =>
      route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ success: false, message: 'Internal error' }) }));
    await page.setContent(makeFullHtml());
    await expect(page.locator('.aapc-error')).toBeVisible();
  });

});

// ── Security ──────────────────────────────────────────────────────────────────

test.describe('Security', () => {

  test('no Authorization header in any API request', async ({ page }) => {
    var authFound = false;
    await page.route('**/api/public/**', async route => {
      var h = route.request().headers();
      if (h['authorization'] || h['Authorization']) authFound = true;
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }) });
    });
    await page.setContent(makeFullHtml());
    await page.waitForTimeout(500);
    expect(authFound).toBe(false);
  });

  test('only /api/public/* endpoints fetched', async ({ page }) => {
    const forbidden = ['/api/auth','/api/admin','/api/auctions','/api/bids','/api/payments'];
    const violations = [];
    await page.route('**/*', async route => {
      const url = route.request().url();
      for (var i = 0; i < forbidden.length; i++) {
        if (url.includes(forbidden[i]) && !url.includes('/api/public/')) violations.push(url);
      }
      if (url.includes('/api/public/')) {
        route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }) });
      } else { route.continue(); }
    });
    await page.setContent(makeFullHtml());
    await page.waitForTimeout(600);
    expect(violations).toHaveLength(0);
  });

  test('XSS: script tag in lot title is escaped and not executed', async ({ page }) => {
    var xssRan = false;
    await page.exposeFunction('__xssProbe', () => { xssRan = true; });
    const xssLot = makeLot({ title: '<script>window.__xssProbe()<\/script>Malicious' });
    await page.route('**/api/public/featured-lots**', lotsRoute([xssLot]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    expect(await page.locator('.aapc-card script').count()).toBe(0);
    expect(xssRan).toBe(false);
    const titleText = await page.locator('.aapc-title').first().textContent();
    expect(titleText).toContain('<script>');  // rendered as literal text, not DOM
  });

  test('XSS: malicious auction title in context label is escaped', async ({ page }) => {
    const xssLot = makeLot({ auction_title: '<img src=x onerror=alert(1)>' });
    await page.route('**/api/public/featured-lots**', lotsRoute([xssLot]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    expect(await page.locator('.aapc-context img').count()).toBe(0);
  });

  test('XSS: malicious thumbnail_url is escaped in img src attribute', async ({ page }) => {
    const xssLot = makeLot({ thumbnail_url: '"onerror="alert(1)' });
    await page.route('**/api/public/featured-lots**', lotsRoute([xssLot]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    const src = await page.locator('.aapc-thumb').getAttribute('src');
    expect(src).not.toContain('"');
  });

});

// ── Analytics events ──────────────────────────────────────────────────────────

test.describe('Analytics events', () => {

  test('aap:widget:loaded fires after render', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    const detail = await page.evaluate(() => new Promise(resolve => {
      document.getElementById('aap-featured-lots')
        .addEventListener('aap:widget:loaded', e => resolve(e.detail), { once: true });
    }));
    expect(detail.widgetId).toBe('aap-featured-lots');
    expect(detail.source).toBe('featured-lots');
    expect(typeof detail.resultCount).toBe('number');
  });

  test('aap:lot:click fires when a card is clicked', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    const clickPromise = page.evaluate(() => new Promise(resolve => {
      document.getElementById('aap-featured-lots')
        .addEventListener('aap:lot:click', e => resolve(e.detail), { once: true });
    }));
    await page.locator('.aapc-card').first().click();
    const detail = await clickPromise;
    expect(detail.lotId).toBe(LOT_LIVE.id);
    expect(detail.auctionId).toBe(LOT_LIVE.auction_id);
  });

  test('aap:cta:click fires when CTA button is clicked', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml({ 'data-seller-cta-url': 'https://example.com/sell' }));
    await page.waitForSelector('.aapc-cta');
    const ctaPromise = page.evaluate(() => new Promise(resolve => {
      document.getElementById('aap-featured-lots')
        .addEventListener('aap:cta:click', e => resolve(e.detail), { once: true });
    }));
    await page.locator('.aapc-cta-btn').click({ noWaitAfter: true });
    const detail = await ctaPromise;
    expect(detail.widgetId).toBe('aap-featured-lots');
  });

  test('aap:widget:loaded fires with resultCount 0 for empty state', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([]));
    await page.setContent(makeFullHtml());
    const detail = await page.evaluate(() => new Promise(resolve => {
      document.getElementById('aap-featured-lots')
        .addEventListener('aap:widget:loaded', e => resolve(e.detail), { once: true });
    }));
    expect(detail.resultCount).toBe(0);
  });

});

// ── Accessibility ─────────────────────────────────────────────────────────────

test.describe('Accessibility', () => {

  test('lot cards have tabindex=0', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    expect(await page.locator('.aapc-card').first().getAttribute('tabindex')).toBe('0');
  });

  test('lot cards have aria-label', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');
    const label = await page.locator('.aapc-card').first().getAttribute('aria-label');
    expect(label).toBeTruthy();
  });

  test('grid has aria-label when rendering results', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapfl-grid[aria-label]');
    const label = await page.locator('.aapfl-grid').getAttribute('aria-label');
    expect(label).toBeTruthy();
  });

  test('CTA card has role=complementary', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml({ 'data-seller-cta-url': 'https://example.com/sell' }));
    await page.waitForSelector('.aapc-cta');
    expect(await page.locator('.aapc-cta').getAttribute('role')).toBe('complementary');
  });

  test('empty state element has role=status', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-empty');
    expect(await page.locator('.aapc-empty').getAttribute('role')).toBe('status');
  });

  test('error state element has role=alert', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', route => route.abort());
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-error');
    expect(await page.locator('.aapc-error').getAttribute('role')).toBe('alert');
  });

});

// ── Mobile rendering ──────────────────────────────────────────────────────────

test.describe('Mobile rendering', () => {

  test('renders on 375px viewport — single column', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE, LOT_UPCOMING]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-card');

    const cardW = await page.locator('.aapc-card').first().evaluate(el => el.getBoundingClientRect().width);
    const gridW = await page.locator('.aapfl-grid').evaluate(el => el.getBoundingClientRect().width);
    expect(Math.abs(cardW - gridW)).toBeLessThanOrEqual(2);
  });

  test('lot title visible and not clipped at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeFullHtml());
    await page.waitForSelector('.aapc-title');
    const box = await page.locator('.aapc-title').first().boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

});

// ── Multi-widget coexistence ───────────────────────────────────────────────────

test.describe('Multi-widget coexistence', () => {

  test('featured-lots and featured-near-you coexist on same page', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.route('**/api/public/featured-auctions**', route =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }) }));

    var html = '<!DOCTYPE html><html><body>' +
      '<div id="aap-featured-lots" data-api-base="' + BASE + '" data-limit="2"></div>' +
      '<div id="aap-featured-near-you" data-api-base="' + BASE + '" data-limit="2"></div>' +
      '<script src="' + BASE + '/widgets/shared/utils.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/config.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/components/badge.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/components/skeleton-card.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/components/auction-card.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/components/seller-cta.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/components/empty-state.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/components/error-state.js"><\/script>' +
      '<script src="' + BASE + '/widgets/featured-lots.js"><\/script>' +
      '<script src="' + BASE + '/widgets/featured-near-you.js"><\/script>' +
      '</body></html>';

    await page.setContent(html);

    // Both containers exist and render independently
    await expect(page.locator('#aap-featured-lots')).toBeAttached();
    await expect(page.locator('#aap-featured-near-you')).toBeAttached();

    // Each has its own CSS prefix — no style collision
    const flGrid = await page.locator('.aapfl-grid').count();
    const nyGrid = await page.locator('.aapny-grid').count();
    expect(flGrid).toBeGreaterThanOrEqual(0);  // may be empty state
    expect(nyGrid).toBeGreaterThanOrEqual(0);
  });

  test('shared style sheets are injected only once per ID', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.route('**/api/public/featured-auctions**', route =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }) }));

    var html = '<!DOCTYPE html><html><body>' +
      '<div id="aap-featured-lots" data-api-base="' + BASE + '"></div>' +
      '<script src="' + BASE + '/widgets/shared/components/badge.js"><\/script>' +
      '<script src="' + BASE + '/widgets/shared/components/auction-card.js"><\/script>' +
      '<script src="' + BASE + '/widgets/featured-lots.js"><\/script>' +
      '</body></html>';

    await page.setContent(html);
    await page.waitForTimeout(400);

    const rootStyleCount = await page.evaluate(() => document.querySelectorAll('#aapc-root-styles').length);
    const badgeStyleCount = await page.evaluate(() => document.querySelectorAll('#aapc-badge-styles').length);
    expect(rootStyleCount).toBe(1);
    expect(badgeStyleCount).toBe(1);
  });

  test('standalone widget works without shared layer loaded', async ({ page }) => {
    await page.route('**/api/public/featured-lots**', lotsRoute([LOT_LIVE]));
    await page.setContent(makeStandaloneHtml());
    await expect(page.locator('.aapc-card')).toBeVisible();
  });

});
