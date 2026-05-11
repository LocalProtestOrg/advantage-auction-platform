/**
 * Advantage Auction Platform — Seller CTA Standalone Embed
 * Export package v1.0.0  |  Source: public/widgets/shared/components/seller-cta.js
 *
 * Renders a standalone "Sell with Advantage" call-to-action card without
 * requiring any widget grid. Use when you want just the CTA on a page,
 * not a full auction grid.
 *
 * DEPLOYMENT USAGE:
 *
 *   <div id="aap-seller-cta"
 *        data-url="https://auctions.advantage.bid/seller-create.html"
 *        data-headline="Consigning an Estate?"
 *        data-subtext="We auction estates, collections, and commercial inventory nationwide."
 *        data-label="Get Started"
 *        data-theme="light">
 *   </div>
 *   <script src="./widget.js"></script>
 *
 * See README.md in this package for the full deployment guide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENGINEERING NOTE:
 * This is a deployment loader + initialization wrapper.
 * Source of truth: /public/widgets/shared/components/seller-cta.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var CDN_BASE    = 'https://auctions.advantage.bid';
  var BADGE_SRC   = CDN_BASE + '/widgets/shared/components/badge.js';
  var CTA_SRC     = CDN_BASE + '/widgets/shared/components/seller-cta.js';
  var CONTAINER_ID = 'aap-seller-cta';

  if (document.querySelector('script[data-aap-widget="seller-cta"]')) return;

  var container = document.getElementById(CONTAINER_ID);
  if (!container) {
    if (typeof console !== 'undefined') {
      console.warn('[AAP] Seller CTA: container #' + CONTAINER_ID + ' not found.');
    }
    return;
  }

  // Read configuration from data-* attributes on the container
  var d        = container.dataset;
  var ctaUrl   = d.url      || '';
  var headline = d.headline || 'Consigning an Estate?';
  var subtext  = d.subtext  || 'We auction estates, collections, and commercial inventory nationwide.';
  var label    = d.label    || 'Get Started';

  if (!ctaUrl) {
    if (typeof console !== 'undefined') {
      console.warn('[AAP] Seller CTA: data-url is required. CTA not rendered.');
    }
    return;
  }

  // Load badge.js first (provides CSS root variables), then seller-cta.js
  function loadScript(src, attr, onload) {
    var s = document.createElement('script');
    s.src = src;
    s.defer = true;
    if (attr) s.setAttribute('data-aap-widget', attr);
    if (onload) s.onload = onload;
    document.head.appendChild(s);
  }

  loadScript(BADGE_SRC, null, function () {
    loadScript(CTA_SRC, 'seller-cta', function () {
      if (!window.AAPComponents || !window.AAPComponents.SellerCta) return;

      var card = window.AAPComponents.SellerCta({
        url:      ctaUrl,
        headline: headline,
        subtext:  subtext,
        label:    label,
        onCtaClick: function () {
          try {
            container.dispatchEvent(new CustomEvent('aap:cta:click', {
              bubbles: true,
              detail: { widgetId: CONTAINER_ID }
            }));
          } catch (e) {}
        }
      });

      container.innerHTML = '';
      container.appendChild(card);
    });
  });

})();
