/* Professional Seller upgrade panel — shared, tasteful, NON-forced upsell shown inside the Free Business
   Listing portal. One source of truth for the copy so submit-listing + events render an identical panel.
   Benefits are limited to VERIFIED, live Professional Seller capabilities (auctions are admin-published,
   which is fine to advertise as "run online auctions"). The embed-on-your-own-site capability is
   intentionally NOT listed because it is not yet a verified, self-serve, brand-removable product.
   Accessible: labelled region, heading, list, and a real focusable link. Free listing stays fully
   usable without upgrading. */
(function () {
  var BENEFITS = [
    ['🔨', 'Run online auctions', 'Host professional online auctions on Advantage.Bid.'],
    ['🎛️', 'Professional auction controls', 'Set starting prices and reserves, and configure your buyer’s premium and bid increments.'],
    ['🏪', 'Branded Professional Storefront', 'A branded storefront with fixed-price Buy Now selling.'],
    ['🧭', 'Marketplace selling & orders', 'List fixed-price items, sell through checkout, and manage your Storefront orders.'],
    ['💳', 'Integrated checkout & direct-deposit payouts', 'Built-in buyer payments with direct-deposit payouts (Stripe Connect).'],
    ['♻️', 'Reuse unsold auction inventory', 'Move eligible unsold auction lots into fixed-price Storefront selling.'],
    ['📣', 'Notify your followers', 'Announce eligible upcoming events to your followers.'],
    ['🔗', 'Keep your existing business profile', 'Upgrade your same company — no new account or second business presence.'],
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function html() {
    var items = BENEFITS.map(function (b) {
      return '<li style="display:flex;gap:10px;align-items:flex-start;padding:6px 0">'
        + '<span aria-hidden="true" style="font-size:1.1rem;line-height:1.4">' + b[0] + '</span>'
        + '<span><b style="color:#0f172a">' + esc(b[1]) + '</b><br><span style="color:#475569;font-size:.86rem">' + esc(b[2]) + '</span></span></li>';
    }).join('');
    return '<section class="pro-upgrade" aria-labelledby="pro-upgrade-h" '
      + 'style="background:#f5f7ff;border:1px solid #c7d2fe;border-radius:14px;padding:1.2rem 1.3rem;margin-top:1rem">'
      + '<p style="font-size:.72rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#4338ca;margin:0 0 .2rem">Ready to sell directly on Advantage.Bid?</p>'
      + '<h2 id="pro-upgrade-h" style="font-size:1.15rem;font-weight:800;margin:0 0 .3rem;color:#0f172a">Upgrade to Professional Seller</h2>'
      + '<p style="color:#475569;font-size:.88rem;margin:0 0 .6rem">Your free business listing stays fully usable. Professional Seller adds transactional selling — it’s optional.</p>'
      + '<ul style="list-style:none;padding:0;margin:0 0 .9rem">' + items + '</ul>'
      + '<a class="pro-upgrade-cta" href="/professional-sellers.html" '
      + 'style="display:inline-block;background:#1d4ed8;color:#fff;font-weight:700;font-size:.9rem;padding:.65rem 1.3rem;border-radius:9px;text-decoration:none">Explore Professional Seller</a>'
      + '</section>';
  }

  function render(elId) {
    var el = typeof elId === 'string' ? document.getElementById(elId) : elId;
    if (el) el.innerHTML = html();
  }

  window.AdvProUpgrade = { html: html, render: render, BENEFITS: BENEFITS };
})();
