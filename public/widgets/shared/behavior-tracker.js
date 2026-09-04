/* ============================================================================
   AdvBehavior — one self-bootstrapping first-party page-view tracker. Drop this
   single tag on any key page and it fires a first-party `page_view` (the server
   classifies page_intent from the path). Reuses AAPAnalytics (session + durable
   visitor id); loads it on demand if absent. First-party only, non-blocking,
   no fingerprinting, no PII, no AI/vendor attribution.

   Usage:
     <script src="/widgets/shared/behavior-tracker.js" defer></script>
   Optional page context (e.g. a lot page):
     <script>window.__ADV_CATEGORY_KEY='jewelry';</script>
   ========================================================================== */
(function () {
  'use strict';
  function fire() {
    try {
      var ctx = {};
      if (window.__ADV_CATEGORY_KEY) ctx.category_key = String(window.__ADV_CATEGORY_KEY);
      if (window.__ADV_AUCTION_ID) ctx.auction_id = String(window.__ADV_AUCTION_ID);
      if (window.AAPAnalytics && window.AAPAnalytics.page) { window.AAPAnalytics.page(ctx); return; }
      // AAPAnalytics not present → load it, then fire once.
      var s = document.createElement('script');
      s.src = '/widgets/shared/analytics.js';
      s.onload = function () { try { window.AAPAnalytics && window.AAPAnalytics.page && window.AAPAnalytics.page(ctx); } catch (e) {} };
      s.onerror = function () { /* analytics must never affect the page */ };
      document.head.appendChild(s);
    } catch (e) { /* swallow — tracking must never break the page */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fire);
  else fire();
})();
