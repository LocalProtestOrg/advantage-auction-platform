/* Bidder status derivation — SINGLE SOURCE OF TRUTH for the Winning/Outbid panel
 * on both the auction catalog cards and the lot page (#2). UMD: require() in Node
 * (tests) and <script> in the browser (window.BidStatus).
 *
 * Privacy: consumes ONLY the per-viewer, identity-free fields from the lot
 * serializer (viewer_is_high_bidder, viewer_has_bid, viewer_max_bid_cents) — it
 * never sees or needs another bidder's identity.
 *
 * Clarity over cleverness: a first-time bidder must instantly know their standing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BidStatus = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Returns a structured status for a lot from the viewer's perspective:
  //   key   : 'winning' | 'outbid' | 'watching' | 'won' | 'sold' | 'closed'
  //   label : human text for the badge
  //   tone  : 'win' (green) | 'lose' (red) | 'neutral'
  //   isClosed, isOpen, winning, hasBid
  //   maxBidCents     : the viewer's own max bid (cents) or null
  //   nextMinCents    : next acceptable bid (cents) or null
  //   extended        : lot was anti-snipe extended
  //   closingSoon     : within 60s of close (when closesAt provided)
  function deriveBidderStatus(lot) {
    lot = lot || {};
    var state    = String(lot.state || 'open').toLowerCase();
    var isClosed = state === 'closed' || state === 'withdrawn';
    var winning  = !!lot.viewer_is_high_bidder;
    var hasBid   = !!lot.viewer_has_bid;
    var maxCents = (lot.viewer_max_bid_cents != null) ? Number(lot.viewer_max_bid_cents) : null;
    var nextMin  = (Number(lot.next_min_bid_cents) > 0) ? Number(lot.next_min_bid_cents) : null;

    var key, label, tone;
    if (isClosed) {
      if (winning)                                  { key = 'won';    label = '✓ You won'; tone = 'win'; }
      else if (Number(lot.winning_amount_cents) > 0){ key = 'sold';   label = 'Sold';      tone = 'neutral'; }
      else                                          { key = 'closed'; label = 'Closed';    tone = 'neutral'; }
    } else if (winning)                             { key = 'winning';  label = '✓ Winning'; tone = 'win'; }
    else if (hasBid)                                { key = 'outbid';   label = 'Outbid';    tone = 'lose'; }
    else                                            { key = 'watching'; label = 'Watching';  tone = 'neutral'; }

    var closingSoon = false;
    var closesAt = lot.extended_until || lot.closes_at || null;
    if (!isClosed && closesAt) {
      var remaining = new Date(closesAt).getTime() - Date.now();
      closingSoon = remaining > 0 && remaining <= 60000;
    }

    return {
      key: key, label: label, tone: tone,
      isClosed: isClosed, isOpen: !isClosed,
      winning: winning, hasBid: hasBid,
      maxBidCents: maxCents, nextMinCents: nextMin,
      extended: Number(lot.extension_count) > 0,
      closingSoon: closingSoon,
    };
  }

  return { deriveBidderStatus: deriveBidderStatus };
}));
