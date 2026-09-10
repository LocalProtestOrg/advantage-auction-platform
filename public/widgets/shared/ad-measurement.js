/* ============================================================================
   AdvMeasurement — consent-gated advertising measurement loader (Phase 3P.2).
   Reads /api/public/measurement-config once per session. Nothing loads and nothing
   is sent to any advertising platform unless BOTH are true:
     1. the Owner has turned that channel's measurement gate ON (server decides), and
     2. this visitor granted ADVERTISING consent (window.__ADV_CONSENT / aap_consent).
   When active, PageView fires once and AdvMeasurement.track(key, eventId) sends the
   same event id the server records, so provider-side deduplication works.
   First-party measurement never depends on this file.
   ========================================================================== */
(function () {
  'use strict';
  if (window.AdvMeasurement) return;
  var CFG_KEY = 'aap_measurement_cfg';
  // Shared definitions (src/lib/conversionDefinitions.js meta_event mapping).
  var META = { buyer_registered: 'CompleteRegistration', seller_registered: 'CompleteRegistration', email_signup: 'Subscribe', watch_lot: 'AddToWishlist',
    bid: 'AddToCart', purchase: 'Purchase', seller_inquiry: 'Lead', assisted_service_inquiry: 'Lead', auction_draft_created: 'StartTrial', auction_published: 'SubmitApplication' };
  var state = { cfg: null, metaReady: false };

  function consentAdvertising() {
    try {
      if (window.__ADV_CONSENT) return window.__ADV_CONSENT.advertising === true;
      var v = JSON.parse(localStorage.getItem('aap_consent') || 'null');
      return !!(v && v.advertising === true);
    } catch (e) { return false; }
  }
  function loadMeta(id) {
    if (state.metaReady || !id) return;
    /* Meta's standard base code, loaded only after the gate + consent checks above. */
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', String(id));
    window.fbq('track', 'PageView');
    state.metaReady = true;
  }
  function apply() {
    var c = state.cfg;
    if (!c || !consentAdvertising()) return;
    if (c.meta_pixel && c.meta_pixel.enabled && c.meta_pixel.dataset_id) loadMeta(c.meta_pixel.dataset_id);
  }
  function init() {
    try {
      var cached = sessionStorage.getItem(CFG_KEY);
      if (cached) { state.cfg = JSON.parse(cached); apply(); return; }
    } catch (e) { /* storage blocked → fetch */ }
    fetch('/api/public/measurement-config', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      if (!c) return; state.cfg = c;
      try { sessionStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
      apply();
    }).catch(function () {});
  }
  window.AdvMeasurement = {
    /** key = a shared conversion key; eventId = the first-party conversion id returned by the server (dedup). */
    track: function (key, eventId) {
      try { if (!state.metaReady || !consentAdvertising() || !META[key]) return false; window.fbq('track', META[key], {}, eventId ? { eventID: String(eventId) } : undefined); return true; }
      catch (e) { return false; }
    },
    reapply: apply,
  };
  // Consent may be granted after load (banner choice) → re-check periodically for a short while, never before.
  var tries = 0; var t = setInterval(function () { tries += 1; apply(); if (state.metaReady || tries > 20) clearInterval(t); }, 3000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
