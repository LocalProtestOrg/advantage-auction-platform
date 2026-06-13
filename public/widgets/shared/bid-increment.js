/* Canonical bid-increment ladder — SINGLE SOURCE OF TRUTH for server and client.
 * UMD: require() in Node (bidService, routes, tests) AND <script> in the browser
 * (exposes window.BidIncrement). Keeping one file means the client hint and the
 * server validation can never drift (the root cause of the "$1000+ stuck at $5"
 * defect was a flat $5 increment with no ladder).
 *
 * Platform default ladder (current price band → increment):
 *   $1.00–$19.99     → $1
 *   $20.00–$49.99    → $2.50
 *   $50.00–$199.99   → $5
 *   $200.00–$499.99  → $10
 *   $500.00–$999.99  → $25
 *   $1000.00–$2499.99→ $50
 *   $2500+           → $100
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BidIncrement = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [maxInclusiveCents, incrementCents] — first tier whose max >= price wins.
  var LADDER = [
    [1999, 100],      // $1.00 – $19.99   → $1.00
    [4999, 250],      // $20.00 – $49.99  → $2.50
    [19999, 500],     // $50.00 – $199.99 → $5.00
    [49999, 1000],    // $200.00 – $499.99→ $10.00
    [99999, 2500],    // $500.00 – $999.99→ $25.00
    [249999, 5000]    // $1000.00 – $2499.99 → $50.00
    // $2500.00+ → $100.00 (default below)
  ];
  var TOP_INCREMENT = 10000; // $100 for $2500+

  // Increment (cents) for the band containing `currentCents`.
  function incrementForCents(currentCents) {
    var c = Math.max(0, Math.floor(Number(currentCents) || 0));
    for (var i = 0; i < LADDER.length; i++) {
      if (c <= LADDER[i][0]) return LADDER[i][1];
    }
    return TOP_INCREMENT;
  }

  // Effective increment at a price: a positive flat override wins (professional
  // seller / admin), else the ladder band.
  function effectiveIncrement(currentCents, overrideCents) {
    var o = Number(overrideCents);
    return (Number.isFinite(o) && o > 0) ? Math.round(o) : incrementForCents(currentCents);
  }

  // Minimum acceptable next bid (cents) = max(starting, current + increment).
  // With no bids (current=0) this is max(starting, opening increment).
  function nextMinCents(startingCents, currentCents, overrideCents) {
    var s = Math.max(0, Math.round(Number(startingCents) || 0));
    var c = Math.max(0, Math.round(Number(currentCents) || 0));
    var n = Math.max(s, c + effectiveIncrement(c, overrideCents));
    return (Number.isFinite(n) && n > 0) ? n : (s > 0 ? s : 100);
  }

  return {
    LADDER: LADDER,
    TOP_INCREMENT: TOP_INCREMENT,
    incrementForCents: incrementForCents,
    effectiveIncrement: effectiveIncrement,
    nextMinCents: nextMinCents
  };
}));
