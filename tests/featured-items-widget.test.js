'use strict';

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const widget = read('public', 'widgets', 'featured-items.js');
const html = read('public', 'widgets', 'featured-items.html');
const pub = read('src', 'routes', 'public.js');
const server = read('server.js');

describe('Featured Items WIDGET — premium image-first discovery grid', () => {
  test('reuses the proven postMessage resize/scroll contract with widget:"featured-items"', () => {
    expect(widget).toContain("WIDGET_ID = 'featured-items'");
    expect(widget).toMatch(/source: MSG_SRC, type: 'resize', widget: WIDGET_ID, height/);
    expect(widget).toMatch(/type: 'scroll-to-widget', widget: WIDGET_ID, target: 'results-top'/);
    expect(widget).toContain('ResizeObserver');
    expect(widget).toContain('function onParentMessage'); // request-resize handshake
    expect(widget).toMatch(/d\.type === 'request-resize'/);
  });
  test('responsive premium grid (4/3/2/1), NOT a carousel', () => {
    expect(widget).toContain('grid-template-columns:repeat(4,1fr)');
    expect(widget).toContain('repeat(3,1fr)');
    expect(widget).toContain('repeat(2,1fr)');
    expect(widget).toMatch(/max-width:520px[^}]*1fr/);
    expect(widget).not.toMatch(/carousel|scroll-snap/i);
    expect(widget).toContain('aspect-ratio:4/3'); // reserved image space → no layout shift
  });
  test('whole card is a single anchor to the canonical lot page (no nested interactive els)', () => {
    expect(widget).toMatch(/<a class="fi-card" href="' \+ esc\(it\.canonicalUrl\)/);
    expect(widget).not.toMatch(/<button[^>]*>[^<]*<a/); // no nested interactive
  });
  test('true numbered pagination, 12/page, capped at 6 pages', () => {
    expect(widget).toContain('PAGE_SIZE = 12');
    expect(widget).toContain('MAX_PAGES = 6');
    expect(widget).toContain('function pageWindow');
    expect(widget).toContain('function goToPage');
    expect(widget).toMatch(/Math\.min\(MAX_PAGES/);
    expect(widget).toContain('aria-current="page"');
    expect(widget).toMatch(/cur <= 1 \? ' disabled'/);
    expect(widget).toMatch(/cur >= tp \? ' disabled'/);
  });
  test('pricing distinguishes current bid / starting-no-bids; no in-widget bidding', () => {
    expect(widget).toContain('Current bid');
    expect(widget).toMatch(/no bids yet/i);
    expect(widget).not.toMatch(/place\s*bid|placeBid|submitBid/i); // marketing widget never transacts
  });
  test('badges are data-driven + capped (no overload)', () => {
    expect(widget).toContain('BADGE_MAP');
    expect(widget).toMatch(/slice\(0, 2\)/); // at most 2 badges
    expect(widget).toContain('Ending Soon');
    expect(widget).toContain('No Bids Yet');
  });
  test('approved empty + error states link to active auctions (no raw errors)', () => {
    expect(widget).toMatch(/New items are being added/);
    expect(widget).toContain('Browse active auctions');
    expect(widget).toContain('function renderError');
  });
  test('accessibility + analytics, BD owns H1 (widget uses h2/h3)', () => {
    expect(widget).toContain('aria-live');
    expect(widget).toContain('<h2 class="fi-h"');
    expect(widget).toContain('<h3 class="fi-title">');
    expect(widget).not.toMatch(/<h1/);
    expect(widget).toContain("loading=\"lazy\"");
    for (const e of ['impression', 'item_click', 'pagination', 'items_rendered', 'empty'])
      expect(widget).toContain("'" + e + "'");
  });
  test('embed html is noindex and loads the widget by placement', () => {
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('featured-items.js');
    expect(html).toContain('data-placement');
  });
});

describe('GET /api/public/discovery/items — public contract', () => {
  const h = pub.slice(pub.indexOf("router.get('/discovery/items'"), pub.indexOf("router.get('/lots/search'"));
  test('rate-limited, delegates to discoveryService, ETag + public cache', () => {
    expect(h).toContain('normalLimiter');
    expect(h).toContain('discoveryService.getFeaturedItems');
    expect(h).toContain("res.set('ETag'");
    expect(h).toContain('if-none-match');
    expect(h).toContain('PUBLIC_CACHE');
  });
  test('ONLY passes the four V1 public params (no no-op personalization params)', () => {
    expect(h).toContain('page: req.query.page');
    expect(h).toContain('limit: req.query.limit');
    expect(h).toContain('placement: req.query.placement');
    expect(h).toContain('sort: req.query.sort');
    for (const bad of ['buyerId', 'sessionId', 'recentlyViewed', 'recentSearch', 'preferredCategories'])
      expect(h).not.toContain(bad);
  });
});

describe('GET /items — crawlable SEO discovery page', () => {
  const r = server.slice(server.indexOf("app.get('/items'"), server.indexOf("Clean, canonical URL for the seller"));
  test('server-rendered, indexable, canonical + rel prev/next', () => {
    expect(r).toContain('index,follow');
    expect(r).toContain('rel="canonical"');
    expect(r).toContain('rel="prev"');
    expect(r).toContain('rel="next"');
  });
  test('crawlable lot anchors + numbered ?page pagination links', () => {
    expect(r).toContain('it.canonicalUrl');
    expect(r).toMatch(/\/items.*\?page=/);
    expect(r).toContain('aria-current="page"');
  });
  test('WebPage + BreadcrumbList + ItemList JSON-LD; NOT Product (no retail misrepresentation)', () => {
    expect(r).toContain("'@type': 'WebPage'");
    expect(r).toContain("'@type': 'BreadcrumbList'");
    expect(r).toContain("'@type': 'ItemList'");
    expect(r).toContain("'@type': 'ListItem'");
    expect(r).not.toContain("'@type': 'Product'");
    expect(r).toContain('application/ld+json');
  });
  test('added to the dynamic sitemap', () => {
    expect(server).toMatch(/staticPaths[\s\S]*'\/items'/);
  });
});
