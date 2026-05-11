/**
 * Advantage Auction Platform — Frontend Analytics Utility
 * window.AAPAnalytics  v1
 *
 * Lightweight, fire-and-forget telemetry helper for widgets and BD pages.
 *
 * Design rules:
 *   - track() NEVER blocks widget rendering or page navigation.
 *   - All errors are swallowed silently — analytics failures must not affect UX.
 *   - No PII is collected: no emails, passwords, payment data, or auth tokens.
 *   - session_id is a random token with a 30-minute idle TTL — not linked to
 *     any user account or auth session.
 *   - keepalive:true allows the fetch to survive page navigation events.
 *
 * Usage:
 *   AAPAnalytics.track('widget_impression', { radius_km: 200 }, {
 *     widget_name: 'featured-near-you',
 *     city: 'Dallas',
 *     state_code: 'TX'
 *   });
 *
 * Load order: include after shared/config.js, before any widget scripts.
 *   <script src="https://auctions.advantage.bid/widgets/shared/analytics.js"></script>
 */

window.AAPAnalytics = (function () {
  'use strict';

  if (window.AAPAnalytics && window.AAPAnalytics._v) return window.AAPAnalytics;

  var ENDPOINT       = '/api/analytics/events';
  var SESSION_KEY    = 'aap_session_id';
  var SESSION_TS_KEY = 'aap_session_ts';
  var SESSION_TTL_MS = 30 * 60 * 1000;  // 30-minute idle TTL

  // ── Session ID ─────────────────────────────────────────────────────────────
  // Random token, regenerated after 30 minutes of inactivity.
  // Never linked to auth, user account, or any identifying information.
  function _getSessionId() {
    try {
      var now    = Date.now();
      var stored = localStorage.getItem(SESSION_KEY);
      var ts     = parseInt(localStorage.getItem(SESSION_TS_KEY) || '0', 10);

      if (stored && (now - ts) < SESSION_TTL_MS) {
        localStorage.setItem(SESSION_TS_KEY, String(now));
        return stored;
      }

      var id = 'aap_' + Math.random().toString(36).slice(2, 10)
                      + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(SESSION_KEY, id);
      localStorage.setItem(SESSION_TS_KEY, String(now));
      return id;
    } catch (e) {
      // localStorage unavailable (private mode, iframe restriction) — use ephemeral ID
      return 'aap_' + Math.random().toString(36).slice(2, 18);
    }
  }

  // ── Device type ────────────────────────────────────────────────────────────
  function _deviceType() {
    var w = (window.innerWidth || document.documentElement.clientWidth || 0);
    if (w === 0) return 'desktop';
    if (w < 768)  return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  // ── Base payload ───────────────────────────────────────────────────────────
  function _basePayload(eventType) {
    return {
      event_type:  eventType,
      session_id:  _getSessionId(),
      device_type: _deviceType(),
      page_url:    typeof location !== 'undefined' ? location.href : null,
      referrer:    typeof document !== 'undefined' ? (document.referrer || null) : null,
      client_ts:   new Date().toISOString(),
    };
  }

  // ── track ──────────────────────────────────────────────────────────────────
  /**
   * Track an analytics event.
   *
   * @param {string} eventType  — snake_case event name (e.g. 'widget_impression')
   * @param {object} metadata   — event-specific data (e.g. { radius_km: 200 })
   * @param {object} context    — optional top-level context fields:
   *                               widget_name, auction_id, seller_id,
   *                               city, state_code
   *
   * Returns nothing. Never throws. Fails silently.
   */
  function track(eventType, metadata, context) {
    if (!eventType || typeof eventType !== 'string') return;

    try {
      var payload = _basePayload(eventType);

      // Merge context fields (top-level, not in metadata)
      if (context && typeof context === 'object') {
        if (context.widget_name) payload.widget_name = String(context.widget_name);
        if (context.auction_id)  payload.auction_id  = String(context.auction_id);
        if (context.seller_id)   payload.seller_id   = String(context.seller_id);
        if (context.city)        payload.city        = String(context.city);
        if (context.state_code)  payload.state_code  = String(context.state_code);
      }

      // Attach event-specific metadata
      payload.metadata = (metadata && typeof metadata === 'object') ? metadata : {};

      fetch(ENDPOINT, {
        method:    'POST',
        headers:   { 'Content-Type': 'application/json' },
        body:      JSON.stringify(payload),
        keepalive: true,   // survives page unload / navigation
      }).catch(function () { /* swallow network errors */ });
    } catch (e) {
      /* swallow — analytics must never affect page behavior */
    }
  }

  // ── trackBatch ─────────────────────────────────────────────────────────────
  /**
   * Track multiple events in a single network request.
   * Useful for page-unload scenarios.
   *
   * @param {Array} events  — array of { event_type, metadata, ...context } objects
   */
  function trackBatch(events) {
    if (!Array.isArray(events) || !events.length) return;
    try {
      var payloads = events.slice(0, 20).map(function (e) {
        var p = _basePayload(e.event_type || 'unknown');
        if (e.widget_name) p.widget_name = String(e.widget_name);
        if (e.auction_id)  p.auction_id  = String(e.auction_id);
        if (e.seller_id)   p.seller_id   = String(e.seller_id);
        if (e.city)        p.city        = String(e.city);
        if (e.state_code)  p.state_code  = String(e.state_code);
        p.metadata = (e.metadata && typeof e.metadata === 'object') ? e.metadata : {};
        return p;
      });

      fetch(ENDPOINT, {
        method:    'POST',
        headers:   { 'Content-Type': 'application/json' },
        body:      JSON.stringify(payloads),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  return {
    track:          track,
    trackBatch:     trackBatch,
    _getSessionId:  _getSessionId,   // exposed for testing only
    _v:             1,
  };

})();
