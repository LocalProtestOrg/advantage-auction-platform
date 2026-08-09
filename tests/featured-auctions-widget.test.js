'use strict';

/**
 * Homepage Featured Auctions widget (GET /api/public/featured-auctions).
 *
 * Root cause of the "no auctions display" regression: the endpoint hard-gated on `marketplace_priority > 0`,
 * so a normally-published auction (default priority 0) never appeared — the widget was empty unless an admin
 * explicitly boosted an auction. Fix: show ELIGIBLE published/active, non-archived auctions ordered by
 * ranking_score (featured/boosted first), with no explicit-priority gate. Native Advantage.Bid Auctions
 * only — never events (Auction Partner Events / GSA / Estate Sales) or fixed-price Marketplace items.
 *
 * Source-level assertions (the codebase's pattern for public-route SQL) + widget empty-state copy.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const publicSrc = read('src/routes/public.js');
const widgetSrc = read('public/widgets/featured-auctions.js');

// Isolate the /featured-auctions handler (up to the next route) so assertions can't match other endpoints.
const feat = (() => {
  const start = publicSrc.indexOf("router.get('/featured-auctions'");
  const end = publicSrc.indexOf("router.get('/featured-videos'");
  return publicSrc.slice(start, end > start ? end : start + 6000);
})();

describe('eligibility', () => {
  test('[#1] eligible published/active auctions appear (state gate)', () => {
    // Both branches (geo + national) select published/active.
    expect((feat.match(/a\.state IN \('published', 'active'\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  test('[#2] draft/submitted auctions do not appear (only published/active pass)', () => {
    expect(feat).not.toMatch(/'draft'/);
    expect(feat).not.toMatch(/'submitted'/);
  });
  test('[#3] archived (and ended→closed) auctions are excluded', () => {
    expect((feat.match(/a\.is_archived IS NOT TRUE/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  test('REGRESSION GUARD: no hard marketplace_priority > 0 gate (a normally-published auction appears)', () => {
    expect(feat).not.toMatch(/AND a\.marketplace_priority > 0/);
  });
  test('featured/boosted auctions still rank first (ordered by ranking score)', () => {
    expect(feat).toMatch(/auctionScoreSQL\('a'\)/);           // score gives marketplace_priority>0 a featured boost
    expect(feat).toMatch(/ranking_score DESC|\$\{auctionScoreSQL\('a'\)\} DESC/);
  });
});

describe('classification — native Advantage.Bid Auctions only (no cross-family leak)', () => {
  test('[#4] queries the auctions table', () => {
    expect((feat.match(/FROM auctions a/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  test('[#5]/[#7]/[#8] does NOT query events or marketplace items (GSA/Estate/fixed-price cannot leak in)', () => {
    // GSA + Estate Sales are EVENTS; the widget is auction-only, so it never selects from events.
    expect(feat).not.toMatch(/FROM events\b/);
    expect(feat).not.toMatch(/event_images/);
    expect(feat).not.toMatch(/marketplace_status = 'syndicated'/); // that's the feed's gate, not this widget's
  });
});

describe('images (not required for eligibility)', () => {
  test('[#6] real auction images are returned (cover + banner); image is not an eligibility gate', () => {
    expect(feat).toMatch(/a\.cover_image_url/);
    expect(feat).toMatch(/a\.banner_image_url/);
    expect(feat).not.toMatch(/cover_image_url IS NOT NULL/);   // no "must have image" WHERE gate
  });
});

describe('[#9] empty-state behavior remains valid', () => {
  test('endpoint returns a plain success+data envelope (empty array when nothing eligible)', () => {
    expect(feat).toMatch(/return res\.json\(\{ success: true, data: rows \}\)/);
  });
  test('widget renders the approved empty-state copy when no auctions are returned', () => {
    expect(widgetSrc).toMatch(/No featured auctions currently available\./);
    expect(widgetSrc).toMatch(/\/api\/public\/featured-auctions/);
  });
});
