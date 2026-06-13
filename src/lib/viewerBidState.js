// #2/#10 Viewer bid-state annotation.
//
// Adds privacy-safe, per-viewer fields to a lot for the authenticated viewer:
//   viewer_is_high_bidder — viewer is the CURRENT leader (open) / final winner (closed)
//   viewer_has_bid        — viewer has a bid (proxy row) on this lot
//   viewer_max_bid_cents  — the viewer's OWN proxy maximum (their data only), or null
//
// The high-bidder flag compares the viewer's id to the lot's winner UUID; those
// raw UUIDs (current_winner_user_id, winning_buyer_user_id) are read ONLY to
// compute the flag and are STRIPPED from the returned object — buyers must never
// see another bidder's identity (public identity is the paddle number).
// viewer_max_bid_cents is the viewer's own maximum and is safe to return to them.
//
// Logged-out callers (no userId) get viewer_is_high_bidder/has_bid = false and a
// null max; no identity is leaked. Realized-price privacy is handled separately
// by redactRealizedPrice — call this BEFORE that so the stripped object still
// flows through the price gate.
function annotateViewerBidState(lot, userId, viewerMaxCents) {
  if (!lot || typeof lot !== 'object') return lot;
  const winnerId = lot.state === 'closed'
    ? (lot.winning_buyer_user_id != null ? lot.winning_buyer_user_id : null)
    : (lot.current_winner_user_id != null ? lot.current_winner_user_id : null);

  const hasBid = !!userId && viewerMaxCents != null;
  const out = { ...lot };
  out.viewer_is_high_bidder = !!userId && winnerId != null && winnerId === userId;
  out.viewer_has_bid        = hasBid;
  out.viewer_max_bid_cents  = hasBid ? Number(viewerMaxCents) : null;
  // Never expose bidder identities to buyers.
  delete out.current_winner_user_id;
  delete out.winning_buyer_user_id;
  return out;
}

module.exports = { annotateViewerBidState };
