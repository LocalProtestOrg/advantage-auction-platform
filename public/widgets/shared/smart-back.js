/* Shared Back-navigation policy (#6). Applies ONE reliable rule to page-level
 * "Back" controls that previously hardcoded a section-landing destination:
 *   1) return to the actual same-origin previous page when one exists;
 *   2) otherwise navigate to an explicit contextual fallback the page provides.
 * This prevents Back from dumping the user on a section home when they arrived
 * from a real in-app page, while still giving cold-entry / cross-origin visitors
 * a safe contextual destination (never an external referrer, no open redirect —
 * the fallback is a caller-supplied same-origin path).
 * Usage: <a href="<fallback>" onclick="return AB.back(event,'<fallback>')">Back</a>
 */
(function () {
  'use strict';
  function sameOriginReferrer() {
    try { return !!document.referrer && new URL(document.referrer).origin === location.origin; }
    catch (e) { return false; }
  }
  function back(ev, fallback) {
    if (ev && ev.preventDefault) ev.preventDefault();
    // Tier 1: real same-origin previous page.
    if (history.length > 1 && sameOriginReferrer()) { history.back(); return false; }
    // Tier 2/3: caller-supplied contextual fallback (must be a same-origin path).
    if (typeof fallback === 'string' && fallback.charAt(0) === '/') { location.href = fallback; }
    return false;
  }
  window.AB = window.AB || {};
  window.AB.back = back;
})();
