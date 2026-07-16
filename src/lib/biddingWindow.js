'use strict';

/**
 * Auction-level bidding window gate.
 *
 * Bidding model (owner decision): a PUBLISHED (approved) auction begins accepting
 * bids immediately, and keeps accepting them once it is 'active'. start_time no
 * longer gates when bidding opens — it marks when the staggered lot-closing
 * sequence begins (the scheduler promotes published -> active at start_time and
 * active -> closed at end_time; per-lot closes_at drive the actual closes).
 *
 * So an auction is biddable while it is 'published' OR 'active'. It is NOT biddable
 * as a draft/submitted (not yet approved+published) or once 'closed'/'withdrawn'.
 *
 * This gate is ONLY the auction-window check — all authentication, registration,
 * terms, card-on-file, and authorization rules are enforced separately (see
 * auctionRegistrationService.assertCanBid) and are unchanged.
 *
 * The extra parameters are accepted and ignored for backward compatibility with the
 * previous (state, startTime, now) signature.
 *
 * @param {string|null} auctionState   auctions.state
 * @returns {boolean} true when the auction may accept bids right now
 */
function auctionBiddingOpen(auctionState /*, startTime, now */) {
  return auctionState === 'published' || auctionState === 'active';
}

module.exports = { auctionBiddingOpen };
