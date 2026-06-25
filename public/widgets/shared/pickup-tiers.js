/* pickup-tiers.js — client-side pickup-tier helpers (Phase 3). Mirrors
 * src/lib/pickupTiers.js. size_category (A/B/C) IS the tier; windows are the
 * auction pickup window split into 3 EQUAL parts (never hardcoded). Size is never
 * inferred — unset shows "Not specified". Exposes window.PickupTiers. */
(function () {
  var TIER_ORDER = { A: 1, B: 2, C: 3 };
  var ITEM = { A: 'Small Items', B: 'Medium Items', C: 'Large Items' };
  function normTier(s) { return (s === 'A' || s === 'B' || s === 'C') ? s : null; }
  function timeLabel(t) { return t ? ('Pickup Time ' + t) : 'Not specified'; }
  function itemLabel(t) { return t ? ITEM[t] : null; }
  function assignedTier(sizes) {
    var best = null;
    (sizes || []).forEach(function (s) { var t = normTier(s); if (t && (!best || TIER_ORDER[t] > TIER_ORDER[best])) best = t; });
    return best;
  }
  function splitWindow(start, end) {
    if (!start || !end) return null;
    var s = new Date(start).getTime(), e = new Date(end).getTime();
    if (!isFinite(s) || !isFinite(e) || !(e > s)) return null;
    var third = (e - s) / 3;
    function mk(i) { return { start: new Date(s + third * i), end: new Date(s + third * (i + 1)) }; }
    return { A: mk(0), B: mk(1), C: mk(2) };
  }
  // UTC for deterministic, viewer-independent clock times (pickup windows store the
  // intended wall-clock; auctions.timezone is essentially unpopulated). Same clock
  // everywhere — packet + public pages.
  function fmtTime(d) { try { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }); } catch (e) { return ''; } }
  function windowLabel(w) { return w ? (fmtTime(w.start) + ' – ' + fmtTime(w.end)) : ''; }
  window.PickupTiers = { normTier: normTier, timeLabel: timeLabel, itemLabel: itemLabel, assignedTier: assignedTier, splitWindow: splitWindow, fmtTime: fmtTime, windowLabel: windowLabel };
})();
