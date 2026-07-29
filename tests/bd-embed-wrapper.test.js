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

describe('BD wrapper doc — all three widgets present + strict validation', () => {
  test('each wrapper has a unique iframe id + data-adv-widget + correct preset', () => {
    for (const [id, preset] of [['adv-all-events', 'all-events'], ['adv-auctions', 'auctions'], ['adv-estate-sales', 'estate-sales']]) {
      expect(doc).toContain('id="' + id + '"');
      expect(doc).toContain('preset=' + preset);
    }
    expect(doc).toContain('data-adv-widget="marketplace-feed"');
    expect(doc).toContain('marketplace-embed.js');
  });
  test('doc states strict origin validation and no wildcard trust', () => {
    expect(doc).toContain('https://bid.advantage.bid');
    expect(doc).toMatch(/only accepts messages|strict|validate/i);
  });
});
