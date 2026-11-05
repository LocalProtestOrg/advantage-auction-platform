/* Auction shipping labels for buyer pages (Phase 1). Renders ONLY what the server computed (the `shipping` object on
   auction and lot payloads, present only when auction shipping is turned on). With no `shipping` object nothing is
   drawn, so pages look exactly as before. Built with DOM calls only. */
(function () {
  'use strict';
  var COLORS = {
    shipping_available: ['#dcfce7', '#166534'],
    limited_shipping: ['#fef3c7', '#92400e'],
    local_pickup: ['#e0e7ff', '#3730a3'],
  };
  function badge(summary) {
    if (!summary || !summary.label || !summary.label_text) return null;
    var c = COLORS[summary.label] || COLORS.local_pickup;
    var el = document.createElement('span');
    el.className = 'ship-label ship-label-' + summary.label;
    el.setAttribute('data-shipping-label', summary.label);
    el.style.cssText = 'display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.75rem;font-weight:700;line-height:1.5;'
      + 'background:' + c[0] + ';color:' + c[1] + ';';
    el.textContent = summary.label_text;
    return el;
  }
  // Badge plus the plain-language terms (eligibility, restrictions, estimated cost or quote, limits).
  function details(summary, heading) {
    var b = badge(summary);
    if (!b) return null;
    var box = document.createElement('div');
    box.className = 'ship-details';
    box.setAttribute('data-shipping-details', summary.label);
    box.style.cssText = 'margin:0.6rem 0;padding:0.6rem 0.75rem;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;font-size:0.85rem;color:#374151;';
    var top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:0.5rem;font-weight:600;';
    var h = document.createElement('span');
    h.textContent = heading || 'Shipping and pickup';
    top.appendChild(h); top.appendChild(b);
    box.appendChild(top);
    var terms = Array.isArray(summary.terms) ? summary.terms : [];
    if (terms.length) {
      var ul = document.createElement('ul');
      ul.style.cssText = 'margin:0.4rem 0 0 1.1rem;padding:0;';
      terms.forEach(function (t) { var li = document.createElement('li'); li.textContent = String(t); ul.appendChild(li); });
      box.appendChild(ul);
    }
    return box;
  }
  window.AuctionShippingLabel = { badge: badge, details: details };
})();
