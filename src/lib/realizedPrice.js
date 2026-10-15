// #20.1 Realized-price privacy.
// A CLOSED lot's realized/sold price (winning amount — and the final current bid,
// which equals it) is gated to logged-in users. Anonymous callers get those
// fields nulled plus a `realized_price_hidden` flag so the UI can render a
// "log in to view realized prices" prompt. OPEN/active lots are untouched, so
// live current-bid information stays public. Rows that alias the lot state as
// `lot_state` (cross-auction feeds) are recognised too.
function redactRealizedPrice(lot, isAuthed) {
  if (!lot || isAuthed) return lot;
  if ((lot.state || lot.lot_state) === 'closed') {
    return Object.assign({}, lot, {
      winning_amount_cents: null,
      current_bid_cents: null,
      next_min_bid_cents: null,
      realized_price_hidden: true,
    });
  }
  return lot;
}

module.exports = { redactRealizedPrice };
