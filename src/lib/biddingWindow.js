'use strict';

/**
 * Auction-level bidding window gate.
 *
 * Registration opens while an auction is 'published' (scheduled), but the auction
 * is only BIDDABLE once it has actually started. The scheduler
 * (notificationWorker.runAuctionStateTransitions) promotes published -> active when
 * start_time <= now, and active -> closed at end_time. So a biddable auction is one
 * that is 'active' AND whose start_time has passed.
 *
 * We check BOTH conditions so that a manual/early flip to 'active' still cannot open
 * bidding before the scheduled start_time, and so a not-yet-promoted 'published'
 * auction (whose lots are already 'open') cannot receive bids.
 *
 * @param {string|null} auctionState   auctions.state
 * @param {Date|string|null} startTime  auctions.start_time
 * @param {Date} [now]                  injectable clock for tests
 * @returns {boolean} true only when the auction may accept bids right now
 */
function auctionBiddingOpen(auctionState, startTime, now = new Date()) {
  if (auctionState !== 'active') return false;
  if (startTime != null) {
    const start = startTime instanceof Date ? startTime : new Date(startTime);
    if (!Number.isNaN(start.getTime()) && now < start) return false;
  }
  return true;
}

module.exports = { auctionBiddingOpen };
