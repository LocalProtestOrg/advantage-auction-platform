/* ============================================================================
   Advantage Marketplace Feed — Brilliant Directories parent embed helper.
   Load this ONCE on any page that embeds one or more marketplace-feed iframes
   (place it in BD "Footer Scripts", NOT inside the widget HTML — BD's content
   editor strips <script> tags and custom attributes from pasted widget markup).

   It listens for postMessage from the Railway widget and:
     • resize            → sets the iframe's explicit height (no inner scrollbar)
     • scroll-to-widget  → smooth-scrolls the MAIN parent document to the top of
                           the widget after a pagination action.

   BD-ROBUST DETECTION: the widget iframe is found by its src
   (…/widgets/marketplace-feed.html…) which BD preserves — it does NOT depend on
   an id or data-* attribute (BD may strip those). A data-adv-widget hook is also
   honored when present.

   SECURITY: accepts messages ONLY from https://bid.advantage.bid, ONLY when
   event.source is one of THIS page's widget iframes, and ONLY with the expected
   source/type/widget envelope. No wildcard trust; never reads the widget DOM.

   Optional scroll offset (to clear a sticky BD header), highest precedence first:
     window.ADV_SCROLL_OFFSET = 190;                         // set before this script
     <iframe … data-adv-scroll-offset="190">                 // if BD keeps the attr
     <html data-adv-scroll-offset="190">                     // page-level
     (else) auto-detected sticky/fixed header height + 12px breathing room.
   ========================================================================== */
(function () {
  'use strict';
  var ORIGIN = 'https://bid.advantage.bid';   // the ONLY trusted message origin
  var SRC = 'advantage-bid-widget', WIDGET = 'marketplace-feed';
  var MIN = 400, MAX = 20000, SPACING = 12;    // height clamp (px) + breathing room above results

  // PURE decision function (no DOM). Given the parts of a received message, decide what to do.
  // Returns { type:'resize', height } (clamped) | { type:'scroll' } | null (ignore). Exported for tests.
  function decide(evtOrigin, isThisFrame, data, opts) {
    opts = opts || {};
    var min = typeof opts.min === 'number' ? opts.min : MIN;
    var max = typeof opts.max === 'number' ? opts.max : MAX;
    if (evtOrigin !== ORIGIN) return null;                                  // strict origin allowlist
    if (!isThisFrame) return null;                                          // must be one of OUR iframes
    if (!data || data.source !== SRC || data.widget !== WIDGET) return null; // expected envelope
    if (data.type === 'resize') {
      var h = parseInt(data.height, 10);
      if (!isFinite(h)) return null;
      return { type: 'resize', height: Math.max(min, Math.min(max, h)) };   // clamp
    }
    if (data.type === 'scroll-to-widget') return { type: 'scroll' };
    return null;
  }

  // PURE offset precedence resolver (testable): global → iframe attr → html attr → auto. `auto` is the
  // DOM-measured fallback (passed in), used only when no explicit value is configured.
  function resolveOffsetValue(globalVal, iframeAttr, htmlAttr, auto) {
    if (typeof globalVal === 'number' && isFinite(globalVal)) return globalVal;
    var a = parseInt(iframeAttr != null ? iframeAttr : '', 10); if (isFinite(a)) return a;
    var b = parseInt(htmlAttr != null ? htmlAttr : '', 10); if (isFinite(b)) return b;
    return typeof auto === 'number' && isFinite(auto) ? auto : 0;
  }

  // ---- DOM glue (only runs in the browser) ----
  function autoHeaderOffset() {
    var max = 0;
    try {
      var els = document.querySelectorAll('header,nav,.navbar,[class*="sticky"],[class*="fixed"],[class*="header"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i], cs = window.getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'sticky') && (parseFloat(cs.top) || 0) <= 1) {
          var h = el.offsetHeight; if (h > 0 && h < 400 && h > max) max = h;
        }
      }
    } catch (e) {}
    return max;
  }
  function offsetFor(iframe) {
    var auto = autoHeaderOffset();
    var iAttr = iframe && (iframe.getAttribute('data-adv-scroll-offset') || iframe.getAttribute('data-adv-header-offset'));
    var hAttr = document.documentElement.getAttribute('data-adv-scroll-offset') || document.documentElement.getAttribute('data-adv-header-offset');
    return resolveOffsetValue(window.ADV_SCROLL_OFFSET, iAttr, hAttr, auto) + SPACING;
  }
  function targetY(iframe) {
    var rect = iframe.getBoundingClientRect();
    var y = rect.top + (window.scrollY || window.pageYOffset || 0) - offsetFor(iframe);
    return Math.max(0, y);
  }
  function doScroll(iframe, smooth) {
    var y = targetY(iframe);
    try { window.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' }); } catch (e) { window.scrollTo(0, y); }
    return y;
  }
  // Scroll the MAIN document to the widget top. Runs after two animation frames so the just-applied
  // height has laid out, then re-asserts once after a bounded delay to absorb late image-load resizes
  // or a smooth-scroll interrupted by layout shift. The iframe's TOP is stable as it grows downward.
  function scrollToWidget(iframe) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        doScroll(iframe, true);
        setTimeout(function () {
          var want = targetY(iframe);
          if (Math.abs((window.scrollY || window.pageYOffset || 0) - want) > 4) doScroll(iframe, true);
        }, 350);
      });
    });
  }

  function frames() {
    return [].slice.call(document.querySelectorAll(
      'iframe[data-adv-widget="' + WIDGET + '"], iframe[src*="/widgets/marketplace-feed.html"]'));
  }
  // Ask each widget iframe to (re-)post its height. Closes the load-order race when this helper
  // (loaded from BD footer scripts) starts listening after the widget already posted its first height.
  function requestResize() {
    var fs = frames();
    for (var i = 0; i < fs.length; i++) {
      try { if (fs[i].contentWindow) fs[i].contentWindow.postMessage({ source: 'advantage-bid-embed', type: 'request-resize', widget: WIDGET }, ORIGIN); } catch (e) {}
    }
  }
  function init() {
    if (!frames().length) return;
    window.addEventListener('message', function (e) {
      var fs = frames();                                   // re-query (BD may inject the iframe late)
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i];
        var action = decide(e.origin, !!f.contentWindow && f.contentWindow === e.source, e.data);
        if (!action) continue;
        if (action.type === 'resize') {
          f.style.overflowAnchor = 'none';                 // don't let the iframe anchor the scroll as it grows
          f.style.minHeight = '0px';                       // release the initial floor so short states shrink
          f.style.height = action.height + 'px';
        } else if (action.type === 'scroll') {
          scrollToWidget(f);
        }
        return;                                            // handled by the matching frame
      }
    }, false);
    // Prompt an initial height even if the widget posted before we were listening; retry for a
    // late-injected iframe, and again once images/layout have settled on window load.
    requestResize();
    setTimeout(requestResize, 400);
    setTimeout(requestResize, 1200);
    try { window.addEventListener('load', requestResize); } catch (e) {}
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  // Node/CommonJS test hook — exposes the pure fns without running any DOM code.
  if (typeof module !== 'undefined' && module.exports)
    module.exports = { decide: decide, resolveOffsetValue: resolveOffsetValue, ORIGIN: ORIGIN, MIN: MIN, MAX: MAX, WIDGET: WIDGET, SRC: SRC };
})();
