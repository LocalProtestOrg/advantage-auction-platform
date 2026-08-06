'use strict';

/**
 * GSA / online-auction public visibility (Phase 5F follow-up). Source-level contract assertions (the
 * codebase's pattern) proving imported ONLINE auctions (sale_type='auction', event_format='online',
 * null coords) are visible on every LIST/FEED surface — and correctly stay off the geographic map —
 * plus the homepage drawer's new online-auctions section.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const publicRoutes = read('src', 'routes', 'public.js');
const publicEvents = read('src', 'routes', 'publicEvents.js');
const index = read('public', 'index.html');

describe('marketplace feed — online auctions are included (no coord/image gate)', () => {
  test('events branch gates ONLY on published + not-expired; no coord requirement anywhere in the feed', () => {
    expect(publicRoutes).toMatch(/e\.status = 'published' AND \(e\.end_at IS NULL OR e\.end_at >= now\(\)\)/);
    expect(publicRoutes).not.toMatch(/e\.lat IS NOT NULL/);   // events are never coord-gated in the feed
  });
  test('classifies sale_type=auction as an auction (never online_auction / auction_event / kind=event)', () => {
    expect(publicRoutes).toMatch(/CASE WHEN e\.sale_type = 'auction' THEN 'auction' ELSE 'estate_sale' END/);
    expect(publicRoutes).not.toMatch(/online_auction|auction_event/);
  });
  test('type filter is applied on the classified kind (auction-only / estate-sale-only presets work)', () => {
    expect(publicRoutes).toMatch(/feed\.kind = \$/);
  });
  test('pagination total counts ALL matches (COUNT(*) OVER()) — GSA auctions included in totals', () => {
    expect(publicRoutes).toMatch(/COUNT\(\*\) OVER\(\) AS total_count/);
  });
  test('server-enforced presets map all-events/auctions/estate-sales', () => {
    expect(publicRoutes).toMatch(/'all-events': 'all'/);
    expect(publicRoutes).toMatch(/auctions: 'auction'/);
    expect(publicRoutes).toMatch(/'estate-sales': 'estate_sale'/);
  });
});

describe('/api/public/events (list) — includes coordless online auctions', () => {
  const list = publicEvents.slice(publicEvents.indexOf("router.get('/events'"), publicEvents.indexOf('// GET /api/public/events/map'));
  test('gates on active only; no coord or type requirement (online auctions listed)', () => {
    expect(list).toMatch(/e\.status = 'published'/);
    expect(list).toMatch(/e\.end_at IS NULL OR e\.end_at >= now\(\)/);
    expect(list).not.toMatch(/e\.lat IS NOT NULL/);
  });
});

describe('/api/public/events/map — physical only (online auctions correctly excluded, no fake pins)', () => {
  const map = publicEvents.slice(publicEvents.indexOf("router.get('/events/map'"), publicEvents.indexOf("router.get('/events/:slug'"));
  test('map still requires coordinates (online auctions are NOT given fabricated pins)', () => {
    expect(map).toMatch(/e\.lat IS NOT NULL/);
    expect(map).toMatch(/e\.lng IS NOT NULL/);
  });
});

describe('homepage drawer — online auctions surfaced list-only', () => {
  test('fetches the auction feed and keeps ONLY coordless auctions for the drawer', () => {
    expect(index).toMatch(/marketplace\/feed\?preset=auctions/);
    expect(index).toMatch(/ONLINE_AUCTIONS=/);
    expect(index).toMatch(/r\.type==='auction' && r\.lat==null && r\.lng==null/);
  });
  test('buildList renders an "Online auctions" section from ONLINE_AUCTIONS (never viewport-filtered)', () => {
    expect(index).toMatch(/function onlineAuctionsFor/);
    expect(index).toMatch(/onlineRows=onlineAuctionsFor\(f,q\)/);
    expect(index).toMatch(/Online auctions · nationwide/);
    // empty state only when BOTH the map viewport AND online auctions are empty
    expect(index).toMatch(/!rows\.length && !onlineRows\.length/);
  });
  test('online-auction records carry no map pin (isEvent:false, null coords) so they never pin the map', () => {
    const feedToDrawer = index.slice(index.indexOf('function feedToDrawer'), index.indexOf('function feedToDrawer') + 700);
    expect(feedToDrawer).toMatch(/lng:null, lat:null/);
    expect(feedToDrawer).toMatch(/isEvent:false/);
  });
  test('HUD no longer falsely claims "No live auctions right now"', () => {
    expect(index).not.toMatch(/No live auctions right now/);
  });
  test('online auctions exclude ended events (fresh inventory)', () => {
    const fn = index.slice(index.indexOf('function onlineAuctionsFor'), index.indexOf('function onlineAuctionsFor') + 320);
    expect(fn).toMatch(/state!=='historical'/);
  });
});
