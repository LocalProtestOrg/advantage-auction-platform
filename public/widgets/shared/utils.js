/**
 * Advantage Auction Platform - Shared Widget Utilities
 * window.AAPWidgetUtils
 *
 * Load this before any widget that depends on it. Safe to include multiple times -
 * subsequent loads are no-ops. All widgets also carry inline fallbacks, so this
 * file is optional but recommended when embedding more than one widget per page.
 *
 *   <script src="https://auctions.advantage.bid/widgets/shared/utils.js"></script>
 */

(function () {
  'use strict';
  if (window.AAPWidgetUtils) return;

  window.AAPWidgetUtils = {

    // XSS-safe HTML escaping - use on every API string inserted into innerHTML
    esc: function (str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    // "May 3, 2026" format
    fmtDate: function (iso) {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
        });
      } catch (e) { return ''; }
    },

    // "Ends in 2h" / "Ends in 4d" / "Ended" relative label
    fmtRelativeTime: function (iso) {
      if (!iso) return '';
      try {
        var diffMs = new Date(iso).getTime() - Date.now();
        if (diffMs <= 0) return 'Ended';
        var h = Math.floor(diffMs / 3600000);
        if (h < 1) return 'Ends in ' + Math.floor(diffMs / 60000) + 'm';
        if (h < 24) return 'Ends in ' + h + 'h';
        return 'Ends in ' + Math.floor(h / 24) + 'd';
      } catch (e) { return ''; }
    },

    // "42 mi away" / "< 1 mi away" / null when km is null (input is km; U.S. users see miles)
    fmtDistance: function (km) {
      if (km == null) return null;
      var r = Math.round(km * 0.621371); // km → miles
      return (r === 0 ? '< 1' : r) + ' mi away';
    },

    clamp: function (v, lo, hi) {
      return Math.min(Math.max(v, lo), hi);
    },

    parseIntSafe: function (str, fallback) {
      var n = parseInt(str, 10);
      return isNaN(n) ? fallback : n;
    },

    parseFloatSafe: function (str, fallback) {
      var n = parseFloat(str);
      return isNaN(n) ? fallback : n;
    },

    // Returns a Promise<GeolocationPosition>. Rejects with code 1/2/3 on failure.
    getGeoPosition: function (timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (!navigator.geolocation) {
          var err = new Error('unavailable');
          err.code = 2;
          return reject(err);
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: timeoutMs || 5000,
          maximumAge: 300000,
        });
      });
    },

    // Inject a <style> element once - skips if the id already exists
    injectStyle: function (id, css) {
      if (document.getElementById(id)) return;
      var el = document.createElement('style');
      el.id = id;
      el.textContent = css;
      document.head.appendChild(el);
    },

    // Dispatch a bubbling CustomEvent from an element
    dispatch: function (el, eventName, detail) {
      try {
        el.dispatchEvent(new CustomEvent(eventName, { bubbles: true, detail: detail || {} }));
      } catch (e) { /* CustomEvent not supported in legacy environment */ }
    },

  };
})();
