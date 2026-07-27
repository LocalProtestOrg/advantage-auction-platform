'use strict';

/**
 * Unified marketplace feed (Increment 8).
 *
 * One discovery experience: Auctions + Marketplace Events (+ future Listings) in a SINGLE grid,
 * every item rendered through the one entry point makeMarketplaceCard(). Guards: no separate grids,
 * no duplicate rendering logic, both content types fetched and merged, and a type filter that keeps
 * it a single feed rather than split sections.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const feed = read('public', 'widgets', 'marketplace-feed.js');
const page = read('public', 'all-events.html');

describe('the feed renders every type through the single card entry point', () => {
  test('uses makeMarketplaceCard and does NOT call the type-specific renderers directly', () => {
    expect(feed).toMatch(/MC\.makeMarketplaceCard\(it,/);
    expect(feed).not.toContain('makeAuctionCard');
    expect(feed).not.toContain('makeEventCard');
  });
  test('renders into ONE grid (no separate auction/event grids)', () => {
    const grids = feed.match(/className = 'auctions-grid'/g) || [];
    expect(grids.length).toBe(1);
  });
});

describe('the feed merges auctions and events', () => {
  test('fetches auctions (featured + all) and events', () => {
    expect(feed).toContain('/api/public/featured-auctions');
    expect(feed).toContain('/api/public/auctions');
    expect(feed).toContain('/api/public/events');
  });
  test('tags each item with its content_type for the dispatcher', () => {
    expect(feed).toMatch(/content_type = 'auction'/);
    expect(feed).toMatch(/content_type = 'event'/);
  });
  test('unified ordering puts featured first, then soonest-relevant date', () => {
    expect(feed).toMatch(/function unifiedSort/);
    expect(feed).toMatch(/_featured \? 0 : 1/);
    expect(feed).toMatch(/function sortDate/);
  });
});

describe('a single experience with a type filter (not split sections)', () => {
  test('offers All / Auctions / Events chips that re-render the one grid', () => {
    expect(feed).toContain('mkt-filter');
    expect(feed).toMatch(/\['all', 'All'/);
    expect(feed).toMatch(/activeFilter = f\[0\]/);
  });
  test('configurable container + types + api base (embeddable on BD /all-events)', () => {
    expect(feed).toMatch(/dataset\.container/);
    expect(feed).toMatch(/dataset\.types/);
    expect(feed).toMatch(/dataset\.apiBase/);
  });
});

describe('canonical platform page wires the unified feed', () => {
  test('all-events.html includes the shared components + the unified feed widget + one container', () => {
    expect(page).toContain('/marketplace-components.js');
    expect(page).toContain('/widgets/marketplace-feed.js');
    expect(page).toContain('id="marketplace-feed"');
    expect(page).toMatch(/data-types="auctions,events"/);
  });
});
