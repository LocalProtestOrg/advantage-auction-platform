/* ============================================================================
   AdvLotImage — the ONE client-side lot-image fallback for Advantage.Bid.
   A lot with a real photo shows it; a lot with none shows the official Advantage.Bid
   placeholder (never a fabricated/borrowed/unrelated image). Presentation only — the
   API/DB stay truthful about whether a real image exists. Also installs a global
   capture-phase error net so a BROKEN lot image URL swaps to the placeholder instead
   of showing a broken-image icon. Mark lot images with class "adv-lot-img".
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
  // Full <img> tag with the fallback baked in (class adv-lot-img + onerror → placeholder).
  function img(u, alt, extraAttrs) {
    return '<img class="adv-lot-img" src="' + esc(src(u)) + '" alt="' + esc(alt || '') + '" '
      + (extraAttrs || '') + ' onerror="AdvLotImage._fail(this)">';
  }
  function _fail(el) {
    if (!el || el.getAttribute('data-adv-fallback') === '1') return; // guard against loops
    el.setAttribute('data-adv-fallback', '1');
    el.src = PLACEHOLDER;
  }

  // Global safety net: any image that fails to load and is a lot image → placeholder.
  if (root.addEventListener) {
    root.addEventListener('error', function (e) {
      var el = e && e.target;
      if (el && el.tagName === 'IMG' && el.classList && el.classList.contains('adv-lot-img')) _fail(el);
    }, true); // capture: image error events do not bubble
  }

  var api = { PLACEHOLDER: PLACEHOLDER, isReal: isReal, src: src, img: img, _fail: _fail };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AdvLotImage = api;
})(typeof self !== 'undefined' ? self : this);
