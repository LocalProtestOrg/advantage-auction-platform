// Buyer notification content + relevance — PURE, side-effect-free, unit-testable.
// The worker joins the lot/auction at SEND time and passes them here, so emails
// always carry the human Lot # + Title (never a UUID), the auction name, the lot
// image, the current bid, and a direct CTA link.
//
// Privacy: these messages are 1:1 to a specific user. We render no bidder
// identities, no internal UUIDs as lot references (the CTA href contains the
// lotId only as a functional URL), and no realized prices to public contexts
// (the recipient is the winner/bidder, and stale post-close "bid now" emails are
// dropped by relevance() before they can be sent).
const SITE_URL = process.env.FRONTEND_URL || 'https://advantageauction.bid';

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// "Bid now / you're winning / closing soon" types are pointless once the lot has
// closed or its close time has passed — they get dropped (status='skipped').
const STALE_IF_CLOSED = new Set(['OUTBID', 'LEADING', 'ENDING_SOON', 'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING']);
// All lot-scoped buyer emails (enriched + relevance-checked here). WINNING is the
// post-close "you won" email and is intentionally NOT stale-on-close.
const LOT_TYPES = new Set([...STALE_IF_CLOSED, 'WINNING']);

function isLotType(type) { return LOT_TYPES.has(type); }

function lotRef(lot) {
  const num = (lot && lot.lot_number != null) ? ('#' + lot.lot_number) : '';
  const title = (lot && lot.title) ? lot.title : 'Lot';
  return num ? ('Lot ' + num + ' — ' + title) : ('Lot — ' + title);
}

// Decide whether a queued notification should still be delivered.
// Returns { send: boolean, reason?: string }. Pure — pass `now` for testability.
function relevance(type, lot, now) {
  if (!LOT_TYPES.has(type)) return { send: true };          // non-lot types (auction/seller) always relevant
  if (!lot) return { send: false, reason: 'lot not found' };
  const closed = lot.state === 'closed' || lot.state === 'withdrawn';
  const closeAt = lot.extended_until || lot.closes_at || null;
  const past = closeAt && new Date(closeAt).getTime() <= now.getTime();
  if (STALE_IF_CLOSED.has(type) && (closed || past)) {
    return { send: false, reason: 'lot closed or past close time' };
  }
  return { send: true };
}

function money(cents) { return (cents != null) ? '$' + (Number(cents) / 100).toFixed(2) : null; }

const META = {
  OUTBID:           { subject: t => "You've been outbid — " + t,   lead: r => "You've been outbid on <strong>" + r + "</strong>. There's still time to take back the lead.", cta: 'Place a new bid →',   priceLabel: 'Current bid' },
  LEADING:          { subject: t => "You're winning — " + t,        lead: r => "You're the current high bidder on <strong>" + r + "</strong>.",                                cta: 'View lot →',          priceLabel: 'Current bid' },
  ENDING_SOON:      { subject: t => 'Closing soon — ' + t,          lead: r => "<strong>" + r + "</strong> is closing soon.",                                                  cta: 'Bid now →',           priceLabel: 'Current bid' },
  CLOSE_TO_WINNING: { subject: t => "You're close — " + t,          lead: r => "You're very close to winning <strong>" + r + "</strong>. A small increase could secure it.",     cta: 'Increase your bid →', priceLabel: 'Current bid' },
  FINAL_SECONDS:    { subject: t => 'Final seconds — ' + t,         lead: r => "Final seconds for <strong>" + r + "</strong> — bid now before it closes.",                       cta: 'Bid now →',           priceLabel: 'Current bid' },
  EXTENDED_BIDDING: { subject: t => 'Bidding extended — ' + t,      lead: r => "Bidding has been extended for <strong>" + r + "</strong>. You still have time to win.",           cta: 'Place your bid →',    priceLabel: 'Current bid' },
  WINNING:          { subject: t => 'You won — ' + t,               lead: r => "Congratulations — you won <strong>" + r + "</strong>. Complete payment to secure your item.",    cta: 'Complete payment →',  priceLabel: 'Winning bid' },
};

// Build the enriched buyer email for a lot-scoped notification. Pure.
// ctx = { lot, auction, toAddress }
function buildLotEmail(type, ctx) {
  const meta = META[type];
  if (!meta) throw new Error('Unknown lot notification type: ' + type);
  const lot = ctx.lot || {};
  const ref = lotRef(lot);
  const refEsc = escHtml(ref);
  const lotUrl = SITE_URL + '/lot.html?lotId=' + encodeURIComponent(lot.id || '');
  const auctionTitle = (ctx.auction && ctx.auction.title) ? ctx.auction.title : null;
  const priceCents = (type === 'WINNING')
    ? (lot.winning_amount_cents != null ? lot.winning_amount_cents : lot.current_bid_cents)
    : lot.current_bid_cents;
  const price = money(priceCents);
  const img = lot.thumbnail_url || null;

  const textLines = [
    meta.lead(ref).replace(/<\/?strong>/g, ''),
    '',
    auctionTitle ? ('Auction: ' + auctionTitle) : null,
    ref,
    price ? (meta.priceLabel + ': ' + price) : null,
    '',
    meta.cta.replace(/\s*→$/, '') + ': ' + lotUrl,
  ].filter(l => l !== null);

  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">' +
      '<div style="font-weight:800;font-size:18px;color:#0f172a;padding:8px 0 12px">Advantage Auction</div>' +
      (img ? ('<img src="' + escHtml(img) + '" alt="" style="width:100%;max-height:260px;object-fit:cover;border-radius:10px;margin-bottom:14px">') : '') +
      (auctionTitle ? ('<div style="font-size:13px;color:#64748b;margin-bottom:2px">' + escHtml(auctionTitle) + '</div>') : '') +
      '<div style="font-size:17px;font-weight:700;margin-bottom:10px">' + refEsc + '</div>' +
      '<p style="line-height:1.5;margin:0 0 12px">' + meta.lead(refEsc) + '</p>' +
      (price ? ('<div style="font-size:15px;margin:0 0 16px"><span style="color:#64748b">' + meta.priceLabel + ':</span> <strong>' + price + '</strong></div>') : '') +
      '<p style="margin:0 0 8px"><a href="' + lotUrl + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px">' + escHtml(meta.cta) + '</a></p>' +
    '</div>';

  return { to: ctx.toAddress, subject: meta.subject(ref), html: html, text: textLines.join('\n') };
}

module.exports = { escHtml, lotRef, relevance, buildLotEmail, isLotType, LOT_TYPES, STALE_IF_CLOSED, SITE_URL };
