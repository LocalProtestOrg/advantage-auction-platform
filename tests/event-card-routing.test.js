'use strict';

/**
 * Regression guard for the "event detail pages show only gray boxes" defect.
 *
 * Root cause: the embeddable widgets' cards linked to the canonical Railway detail pages
 * (event.html / auction-view.html / lot.html) with NO target. Inside the cross-origin BD iframe a
 * click navigated the IFRAME to those pages, which Railway refuses to frame (X-Frame-Options:
 * SAMEORIGIN) → a blank/gray frame. The fix: open the card in the TOP window (target="_top"), so the
 * canonical Railway detail page loads full-screen where it renders correctly. Source-level assertions
 * (the codebase's pattern for widget/routing invariants).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('widget cards open the canonical Railway detail page in the TOP window', () => {
  const feed = read('public', 'widgets', 'marketplace-feed.js');
  const items = read('public', 'widgets', 'featured-items.js');

  test('marketplace-feed event card uses target="_top" (not framed in the BD iframe)', () => {
    expect(feed).toMatch(/<a class="amf-card" target="_top" href="' \+ API_BASE \+ esc\(it\.url\)/);
  });
  test('marketplace-feed card href is the ABSOLUTE Railway URL (API_BASE), never a BD/relative URL', () => {
    expect(feed).toContain("var API_BASE = 'https://bid.advantage.bid'");
    expect(feed).toMatch(/href="' \+ API_BASE \+ esc\(it\.url\)/);
  });
  test('featured-items lot card uses target="_top" as well', () => {
    expect(items).toMatch(/<a class="fi-card" target="_top" href="' \+ esc\(it\.canonicalUrl\)/);
  });
});

describe('feed routes each card to the correct canonical page (public.js)', () => {
  const pub = read('src', 'routes', 'public.js');
  const feedHandler = pub.slice(pub.indexOf("router.get('/marketplace/feed'"), pub.indexOf("router.get('/auctions'"));

  test('an event (has a slug — incl. auction-type events) links to /event.html?slug=', () => {
    expect(feedHandler).toMatch(/r\.slug\s*\?\s*'\/event\.html\?slug='/);
  });
  test('a native auction (no slug) links to /auction-view.html?auctionId=', () => {
    expect(feedHandler).toMatch(/:\s*'\/auction-view\.html\?auctionId='\s*\+\s*encodeURIComponent\(r\.ref_id\)/);
  });
  test('a card is never routed to a generic BD listing page (/estate-sales) or an empty slug', () => {
    // The url is always one of the two canonical Railway detail routes — never /estate-sales, never bare.
    expect(feedHandler).not.toMatch(/url:\s*'\/estate-sales'/);
    expect(feedHandler).not.toMatch(/url:\s*'\/event\.html\?slug='\s*[,}]/); // slug is always appended, never empty
  });
});

describe('the canonical Railway event page carries event-specific ShareMeta (not a generic shell)', () => {
  // shareMetaService builds per-entity title/canonical/OG/JSON-LD for /event.html; covered in depth by
  // tests/share-meta.test.js. Here we assert the wiring that makes an ACTIVE event a real page, not a
  // generic shell: the public event-detail endpoint (SPA + ShareMeta source of truth) exists.
  const publicEvents = read('src', 'routes', 'publicEvents.js');
  test('a public event-detail endpoint (GET /events/:slug) exists and returns the event + images', () => {
    expect(publicEvents).toMatch(/router\.get\('\/events\/:slug'/);
    expect(publicEvents).toMatch(/all images/i);
  });
});
