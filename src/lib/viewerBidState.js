// #2/#10 Viewer bid-state annotation.
//
// Adds a privacy-safe `viewer_is_high_bidder` boolean to a lot for the
// authenticated viewer, computed by comparing the viewer's id to the lot's
// CURRENT live leader (open lots) or final winner (closed lots). The raw
// winner UUIDs (current_winner_user_id, winning_buyer_user_id) are read ONLY to
// compute this boolean and are STRIPPED from the returned object — buyers must
// never see another bidder's identity (public identity is the paddle number).
//
// Logged-out callers (no userId) always get viewer_is_high_bidder = false; no
// identity is leaked. Realized-price privacy is handled separately by
// redactRealizedPrice — call this BEFORE that so the stripped object still flows
// through the price gate.
function annotateViewerBidState(lot, userId) {
  if (!lot || typeof lot !== 'object') return lot;
  const winnerId = lot.state === 'closed'
    ? (lot.winning_buyer_user_id != null ? lot.winning_buyer_user_id : null)
    : (lot.current_winner_user_id != null ? lot.current_winner_user_id : null);

  const out = { ...lot };
  out.viewer_is_high_bidder = !!userId && winnerId != null && winnerId === userId;
  // Never expose bidder identities to buyers.
  delete out.current_winner_user_id;
  delete out.winning_buyer_user_id;
  return out;
}

module.exports = { annotateViewerBidState };
