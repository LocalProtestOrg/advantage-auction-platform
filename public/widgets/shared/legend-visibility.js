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

  var api = { visibleItems: visibleItems, anyVisible: anyVisible };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LegendVisibility = api;
})(typeof self !== 'undefined' ? self : this);
