/**
 * Advantage Auction Platform — Featured Lots Widget Loader
 * Export package v1.0.0  |  Source: public/widgets/featured-lots.js
 *
 * DEPLOYMENT USAGE — drop this script tag into any BD or partner page:
 *
 *   <div id="aap-featured-lots"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-limit="6"
 *        data-auction-state="published"
 *        data-theme="light">
 *   </div>
 *   <script src="./widget.js"></script>
 *
 * Or reference the CDN directly:
 *   <script src="https://auctions.advantage.bid/widgets/featured-lots.js" defer></script>
 *
 * See README.md in this package for the full configuration and deployment guide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENGINEERING NOTE:
 * This file is a thin deployment loader — it is NOT the widget source code.
 * Source of truth: /public/widgets/featured-lots.js
 * The widget logic, CSS injection, API calls, and component fallbacks all
 * live in the canonical source file served from the CDN.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var CDN_BASE   = 'https://auctions.advantage.bid';
  var WIDGET_SRC = CDN_BASE + '/widgets/featured-lots.js';
  var WIDGET_ID  = 'aap-featured-lots';

  // Idempotency — do not load twice
  if (document.querySelector('script[data-aap-widget="featured-lots"]')) return;

  // Container must exist — fail silently if page didn't include it
  if (!document.getElementById(WIDGET_ID)) {
    if (typeof console !== 'undefined') {
      console.warn('[AAP] Featured Lots: container #' + WIDGET_ID + ' not found. Widget not loaded.');
    }
    return;
  }

  // Load the canonical widget script from CDN
  var s      = document.createElement('script');
  s.src      = WIDGET_SRC;
  s.defer    = true;
  s.setAttribute('data-aap-widget', 'featured-lots');
  s.onerror  = function () {
    if (typeof console !== 'undefined') {
      console.error('[AAP] Featured Lots: failed to load from CDN. Check network and CORS.');
    }
  };
  document.head.appendChild(s);

})();
