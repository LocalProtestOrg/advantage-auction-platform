/**
 * Advantage Auction Platform — Featured Near You Widget Loader
 * Export package v1.0.0  |  Source: public/widgets/featured-near-you.js
 *
 * DEPLOYMENT USAGE — drop this into any BD or partner page:
 *
 *   <!-- Auto-detect location (browser geolocation prompt) -->
 *   <div id="aap-featured-near-you"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-limit="6"
 *        data-radius-km="200"
 *        data-use-geolocation="true">
 *   </div>
 *   <script src="./widget.js"></script>
 *
 *   <!-- Hardcoded region (no geolocation prompt) -->
 *   <div id="aap-featured-near-you"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-lat="32.7767"
 *        data-lng="-96.7970"
 *        data-radius-km="150"
 *        data-limit="6">
 *   </div>
 *   <script src="./widget.js"></script>
 *
 * Or reference the CDN directly:
 *   <script src="https://auctions.advantage.bid/widgets/featured-near-you.js" defer></script>
 *
 * See README.md in this package for the full configuration and deployment guide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENGINEERING NOTE:
 * This file is a thin deployment loader — it is NOT the widget source code.
 * Source of truth: /public/widgets/featured-near-you.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var CDN_BASE   = 'https://auctions.advantage.bid';
  var WIDGET_SRC = CDN_BASE + '/widgets/featured-near-you.js';
  var WIDGET_ID  = 'aap-featured-near-you';

  // Idempotency — do not load twice
  if (document.querySelector('script[data-aap-widget="featured-near-you"]')) return;

  // Container must exist
  if (!document.getElementById(WIDGET_ID)) {
    if (typeof console !== 'undefined') {
      console.warn('[AAP] Featured Near You: container #' + WIDGET_ID + ' not found. Widget not loaded.');
    }
    return;
  }

  // Load the canonical widget script from CDN
  var s      = document.createElement('script');
  s.src      = WIDGET_SRC;
  s.defer    = true;
  s.setAttribute('data-aap-widget', 'featured-near-you');
  s.onerror  = function () {
    if (typeof console !== 'undefined') {
      console.error('[AAP] Featured Near You: failed to load from CDN. Check network and CORS.');
    }
  };
  document.head.appendChild(s);

})();
