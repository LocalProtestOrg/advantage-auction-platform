'use strict';

/**
 * Event Search distance/radius slider — regression coverage.
 *
 * Flow verified end-to-end (also confirmed with a live browser test): the slider updates state.radius,
 * sends it to /api/public/marketplace/feed when a location is set, resolveFeedGeo parses it, and the feed
 * applies a Haversine (miles) distance filter. The fix: a finite radius keeps PHYSICAL events within the
 * radius PLUS online/nationwide (coordless) events — so a radius search surfaces the available inventory
 * (e.g. online auctions) instead of near-empty results, matching the homepage's approved behavior.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const { resolveFeedGeo } = require('../src/routes/public');

const publicSrc = read('src/routes/public.js');
const widgetSrc = read('public/widgets/marketplace-feed.js');

describe('radius parsing (API receives the correct radius)', () => {
  test('finite radii 10/25/50/100 → numeric radiusMi when a location is set', () => {
    for (const r of [10, 25, 50, 100]) {
      const g = resolveFeedGeo({ lat: '34.00', lng: '-81.03', radius: String(r) });
      expect(g.hasGeo).toBe(true);
      expect(g.radiusMi).toBe(r);
    }
  });
  test('Nationwide → no distance filter (radiusMi null)', () => {
    expect(resolveFeedGeo({ lat: '34', lng: '-81', radius: 'nationwide' }).radiusMi).toBeNull();
  });
  test('radius is meaningless without a location (no center → radiusMi null)', () => {
    expect(resolveFeedGeo({ radius: '25' }).radiusMi).toBeNull();
    expect(resolveFeedGeo({ radius: '25' }).hasGeo).toBe(false);
  });
});

describe('feed distance filter (search results change appropriately)', () => {
  test('distance is Haversine in MILES (3959 mi Earth radius)', () => {
    expect(publicSrc).toMatch(/3959\.0 \* acos/);
  });
  test('a finite radius INCLUDES online/nationwide (coordless) events plus physical within the radius', () => {
    // The fix: coordless (distance NULL) rows pass; physical rows must be within the radius.
    expect(publicSrc).toMatch(/WHERE x\.distance_mi IS NULL OR x\.distance_mi <= \$\$\{params\.length\}/);
    // Guard against the regression (excluding all coordless events → near-empty radius search).
    expect(publicSrc).not.toMatch(/WHERE x\.distance_mi IS NOT NULL AND x\.distance_mi <= /);
  });
  test('nearest sort lists closest physical events first, online (NULL distance) last', () => {
    expect(publicSrc).toMatch(/x\.distance_mi ASC NULLS LAST/);
  });
});

describe('widget slider wiring (slider value updates + sends radius; map/list share the same feed)', () => {
  test('slider input updates state.radius; 255 = nationwide', () => {
    expect(widgetSrc).toMatch(/state\.radius = v >= 255 \? 'nationwide' : v/);
  });
  test('releasing the slider re-searches when a location is set', () => {
    expect(widgetSrc).toMatch(/rg\.addEventListener\('change', function \(\) \{[\s\S]*?if \(state\.loc\) apply\(\);/);
  });
  test('apiParams sends lat/lng + radius to the feed only when a location is set', () => {
    expect(widgetSrc).toMatch(/if \(state\.loc\) \{ p\.set\('lat'[\s\S]{0,120}p\.set\('radius'/);
  });
  test('Map View link carries the same params (map + list stay in sync)', () => {
    expect(widgetSrc).toMatch(/function mapHref\(\) \{ var p = apiParams\(\{ view: 'map' \}\)/);
  });
});
