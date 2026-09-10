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
  // Landing capture of ad click IDs (server-side, first-party). Captured once per page load if present.
  // NEVER re-appended to any Advantage.Bid link; the value only travels to our own capture endpoint.
  function captureClickIds() {
    try {
      var q = new URLSearchParams(location.search);
      var payload = { visitor_id: (window.AAPAnalytics && window.AAPAnalytics._getVisitorId) ? window.AAPAnalytics._getVisitorId() : null,
        consent: window.__ADV_CONSENT || null, source: location.hostname };
      var any = false;
      ['gclid', 'gbraid', 'wbraid', 'fbclid'].forEach(function (t) { var v = q.get(t); if (v) { payload[t] = v; any = true; } });
      if (!any) return;
      fetch('/api/analytics/click-id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }).catch(function () {});
    } catch (e) { /* never break the page */ }
  }

  // First-party campaign attribution: landing URL + referrer for campaign-bearing (UTM / click id) or external
  // arrivals, once per landing per session. The server classifies the channel; internal navigation is ignored.
  function captureTouch() {
    try {
      var q = location.search || '';
      var ref = document.referrer || '';
      var external = ref && ref.indexOf(location.protocol + '//' + location.host) !== 0 && !/(^|\.)advantage\.bid$/i.test((ref.split('/')[2] || ''));
      if (!/[?&](utm_[a-z]+|gclid|gbraid|wbraid|fbclid)=/i.test(q) && !external) return;
      var key = 'aap_touch_' + (location.pathname + q).slice(0, 180);
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* storage blocked → still send once */ }
      var A = window.AAPAnalytics || {};
      var payload = { visitor_id: A._getVisitorId ? A._getVisitorId() : null, session_id: A._getSessionId ? A._getSessionId() : null,
        landing_url: location.href, referrer: ref || null, consent: window.__ADV_CONSENT || null };
      if (!payload.visitor_id) return;
      fetch('/api/analytics/touch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }).catch(function () {});
    } catch (e) { /* never break the page */ }
  }

  // Ensure the consent banner is present (one shared integration point). It self-suppresses once a
  // choice exists and publishes window.__ADV_CONSENT for the tracker.
  function ensureConsentBanner() {
    try {
      if (window.__ADV_CONSENT || document.querySelector('.adv-consent') || document.getElementById('adv-consent-styles')) return;
      var s = document.createElement('script'); s.src = '/widgets/shared/consent-banner.js'; s.defer = true;
      document.head.appendChild(s);
    } catch (e) { /* never break the page */ }
  }

  // Consent-gated advertising measurement loader (does nothing unless an Owner gate is ON and advertising consent is granted).
  function ensureAdMeasurement() {
    try {
      if (window.AdvMeasurement || document.getElementById('adv-ad-measurement')) return;
      var s = document.createElement('script'); s.id = 'adv-ad-measurement'; s.src = '/widgets/shared/ad-measurement.js'; s.defer = true;
      document.head.appendChild(s);
    } catch (e) { /* never break the page */ }
  }

  function fire() {
    try {
      ensureConsentBanner();
      ensureAdMeasurement();
      captureClickIds();
      var ctx = {};
      if (window.__ADV_CATEGORY_KEY) ctx.category_key = String(window.__ADV_CATEGORY_KEY);
      if (window.__ADV_AUCTION_ID) ctx.auction_id = String(window.__ADV_AUCTION_ID);
      if (window.AAPAnalytics && window.AAPAnalytics.page) { window.AAPAnalytics.page(ctx); captureTouch(); return; }
      // AAPAnalytics not present → load it, then fire once.
      var s = document.createElement('script');
      s.src = '/widgets/shared/analytics.js';
      s.onload = function () { try { window.AAPAnalytics && window.AAPAnalytics.page && window.AAPAnalytics.page(ctx); captureTouch(); } catch (e) {} };
      s.onerror = function () { /* analytics must never affect the page */ };
      document.head.appendChild(s);
    } catch (e) { /* swallow — tracking must never break the page */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fire);
  else fire();
})();
