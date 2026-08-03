'use strict';

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const pub = read('src', 'routes', 'publicEvents.js');
const html = read('public', 'event.html');
const shareMeta = read('src', 'middleware', 'shareMeta.js');

describe('GET /api/public/events/:slug/related — keep visitors on Advantage.Bid', () => {
  const r = pub.slice(pub.indexOf("router.get('/events/:slug/related'"), pub.indexOf('// GET /api/public/event-markets'));
  test('published + not-ended only, excludes self', () => {
    expect(r).toMatch(/status = 'published'/);
    expect(r).toMatch(/end_at IS NULL OR e\.end_at >= now\(\)/);
    expect(r).toMatch(/e\.id <> \$/);
  });
  test('returns related (same market), nearby (great-circle), and companies', () => {
    expect(r).toMatch(/market_slug = \$/);
    expect(r).toMatch(/acos\(LEAST\(1, GREATEST\(-1/); // haversine
    expect(r).toMatch(/dist <= 100/);
    expect(r).toMatch(/FROM events e JOIN organizations o/); // companies
  });
  test('every related/nearby card links to the INTERNAL event page (never external)', () => {
    expect(r).toMatch(/url: '\/event\.html\?slug=' \+ encodeURIComponent/);
    expect(r).not.toMatch(/url:[^\n]*external_url/);
  });
  test('no private fields leaked (address/lat/lng/reserve/email)', () => {
    // cardOf only exposes slug/title/city/state/date/market/cover/badge/url
    const cardOf = r.slice(r.indexOf('const cardOf'), r.indexOf('const related'));
    expect(cardOf).not.toMatch(/address|\blat\b|\blng\b|reserve|email/);
  });
});

describe('event.html — Advantage.Bid page primary, external secondary + signposted', () => {
  test('ALL external links open a new tab with rel="nofollow noopener noreferrer"', () => {
    expect(html).toMatch(/var EXT = ' target="_blank" rel="nofollow noopener noreferrer"'/);
    // no external link uses a bare rel="noopener" (must be the full triplet)
    expect(html).not.toMatch(/rel="noopener"(?! noreferrer)/);
  });
  test('external CTA links ONLY to a verified company-controlled destination (never the discovery source)', () => {
    // The page uses the server-approved host_external_url (classifier already rejected discovery/competitors),
    // never the raw external_url/registration/bidding fields, and never "original listing" language.
    expect(html).toMatch(/e\.host_external_url/);
    expect(html).toMatch(/This event is conducted by/);
    expect(html).not.toMatch(/e\.registration_url \|\| e\.bidding_url \|\| e\.external_url/);
    expect(html).not.toMatch(/hosted on an external website/);
  });
  test('breadcrumbs use crawlable INTERNAL links', () => {
    expect(html).toMatch(/class="crumbs"[\s\S]*href="\/"[\s\S]*href="\/events\.html"/);
  });
  test('related/nearby cards link to the internal event page', () => {
    expect(html).toMatch(/class="ec" href="' \+ esc\(it\.url\)/);
    expect(html).toMatch(/encodeURIComponent\(slug\) \+ '\/related'/);
  });
  test('NEVER auto-redirects the visitor off Advantage.Bid', () => {
    expect(html).not.toMatch(/location\.href\s*=/);
    expect(html).not.toMatch(/location\.replace/);
    expect(html).not.toMatch(/window\.location\s*=/);
    expect(html).not.toMatch(/http-equiv=["']refresh/i);
  });
  test('does not set an external canonical (canonical stays the internal page)', () => {
    expect(html).not.toMatch(/rel=["']canonical["'][^>]*http/i);
  });
});

describe('shareMeta server-rendered event body — crawlable breadcrumb', () => {
  const b = shareMeta.slice(shareMeta.indexOf('function buildEventBody'), shareMeta.indexOf('function buildEventBody') + 900);
  test('emits an internal breadcrumb nav before the content', () => {
    expect(b).toMatch(/class="crumbs"[\s\S]*href="\/"[\s\S]*href="\/events\.html"/);
    expect(b).toMatch(/aria-current="page"/);
  });
});
