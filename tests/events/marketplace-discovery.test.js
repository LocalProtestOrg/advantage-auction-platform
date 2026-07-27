'use strict';

/**
 * Marketplace discovery parity (Increment 7).
 *
 * Events must be discoverable like auctions and render through the SAME card framework, so
 * Auctions + Marketplace Events (+ future Listings) share one discovery grid. Guards: the event
 * feed gains text/city/state/type filters + tier-aware ranking, and the shared card library gains
 * a type-dispatching entry point without disturbing the existing auction card.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const feed = read('src', 'routes', 'publicEvents.js');
const comp = read('public', 'marketplace-components.js');

describe('event feed reaches auction discovery parity', () => {
  test('adds text (q), city, state, and event_type filters', () => {
    expect(feed).toContain('e.event_type = $');
    expect(feed).toMatch(/e\.title ILIKE .*e\.description ILIKE .*e\.city ILIKE .*e\.venue_name ILIKE/s);
    expect(feed).toContain('e.city ILIKE $');
    expect(feed).toContain('UPPER(e.state) = $');
  });
  test('ranks by featured, then membership search-placement tier, then start date', () => {
    expect(feed).toContain('LEFT JOIN organization_plans p ON p.plan_tier = o.plan_tier');
    expect(feed).toMatch(/ORDER BY e\.is_featured DESC, COALESCE\(p\.search_placement_tier, 3\) ASC, e\.start_at ASC/);
  });
  test('serializer tags each item with a content_type discriminator', () => {
    expect(feed).toMatch(/content_type:\s*'event'/);
  });
});

describe('shared card framework renders events like auctions', () => {
  test('makeEventCard + makeMarketplaceCard are exported', () => {
    expect(comp).toMatch(/makeEventCard:\s*makeEventCard/);
    expect(comp).toMatch(/makeMarketplaceCard:\s*makeMarketplaceCard/);
  });
  test('event card reuses the shared .auction-card shell and links to the event page', () => {
    const fn = comp.slice(comp.indexOf('function makeEventCard'), comp.indexOf('function makeMarketplaceCard'));
    expect(fn).toMatch(/a\.className = 'auction-card'/);
    expect(fn).toContain('/event.html?slug=');
    // privacy-safe: only city/state, never a raw address field
    expect(fn).toMatch(/\[event\.city, event\.state\]/);
    expect(fn).not.toContain('event.address');
  });
  test('makeMarketplaceCard dispatches by content_type; auctions stay the default', () => {
    const fn = comp.slice(comp.indexOf('function makeMarketplaceCard'), comp.indexOf('function makeMarketplaceCard') + 240);
    expect(fn).toMatch(/content_type === 'event'.*makeEventCard/s);
    expect(fn).toMatch(/return makeAuctionCard/);
  });
  test('the existing makeAuctionCard export is unchanged (no parallel rewrite)', () => {
    expect(comp).toMatch(/makeAuctionCard:\s*makeAuctionCard/);
  });
});
