'use strict';

/**
 * Auction-level bidding-window gate (src/lib/biddingWindow.js).
 *
 * This is the server-side guard that backs POST /api/lots/:lotId/bids: a bid is
 * rejected with 422 "Bidding has not opened for this auction yet" unless this
 * predicate returns true.
 *
 * BIDDING MODEL (owner decision): a PUBLISHED (approved) auction begins accepting
 * bids immediately, and keeps accepting them once 'active'. start_time no longer
 * gates bidding — it marks when the staggered lot-closing sequence begins. So the
 * gate is purely: biddable while 'published' OR 'active'.
 */

const { auctionBiddingOpen } = require('../src/lib/biddingWindow');

const PAST   = new Date('2026-01-01T00:00:00Z');
const NOW    = new Date('2026-06-16T12:00:00Z');
const FUTURE = new Date('2026-07-15T16:00:00Z');

describe('auctionBiddingOpen (immediate-bidding-on-publish model)', () => {
  test('published auction → biddable immediately, regardless of start_time', () => {
    // The core change: a published auction with a FUTURE start (closing hasn't begun)
    // now accepts bids — bidding is open the moment it's published.
    expect(auctionBiddingOpen('published', FUTURE, NOW)).toBe(true);
    expect(auctionBiddingOpen('published', PAST, NOW)).toBe(true);
    expect(auctionBiddingOpen('published', null, NOW)).toBe(true);
  });

  test('active auction → biddable (closing sequence underway)', () => {
    expect(auctionBiddingOpen('active', PAST, NOW)).toBe(true);
    expect(auctionBiddingOpen('active', FUTURE, NOW)).toBe(true);
    expect(auctionBiddingOpen('active', null, NOW)).toBe(true);
  });

  test('draft / submitted (not yet approved+published) → NOT biddable', () => {
    expect(auctionBiddingOpen('draft', null, NOW)).toBe(false);
    expect(auctionBiddingOpen('submitted', null, NOW)).toBe(false);
  });

  test('closed / withdrawn → NOT biddable', () => {
    expect(auctionBiddingOpen('closed', PAST, NOW)).toBe(false);
    expect(auctionBiddingOpen('withdrawn', PAST, NOW)).toBe(false);
  });

  test('null / unknown state → NOT biddable', () => {
    expect(auctionBiddingOpen(null)).toBe(false);
    expect(auctionBiddingOpen(undefined)).toBe(false);
    expect(auctionBiddingOpen('nonsense')).toBe(false);
  });

  test('start_time / now arguments are ignored (state alone governs)', () => {
    // Backward-compatible signature: extra args accepted, never change the outcome.
    expect(auctionBiddingOpen('published', 'not-a-date', NOW)).toBe(true);
    expect(auctionBiddingOpen('active')).toBe(true);
  });
});
