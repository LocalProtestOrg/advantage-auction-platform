'use strict';

/**
 * BD parent embed helper (public/widgets/marketplace-embed.js) — the pure message-decision fn that
 * every wrapper uses. Validates origin + source-frame + envelope, clamps height, routes resize/scroll.
 */
const embed = require('../public/widgets/marketplace-embed.js');
const fs = require('fs');
const path = require('path');
const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'projects', 'bd-event-feed-widgets-install.md'), 'utf8');

const ORIGIN = 'https://bid.advantage.bid';
const good = (over) => Object.assign({ source: 'advantage-bid-widget', widget: 'marketplace-feed', type: 'resize', height: 1840 }, over);

describe('embed.decide — origin + source validation', () => {
  test('accepts a valid resize from the trusted origin + matching frame', () => {
    expect(embed.decide(ORIGIN, true, good())).toEqual({ type: 'resize', height: 1840 });
  });
  test('rejects a FOREIGN origin (even with a perfect payload)', () => {
    expect(embed.decide('https://evil.example', true, good())).toBeNull();
    expect(embed.decide('https://www.advantage.bid', true, good())).toBeNull(); // parent origin is NOT the sender
    expect(embed.decide('http://bid.advantage.bid', true, good())).toBeNull();  // wrong scheme
  });
  test('rejects when event.source is NOT this iframe', () => {
    expect(embed.decide(ORIGIN, false, good())).toBeNull();
  });
  test('rejects a wrong/missing envelope (source/widget)', () => {
    expect(embed.decide(ORIGIN, true, good({ source: 'somebody-else' }))).toBeNull();
    expect(embed.decide(ORIGIN, true, good({ widget: 'other-widget' }))).toBeNull();
    expect(embed.decide(ORIGIN, true, null)).toBeNull();
    expect(embed.decide(ORIGIN, true, undefined)).toBeNull();
  });
});

describe('embed.decide — height clamping', () => {
  test('clamps below MIN and above MAX; rejects non-numeric', () => {
    expect(embed.decide(ORIGIN, true, good({ height: 10 }))).toEqual({ type: 'resize', height: embed.MIN });
    expect(embed.decide(ORIGIN, true, good({ height: 999999 }))).toEqual({ type: 'resize', height: embed.MAX });
    expect(embed.decide(ORIGIN, true, good({ height: 'tall' }))).toBeNull();
    expect(embed.decide(ORIGIN, true, good({ height: NaN }))).toBeNull();
  });
  test('respects custom min/max opts', () => {
    expect(embed.decide(ORIGIN, true, good({ height: 500 }), { min: 600, max: 5000 })).toEqual({ type: 'resize', height: 600 });
  });
});

describe('embed.decide — scroll routing', () => {
  test('scroll-to-widget from the trusted origin → {type:scroll}', () => {
    expect(embed.decide(ORIGIN, true, good({ type: 'scroll-to-widget' }))).toEqual({ type: 'scroll' });
  });
  test('scroll-to-widget from a foreign origin is ignored', () => {
    expect(embed.decide('https://evil.example', true, good({ type: 'scroll-to-widget' }))).toBeNull();
  });
  test('unknown message type → null', () => {
    expect(embed.decide(ORIGIN, true, good({ type: 'exec' }))).toBeNull();
  });
});

describe('embed.resolveOffsetValue — sticky-header offset precedence', () => {
  test('global window value wins over everything', () => {
    expect(embed.resolveOffsetValue(190, '50', '20', 80)).toBe(190);
  });
  test('then iframe attr, then html attr, then auto-detected fallback', () => {
    expect(embed.resolveOffsetValue(undefined, '150', '20', 80)).toBe(150);
    expect(embed.resolveOffsetValue(undefined, null, '120', 80)).toBe(120);
    expect(embed.resolveOffsetValue(undefined, null, null, 64)).toBe(64);
    expect(embed.resolveOffsetValue(undefined, null, null, undefined)).toBe(0);
  });
  test('ignores non-numeric/NaN configured values, falls through', () => {
    expect(embed.resolveOffsetValue(NaN, 'abc', '', 40)).toBe(40);
  });
});

describe('embed helper — BD-robust iframe detection', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'widgets', 'marketplace-embed.js'), 'utf8');
  test('detects the widget by src (BD-preserved), not only by stripped id/data attrs', () => {
    expect(src).toContain('iframe[src*="/widgets/marketplace-feed.html"]');
    expect(src).toContain('iframe[src*="/widgets/featured-items.html"]'); // second widget, additive
    expect(src).toContain('data-adv-widget'); // also honors the attr when BD keeps it
  });
  test('prevents scroll anchoring + scrolls after double rAF with a re-assert', () => {
    expect(src).toContain("overflowAnchor = 'none'");
    expect(src).toMatch(/requestAnimationFrame\([\s\S]{0,80}requestAnimationFrame/);
    expect(src).toContain('setTimeout');
  });
  test('requests an initial height from each iframe (handshake) using the widget origin', () => {
    expect(src).toContain('function requestResize');
    expect(src).toMatch(/source: 'advantage-bid-embed', type: 'request-resize', widget: widgetOf\(fs\[i\]\)/);
    expect(src).toMatch(/setTimeout\(requestResize/);
  });
});

describe('BD wrapper doc — all three widgets present + strict validation', () => {
  test('all three presets present + helper loaded from a script-allowed area (Footer Scripts)', () => {
    for (const preset of ['all-events', 'auctions', 'estate-sales']) expect(doc).toContain('preset=' + preset);
    expect(doc).toContain('marketplace-embed.js');
    expect(doc).toMatch(/Footer Scripts/i);
  });
  test('doc explains BD strips scripts/attrs and the helper detects by src', () => {
    expect(doc).toMatch(/strip/i);
    expect(doc).toMatch(/by (its )?`?src`?/i);
    expect(doc).toContain('window.ADV_SCROLL_OFFSET');
  });
  test('doc states strict origin validation and no wildcard trust', () => {
    expect(doc).toContain('https://bid.advantage.bid');
    expect(doc).toMatch(/No wildcard trust|strict|validate/i);
  });
});
