'use strict';

/**
 * Auction-level bidding-window gate (src/lib/biddingWindow.js).
 *
 * This is the server-side guard that backs POST /api/lots/:lotId/bids: a bid is
 * rejected with 422 "Bidding has not opened for this auction yet" unless this
 * predicate returns true. Covers the Summer Showcase / upcoming-auction case where
 * lots are 'open' but the auction has not started.
 */

const { auctionBiddingOpen } = require('../src/lib/biddingWindow');

const PAST   = new Date('2026-01-01T00:00:00Z');
const NOW    = new Date('2026-06-16T12:00:00Z');
const FUTURE = new Date('2026-07-15T16:00:00Z');

describe('auctionBiddingOpen', () => {
  test('active auction whose start_time has passed → biddable', () => {
    expect(auctionBiddingOpen('active', PAST, NOW)).toBe(true);
  });

  test('active auction with null start_time → biddable (no scheduled gate)', () => {
    expect(auctionBiddingOpen('active', null, NOW)).toBe(true);
  });

  test('published upcoming auction (future start) → NOT biddable', () => {
    // Summer Showcase: state='published', start 2026-07-15. Lots may be 'open'.
    expect(auctionBiddingOpen('published', FUTURE, NOW)).toBe(false);
  });

  test('published auction whose start has passed but not yet promoted → NOT biddable', () => {
    // Scheduler lag: still 'published' even though start_time passed. Stay closed.
    expect(auctionBiddingOpen('published', PAST, NOW)).toBe(false);
  });

  test('manual early flip to active before start_time → still NOT biddable', () => {
    // Defense in depth: even if state is forced to 'active', the future start_time
    // keeps bidding closed until the scheduled moment.
    expect(auctionBiddingOpen('active', FUTURE, NOW)).toBe(false);
  });

  test('closed / draft / submitted auctions → NOT biddable', () => {
    expect(auctionBiddingOpen('closed', PAST, NOW)).toBe(false);
    expect(auctionBiddingOpen('draft', null, NOW)).toBe(false);
    expect(auctionBiddingOpen('submitted', null, NOW)).toBe(false);
  });

  test('exact start boundary → biddable (now === start)', () => {
    expect(auctionBiddingOpen('active', NOW, NOW)).toBe(true);
  });

  test('invalid start_time is ignored (state still governs)', () => {
    expect(auctionBiddingOpen('active', 'not-a-date', NOW)).toBe(true);
  });
});
