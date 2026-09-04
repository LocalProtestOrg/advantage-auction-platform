/* ============================================================================
   LegendVisibility — the ONE rule for the homepage map key: a legend item is
   shown only when its current count is > 0. Zero-count items are hidden entirely
   (no muted/blank rows), a section with no visible items is omitted (no orphan
   header/divider), and the whole key hides when nothing is visible. Pure +
   isomorphic so index.html and the unit tests share the exact same logic.
   ========================================================================== */
(function (root) {
  'use strict';

  // items: [{ key, ... }]; counts: an object keyed by item.key OR a function(item)->number.
  // Returns only the items whose count is a positive number.
  function visibleItems(items, counts) {
    var get = (typeof counts === 'function')
      ? counts
      : function (it) { return (counts && counts[it.key]) || 0; };
    return (Array.isArray(items) ? items : []).filter(function (it) { return Number(get(it)) > 0; });
  }
  // True when at least one item has a positive count (→ render the section / the key).
  function anyVisible(items, counts) { return visibleItems(items, counts).length > 0; }

  // A count is "known" only when it is a finite number (or a numeric string like "0"/"3").
  // null / undefined / '' / non-numeric → UNKNOWN (still loading / API error), NOT an authoritative zero.
  function isKnownCount(count) {
    if (count === null || count === undefined || count === '') return false;
    return Number.isFinite(Number(count));
  }
  // An authoritative zero: a KNOWN count that is <= 0 (0, "0", or a data-error negative).
  function isAuthoritativeZero(count) { return isKnownCount(count) && Number(count) <= 0; }
  // For surfaces that may render before data loads: SHOW unless the count is an authoritative zero.
  // Unknown/loading/failed → keep (never hide as a false zero, per the owner rule).
  function keepUnlessZero(count) { return !isAuthoritativeZero(count); }

  var api = { visibleItems: visibleItems, anyVisible: anyVisible, isKnownCount: isKnownCount, isAuthoritativeZero: isAuthoritativeZero, keepUnlessZero: keepUnlessZero };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LegendVisibility = api;
})(typeof self !== 'undefined' ? self : this);
