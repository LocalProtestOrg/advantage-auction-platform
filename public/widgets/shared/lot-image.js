/* ============================================================================
   AdvLotImage — the ONE client-side image fallback for Advantage.Bid lot photos
   AND auction/sale cover images. A record with a real photo shows it (normal
   cover/crop); a record with none shows the official Advantage.Bid SQUARE logo
   placeholder — never a fabricated/borrowed/unrelated image. Presentation only —
   the API/DB stay truthful about whether a real image exists.

   The placeholder is a SQUARE logo, so when it stands in for a wide/short cover it
   is rendered object-fit:contain (fully visible, letterboxed) instead of being
   cropped/zoomed. Real images keep their page's cover/crop behavior. A global
   capture-phase error net swaps a BROKEN image URL to the placeholder (contained),
   never a broken-image icon or reload loop. Mark images with class "adv-lot-img".
   ========================================================================== */
(function (root) {
  'use strict';
  var PLACEHOLDER = '/img/lot-placeholder.png';

  function isReal(u) {
    if (u == null) return false;
    var s = String(u).trim();
    return !!s && s !== PLACEHOLDER && s.indexOf('/img/lot-placeholder.png') === -1;
  }
  // Resolve a URL for display: real URL or the placeholder.
  function src(u) { return isReal(u) ? String(u) : PLACEHOLDER; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Full <img> tag with the fallback baked in. When the placeholder stands in for a missing image it also
  // gets `adv-lot-ph` → object-fit:contain (square logo never cropped). Real images keep the page's crop.
  function img(u, alt, extraAttrs) {
    var real = isReal(u);
    return '<img class="adv-lot-img' + (real ? '' : ' adv-lot-ph') + '" src="' + esc(src(u)) + '" alt="' + esc(alt || '') + '" '
      + (extraAttrs || '') + ' onerror="AdvLotImage._fail(this)">';
  }
  function _fail(el) {
    if (!el || el.getAttribute('data-adv-fallback') === '1') return; // guard against loops
    el.setAttribute('data-adv-fallback', '1');
    el.src = PLACEHOLDER;
    if (el.classList) el.classList.add('adv-lot-ph'); // a broken real image falls back to the CONTAINED logo
  }

  // Global safety net: any lot/cover image that fails to load → placeholder (contained). Capture phase
  // because image error events do not bubble.
  if (root.addEventListener) {
    root.addEventListener('error', function (e) {
      var el = e && e.target;
      if (el && el.tagName === 'IMG' && el.classList && el.classList.contains('adv-lot-img')) _fail(el);
    }, true);
  }

  // Inject the placeholder-contain treatment once, so every consumer gets it without per-page CSS. Scoped
  // to the placeholder class only — it never changes how REAL images (adv-lot-img without adv-lot-ph) crop.
  if (root.document && !root.__advLotPhStyle) {
    root.__advLotPhStyle = true;
    try {
      var st = root.document.createElement('style');
      st.textContent = '.adv-lot-img.adv-lot-ph{object-fit:contain !important;background:#fff;padding:6%;}';
      (root.document.head || root.document.documentElement).appendChild(st);
    } catch (e) { /* non-fatal */ }
  }

  var api = { PLACEHOLDER: PLACEHOLDER, isReal: isReal, src: src, img: img, _fail: _fail };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AdvLotImage = api;
})(typeof self !== 'undefined' ? self : this);
